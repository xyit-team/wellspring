/*
 * wellspring-http 插件端到端测试：
 * 用测试消费者插件（test-fixtures/http-consumer）注册服务器，验证 HTTP / HTTPS 转发、
 * 流式响应、错误、体积上限、超时、重名、端口占用、WebSocket 与关闭清理。
 */

import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"
import { WebSocket as WsClient } from "ws"

import { configureHost } from "../src/api/host/host.ts"
import { emitShutdownHooks } from "../src/api/host/hooks.ts"
import {
    HTTP_BUS_SERVERS,
    type HttpBusReadyEvent,
    type HttpBusServersEvent,
} from "../src/api/plugin/http-protocol.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { EventEntity } from "../src/event/event.ts"
import { eventBus } from "../src/event/event.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import { loadPlugins } from "../src/plugin/loader.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { PluginSandboxClient, shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"
import {
    startHttpHostPlugin,
    watchHttpServer,
    type HttpServerWatcher,
} from "./helpers/http-host.ts"

const projectRoot = join(import.meta.dirname, "..")
let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-http-test-"))
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

function quietOutput(): ElogStream & { text: string } {
    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    return output
}

function createConsumer(
    pathsValue: ResolvedPaths,
    pluginConfig: Record<string, unknown>,
): PluginSandboxClient {
    return new PluginSandboxClient({
        pluginId: "http-consumer",
        pluginName: "HTTP Consumer Fixture",
        pluginVersion: "1.0.0",
        pluginDir: join(projectRoot, "test-fixtures", "http-consumer"),
        pluginEntry: join(projectRoot, "test-fixtures", "http-consumer", "index.ts"),
        paths: pathsValue,
        config: DEFAULT_SETTINGS,
        pluginConfig,
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: {
            hostApi: ["logger", "fs", "event"],
            workspaceRead: false,
            workspaceWrite: false,
        },
    })
}

function startConsumer(
    pathsValue: ResolvedPaths,
    pluginConfig: Record<string, unknown>,
): Promise<PluginSandboxClient> {
    const client = createConsumer(pathsValue, pluginConfig)
    return client.start().then(() => client)
}

async function closeQuietly(client: PluginSandboxClient | null): Promise<void> {
    if (client === null) {
        return
    }
    await client.close().catch(() => undefined)
}

test("wellspring-http：注册服务器、转发请求/响应/流式响应", { timeout: 30_000 }, async () => {
    const resolved = paths()
    configureHost({ paths: resolved })
    const output = quietOutput()
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const host = await startHttpHostPlugin(resolved)
    const watcher: HttpServerWatcher = watchHttpServer("fixture-http")
    const serverList: HttpBusServersEvent[] = []
    const offServers = eventBus.subscribe<HttpBusServersEvent>(HTTP_BUS_SERVERS, (event) => {
        serverList.push(event.getData())
    })
    let consumer: PluginSandboxClient | null = null
    try {
        consumer = await startConsumer(resolved, { name: "fixture-http", port: 0 })
        const ready: HttpBusReadyEvent = await watcher.ready
        assert.equal(ready.type, "ready")
        assert.equal(ready.secure, false)
        assert.ok(ready.port > 0, "应返回真实端口")
        const base = `http://${ready.host}:${ready.port}`

        const hello = await fetch(`${base}/hello`)
        assert.equal(hello.status, 200)
        assert.deepEqual(await hello.json(), { hello: true })

        const info = (await (
            await fetch(`${base}/info?x=1`, { headers: { "x-test": "v1" } })
        ).json()) as {
            method: string
            url: string
            headers: Record<string, string>
            remoteAddress: string | null
            bodyBytes: number
        }
        assert.equal(info.method, "GET")
        assert.equal(info.url, "/info?x=1")
        assert.equal(info.headers["x-test"], "v1")
        assert.ok(info.remoteAddress !== null && info.remoteAddress !== "")

        // 请求体用 base64 原样转发，响应体再原样带回
        const payload = Buffer.from("中文与 binary \u0000\u0001 数据", "utf8")
        const echo = await fetch(`${base}/echo`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: payload,
        })
        assert.equal(echo.status, 201)
        assert.equal(echo.headers.get("content-type"), "application/octet-stream")
        assert.deepEqual(Buffer.from(await echo.arrayBuffer()), payload)

        // 返回 response 之前写的分片要缓冲到响应头之后
        assert.equal(
            await (await fetch(`${base}/stream?count=3`)).text(),
            "chunk-0;chunk-1;chunk-2;",
        )
        assert.equal(
            await (await fetch(`${base}/stream-async?count=4`)).text(),
            "chunk-0;chunk-1;chunk-2;chunk-3;",
        )
        assert.equal(await (await fetch(`${base}/stream-pre`)).text(), "pre-0;pre-1;")
        assert.equal(await (await fetch(`${base}/delay?ms=30`)).text(), "delayed:30")

        const failure = await fetch(`${base}/error`)
        assert.equal(failure.status, 500)
        assert.match(await failure.text(), /fixture boom/)

        // 响应体超过事件转发上限：转成 502，不让超大帧进事件总线
        const bigResponse = await fetch(`${base}/big?size=${3 * 1024 * 1024}`)
        assert.equal(bigResponse.status, 502)
        assert.match(await bigResponse.text(), /响应体超过/)

        // 请求体超过事件转发上限：wellspring-http 直接 413
        const bigRequest = await fetch(`${base}/big-request`, {
            method: "POST",
            body: Buffer.alloc(2_700_000, 0x61),
        })
        assert.equal(bigRequest.status, 413)
        assert.match(await bigRequest.text(), /请求体超过/)

        // 服务器列表事件：消费者注册后广播当前端口
        const latest = serverList[serverList.length - 1]
        assert.ok(latest !== undefined)
        assert.ok(
            latest.servers.some(
                (server) => server.name === "fixture-http" && server.port === ready.port,
            ),
            JSON.stringify(latest),
        )

        // 关掉消费者：端口应释放
        await consumer.close()
        consumer = null
        await new Promise((resolve) => setTimeout(resolve, 100))
        await assert.rejects(fetch(`${base}/hello`))
    } finally {
        offServers()
        watcher.dispose()
        await closeQuietly(consumer)
        await host.close()
    }
})

test("wellspring-http：端口被占用时向注册方报错", { timeout: 20_000 }, async () => {
    const resolved = paths()
    configureHost({ paths: resolved })
    const output = quietOutput()
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const occupied = createServer((_request, response) => response.end("x"))
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve))
    const address = occupied.address()
    assert.ok(address !== null && typeof address === "object")
    const occupiedPort = address.port
    const host = await startHttpHostPlugin(resolved)
    let consumer: PluginSandboxClient | null = null
    try {
        await assert.rejects(
            startConsumer(resolved, { name: "busy-http", port: occupiedPort }),
            (error: unknown) => {
                const message = error instanceof Error ? error.message : String(error)
                assert.match(message, /port-in-use/)
                return true
            },
        )
    } finally {
        await closeQuietly(consumer)
        await host.close()
        await new Promise<void>((resolve) => occupied.close(() => resolve()))
    }
})

test("wellspring-http：重名注册被拒绝", { timeout: 20_000 }, async () => {
    const resolved = paths()
    configureHost({ paths: resolved })
    const output = quietOutput()
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const host = await startHttpHostPlugin(resolved)
    const firstWatcher = watchHttpServer("dup-http")
    let first: PluginSandboxClient | null = null
    let second: PluginSandboxClient | null = null
    try {
        first = await startConsumer(resolved, { name: "dup-http", port: 0 })
        const ready = await firstWatcher.ready
        await assert.rejects(
            startConsumer(resolved, { name: "dup-http", port: 0 }),
            (error: unknown) => {
                const message = error instanceof Error ? error.message : String(error)
                assert.match(message, /duplicate-name/)
                return true
            },
        )
        const hello = await fetch(`http://${ready.host}:${ready.port}/hello`)
        assert.equal(hello.status, 200, "第一个服务器不受影响")
    } finally {
        firstWatcher.dispose()
        await closeQuietly(first)
        await closeQuietly(second)
        await host.close()
    }
})

test("wellspring-http：请求超时返回 504", { timeout: 20_000 }, async () => {
    const resolved = paths()
    configureHost({ paths: resolved })
    const output = quietOutput()
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const host = await startHttpHostPlugin(resolved)
    const watcher = watchHttpServer("timeout-http")
    let consumer: PluginSandboxClient | null = null
    try {
        consumer = await startConsumer(resolved, {
            name: "timeout-http",
            port: 0,
            requestTimeoutMs: 200,
        })
        const ready = await watcher.ready
        const started = Date.now()
        const response = await fetch(`http://${ready.host}:${ready.port}/hang`)
        const elapsed = Date.now() - started
        assert.equal(response.status, 504)
        assert.match(await response.text(), /超时/)
        assert.ok(elapsed < 5_000, `超时时间过长：${elapsed}ms`)
    } finally {
        watcher.dispose()
        await closeQuietly(consumer)
        await host.close()
    }
})

test("wellspring-http：WebSocket 升级与消息转发", { timeout: 20_000 }, async () => {
    const resolved = paths()
    configureHost({ paths: resolved })
    const output = quietOutput()
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const host = await startHttpHostPlugin(resolved)
    const watcher = watchHttpServer("ws-http")
    let consumer: PluginSandboxClient | null = null
    let socket: WsClient | null = null
    try {
        consumer = await startConsumer(resolved, { name: "ws-http", port: 0, websocket: true })
        const ready = await watcher.ready
        socket = new WsClient(`ws://${ready.host}:${ready.port}/socket`)
        const messages: string[] = []
        let closedCode = 0
        await new Promise<void>((resolve, reject) => {
            socket?.once("open", resolve)
            socket?.once("error", reject)
        })
        socket.on("message", (data) => messages.push(String(data)))
        socket.send("ping")
        await new Promise((resolve) => setTimeout(resolve, 200))
        assert.deepEqual(messages, ["echo:ping"])
        const closed = new Promise<number>((resolve) => {
            socket?.once("close", (code) => {
                closedCode = code
                resolve(code)
            })
        })
        socket.send("close")
        const code = await closed
        assert.equal(code, 1000)
        assert.equal(closedCode, 1000)
    } finally {
        socket?.terminate()
        watcher.dispose()
        await closeQuietly(consumer)
        await host.close()
    }
})

test("wellspring-http：等不到 wellspring-http 时注册超时报错", { timeout: 20_000 }, async () => {
    const resolved = paths()
    configureHost({ paths: resolved })
    const output = quietOutput()
    initElog({ stdout: output, stderr: output, color: false, json: false })
    let consumer: PluginSandboxClient | null = null
    try {
        await assert.rejects(
            startConsumer(resolved, {
                name: "orphan-http",
                port: 0,
                registerTimeoutMs: 400,
            }),
            (error: unknown) => {
                const message = error instanceof Error ? error.message : String(error)
                assert.match(message, /注册超时/)
                return true
            },
        )
    } finally {
        await closeQuietly(consumer)
    }
})

test("loader：按 deps 先加载 wellspring-http，再加载消费者", { timeout: 30_000 }, async () => {
    const resolved = paths()
    configureHost({ paths: resolved })
    const pluginRoot = join(resolved.dataDir, "plugins")
    await mkdir(pluginRoot, { recursive: true })
    await cp(join(projectRoot, "plugins", "wellspring-http"), join(pluginRoot, "wellspring-http"), {
        recursive: true,
    })
    await cp(
        join(projectRoot, "test-fixtures", "http-consumer"),
        join(pluginRoot, "http-consumer"),
        { recursive: true },
    )
    const output = quietOutput()
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const sandbox = { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" as const }
    const plugins = await loadPlugins({
        paths: resolved,
        config: { ...DEFAULT_SETTINGS, sandbox },
        logger: pino({ level: "silent" }),
        registry: new PluginRegistry(),
        sandbox,
        sandboxBackend: new DirectBackend(),
    })
    try {
        const ids = plugins.map((plugin) => plugin.id)
        assert.ok(ids.includes("wellspring-http"), JSON.stringify(plugins))
        assert.ok(ids.includes("http-consumer"), JSON.stringify(plugins))
        const consumer = plugins.find((plugin) => plugin.id === "http-consumer")
        assert.equal(consumer?.status, "ok", JSON.stringify(plugins))
        const match = /http-consumer listening on ([^:\s]+):(\d+)/.exec(output.text)
        assert.ok(match, output.text)
        const response = await fetch(`http://${match[1]}:${match[2]}/hello`)
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { hello: true })
    } finally {
        await emitShutdownHooks()
        await shutdownAllSandboxPlugins()
    }
})

test("loader：缺少 wellspring-http 时消费者加载失败", { timeout: 30_000 }, async () => {
    const base = join(root, "missing-dep")
    const resolved: ResolvedPaths = {
        configDir: join(base, "config"),
        dataDir: join(base, "data"),
        cacheDir: join(base, "cache"),
        logDir: join(base, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
    configureHost({ paths: resolved })
    const pluginRoot = join(resolved.dataDir, "plugins")
    await mkdir(pluginRoot, { recursive: true })
    await cp(
        join(projectRoot, "test-fixtures", "http-consumer"),
        join(pluginRoot, "http-consumer"),
        { recursive: true },
    )
    const output = quietOutput()
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const sandbox = { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" as const }
    const plugins = await loadPlugins({
        paths: resolved,
        config: { ...DEFAULT_SETTINGS, sandbox },
        logger: pino({ level: "silent" }),
        registry: new PluginRegistry(),
        sandbox,
        sandboxBackend: new DirectBackend(),
    })
    try {
        const consumer = plugins.find((plugin) => plugin.id === "http-consumer")
        assert.equal(consumer?.status, "failed")
        assert.match(consumer?.error ?? "", /依赖不存在：wellspring-http/)
    } finally {
        await emitShutdownHooks()
        await shutdownAllSandboxPlugins()
    }
})

test("只有 wellspring-http 持有 hostApi.http，其它 HTTP 插件依赖它", async () => {
    const hostPackage = JSON.parse(
        await readFile(join(projectRoot, "plugins", "wellspring-http", "package.json"), "utf8"),
    ) as { wellspring: { sandbox: { hostApi: string[] } } }
    assert.ok(hostPackage.wellspring.sandbox.hostApi.includes("http"))

    for (const pluginId of ["wellspring-web", "wellspring-code"]) {
        const manifest = JSON.parse(
            await readFile(join(projectRoot, "plugins", pluginId, "package.json"), "utf8"),
        ) as { wellspring: { sandbox: { hostApi: string[] } } }
        assert.ok(
            !manifest.wellspring.sandbox.hostApi.includes("http"),
            `${pluginId} 不应再直接持有 hostApi.http`,
        )
        const entry = await readFile(join(projectRoot, "plugins", pluginId, "index.ts"), "utf8")
        assert.match(
            entry,
            /deps:[^[]*\[[^\]]*"wellspring-http"/,
            `${pluginId} 应依赖 wellspring-http`,
        )
    }

    const webManifest = JSON.parse(
        await readFile(join(projectRoot, "plugins", "wellspring-web", "package.json"), "utf8"),
    ) as { wellspring: { sandbox: { hostApi: string[] } } }
    assert.ok(
        webManifest.wellspring.sandbox.hostApi.includes("workspaces"),
        "wellspring-web 仍使用宿主工作区注册表",
    )

    const codeManifest = JSON.parse(
        await readFile(join(projectRoot, "plugins", "wellspring-code", "package.json"), "utf8"),
    ) as { wellspring: { sandbox: { hostApi: string[] } } }
    assert.ok(
        codeManifest.wellspring.sandbox.hostApi.includes("fileRoots"),
        "wellspring-code 通过 fileRoots 打开任意工作区目录",
    )
    assert.ok(
        !codeManifest.wellspring.sandbox.hostApi.includes("workspaces"),
        "wellspring-code 不应再依赖宿主工作区注册表",
    )
    // code 插件不再依赖 web：工作区注册表已经内嵌到宿主
    const codeEntry = await readFile(
        join(projectRoot, "plugins", "wellspring-code", "index.ts"),
        "utf8",
    )
    const codeDeps = /deps:\s*\[([^\]]*)\]/.exec(codeEntry)
    assert.ok(codeDeps !== null, codeEntry)
    assert.doesNotMatch(
        codeDeps[1] ?? "",
        /"wellspring-web"/,
        "wellspring-code 不应再依赖 wellspring-web",
    )
})
