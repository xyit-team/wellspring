/*
 * 宿主 Agent 插话：运行中的一轮在下一次模型调用前收到用户补充消息
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
import { initElog } from "../src/logger/elog4js.ts"
import { initPaths, type ResolvedPaths } from "../src/platform/path.ts"
import { createHostAgentService } from "../src/plugin/agent-service.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"

let root = ""
let server: Server | null = null
let baseUrl = ""
let requestCount = 0
const requestBodies: unknown[] = []

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-agent-interject-"))
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
        const chunks: Buffer[] = []
        request.on("data", (chunk: Buffer) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        request.on("end", () => {
            requestCount += 1
            try {
                requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
            } catch {
                requestBodies.push(null)
            }
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

function chunk(delta: Record<string, unknown>, finish: string | null = null): object {
    return {
        id: "chatcmpl_interject",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
    }
}

function usageChunk(): object {
    return {
        id: "chatcmpl_interject",
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
        chunk({ content: "先等工具跑完。" }),
        chunk({
            tool_calls: [
                {
                    index: 0,
                    id: "call_wait",
                    type: "function",
                    function: { name: "read", arguments: '{"file_path":"a.txt"}' },
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
        chunk({ content: "收到插话，继续回答。" }),
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

function sleep(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

test("Agent 插话：消息在下一步模型调用前注入同一轮", { timeout: 20_000 }, async () => {
    requestCount = 0
    requestBodies.length = 0
    const agentTools = new AgentToolRegistry()
    agentTools.register("test", {
        name: "read",
        introduction: { params: { file_path: "路径" }, content: "读取文件" },
        call: async () => {
            // 留出插话窗口
            await sleep(300)
            return { success: true, data: { content: "文件内容" } }
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

    let sessionId = ""
    const turn = service.stream({ message: "读一下 a.txt", cwd: root }, (event) => {
        if (event.type === "session") sessionId = event.sessionId
    })

    // begin 之后才接受插话
    let accepted = false
    for (let attempt = 0; attempt < 100 && !accepted; attempt += 1) {
        accepted = await service.interject(sessionId, "顺便看下 README.md")
        if (!accepted) await sleep(10)
    }
    assert.equal(accepted, true, "运行中的会话应接受插话")

    const result = await turn
    assert.equal(result.reply, "收到插话，继续回答。")
    assert.equal(requestCount, 2, "一轮里两次模型调用")
    const secondPrompt = JSON.stringify(requestBodies[1])
    assert.match(secondPrompt, /顺便看下 README\.md/, "第二次请求带上插话内容")

    // 轮次结束后与未知会话都拒绝插话
    assert.equal(await service.interject(sessionId, "太晚了"), false)
    assert.equal(await service.interject("no-such-session", "hello"), false)
    assert.equal(await service.interject(sessionId, "   "), false)
})
