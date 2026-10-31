/*
 * 事件缓冲超限后，实时推送必须继续。
 *
 * 曾经的 bug：`recordChatTurnEvent` 一旦 truncated 就整体 return，
 * 连正在看的页面也收不到后续事件 —— 服务端还在跑、前端卡住不动。
 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { emitInitHooks } from "../src/api/host/hooks.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initElog } from "../src/logger/elog4js.ts"
import { createHostPluginManager } from "../src/plugin/manage.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { PluginSandboxClient, shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"
import { startHttpHostPlugin, watchHttpServer } from "../test/helpers/http-host.ts"

const projectRoot = join(import.meta.dirname, "..")
let root = ""
let client: PluginSandboxClient | null = null
let watcher: ReturnType<typeof watchHttpServer> | null = null
let base = ""
let cookie = ""

/**
 * 缓冲阈值调得很小，让第一轮事件就超限
 *
 * 走 pluginConfig 而不是环境变量：插件跑在 sandbox 子进程里，env 是清洗过的，
 * 测试进程里设的变量传不进去。
 */
const BUFFER_CHARS = 600

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-turn-buffer-"))
    const paths = {
        configDir: join(root, "config"),
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        logDir: join(root, "logs"),
        sources: {
            configDir: "override" as const,
            dataDir: "override" as const,
            cacheDir: "override" as const,
            logDir: "override" as const,
        },
    }
    configureHost({ paths })
    const output: { text: string; write: (text: string) => void } = {
        text: "",
        write(text: string) {
            output.text += text
        },
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    await startHttpHostPlugin(paths)
    watcher = watchHttpServer("wellspring-web")

    const agent = {
        async validateWorkspace(path: string) {
            return { ok: true, root: path, name: "demo" }
        },
        async pickDirectory() {
            return { ok: true, root: join(root, "demo"), name: "demo" }
        },
        async chat(input: { message: string }) {
            return {
                sessionId: "s",
                turn: 1,
                steps: 1,
                reply: input.message,
                model: "m",
                usage: null,
            }
        },
        async stream(
            input: { conversationId?: string },
            onEvent: (event: Record<string, unknown>) => void,
        ) {
            onEvent({ type: "session", sessionId: `sess-${input.conversationId}` })
            // 每段都不大，但累加起来超过 2000 字符的缓冲上限
            for (let i = 1; i <= 40; i += 1) {
                onEvent({ type: "delta", text: `第${i}段。` })
            }
            onEvent({ type: "done", reply: "结束" })
            return { sessionId: "s", turn: 1, steps: 1, reply: "结束", model: "m", usage: null }
        },
        async stop() {
            return true
        },
        async searchWorkspaceFiles(path: string) {
            return { ok: true, root: path, truncated: false, entries: [] }
        },
        async interject() {
            return false
        },
        async respondApproval() {
            return true
        },
        async respondAsk() {
            return true
        },
    }

    const pluginDir = join(projectRoot, "plugins", "wellspring-web")
    client = new PluginSandboxClient({
        pluginId: "wellspring-web",
        pluginName: "Wellspring Web",
        pluginVersion: "1.0.0",
        pluginDir,
        pluginEntry: join(pluginDir, "index.ts"),
        paths,
        config: DEFAULT_SETTINGS,
        pluginConfig: { port: 0, turnBufferChars: BUFFER_CHARS },
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: {
            hostApi: [
                "logger",
                "fs",
                "agent",
                "models",
                "plugins",
                "shutdown",
                "event",
                "getHost",
                "workspaces",
            ],
            workspaceRead: false,
            workspaceWrite: false,
        },
        agent,
        plugins: createHostPluginManager({ paths, logger: pino({ level: "silent" }) }),
    } as never)
    await client.start()
    await emitInitHooks()
    const ready = await watcher.ready
    base = `http://127.0.0.1:${ready.port}`
    const setup = await fetch(`${base}/api/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "secret123" }),
    })
    cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
})

after(async () => {
    watcher?.dispose()
    await shutdownAllSandboxPlugins()
    await rm(root, { recursive: true, force: true })
})

test("缓冲超限后直播不断：仍能收到后续 delta 与 done", { timeout: 20_000 }, async () => {
    const response = await fetch(`${base}/api/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
            message: "写很长",
            // 用 workspaceRoot：workspaceId 要先用真实目录登记，未登记会直接 404
            workspaceRoot: join(root, "demo"),
            conversationId: "c_buffer",
        }),
    })
    assert.equal(response.status, 200)
    const body = await response.text()

    // 超限后前端会先收到 truncated 提示
    assert.match(body, /"type":"truncated"/)
    // 关键：超限之后的正文照样推过来
    assert.match(body, /第40段/)
    assert.match(body, /"type":"done"/)
})
