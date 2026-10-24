import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import type { HostAgentAskRequest, HostAgentStreamEvent } from "../src/api/host/agent.ts"
import { onAgentAsk, onUserAnswer } from "../src/api/host/hooks.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initElog } from "../src/logger/elog4js.ts"
import { initPaths, type ResolvedPaths } from "../src/platform/path.ts"
import { cancelSessionAsks, pendingAskCount, waitForAsk } from "../src/agent/pending-asks.ts"
import { createHostAgentService } from "../src/plugin/agent-service.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"

let root = ""
let server: Server | null = null
let baseUrl = ""
let requestCount = 0

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-agent-ask-"))
    process.env["OPENAI_API_KEY"] = "test-key"
    const resolved = paths()
    initPaths(resolved)
    configureHost({ paths: resolved })
    initElog({
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        color: false,
        json: false,
    })
    server = createServer((request, response) => {
        request.resume()
        request.on("end", () => {
            requestCount += 1
            response.statusCode = 200
            response.setHeader("content-type", "text/event-stream")
            const parts = requestCount % 2 === 1 ? askChunks() : finalChunks()
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

function chunk(delta: Record<string, unknown>, finish: string | null = null): object {
    return {
        id: "chatcmpl_ask",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
    }
}

function usageChunk(): object {
    return {
        id: "chatcmpl_ask",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
}

function askChunks(): object[] {
    return [
        chunk({ role: "assistant" }),
        chunk({
            tool_calls: [
                {
                    index: 0,
                    id: "call_ask",
                    type: "function",
                    function: {
                        name: "ask",
                        arguments: JSON.stringify({
                            question: "用哪个分支？",
                            options: ["main", "dev"],
                        }),
                    },
                },
            ],
        }),
        chunk({}, "tool_calls"),
        usageChunk(),
    ]
}

function finalChunks(): object[] {
    return [
        chunk({ role: "assistant" }),
        chunk({ content: "好，用 main。" }),
        chunk({}, "stop"),
        usageChunk(),
    ]
}

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

function createService(): ReturnType<typeof createHostAgentService> {
    return createHostAgentService({
        settings: {
            ...DEFAULT_SETTINGS,
            openai: { ...DEFAULT_SETTINGS.openai, baseUrl, model: "test-model" },
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        paths: paths(),
        logger: pino({ level: "silent" }),
        registry: new PluginRegistry(),
        agentTools: new AgentToolRegistry(),
        cwd: root,
    })
}

test("Agent ask 工具：提问事件 + 回答回到工具结果", { timeout: 20_000 }, async () => {
    requestCount = 0
    const service = createService()
    const asks: HostAgentAskRequest[] = []
    const answers: string[] = []
    const offAsk = onAgentAsk((event) => {
        asks.push({
            askId: event.askId ?? "",
            question: event.question,
            ...(event.options === undefined ? {} : { options: event.options }),
        })
    })
    const offAnswer = onUserAnswer((event) => {
        answers.push(event.answer)
    })

    const events: HostAgentStreamEvent[] = []
    let answered = false
    let result
    try {
        const streamPromise = service.stream({ message: "用哪个分支？" }, (event) => {
            events.push(event)
            if (event.type === "ask" && !answered) {
                answered = true
                // 等 ask 事件到齐后异步回答，模拟界面
                void service.respondAsk(event.request.askId, "main").then((accepted) => {
                    assert.equal(accepted, true)
                })
            }
        })
        result = await streamPromise
    } finally {
        offAsk()
        offAnswer()
    }

    assert.equal(result.reply, "好，用 main。")
    assert.equal(asks.length, 1)
    assert.equal(asks[0]?.question, "用哪个分支？")
    assert.deepEqual(asks[0]?.options, ["main", "dev"])
    assert.match(asks[0]?.askId ?? "", /^ask_/)
    assert.deepEqual(answers, ["main"])

    const askEvent = events.find((event) => event.type === "ask")
    assert.ok(askEvent !== undefined, "SSE 事件里应有 ask")
    if (askEvent?.type === "ask") {
        assert.equal(askEvent.request.question, "用哪个分支？")
        assert.deepEqual(askEvent.request.options, ["main", "dev"])
    }

    const toolEvents = events.filter((event) => event.type === "tool")
    const start = toolEvents.find((event) => event.phase === "start" && event.name === "ask")
    const end = toolEvents.find((event) => event.phase === "end" && event.name === "ask")
    assert.ok(start !== undefined, "ask 是内置工具，也应有 start 事件")
    assert.ok(end !== undefined, "ask 工具结束时带回用户答案")
    assert.equal(end.ok, true)
    assert.equal(end.result, "用户回答：main")
})

test("提问登记：会话结束可以取消遗留等待", async () => {
    const waiting = waitForAsk({ askId: "ask_cancel", sessionId: "s-cancel", timeoutMs: 60_000 })
    assert.equal(pendingAskCount(), 1)
    cancelSessionAsks("s-cancel")
    assert.equal(await waiting, null)
    assert.equal(pendingAskCount(), 0)
})

test("Agent ask：非 TTY 的终端提问立即返回 null，过期回答返回 false", async () => {
    const { promptAgentAsk } = await import("../src/commands/ask-prompt.ts")
    assert.equal(await promptAgentAsk({ askId: "ask_x", question: "随便问问" }), null)
    const service = createService()
    assert.equal(await service.respondAsk("ask_missing", "main"), false)
})

test("Agent ask 工具：没有界面通道时立即跳过，不会挂住", { timeout: 20_000 }, async () => {
    requestCount = 0
    const service = createService()
    const started = Date.now()
    const result = await service.chat({ message: "用哪个分支？" })
    assert.equal(result.reply, "好，用 main。")
    assert.ok(Date.now() - started < 10_000, "agent.chat 不应等待 ask 超时")
})
