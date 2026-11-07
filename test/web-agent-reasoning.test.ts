import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import type { HostAgentStreamEvent, HostAgentToolEvent } from "../src/api/host/agent.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initElog } from "../src/logger/elog4js.ts"
import { initPaths, type ResolvedPaths } from "../src/platform/path.ts"
import { createHostAgentService } from "../src/plugin/agent-service.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"

let root = ""
let server: Server | null = null
let baseUrl = ""
let requestCount = 0

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-agent-reasoning-"))
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
            const parts = requestCount % 2 === 1 ? reasoningToolChunks() : reasoningAnswerChunks()
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
        id: "chatcmpl_reasoning",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
    }
}

function usageChunk(): object {
    return {
        id: "chatcmpl_reasoning",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
}

function reasoningToolChunks(): object[] {
    return [
        chunk({ role: "assistant" }),
        chunk({ reasoning_content: "先读取文件。" }),
        chunk({ reasoning_content: "确认内容后再回答。" }),
        chunk({
            tool_calls: [
                {
                    index: 0,
                    id: "call_read",
                    type: "function",
                    function: { name: "read", arguments: '{"file_path":"a.txt"}' },
                },
            ],
        }),
        chunk({}, "tool_calls"),
        usageChunk(),
    ]
}

function reasoningAnswerChunks(): object[] {
    return [
        chunk({ role: "assistant" }),
        chunk({ reasoning_content: "文件已读到。" }),
        chunk({ content: "回答完成" }),
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

test("Agent 服务：流式推送思考内容与工具调用事件", { timeout: 20_000 }, async () => {
    requestCount = 0
    const agentTools = new AgentToolRegistry()
    agentTools.register("test", {
        name: "read",
        introduction: { params: { file_path: "路径" }, content: "读取文件" },
        call: async () => ({ success: true, data: { content: "文件内容" } }),
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

    const events: HostAgentStreamEvent[] = []
    const result = await service.stream({ message: "看看 a.txt" }, (event) => {
        events.push(event)
    })
    assert.equal(result.reply, "回答完成")
    assert.equal(requestCount, 2)
    const sessionEvent = events[0]
    assert.equal(sessionEvent?.type, "session", "会话 id 应在流的最前面下发")
    if (sessionEvent !== undefined && sessionEvent.type === "session") {
        assert.equal(sessionEvent.sessionId, result.sessionId)
    }

    const reasoning = events
        .filter((event): event is Extract<HostAgentStreamEvent, { type: "reasoning" }> => {
            return event.type === "reasoning"
        })
        .map((event) => event.text)
        .join("")
    assert.equal(reasoning, "先读取文件。确认内容后再回答。文件已读到。")

    const tools = events.filter(
        (event): event is Extract<HostAgentStreamEvent, { type: "tool" }> => event.type === "tool",
    )
    assert.equal(tools.length, 2, "工具应有 start 与 end 两个事件")
    const start = tools[0] as HostAgentToolEvent
    assert.equal(start.phase, "start")
    assert.equal(start.id, "call_read")
    assert.equal(start.name, "read")
    assert.equal(start.arguments, '{"file_path":"a.txt"}')
    const end = tools[1] as HostAgentToolEvent
    assert.equal(end.phase, "end")
    assert.equal(end.ok, true)
    assert.equal(end.result, "文件内容")
    assert.equal(end.truncated, undefined)

    // 思考内容落在会话的 assistant 消息里（replay 忽略 reasoning 片段）
    const deltas = events.filter((event) => event.type === "delta")
    assert.ok(deltas.length > 0, "正文仍按 delta 推送")
})
