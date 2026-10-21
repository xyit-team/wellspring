import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { afterMessage, afterStep, afterTurn, beforeMessage } from "../src/api/host/hooks.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { CommandContext } from "../src/commands/shared.ts"
import { executeTurn } from "../src/commands/conversation.ts"
import { Elog } from "../src/logger/elog4js.ts"
import { createProxyFetch } from "../src/network/proxy.ts"
import { OpenAIClient, type CreateOpenAIClientOptions } from "../src/network/openai.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import { SessionStore } from "../src/session/store.ts"

let root = ""
let cwd = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-conversation-"))
    cwd = await mkdtemp(join(tmpdir(), "wellspring-conversation-cwd-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
})

const SETTINGS = {
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    timeoutMs: 1000,
    maxRetries: 0,
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): object {
    return {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
    }
}

function usageChunk(): object {
    return {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    }
}

function sse(parts: readonly object[]): Response {
    const body = `${parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("")}data: [DONE]\n\n`
    return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    })
}

function successFetch(requests: unknown[]): NonNullable<CreateOpenAIClientOptions["fetch"]> {
    return async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return sse([
            chunk({ role: "assistant" }),
            chunk({ content: "hel" }),
            chunk({ content: "lo" }),
            chunk({}, "stop"),
            usageChunk(),
        ])
    }
}

function context(client: OpenAIClient): CommandContext {
    const paths: ResolvedPaths = {
        configDir: join(root, "config"),
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        logDir: join(root, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
    const elog = new Elog({
        stdout: { write: () => true },
        stderr: { write: () => true },
        json: true,
    })
    return {
        global: { json: true, quiet: true, help: false, version: false },
        settings: DEFAULT_SETTINGS,
        settingsFile: join(paths.configDir, "app-setting.json"),
        configCode: null,
        paths,
        logger: pino({ level: "silent" }),
        elog,
        registry: new PluginRegistry(),
        openai: client,
        loadPlugins: async () => [],
    }
}

function createClient(fetchImpl: NonNullable<CreateOpenAIClientOptions["fetch"]>): OpenAIClient {
    const created = OpenAIClient.create({
        apiKey: "test-key",
        settings: SETTINGS,
        fetch: fetchImpl,
    })
    assert.equal(created.isSuccess(), true)
    const client = created.getData()
    assert.ok(client !== null)
    return client
}

test("executeTurn 写入会话与流式 chunk", async () => {
    const requests: unknown[] = []
    const client = createClient(successFetch(requests))
    const ctx = context(client)
    const store = new SessionStore(join(root, "sessions"))
    const session = await store.create({ cwd, model: "test-model", id: "conv-1" })

    const result = await executeTurn({
        ctx,
        client,
        store,
        session,
        mode: "chat",
        input: "hi",
        model: "test-model",
        stream: false,
        display: false,
    })

    assert.equal(result.isSuccess(), true)
    assert.equal(result.getData()?.reply, "hello")
    assert.deepEqual(result.getData()?.usage, { inputTokens: 2, outputTokens: 2 })

    const reopened = await store.open("conv-1", cwd)
    assert.deepEqual(
        reopened.events.map((event) => event.type),
        ["turn/start", "user/message", "assistant/message", "turn/end"],
    )
    const assistant = reopened.events[2]
    const stream = assistant?.data["stream"]
    assert.ok(Array.isArray(stream))
    const deltas = (stream as Array<{ chunk?: { type?: string; text?: string } }>).filter(
        (item) => item.chunk?.type === "text-delta",
    )
    assert.deepEqual(
        deltas.map((item) => item.chunk?.text),
        ["hel", "lo"],
    )
    assert.deepEqual(
        (reopened.events[3]?.data["reason"] as { kind?: string } | undefined)?.kind,
        "completed",
    )

    const second = await executeTurn({
        ctx,
        client,
        store,
        session,
        mode: "chat",
        input: "again",
        model: "test-model",
        stream: false,
        display: false,
    })
    assert.equal(second.isSuccess(), true)
    const secondRequest = requests[1] as { messages?: Array<{ role: string }> }
    assert.deepEqual(
        secondRequest.messages?.map((message) => message.role),
        ["user", "assistant", "user"],
    )
})

test("对话生命周期触发 before/after 钩子", async () => {
    const requests: unknown[] = []
    const client = createClient(successFetch(requests))
    const ctx = context(client)
    const store = new SessionStore(join(root, "sessions"))
    const session = await store.create({ cwd, model: "test-model", id: "conv-hooks" })

    const calls: string[] = []
    const unregisters = [
        beforeMessage(({ prompt }) => {
            calls.push("beforeMessage")
            prompt.push("hook-rule")
        }),
        afterStep(() => {
            calls.push("afterStep")
        }),
        afterMessage(() => {
            calls.push("afterMessage")
        }),
        afterTurn((payload) => {
            calls.push(`afterTurn:${payload.reason}`)
        }),
    ]

    try {
        const result = await executeTurn({
            ctx,
            client,
            store,
            session,
            mode: "chat",
            input: "hi",
            model: "test-model",
            stream: false,
            display: false,
        })
        assert.equal(result.isSuccess(), true)

        const request = requests[0] as {
            messages?: Array<{ role: string; content: string }>
        }
        assert.deepEqual(request.messages?.[0], { role: "system", content: "hook-rule" })
        assert.deepEqual(calls, [
            "beforeMessage",
            "afterStep",
            "afterMessage",
            "afterTurn:completed",
        ])
    } finally {
        for (const unregister of unregisters) {
            unregister()
        }
    }
})

test("executeTurn 失败时记录 failed 轮次", async () => {
    const fetchImpl: NonNullable<CreateOpenAIClientOptions["fetch"]> = async () =>
        new Response(
            JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }),
            {
                status: 429,
                headers: { "content-type": "application/json" },
            },
        )
    const client = createClient(fetchImpl)
    const ctx = context(client)
    const store = new SessionStore(join(root, "sessions"))
    const session = await store.create({ cwd, model: "test-model", id: "conv-2" })

    const result = await executeTurn({
        ctx,
        client,
        store,
        session,
        mode: "run",
        input: "hello",
        model: "test-model",
        stream: false,
        display: false,
    })

    assert.equal(result.isSuccess(), false)
    assert.equal(result.getCode(), "openai.rate-limited")

    const reopened = await store.open("conv-2", cwd)
    const last = reopened.events[reopened.events.length - 1]
    assert.equal(last?.type, "turn/end")
    const reason = last?.data["reason"] as { kind?: string; code?: string } | undefined
    assert.equal(reason?.kind, "failed")
    assert.equal(reason?.code, "openai.rate-limited")
})

test("代理为 null 时不注入 fetch", () => {
    assert.equal(createProxyFetch(null), undefined)
})
