import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { emitInitHooks, emitShutdownHooks } from "../src/api/host/hooks.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { PluginSandboxClient, shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"

const projectRoot = join(import.meta.dirname, "..")
let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-web-test-"))
})

after(async () => {
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

test("web 插件：首次设置密码、登录、与 Agent 聊天", { timeout: 20_000 }, async () => {
    const resolved = paths()
    configureHost({ paths: resolved })
    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const client = new PluginSandboxClient({
        pluginId: "wellspring-web",
        pluginName: "Wellspring Web",
        pluginVersion: "1.0.0",
        pluginDir: join(projectRoot, "plugins", "wellspring-web"),
        pluginEntry: join(projectRoot, "plugins", "wellspring-web", "index.ts"),
        paths: resolved,
        config: DEFAULT_SETTINGS,
        pluginConfig: { port: 0 },
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: {
            hostApi: ["logger", "fs", "http", "agent"],
            workspaceRead: false,
            workspaceWrite: false,
        },
        agent: {
            async chat(input) {
                return {
                    sessionId: "web-session",
                    reply: `reply:${input.message}`,
                    model: "test",
                    usage: null,
                }
            },
            async stream(input, onEvent) {
                onEvent({ type: "delta", text: "partial" })
                return {
                    sessionId: "stream-session",
                    reply: `stream:${input.message}`,
                    model: "test",
                    usage: null,
                }
            },
        },
    })
    try {
        await client.start()
        await emitInitHooks()
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output.text)
        assert.ok(match, output.text)
        const base = `http://127.0.0.1:${match[1]}`

        const state = (await (await fetch(`${base}/api/state`)).json()) as {
            configured: boolean
            authenticated: boolean
        }
        assert.equal(state.configured, false)
        assert.equal(state.authenticated, false)

        const setup = await fetch(`${base}/api/auth/setup`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: "secret123" }),
        })
        assert.equal(setup.status, 200)
        const cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? ""
        assert.match(cookie, /wellspring_web_session=/)

        const authed = (await (
            await fetch(`${base}/api/state`, { headers: { cookie } })
        ).json()) as { authenticated: boolean }
        assert.equal(authed.authenticated, true)

        const chat = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ message: "hello" }),
        })
        assert.equal(chat.status, 200)
        const data = (await chat.json()) as { sessionId: string; reply: string }
        assert.equal(data.sessionId, "web-session")
        assert.equal(data.reply, "reply:hello")

        const streamed = await fetch(`${base}/api/chat/stream`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ message: "hello" }),
        })
        const events = await streamed.text()
        assert.equal(streamed.status, 200, events)
        assert.match(events, /"type":"delta"/)
        assert.match(events, /"text":"partial"/)
        assert.match(events, /"type":"done"/)
        assert.match(events, /"sessionId":"stream-session"/)

        const unauthorized = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "hello" }),
        })
        assert.equal(unauthorized.status, 401)
    } finally {
        await emitShutdownHooks()
        await shutdownAllSandboxPlugins()
    }
})
