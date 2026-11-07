/*
 * 会话中断/重启时的落盘：本轮开始先写用户消息，不等整轮结束
 */

import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initPaths, type ResolvedPaths } from "../src/platform/path.ts"
import { executeTurn } from "../src/commands/conversation.ts"
import { DEFAULT_SETTINGS as SETTINGS } from "../src/config/defaults.ts"
import { Elog } from "../src/logger/elog4js.ts"
import { OpenAIClient } from "../src/network/openai.ts"
import { createHostAgentService } from "../src/plugin/agent-service.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import { SessionStore } from "../src/session/store.ts"

let root = ""
let server: Server | null = null
let baseUrl = ""
let requestCount = 0

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-session-persistence-"))
    process.env["OPENAI_API_KEY"] = "test-key"
    const resolved = paths()
    initPaths(resolved)
    configureHost({ paths: resolved })
    server = createServer((request, response) => {
        request.on("data", () => undefined)
        request.on("end", () => {
            requestCount += 1
            response.statusCode = 200
            response.setHeader("content-type", "text/event-stream")
            const parts = requestCount === 1 ? toolCallChunks() : answerChunks()
            for (const part of parts) {
                response.write(`data: ${JSON.stringify(part)}\n\n`)
            }
            response.end("data: [DONE]\n\n")
        })
    })
    await new Promise<void>((resolvePromise) => {
        server?.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const address = server.address()
    if (address === null || typeof address === "string") {
        throw new Error("测试服务器没有端口")
    }
    baseUrl = `http://127.0.0.1:${address.port}/v1`
})

after(async () => {
    delete process.env["OPENAI_API_KEY"]
    await new Promise<void>((resolvePromise) => server?.close(() => resolvePromise()))
    await rm(root, { recursive: true, force: true })
})

function paths(): ResolvedPaths {
    return {
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
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): object {
    return {
        id: "chatcmpl_persist",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
    }
}

function usageChunk(): object {
    return {
        id: "chatcmpl_persist",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
}

function toolCallChunks(): object[] {
    return [
        chunk({ role: "assistant" }),
        chunk({ content: "先跑一个慢工具。" }),
        chunk({
            tool_calls: [
                {
                    index: 0,
                    id: "call_slow",
                    type: "function",
                    function: { name: "slow_tool", arguments: "{}" },
                },
            ],
        }),
        chunk({}, "tool_calls"),
        usageChunk(),
    ]
}

function answerChunks(): object[] {
    return [
        chunk({ role: "assistant" }),
        chunk({ content: "工具跑完了。" }),
        chunk({}, "stop"),
        usageChunk(),
    ]
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

test("Agent 本轮开始时用户消息已经落盘，进程中断也不会失忆", { timeout: 20_000 }, async () => {
    requestCount = 0
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolvePromise) => {
        release = resolvePromise
    })
    const agentTools = new AgentToolRegistry()
    agentTools.register("test", {
        name: "slow_tool",
        introduction: { params: {}, content: "慢工具" },
        call: async () => {
            await gate
            return { success: true, data: { content: "工具结果" } }
        },
    })
    const service = createHostAgentService({
        settings: {
            ...DEFAULT_SETTINGS,
            openai: { ...DEFAULT_SETTINGS.openai, baseUrl, model: "test-model" },
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        paths: paths(),
        logger: pino({ level: "silent" }),
        registry: new PluginRegistry(),
        agentTools,
        cwd: root,
    })
    const store = new SessionStore(join(root, "data", "sessions"))

    let sessionId = ""
    const turn = service.stream({ message: "这条消息不能丢", cwd: root }, (event) => {
        if (event.type === "session") sessionId = event.sessionId
    })
    for (let attempt = 0; attempt < 200 && sessionId === ""; attempt += 1) {
        await sleep(5)
    }
    assert.notEqual(sessionId, "")

    /*
     * 工具仍阻塞、整轮未结束：从磁盘重新打开会话时应已能看到用户消息
     * 结尾一次性 appendTurn 的实现下，此处为空
     */
    let openedUser = ""
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const opened = await store.open(sessionId, root).catch(() => null)
        const user = opened?.events.find((event) => event.type === "user/message")
        if (user !== undefined) {
            openedUser =
                (user.data["message"] as { content?: Array<{ text?: string }> }).content?.[0]
                    ?.text ?? ""
            break
        }
        await sleep(20)
    }
    assert.equal(openedUser, "这条消息不能丢", "本轮开始时用户消息应已写入会话文件")

    release!()
    const result = await turn
    assert.match(result.reply, /工具跑完了/)

    const finished = await store.open(sessionId, root)
    assert.ok(finished.events.some((event) => event.type === "assistant/message"))
    assert.equal(
        (finished.events.at(-1)?.data["reason"] as { kind?: string } | undefined)?.kind,
        "completed",
    )
    const userMessages = finished.events.filter((event) => event.type === "user/message")
    assert.equal(userMessages.length, 1, "用户消息只落盘一次")
})

test("chat 模式本轮开始时也先落盘用户消息", { timeout: 20_000 }, async () => {
    const cwd = root
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolvePromise) => {
        release = resolvePromise
    })
    const client = OpenAIClient.create({
        apiKey: "test-key",
        settings: { ...SETTINGS.openai, baseUrl },
        fetch: async () => {
            await gate
            const body = [
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "答" } }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
                "data: [DONE]\n\n",
            ].join("")
            return new Response(body, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            })
        },
    })
    assert.equal(client.isSuccess(), true)
    const openai = client.getData()
    assert.ok(openai !== null)
    const elog = new Elog({
        stdout: { write: () => true },
        stderr: { write: () => true },
        json: true,
    })
    const ctx = {
        global: { json: true, quiet: true, help: false, version: false },
        settings: SETTINGS,
        settingsFile: join(root, "apps.json"),
        configCode: null,
        paths: paths(),
        logger: pino({ level: "silent" }),
        elog,
        registry: new PluginRegistry(),
        agentTools: new AgentToolRegistry(),
        openai,
        loadPlugins: async () => [],
    }
    const store = new SessionStore(join(root, "data", "sessions"))
    const session = await store.create({ cwd, model: "test-model", id: "conv-persist-chat" })
    const turn = executeTurn({
        ctx,
        client: openai,
        store,
        session,
        mode: "chat",
        input: "chat 也别丢",
        model: "test-model",
        stream: false,
        display: false,
    })

    let openedUser = ""
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const opened = await store.open("conv-persist-chat", cwd).catch(() => null)
        const user = opened?.events.find((event) => event.type === "user/message")
        if (user !== undefined) {
            openedUser =
                (user.data["message"] as { content?: Array<{ text?: string }> }).content?.[0]
                    ?.text ?? ""
            break
        }
        await sleep(10)
    }
    assert.equal(openedUser, "chat 也别丢")
    release!()
    const result = await turn
    assert.equal(result.isSuccess(), true)

    const finished = await store.open("conv-persist-chat", cwd)
    assert.deepEqual(
        finished.events.map((event) => event.type),
        ["turn/start", "user/message", "assistant/message", "turn/end"],
    )
})
