import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost, setHostPlugins, setHostStatus } from "../src/api/host/host.ts"
import { emitOnMessage, onMessage } from "../src/api/host/hooks.ts"
import { flushSandboxAudit } from "../src/sandbox/audit.ts"
import { eventBus } from "../src/event/event.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { PluginSandboxClient, shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"
import { loadPlugins } from "../src/plugin/loader.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import { createPluginFileApi } from "../src/plugin/fs.ts"
import { registerSession } from "../src/session/registry.ts"
import { Session } from "../src/session/session.ts"
import { SessionStore } from "../src/session/store.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-sandbox-plugin-"))
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

const PLUGIN_SOURCE = [
    'import { EventEntity, eventBus, getHost, onMessage } from "wellspring/api/host/index.ts"',
    "",
    "onMessage(({ phase, prompt }) => {",
    '    if (phase === "before") prompt.push("sandbox-rule")',
    "})",
    "",
    "export function setup() {",
    "    return {",
    '        id: "sandbox-plugin",',
    '        name: "Sandbox Plugin",',
    '        version: "1.0.0",',
    '        status: "ok",',
    "        commands: [",
    "            {",
    '                name: "hello",',
    '                summary: "hello",',
    "                run: (ctx) => {",
    '                    ctx.output.info("hello:" + ctx.argv.join(","))',
    '                    ctx.logger.info("cmd-log")',
    "                    return 3",
    "                },",
    "            },",
    "            {",
    '                name: "fs-roundtrip",',
    '                summary: "fs",',
    "                run: async (ctx) => {",
    '                    await ctx.fs.writeText("a.txt", "from-sandbox")',
    '                    const text = await ctx.fs.readText("a.txt")',
    '                    ctx.output.info(text ?? "null")',
    "                    return 0",
    "                },",
    "            },",
    "            {",
    '                name: "host-info",',
    '                summary: "host",',
    "                run: (ctx) => {",
    "                    const host = getHost()",
    '                    ctx.output.info("host:" + host.getStatus())',
    "                    return 0",
    "                },",
    "            },",
    "            {",
    '                name: "publish",',
    '                summary: "publish",',
    "                run: (ctx) => {",
    '                    eventBus.publish("sandbox/demo", EventEntity.create({ ok: true }))',
    '                    ctx.output.info("published")',
    "                    return 0",
    "                },",
    "            },",
    "        ],",
    "    }",
    "}",
    "",
].join("\n")

test("PluginSandboxClient 命令/钩子/fs/host/event 往返", { timeout: 20_000 }, async () => {
    const dataDir = join(root, "data")
    const pluginDir = join(dataDir, "plugins", "sandbox-plugin")
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({
            name: "sandbox-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: {
                apiVersion: 1,
                sandbox: {
                    profile: "plugin",
                    hostApi: ["logger", "fs", "event", "getHost"],
                },
            },
        }),
    )
    await writeFile(join(pluginDir, "index.ts"), PLUGIN_SOURCE)

    const resolved = paths()
    configureHost({ paths: resolved })
    setHostStatus("running")
    setHostPlugins([])

    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })

    const client = new PluginSandboxClient({
        pluginId: "sandbox-plugin",
        pluginName: "Sandbox Plugin",
        pluginVersion: "1.0.0",
        pluginDir,
        pluginEntry: join(pluginDir, "index.ts"),
        paths: resolved,
        config: DEFAULT_SETTINGS,
        pluginConfig: {},
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: {
            hostApi: ["logger", "fs", "event", "getHost"],
            workspaceRead: false,
            workspaceWrite: false,
        },
    })

    try {
        const ready = await client.start()
        assert.equal(ready.plugin.id, "sandbox-plugin")
        assert.equal(ready.plugin.status, "ok")
        assert.deepEqual(
            ready.commands.map((command) => command.name),
            ["hello", "fs-roundtrip", "host-info", "publish"],
        )
        assert.ok(ready.hooks.includes("onMessage"))

        const exitCode = await client.runCommand("hello", ["a", "b"], pluginDir, false)
        assert.equal(exitCode, 3)
        assert.match(output.text, /hello:a,b/)

        await client.runCommand("fs-roundtrip", [], pluginDir, false)
        assert.match(output.text, /from-sandbox/)
        assert.equal(
            await readFile(
                join(resolved.dataDir, "plugin-data", "sandbox-plugin", "a.txt"),
                "utf8",
            ),
            "from-sandbox",
        )

        await client.runCommand("host-info", [], pluginDir, false)
        assert.match(output.text, /host:running/)

        const received: unknown[] = []
        const off = eventBus.subscribe("sandbox/demo", (event) => {
            received.push(event.getData())
        })
        try {
            await client.runCommand("publish", [], pluginDir, false)
            await new Promise((resolve) => setTimeout(resolve, 100))
            assert.deepEqual(received, [{ ok: true }])
        } finally {
            off()
        }

        const hookResult = (await client.runHook("onMessage", {
            sessionId: "s",
            mode: "chat",
            turn: 1,
            role: "user",
            phase: "before",
            content: "hi",
            prompt: [],
        })) as { prompt: string[] }
        assert.deepEqual(hookResult.prompt, ["sandbox-rule"])
    } finally {
        await client.close()
    }
})

test("loader 通过 sandbox 加载插件、注册命令与远程钩子", { timeout: 20_000 }, async () => {
    const dataDir = join(root, "data-loader")
    const pluginDir = join(dataDir, "plugins", "sandbox-plugin")
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({
            name: "sandbox-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: {
                apiVersion: 1,
                sandbox: {
                    profile: "plugin",
                    hostApi: ["logger", "fs", "event", "getHost"],
                },
            },
        }),
    )
    await writeFile(join(pluginDir, "index.ts"), PLUGIN_SOURCE)

    const resolved = paths()
    configureHost({ paths: resolved })
    setHostStatus("running")
    setHostPlugins([])

    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })

    const registry = new PluginRegistry()
    try {
        const plugins = await loadPlugins({
            paths: resolved,
            config: DEFAULT_SETTINGS,
            logger: pino({ level: "silent" }),
            registry,
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "strict" },
            sandboxBackend: new DirectBackend(),
        })
        assert.equal(plugins.length, 1)
        assert.equal(plugins[0]?.status, "ok")
        assert.deepEqual(plugins[0]?.commands, ["hello", "fs-roundtrip", "host-info", "publish"])

        const record = registry.resolve("hello")
        assert.ok(record !== undefined)
        const exitCode = await record.command.run({
            argv: ["x"],
            env: process.env,
            paths: resolved,
            config: DEFAULT_SETTINGS,
            logger: pino({ level: "silent" }),
            output: {
                info: (text) => output.write(text),
                warn: (text) => output.write(text),
                error: (text) => output.write(text),
                print: (text = "") => output.write(text),
            },
            pluginDataDir: join(resolved.dataDir, "plugin-data", "sandbox-plugin"),
            pluginConfig: {},
            fs: createPluginFileApi(join(resolved.dataDir, "plugin-data", "sandbox-plugin")),
            workspaceFs: createPluginFileApi(process.cwd()),
            cwd: pluginDir,
            json: false,
            stdin: process.stdin,
            stdout: process.stdout,
            stderr: process.stderr,
        })
        assert.equal(exitCode, 3)
        assert.match(output.text, /hello:x/)

        const prompt: string[] = []
        await emitOnMessage({
            sessionId: "s",
            mode: "chat",
            turn: 1,
            role: "user",
            phase: "before",
            content: "hi",
            prompt,
        })
        assert.deepEqual(prompt, ["sandbox-rule"])
    } finally {
        await shutdownAllSandboxPlugins()
    }
})

test("sandbox 插件缺少 hostApi 权限时拒绝 fs 调用并写 audit", { timeout: 20_000 }, async () => {
    const dataDir = join(root, "data-perm")
    const pluginDir = join(dataDir, "plugins", "sandbox-plugin")
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({
            name: "sandbox-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: { apiVersion: 1, sandbox: { profile: "plugin", hostApi: ["logger"] } },
        }),
    )
    await writeFile(join(pluginDir, "index.ts"), PLUGIN_SOURCE)

    const resolved = paths()
    configureHost({ paths: resolved })
    const client = new PluginSandboxClient({
        pluginId: "sandbox-plugin",
        pluginName: "Sandbox Plugin",
        pluginVersion: "1.0.0",
        pluginDir,
        pluginEntry: join(pluginDir, "index.ts"),
        paths: resolved,
        config: DEFAULT_SETTINGS,
        pluginConfig: {},
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: { hostApi: ["logger"], workspaceRead: false, workspaceWrite: false },
    })
    try {
        await client.start()
        await assert.rejects(client.runCommand("fs-roundtrip", [], pluginDir, false), /权限/)
        await flushSandboxAudit()
        const audits = await readFile(join(resolved.logDir, "sandbox-audit.log"), "utf8")
        assert.match(audits, /"type":"sandbox\.permission"/)
        assert.match(audits, /"decision":"denied"/)
    } finally {
        await client.close()
    }
})

test("sandbox 插件 Agent 工具经 bridge 调用", { timeout: 20_000 }, async () => {
    const dataDir = join(root, "data-agent-tool")
    const pluginDir = join(dataDir, "plugins", "agent-tool-plugin")
    await mkdir(pluginDir, { recursive: true })
    const source = [
        "export function setup() {",
        "    return {",
        '        id: "agent-tool-plugin",',
        '        name: "Agent Tool Plugin",',
        '        version: "1.0.0",',
        '        status: "ok",',
        "        agentTools: [{",
        '            name: "echo_tool",',
        '            introduction: { params: { text: "文本" }, content: "回显" },',
        "            call: (args) => ({ success: true, data: { text: args.text } }),",
        "        }],",
        "    }",
        "}",
    ].join("\n")
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({
            name: "agent-tool-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: { apiVersion: 1, sandbox: { profile: "plugin", hostApi: ["logger"] } },
        }),
    )
    await writeFile(join(pluginDir, "index.ts"), source)
    const resolved = paths()
    configureHost({ paths: resolved })
    const client = new PluginSandboxClient({
        pluginId: "agent-tool-plugin",
        pluginName: "Agent Tool Plugin",
        pluginVersion: "1.0.0",
        pluginDir,
        pluginEntry: join(pluginDir, "index.ts"),
        paths: resolved,
        config: DEFAULT_SETTINGS,
        pluginConfig: {},
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: { hostApi: ["logger"], workspaceRead: false, workspaceWrite: false },
    })
    try {
        const ready = await client.start()
        assert.equal(ready.agentTools[0]?.name, "echo_tool")
        const tool = client.agentToolStubs()[0]
        assert.ok(tool)
        const result = await tool.call({ text: "hello" })
        assert.deepEqual(result, { success: true, data: { text: "hello" } })
    } finally {
        await shutdownAllSandboxPlugins()
    }
})

test("sandbox 插件通过 bridge 调用 getSession / session.message", { timeout: 20_000 }, async () => {
    const dataDir = join(root, "data-session-bridge")
    const pluginDir = join(dataDir, "plugins", "session-bridge-plugin")
    await mkdir(pluginDir, { recursive: true })
    const source = [
        'import { getSession, onMessage } from "wellspring/api/host/index.ts"',
        "export function setup() {",
        "    return {",
        '        id: "session-bridge-plugin",',
        '        name: "Session Bridge",',
        '        version: "1.0.0",',
        '        status: "ok",',
        "        commands: [{",
        '            name: "session",',
        '            summary: "session",',
        "            run: async (ctx) => {",
        '                const session = await getSession("s-active")',
        '                if (session === null) { ctx.output.info("missing"); return 1 }',
        '                await session.message("from-sandbox")',
        '                ctx.output.info("sent")',
        "                return 0",
        "            },",
        "        }],",
        "    }",
        "}",
    ].join("\n")
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({
            name: "session-bridge-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: { apiVersion: 1, sandbox: { profile: "plugin", hostApi: ["logger"] } },
        }),
    )
    await writeFile(join(pluginDir, "index.ts"), source)
    const resolved = paths()
    configureHost({ paths: resolved })
    const store = new SessionStore(join(root, "bridge-sessions"))
    const data = await store.create({ cwd: root, model: "m", id: "s-active" })
    const session = new Session(data, store)
    registerSession(session)
    const seen: string[] = []
    const off = onMessage((event) => {
        seen.push(event.content)
    })
    const client = new PluginSandboxClient({
        pluginId: "session-bridge-plugin",
        pluginName: "Session Bridge",
        pluginVersion: "1.0.0",
        pluginDir,
        pluginEntry: join(pluginDir, "index.ts"),
        paths: resolved,
        config: DEFAULT_SETTINGS,
        pluginConfig: {},
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: { hostApi: ["logger"], workspaceRead: false, workspaceWrite: false },
    })
    try {
        await client.start()
        const exitCode = await client.runCommand("session", [], root, true)
        assert.equal(exitCode, 0)
        assert.deepEqual(seen, ["from-sandbox"])
    } finally {
        off()
        await shutdownAllSandboxPlugins()
    }
})

test("sandbox 插件通过 host http 提供 HTTP 服务", { timeout: 20_000 }, async () => {
    const dataDir = join(root, "data-http")
    const pluginDir = join(dataDir, "plugins", "http-plugin")
    await mkdir(pluginDir, { recursive: true })
    const source = [
        'import { onShutdown } from "wellspring/api/host/index.ts"',
        "let api",
        "let server",
        "export function setup() {",
        "    return {",
        '        id: "http-plugin",',
        '        name: "HTTP Plugin",',
        '        version: "1.0.0",',
        '        status: "ok",',
        "        init: (value) => { api = value },",
        "        commands: [{",
        '            name: "serve",',
        '            summary: "serve",',
        "            run: async (ctx) => {",
        '                server = await api.http.createServer({ host: "0.0.0.0", port: 0 }, (request) => ({',
        "                    status: 200,",
        '                    headers: { "content-type": "text/plain" },',
        '                    body: "hello " + request.url,',
        "                }))",
        '                ctx.output.print("PORT=" + server.port)',
        "                return 0",
        "            },",
        "        }],",
        "    }",
        "}",
        "onShutdown(async () => {",
        "    await server?.close()",
        "})",
    ].join("\n")
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({
            name: "http-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: {
                apiVersion: 1,
                sandbox: { profile: "plugin", hostApi: ["logger", "http"] },
            },
        }),
    )
    await writeFile(join(pluginDir, "index.ts"), source)
    const resolved = paths()
    configureHost({ paths: resolved })
    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const client = new PluginSandboxClient({
        pluginId: "http-plugin",
        pluginName: "HTTP Plugin",
        pluginVersion: "1.0.0",
        pluginDir,
        pluginEntry: join(pluginDir, "index.ts"),
        paths: resolved,
        config: DEFAULT_SETTINGS,
        pluginConfig: {},
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: { hostApi: ["logger", "http"], workspaceRead: false, workspaceWrite: false },
    })
    try {
        await client.start()
        const code = await client.runCommand("serve", [], root, true)
        assert.equal(code, 0)
        const match = /PORT=(\d+)/.exec(output.text)
        assert.ok(match)
        const response = await fetch(`http://127.0.0.1:${match[1]}/ping`)
        assert.equal(response.status, 200)
        assert.equal(await response.text(), "hello /ping")
    } finally {
        await shutdownAllSandboxPlugins()
    }
})

test("sandbox 插件通过 host http 提供 HTTPS 服务", { timeout: 20_000 }, async () => {
    const resolvedPaths = paths()
    const pluginDir = join(resolvedPaths.dataDir, "plugins", "https-plugin")
    const pluginData = join(resolvedPaths.dataDir, "plugin-data", "https-plugin")
    await mkdir(pluginDir, { recursive: true })
    await mkdir(pluginData, { recursive: true })
    const { execFileSync } = await import("node:child_process")
    execFileSync(
        "openssl",
        [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            join(pluginData, "key.pem"),
            "-out",
            join(pluginData, "cert.pem"),
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
        ],
        { stdio: "ignore" },
    )
    const source = [
        "let api",
        "let server",
        "export function setup() {",
        "    return {",
        '        id: "https-plugin",',
        '        name: "HTTPS Plugin",',
        '        version: "1.0.0",',
        '        status: "ok",',
        "        init: (value) => { api = value },",
        "        commands: [{",
        '            name: "serve",',
        '            summary: "serve",',
        "            run: async (ctx) => {",
        '                const cert = await api.fs.readText("cert.pem")',
        '                const key = await api.fs.readText("key.pem")',
        "                server = await api.http.createServer({ port: 0, tls: { cert, key } }, () => ({",
        "                    status: 200,",
        '                    body: "secure",',
        "                }))",
        '                ctx.output.print("PORT=" + server.port)',
        "                return 0",
        "            },",
        "        }],",
        "    }",
        "}",
    ].join("\n")
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({
            name: "https-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: {
                apiVersion: 1,
                sandbox: { profile: "plugin", hostApi: ["logger", "fs", "http"] },
            },
        }),
    )
    await writeFile(join(pluginDir, "index.ts"), source)
    const resolved = resolvedPaths
    configureHost({ paths: resolved })
    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const client = new PluginSandboxClient({
        pluginId: "https-plugin",
        pluginName: "HTTPS Plugin",
        pluginVersion: "1.0.0",
        pluginDir,
        pluginEntry: join(pluginDir, "index.ts"),
        paths: resolved,
        config: DEFAULT_SETTINGS,
        pluginConfig: {},
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: {
            hostApi: ["logger", "fs", "http"],
            workspaceRead: false,
            workspaceWrite: false,
        },
    })
    try {
        await client.start()
        const code = await client.runCommand("serve", [], root, true)
        assert.equal(code, 0)
        const match = /PORT=(\d+)/.exec(output.text)
        assert.ok(match)
        const { request } = await import("node:https")
        const body = await new Promise<string>((resolveBody, rejectBody) => {
            const req = request(
                `https://127.0.0.1:${match[1]}/`,
                { rejectUnauthorized: false },
                (res) => {
                    res.setEncoding("utf8")
                    let text = ""
                    res.on("data", (chunk: string) => {
                        text += chunk
                    })
                    res.on("end", () => resolveBody(text))
                },
            )
            req.on("error", rejectBody)
            req.end()
        })
        assert.equal(body, "secure")
    } finally {
        await shutdownAllSandboxPlugins()
    }
})

test("sandbox 插件通过 host http 提供 SSE", { timeout: 20_000 }, async () => {
    const resolved = paths()
    const pluginDir = join(resolved.dataDir, "plugins", "sse-plugin")
    await mkdir(pluginDir, { recursive: true })
    const source = [
        "let api",
        "let server",
        "export function setup() {",
        "    return {",
        '        id: "sse-plugin",',
        '        name: "SSE Plugin",',
        '        version: "1.0.0",',
        '        status: "ok",',
        "        init: (value) => { api = value },",
        "        commands: [{",
        '            name: "serve",',
        '            summary: "serve",',
        "            run: async (ctx) => {",
        "                server = await api.http.createServer({ port: 0 }, (request, stream) => {",
        "                    if (request.url === '/sse') {",
        "                        stream.write('data: one\\n\\n')",
        "                        setTimeout(() => {",
        "                            stream.write('data: two\\n\\n')",
        "                            stream.end()",
        "                        }, 100)",
        "                        return { status: 200, headers: { 'content-type': 'text/event-stream' }, stream: true }",
        "                    }",
        "                    return { status: 404, body: 'no' }",
        "                })",
        '                ctx.output.print("PORT=" + server.port)',
        "                return 0",
        "            },",
        "        }],",
        "    }",
        "}",
    ].join("\n")
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({
            name: "sse-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: {
                apiVersion: 1,
                sandbox: { profile: "plugin", hostApi: ["logger", "http"] },
            },
        }),
    )
    await writeFile(join(pluginDir, "index.ts"), source)
    configureHost({ paths: resolved })
    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const client = new PluginSandboxClient({
        pluginId: "sse-plugin",
        pluginName: "SSE Plugin",
        pluginVersion: "1.0.0",
        pluginDir,
        pluginEntry: join(pluginDir, "index.ts"),
        paths: resolved,
        config: DEFAULT_SETTINGS,
        pluginConfig: {},
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: { hostApi: ["logger", "http"], workspaceRead: false, workspaceWrite: false },
    })
    try {
        await client.start()
        assert.equal(await client.runCommand("serve", [], root, true), 0)
        const match = /PORT=(\d+)/.exec(output.text)
        assert.ok(match)
        const response = await fetch(`http://127.0.0.1:${match[1]}/sse`)
        const text = await response.text()
        assert.match(text, /data: one/)
        assert.match(text, /data: two/)
    } finally {
        await shutdownAllSandboxPlugins()
    }
})

test("sandbox 插件通过 host http 提供 WebSocket", { timeout: 20_000 }, async () => {
    const resolved = paths()
    const pluginDir = join(resolved.dataDir, "plugins", "ws-plugin")
    await mkdir(pluginDir, { recursive: true })
    const source = [
        "let api",
        "let server",
        "export function setup() {",
        "    return {",
        '        id: "ws-plugin",',
        '        name: "WS Plugin",',
        '        version: "1.0.0",',
        '        status: "ok",',
        "        init: (value) => { api = value },",
        "        commands: [{",
        '            name: "serve",',
        '            summary: "serve",',
        "            run: async (ctx) => {",
        "                server = await api.http.createServer({",
        "                    port: 0,",
        "                    websocket: (socket) => {",
        "                        socket.onMessage((data) => { void socket.send('echo:' + data) })",
        "                    },",
        "                }, () => ({ status: 404 }))",
        '                ctx.output.print("PORT=" + server.port)',
        "                return 0",
        "            },",
        "        }],",
        "    }",
        "}",
    ].join("\n")
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({
            name: "ws-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: {
                apiVersion: 1,
                sandbox: { profile: "plugin", hostApi: ["logger", "http"] },
            },
        }),
    )
    await writeFile(join(pluginDir, "index.ts"), source)
    configureHost({ paths: resolved })
    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const client = new PluginSandboxClient({
        pluginId: "ws-plugin",
        pluginName: "WS Plugin",
        pluginVersion: "1.0.0",
        pluginDir,
        pluginEntry: join(pluginDir, "index.ts"),
        paths: resolved,
        config: DEFAULT_SETTINGS,
        pluginConfig: {},
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: { hostApi: ["logger", "http"], workspaceRead: false, workspaceWrite: false },
    })
    const { WebSocket } = await import("ws")
    try {
        await client.start()
        assert.equal(await client.runCommand("serve", [], root, true), 0)
        const match = /PORT=(\d+)/.exec(output.text)
        assert.ok(match)
        const ws = new WebSocket(`ws://127.0.0.1:${match[1]}/`)
        const echoed = await new Promise<string>((resolveEcho, rejectEcho) => {
            ws.once("open", () => ws.send("ping"))
            ws.once("message", (data) => resolveEcho(data.toString()))
            ws.once("error", rejectEcho)
        })
        assert.equal(echoed, "echo:ping")
        ws.close()
    } finally {
        await shutdownAllSandboxPlugins()
    }
})

test("sandbox 插件通过 host agent 与 Agent 交互", { timeout: 20_000 }, async () => {
    const resolved = paths()
    const pluginDir = join(resolved.dataDir, "plugins", "agent-plugin")
    await mkdir(pluginDir, { recursive: true })
    const source = [
        "let api",
        "export function setup() {",
        "    return {",
        '        id: "agent-plugin",',
        '        name: "Agent Plugin",',
        '        version: "1.0.0",',
        '        status: "ok",',
        "        init: (value) => { api = value },",
        "        commands: [{",
        '            name: "chat",',
        '            summary: "chat",',
        "            run: async (ctx) => {",
        "                const result = await api.agent.chat({ message: ctx.argv.join(' ') })",
        "                ctx.output.print(result.reply)",
        "                return 0",
        "            },",
        "        }],",
        "    }",
        "}",
    ].join("\n")
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({
            name: "agent-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: {
                apiVersion: 1,
                sandbox: { profile: "plugin", hostApi: ["logger", "agent"] },
            },
        }),
    )
    await writeFile(join(pluginDir, "index.ts"), source)
    configureHost({ paths: resolved })
    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const client = new PluginSandboxClient({
        pluginId: "agent-plugin",
        pluginName: "Agent Plugin",
        pluginVersion: "1.0.0",
        pluginDir,
        pluginEntry: join(pluginDir, "index.ts"),
        paths: resolved,
        config: DEFAULT_SETTINGS,
        pluginConfig: {},
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: { hostApi: ["logger", "agent"], workspaceRead: false, workspaceWrite: false },
        agent: {
            async chat(input) {
                return {
                    sessionId: "session-1",
                    reply: `agent:${input.message}`,
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
        assert.equal(await client.runCommand("chat", ["hello"], root, true), 0)
        assert.match(output.text, /agent:hello/)
    } finally {
        await shutdownAllSandboxPlugins()
    }
})
