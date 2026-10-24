/*
 * Web 插件：关闭 Wellspring 按钮的接口与界面接线。
 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { emitShutdownHooks, setShutdownHandler } from "../src/api/host/hooks.ts"
import { emitInitHooks } from "../src/api/host/hooks.ts"
import type { HostAgentService } from "../src/plugin/agent-service.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { PluginSandboxClient, shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"

const projectRoot = join(import.meta.dirname, "..")
let root = ""
let client: PluginSandboxClient | null = null
let base = ""
let shutdownRequests = 0

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

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-web-shutdown-"))
    const resolved = paths()
    configureHost({ paths: resolved })
    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const logger = pino({ level: "silent" })
    const fakeAgent = {
        async chat() {
            throw new Error("not used")
        },
        async stream() {
            throw new Error("not used")
        },
        async validateWorkspace(path: string) {
            return { ok: true, root: path, name: "ws" }
        },
        async pickDirectory() {
            return { ok: false, root: "", name: "", error: "已取消" }
        },
        async searchWorkspaceFiles(fileRoot: string) {
            return { ok: true, root: fileRoot, entries: [], truncated: false }
        },
        async interject() {
            return false
        },
        async respondApproval() {
            return false
        },
    } as unknown as HostAgentService
    client = new PluginSandboxClient({
        pluginId: "wellspring-web",
        pluginName: "Wellspring Web",
        pluginVersion: "1.0.0",
        pluginDir: join(projectRoot, "plugins", "wellspring-web"),
        pluginEntry: join(projectRoot, "plugins", "wellspring-web", "index.ts"),
        paths: resolved,
        config: DEFAULT_SETTINGS,
        pluginConfig: { port: 0 },
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 8192 },
        logger,
        permissions: {
            hostApi: ["logger", "fs", "http", "agent", "event", "getHost", "shutdown"],
            workspaceRead: false,
            workspaceWrite: false,
        },
        agent: fakeAgent,
    })
    await client.start()
    await emitInitHooks()
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output.text)
    assert.ok(match, output.text)
    base = `http://127.0.0.1:${match[1]}`
    // 测试进程不是 wellspring start，这里自己接住优雅关闭请求
    setShutdownHandler(() => {
        shutdownRequests += 1
    })
})

after(async () => {
    setShutdownHandler(null)
    await emitShutdownHooks()
    await shutdownAllSandboxPlugins()
    client = null
    await rm(root, { recursive: true, force: true })
})

test("页面包含「关闭 Wellspring」按钮与关闭后的提示", async () => {
    const html = await (await fetch(`${base}/`)).text()
    assert.match(html, /id="shutdown-open"/)
    assert.match(html, /关闭 Wellspring/)
    assert.match(html, /id="shutdown-screen"/)
    assert.match(html, /Wellspring 已关闭/)
    const script = await (await fetch(`${base}/assets/app.js`)).text()
    assert.match(script, /function closeWellspring\(/)
    assert.match(script, /function showShutdownScreen\(/)
    assert.match(script, /\/api\/shutdown/)
})

test("关闭接口需要登录，确认后触发宿主优雅关闭", async () => {
    const anonymous = await fetch(`${base}/api/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
    })
    assert.equal(anonymous.status, 401)

    const setup = await fetch(`${base}/api/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "secret123" }),
    })
    assert.equal(setup.status, 200)
    const cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? ""

    const response = await fetch(`${base}/api/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
    })
    assert.equal(response.status, 200)
    const data = (await response.json()) as { ok: boolean }
    assert.equal(data.ok, true)
    // 关闭是响应返回后延迟触发的
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(shutdownRequests, 1)
})
