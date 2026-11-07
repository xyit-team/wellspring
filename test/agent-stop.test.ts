/*
 * 宿主 Agent 停止：运行中的一轮在下一步之前收尾，不再发起模型调用
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
import { Session } from "../src/session/session.ts"

let root = ""
let server: Server | null = null
let baseUrl = ""
let requestCount = 0

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-agent-stop-"))
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
        request.on("data", () => undefined)
        request.on("end", () => {
            requestCount += 1
            response.statusCode = 200
            response.setHeader("content-type", "text/event-stream")
            // 首次调用请求慢工具，第二次返回最终回答
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
        id: "chatcmpl_stop",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
    }
}

function usageChunk(): object {
    return {
        id: "chatcmpl_stop",
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
        chunk({ content: "先跑个工具。" }),
        chunk({
            tool_calls: [
                {
                    index: 0,
                    id: "call_slow",
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
        chunk({ content: "工具跑完了，这是最终回答。" }),
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

function serviceWith(agentTools: AgentToolRegistry) {
    return createHostAgentService({
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
}

test("Agent 停止：下一步之前收尾，不再调用模型", { timeout: 20_000 }, async () => {
    requestCount = 0
    const agentTools = new AgentToolRegistry()
    agentTools.register("test", {
        name: "read",
        introduction: { params: { file_path: "路径" }, content: "读取文件" },
        call: async () => {
            // 留出停止窗口
            await sleep(400)
            return { success: true, data: { content: "文件内容" } }
        },
    })
    const service = serviceWith(agentTools)

    let sessionId = ""
    const events: string[] = []
    const turn = service.stream({ message: "读一下 a.txt", cwd: root }, (event) => {
        events.push(event.type)
        if (event.type === "session") sessionId = event.sessionId
    })

    /*
     * 等第一次模型调用发生、工具开始执行后再停止
     * stop() 立即中断在途请求，提前调用会连第一次请求一起中断
     * 本用例观察的是停止后不再进入下一步
     */
    for (let attempt = 0; attempt < 200 && requestCount === 0; attempt += 1) {
        await sleep(10)
    }
    assert.equal(requestCount, 1, "第一次模型调用应已发出")
    await sleep(100)

    let stopped = false
    for (let attempt = 0; attempt < 100 && !stopped; attempt += 1) {
        stopped = await service.stop(sessionId)
        if (!stopped) await sleep(10)
    }
    assert.equal(stopped, true, "运行中的会话应接受停止")

    const result = await turn
    assert.equal(requestCount, 1, "停止后不再发起下一次模型调用")
    assert.match(result.reply, /先跑个工具/, "保留已经产出的正文")
    assert.doesNotMatch(result.reply, /最终回答/, "不再继续生成")

    // 已收尾的一轮与未知会话返回 false
    assert.equal(await service.stop(sessionId), false)
    assert.equal(await service.stop("no-such-session"), false)
})

test("Session 停止标记：新一轮开始时复位", () => {
    const session = new Session({
        meta: {
            type: "run",
            version: 1,
            id: "sess-stop-flag",
            createdAt: Date.now(),
            cwd: root,
            workspace: root,
            metadata: {},
            app: "wellspring",
            appVersion: "1.0.0",
            model: "test-model",
        },
        header: { type: "run", metadata: {}, workspace: root },
        dir: join(root, "sessions", "sess-stop-flag"),
        events: [],
        turns: [],
    })
    session.begin()
    assert.equal(session.stopRequested, false)
    session.requestStop()
    assert.equal(session.stopRequested, true)
    // 新一轮复位停止标记
    session.end()
    session.begin()
    assert.equal(session.stopRequested, false)
})
