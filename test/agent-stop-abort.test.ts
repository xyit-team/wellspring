/*
 * 停止打断在途模型请求：已收到正文保留，本轮按「已停止」收尾
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
// 客户端提前断开
let clientAborted = false
let streamedChunks = 0

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-agent-abort-"))
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
        request.on("error", () => undefined)
        request.on("end", () => {
            response.statusCode = 200
            response.setHeader("content-type", "text/event-stream")
            // 分段慢速推送，留出打断窗口
            let index = 0
            const timer = setInterval(() => {
                if (response.writableEnded || response.destroyed) {
                    clearInterval(timer)
                    return
                }
                index += 1
                streamedChunks = index
                const delta = { content: `第${index}段。` }
                response.write(
                    `data: ${JSON.stringify({
                        id: "chatcmpl_abort",
                        object: "chat.completion.chunk",
                        created: 0,
                        model: "test-model",
                        choices: [{ index: 0, delta, finish_reason: null }],
                    })}\n\n`,
                )
            }, 120)
            response.on("close", () => {
                clearInterval(timer)
                // 客户端先断开时标记中止
                if (!response.writableEnded) clientAborted = true
            })
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

function sleep(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

test("停止打断在途模型请求：保留已收到的正文，按已停止收尾", { timeout: 20_000 }, async () => {
    clientAborted = false
    streamedChunks = 0
    const service = createHostAgentService({
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

    let sessionId = ""
    let received = ""
    const turn = service.stream({ message: "写长一点", cwd: root }, (event) => {
        if (event.type === "session") sessionId = event.sessionId
        if (event.type === "delta") received += event.text
    })

    // 等首个正文片段到达后停止
    for (let attempt = 0; attempt < 100 && received === ""; attempt += 1) {
        await sleep(20)
    }
    assert.notEqual(received, "", "停止前应已收到部分正文")
    const beforeStop = received
    const stoppedAt = Date.now()

    const stopped = await service.stop(sessionId)
    assert.equal(stopped, true, "运行中的会话应接受停止")

    const result = await turn
    const elapsed = Date.now() - stoppedAt

    // 收尾不等剩余片段
    assert.ok(elapsed < 3000, `停止后应尽快收尾，实际 ${elapsed}ms`)
    // 保留已收到正文
    assert.ok(result.reply.length >= beforeStop.length, "已收到的正文不应丢失")
    assert.match(result.reply, /第1段/, "半截回复要有内容")
    // 停止断开请求，流未读完
    assert.equal(clientAborted, true, "服务端应观察到客户端断开")
    assert.ok(streamedChunks < 40, `不应读完所有段，实际 ${streamedChunks} 段`)
    // 已收尾的一轮拒绝停止
    assert.equal(await service.stop(sessionId), false)
})
