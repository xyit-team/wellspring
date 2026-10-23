/*
 * 宿主侧 sandbox 插件客户端：启动 child、握手、命令/钩子 RPC、host API 代理。
 */

import { spawn, type ChildProcess } from "node:child_process"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { WebSocketServer, type WebSocket } from "ws"
import { randomUUID } from "node:crypto"
import { cp, mkdir, rm } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"

import type { Logger } from "pino"

import type { AppSetting } from "../config/types.ts"
import { eventBus, EventEntity } from "../event/event.ts"
import { getElog } from "../logger/elog4js.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import { createPluginFileApi } from "../plugin/fs.ts"
import type { PluginDataService } from "../plugin/data-access.ts"
import type { HostCapabilities } from "../plugin/capabilities.ts"
import { getAgentToolContext, type AgentToolContext } from "../agent/tool-context.ts"
import { ensurePluginDataDir } from "../plugin/runtime.ts"
import { auditSandbox } from "./audit.ts"
import { getHost } from "../api/host/host.ts"
import { getSession as findSession } from "../session/registry.ts"
import { registerExternalHook, shutdown as shutdownHost } from "../api/host/hooks.ts"
import type {
    AgentCallToolResult,
    AgentTool,
    AgentToolIntroduction,
    PluginCommand,
    PluginConfig,
} from "../api/host/plugin.ts"
import type { HostFileApi, HostFileEntry, HostFileStat } from "../api/host/fs.ts"
import type { HttpRequest, HttpResponse } from "../api/host/http.ts"
import type { HostAgentChatInput } from "../api/host/agent.ts"
import type { HostAgentService } from "../plugin/agent-service.ts"
import { HTTP_MAX_BODY_BYTES } from "../api/host/http.ts"
import {
    FrameDecoder,
    encodeMessage,
    nextRequestId,
    type RpcMessage,
    type RpcRequest,
    type RpcResponse,
} from "./protocol.ts"
import type { PluginLaunchInput, SandboxBackend, SandboxLimits } from "./types.ts"

const HOOK_KIND_BY_API: Readonly<Record<string, string>> = {
    onMessage: "message",
    beforeTurn: "beforeTurn",
    beforeStep: "beforeStep",
    afterStep: "afterStep",
    afterTurn: "afterTurn",
    onAgentRunSync: "agentRunSync",
    onAgentRunAsync: "agentRunAsync",
    onAgentAsyncTaskComplete: "agentAsyncTaskComplete",
    onAgentCallTool: "agentCallTool",
    onAgentAsk: "agentAsk",
    onAgentRead: "agentRead",
    onAgentQueryTask: "agentQueryTask",
    onAgentSubmit: "agentSubmit",
    onAgentSetTasks: "agentSetTasks",
    onAgentSetGoal: "agentSetGoal",
    onAgentRequestPermission: "agentRequestPermission",
    onUserAnswer: "userAnswer",
    onInit: "init",
    onShutdown: "shutdown",
}

const activeClients = new Set<PluginSandboxClient>()

export async function shutdownAllSandboxPlugins(): Promise<void> {
    const clients = [...activeClients]
    activeClients.clear()
    await Promise.all(clients.map(async (client) => await client.close().catch(() => undefined)))
}

const PROJECT_ROOT = resolve(import.meta.dirname, "../..")
const RUNNER_PATH = join(PROJECT_ROOT, "src", "sandbox", "plugin-host.ts")

export interface SandboxPluginMetadata {
    readonly id: string
    readonly name: string
    readonly version: string
    readonly status: "ok" | "failed"
    readonly deps: readonly string[]
}

export interface SandboxPluginCommandMeta {
    readonly name: string
    readonly summary: string
    readonly usage?: string
    readonly aliases?: readonly string[]
}

export interface SandboxAgentToolMeta {
    readonly name: string
    readonly introduction: AgentToolIntroduction
}

export interface SandboxPluginReady {
    readonly plugin: SandboxPluginMetadata
    readonly commands: readonly SandboxPluginCommandMeta[]
    readonly agentTools: readonly SandboxAgentToolMeta[]
    readonly hooks: readonly string[]
}

export interface PluginSandboxPermissions {
    readonly hostApi: readonly string[]
    readonly workspaceRead: boolean
    readonly workspaceWrite: boolean
}

export interface PluginSandboxClientOptions {
    readonly pluginId: string
    readonly pluginName: string
    readonly pluginVersion: string
    readonly pluginDir: string
    readonly pluginEntry: string
    readonly paths: ResolvedPaths
    readonly config: AppSetting
    readonly pluginConfig: PluginConfig
    readonly backend: SandboxBackend
    readonly limits: SandboxLimits
    readonly logger: Logger
    readonly permissions: PluginSandboxPermissions
    readonly dataAccess?: PluginDataService
    readonly capabilities?: HostCapabilities
    readonly agent?: HostAgentService
}

export class PluginSandboxError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "PluginSandboxError"
    }
}

interface PendingRequest {
    readonly resolve: (value: unknown) => void
    readonly reject: (error: Error) => void
    readonly timer: NodeJS.Timeout
}

function hostSnapshotData(): unknown {
    const host = getHost()
    return {
        status: host.getStatus(),
        os: host.getOS(),
        paths: host.getPaths(),
        plugins: host.getPlugins().map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            deps: plugin.deps,
            commands: plugin.commands,
            status: plugin.getStatus(),
        })),
    }
}

export class PluginSandboxClient {
    readonly #options: PluginSandboxClientOptions
    readonly #sandboxId = randomUUID()
    readonly #pending = new Map<string, PendingRequest>()
    readonly #decoder = new FrameDecoder()
    readonly #eventUnsubscribes = new Map<string, () => void>()
    readonly #hookUnsubscribes: Array<() => void> = []
    #activeContext: AgentToolContext | null = null
    readonly #httpServers = new Map<
        string,
        {
            readonly server: HttpServer
            readonly host: string
            readonly port: number
            readonly wsServer: WebSocketServer | null
        }
    >()
    readonly #httpResponses = new Map<
        string,
        { readonly response: import("node:http").ServerResponse }
    >()
    readonly #wsConnections = new Map<string, WebSocket>()
    #child: ChildProcess | null = null
    #ready: SandboxPluginReady | null = null
    #closed = false
    #pluginDataDir: string
    #sandboxDir: string
    #hostSdkDir: string

    constructor(options: PluginSandboxClientOptions) {
        this.#options = options
        this.#pluginDataDir = ""
        this.#sandboxDir = join(options.paths.dataDir, "sandbox", this.#sandboxId)
        this.#hostSdkDir = join(this.#sandboxDir, "host")
        activeClients.add(this)
    }

    get sandboxId(): string {
        return this.#sandboxId
    }

    get ready(): SandboxPluginReady | null {
        return this.#ready
    }

    get pluginDataDir(): string {
        return this.#pluginDataDir
    }

    /** sandbox 插件声明的 Agent 工具，call 走 RPC */
    agentToolStubs(): readonly AgentTool[] {
        const tools = this.#ready?.agentTools ?? []
        return tools.map((meta) => ({
            name: meta.name,
            introduction: {
                params: { ...meta.introduction.params },
                content: meta.introduction.content,
            },
            call: async (...args: unknown[]): Promise<AgentCallToolResult> => {
                const input = args.length === 1 ? args[0] : args
                const previous = this.#activeContext
                this.#activeContext = getAgentToolContext()
                try {
                    return (await this.#request("plugin.agentTool", {
                        name: meta.name,
                        args: input,
                    })) as AgentCallToolResult
                } finally {
                    this.#activeContext = previous
                }
            },
        }))
    }

    async start(options: { readonly deferInit?: boolean } = {}): Promise<SandboxPluginReady> {
        this.#pluginDataDir = await ensurePluginDataDir(this.#options.pluginId, this.#options.paths)
        await mkdir(this.#sandboxDir, { recursive: true })

        const isBwrap = this.#options.backend.name === "bwrap"
        if (isBwrap) {
            await this.#prepareHostSdk()
        }

        const pluginEntryRel = relative(this.#options.pluginDir, this.#options.pluginEntry)
        const env: Record<string, string> = {
            PATH: "/usr/bin:/bin",
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            TERM: "dumb",
            HOME: "/tmp",
            TMPDIR: "/tmp",
        }
        const input: PluginLaunchInput = {
            pluginDir: this.#options.pluginDir,
            pluginEntryRel,
            pluginDataDir: this.#pluginDataDir,
            hostSdkDir: this.#hostSdkDir,
            runnerPath: RUNNER_PATH,
            env,
            limits: this.#options.limits,
        }
        const spec = this.#options.backend.buildPluginLaunch(input)
        const child = spawn(spec.command, [...spec.args], {
            cwd: spec.cwd,
            env: { ...spec.env },
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
        })
        this.#child = child

        let stderrBuffer = ""
        child.stderr?.on("data", (chunk: Buffer) => {
            stderrBuffer += chunk.toString("utf8")
            if (stderrBuffer.length > 64 * 1024) {
                stderrBuffer = stderrBuffer.slice(-64 * 1024)
            }
        })
        child.stdout?.on("data", (chunk: Buffer) => {
            let messages: RpcMessage[]
            try {
                messages = this.#decoder.push(chunk)
            } catch (error) {
                this.#failAll(error instanceof Error ? error : new Error(String(error)))
                this.#kill()
                return
            }
            for (const message of messages) {
                void this.#handleMessage(message)
            }
        })
        child.once("exit", (code, signal) => {
            if (!this.#closed) {
                this.#failAll(
                    new PluginSandboxError(
                        `插件 sandbox 退出（code=${String(code)}, signal=${String(signal)}）：${stderrBuffer.trim()}`,
                    ),
                )
            }
            this.#closed = true
        })
        child.once("error", (error) => {
            this.#failAll(
                new PluginSandboxError(
                    `插件 sandbox 启动失败：${error instanceof Error ? error.message : String(error)}`,
                ),
            )
            this.#closed = true
        })

        const configureResult = (await this.#request("sandbox.configure", {
            pluginId: this.#options.pluginId,
            pluginName: this.#options.pluginName,
            pluginVersion: this.#options.pluginVersion,
            pluginEntry: isBwrap
                ? `/plugin/${pluginEntryRel.split("\\").join("/")}`
                : resolve(this.#options.pluginEntry),
            pluginDataDir: isBwrap ? "/plugin-data" : this.#pluginDataDir,
            pluginConfig: this.#options.pluginConfig,
            paths: this.#options.paths,
            config: this.#options.config,
            host: this.#hasHostApi("getHost") ? hostSnapshotData() : null,
            deferInit: options.deferInit === true,
        })) as SandboxPluginReady

        this.#ready = configureResult
        if (options.deferInit !== true) {
            this.#registerRemoteHooks(configureResult.hooks)
        }
        auditSandbox(this.#options.paths, {
            type: "sandbox.plugin.start",
            sandboxId: this.#sandboxId,
            pluginId: this.#options.pluginId,
            backend: this.#options.backend.name,
            decision: "allowed",
            permissions: this.#options.permissions.hostApi,
        })
        return configureResult
    }

    async initialize(): Promise<SandboxPluginReady> {
        const result = (await this.#request("plugin.init", {})) as SandboxPluginReady
        this.#ready = result
        this.#registerRemoteHooks(result.hooks)
        return result
    }

    async #request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
        if (this.#closed || this.#child === null) {
            throw new PluginSandboxError("插件 sandbox 已关闭")
        }
        const id = nextRequestId("host")
        return await new Promise<unknown>((resolveRequest, rejectRequest) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id)
                rejectRequest(new PluginSandboxError(`插件 RPC 超时：${method}`))
            }, timeoutMs)
            timer.unref()
            this.#pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer)
                    resolveRequest(value)
                },
                reject: (error) => {
                    clearTimeout(timer)
                    rejectRequest(error)
                },
                timer,
            })
            this.#send({ v: 1, type: "request", id, method, params, timeoutMs })
        })
    }

    #notify(method: string, params: unknown): void {
        if (this.#closed || this.#child === null) {
            return
        }
        this.#send({ v: 1, type: "event", method, params })
    }

    #send(message: RpcMessage): void {
        if (this.#child?.stdin === null || this.#child?.stdin === undefined) {
            return
        }
        try {
            this.#child.stdin.write(encodeMessage(message))
        } catch {
            // child 已退出；pending 会由 exit 处理
        }
    }

    #respond(response: RpcResponse): void {
        this.#send(response)
    }

    async #handleMessage(message: RpcMessage): Promise<void> {
        if (message.type === "response") {
            const pending = this.#pending.get(message.id)
            if (pending === undefined) {
                return
            }
            this.#pending.delete(message.id)
            if (message.ok) {
                pending.resolve(message.result)
            } else {
                pending.reject(new PluginSandboxError(message.error?.message ?? "插件 RPC 失败"))
            }
            return
        }
        if (message.type === "event") {
            this.#handleEvent(message.method, message.params)
            return
        }
        await this.#handleRequest(message)
    }

    #handleEvent(method: string, params: unknown): void {
        const data = (params ?? {}) as Record<string, unknown>
        if (method === "host.http.stream") {
            const requestId = String(data["requestId"] ?? "")
            const pending = this.#httpResponses.get(requestId)
            if (pending !== undefined) {
                if (data["end"] === true) {
                    this.#httpResponses.delete(requestId)
                    pending.response.end()
                } else {
                    pending.response.write(String(data["chunk"] ?? ""))
                }
            }
            return
        }
        const pluginLogger = this.#options.logger.child({ plugin: this.#options.pluginId })
        if (method === "host.log") {
            const level = String(data["level"] ?? "info") as "info" | "warn" | "error"
            const fields = (data["fields"] as Record<string, unknown> | undefined) ?? {}
            const message = String(data["message"] ?? "")
            pluginLogger[level]?.(fields, message)
            return
        }
        if (method === "host.console") {
            const level = String(data["level"] ?? "info") as "info" | "warn" | "error"
            const args = Array.isArray(data["args"]) ? data["args"].map(String) : []
            pluginLogger.error(`插件 [${this.#options.pluginId}] 使用了不推荐的 console logger ！`)
            pluginLogger[level]?.(`${this.#options.pluginId} ${args.join(" ")}`)
            return
        }
        if (method === "host.output") {
            const kind = String(data["kind"] ?? "info") as "info" | "warn" | "error" | "print"
            const text = String(data["text"] ?? "")
            getElog().plugin(kind === "print" ? "info" : kind, this.#options.pluginId, text)
            return
        }
        if (method === "host.event.publish") {
            if (!this.#hasHostApi("event")) {
                pluginLogger.warn("sandbox 插件没有 event 权限，已拒绝发布事件")
                return
            }
            const name = String(data["name"] ?? "")
            try {
                eventBus.publish(name, EventEntity.create(data["data"]))
            } catch (error) {
                pluginLogger.warn(
                    { error: error instanceof Error ? error.message : String(error) },
                    "sandbox 插件发布事件失败",
                )
            }
            return
        }
        if (method === "host.event.unsubscribe") {
            const name = String(data["name"] ?? "")
            const unsubscribe = this.#eventUnsubscribes.get(name)
            unsubscribe?.()
            this.#eventUnsubscribes.delete(name)
        }
    }

    #hasHostApi(name: string): boolean {
        return this.#options.permissions.hostApi.includes(name)
    }

    #requireHostApi(name: string): void {
        if (!this.#hasHostApi(name)) {
            throw new PluginSandboxError(`插件没有 hostApi.${name} 权限`)
        }
    }

    async #handleRequest(request: RpcRequest): Promise<void> {
        try {
            const params = (request.params ?? {}) as Record<string, unknown>
            let result: unknown
            if (request.method === "host.agent.chat") {
                this.#requireHostApi("agent")
                if (this.#options.agent === undefined) {
                    throw new PluginSandboxError("宿主没有 Agent 服务")
                }
                result = await this.#options.agent.chat(params as unknown as HostAgentChatInput)
            } else if (request.method === "host.http.createServer") {
                this.#requireHostApi("http")
                const serverId = String(params["serverId"] ?? "")
                const host = String(params["host"] ?? "127.0.0.1")
                const port = typeof params["port"] === "number" ? params["port"] : 0
                if (host.trim() === "" || /\s/.test(host)) {
                    throw new PluginSandboxError(`非法监听地址：${host}`)
                }
                if (!Number.isInteger(port) || port < 0 || port > 65_535) {
                    throw new PluginSandboxError(`非法端口：${String(port)}`)
                }
                const tls = params["tls"] as
                    | { cert?: unknown; key?: unknown; ca?: unknown }
                    | undefined
                if (
                    tls !== undefined &&
                    (typeof tls.cert !== "string" ||
                        typeof tls.key !== "string" ||
                        tls.cert.trim() === "" ||
                        tls.key.trim() === "")
                ) {
                    throw new PluginSandboxError("TLS 需要 cert 与 key PEM")
                }
                const requestListener = async (
                    req: import("node:http").IncomingMessage,
                    res: import("node:http").ServerResponse,
                ): Promise<void> => {
                    try {
                        const chunks: Buffer[] = []
                        let size = 0
                        for await (const chunk of req) {
                            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                            size += buffer.length
                            if (size > HTTP_MAX_BODY_BYTES) {
                                throw new Error("HTTP 请求体超过上限")
                            }
                            chunks.push(buffer)
                        }
                        const httpRequest: HttpRequest = {
                            method: req.method ?? "GET",
                            url: req.url ?? "/",
                            headers: Object.fromEntries(
                                Object.entries(req.headers).map(([key, value]) => [
                                    key,
                                    Array.isArray(value) ? value.join(", ") : (value ?? ""),
                                ]),
                            ),
                            body: Buffer.concat(chunks).toString("base64"),
                            remoteAddress: req.socket.remoteAddress ?? null,
                        }
                        const requestId = nextRequestId("http-req")
                        this.#httpResponses.set(requestId, { response: res })
                        res.on("close", () => this.#httpResponses.delete(requestId))
                        const response = (await this.#request(
                            "plugin.http",
                            { serverId, requestId, request: httpRequest },
                            180_000,
                        )) as HttpResponse
                        res.statusCode = response.status ?? 200
                        for (const [key, value] of Object.entries(response.headers ?? {})) {
                            res.setHeader(key, value)
                        }
                        if (response.stream === true) {
                            return
                        }
                        this.#httpResponses.delete(requestId)
                        const body =
                            response.body === undefined
                                ? Buffer.alloc(0)
                                : Buffer.from(
                                      response.body,
                                      response.bodyEncoding === "base64" ? "base64" : "utf8",
                                  )
                        res.end(body)
                    } catch (error) {
                        res.statusCode = 500
                        res.end(error instanceof Error ? error.message : String(error))
                    }
                }
                const server =
                    tls === undefined
                        ? createHttpServer(requestListener)
                        : createHttpsServer(
                              {
                                  cert: String(tls.cert ?? ""),
                                  key: String(tls.key ?? ""),
                                  ...(typeof tls.ca === "string" ? { ca: tls.ca } : {}),
                              },
                              requestListener,
                          )
                let wsServer: WebSocketServer | null = null
                if (params["websocket"] === true) {
                    wsServer = new WebSocketServer({ noServer: true })
                    server.on("upgrade", (req, socket, head) => {
                        wsServer?.handleUpgrade(req, socket, head, (ws) => {
                            const connectionId = nextRequestId("ws")
                            this.#wsConnections.set(connectionId, ws)
                            const headers = Object.fromEntries(
                                Object.entries(req.headers).map(([key, value]) => [
                                    key,
                                    Array.isArray(value) ? value.join(", ") : (value ?? ""),
                                ]),
                            )
                            const httpRequest: HttpRequest = {
                                method: req.method ?? "GET",
                                url: req.url ?? "/",
                                headers,
                                body: "",
                                remoteAddress: req.socket.remoteAddress ?? null,
                            }
                            void this.#request("plugin.websocket.connect", {
                                serverId,
                                connectionId,
                                request: httpRequest,
                            }).catch(() => ws.close())
                            ws.on("message", (data, isBinary) => {
                                void this.#request("plugin.websocket.message", {
                                    connectionId,
                                    data: Buffer.from(data as Buffer).toString("base64"),
                                    binary: isBinary,
                                }).catch(() => undefined)
                            })
                            ws.on("close", (code, reason) => {
                                this.#wsConnections.delete(connectionId)
                                void this.#request("plugin.websocket.close", {
                                    connectionId,
                                    code,
                                    reason: reason.toString(),
                                }).catch(() => undefined)
                            })
                        })
                    })
                }
                await new Promise<void>((resolveListen, rejectListen) => {
                    server.once("error", rejectListen)
                    server.listen(port, host, () => {
                        server.off("error", rejectListen)
                        resolveListen()
                    })
                })
                const address = server.address()
                const actualPort =
                    typeof address === "object" && address !== null ? address.port : port
                this.#httpServers.set(serverId, { server, host, port: actualPort, wsServer })
                result = { serverId, host, port: actualPort }
            } else if (request.method === "host.http.closeServer") {
                this.#requireHostApi("http")
                const serverId = String(params["serverId"] ?? "")
                const record = this.#httpServers.get(serverId)
                if (record !== undefined) {
                    this.#httpServers.delete(serverId)
                    for (const ws of this.#wsConnections.values()) {
                        ws.close()
                    }
                    record.wsServer?.close()
                    await new Promise<void>((resolveClose) =>
                        record.server.close(() => resolveClose()),
                    )
                }
                result = {}
            } else if (request.method === "host.websocket.send") {
                this.#requireHostApi("http")
                const connectionId = String(params["connectionId"] ?? "")
                const ws = this.#wsConnections.get(connectionId)
                if (ws === undefined) {
                    throw new PluginSandboxError(`WebSocket 连接不存在：${connectionId}`)
                }
                ws.send(String(params["data"] ?? ""))
                result = {}
            } else if (request.method === "host.websocket.close") {
                this.#requireHostApi("http")
                const connectionId = String(params["connectionId"] ?? "")
                const ws = this.#wsConnections.get(connectionId)
                if (ws !== undefined) {
                    this.#wsConnections.delete(connectionId)
                    ws.close(
                        typeof params["code"] === "number" ? params["code"] : 1000,
                        String(params["reason"] ?? ""),
                    )
                }
                result = {}
            } else if (request.method === "host.pluginData") {
                this.#requireHostApi("fs")
                const targetId = String(params["targetId"] ?? "")
                const method = String(params["method"] ?? "")
                const args = Array.isArray(params["args"]) ? params["args"] : []
                if (this.#options.dataAccess === undefined) {
                    throw new PluginSandboxError("宿主没有 plugin data 服务")
                }
                const api = await this.#options.dataAccess.open(this.#options.pluginId, targetId)
                if (api === null) {
                    throw new PluginSandboxError(`没有插件 data 访问权限：${targetId}`)
                }
                const target = (api as unknown as Record<string, unknown>)[method]
                if (typeof target !== "function") {
                    throw new PluginSandboxError(`不支持的 data 方法：${method}`)
                }
                try {
                    const value = await (
                        target as (...values: unknown[]) => Promise<unknown>
                    ).apply(api, args)
                    result = value instanceof Uint8Array ? [...value] : value
                } catch (error) {
                    throw new PluginSandboxError(
                        error instanceof Error ? error.message : String(error),
                    )
                }
            } else if (request.method.startsWith("host.fs.")) {
                this.#requireHostApi("fs")
                result = await this.#handleFs(request.method, params, false)
            } else if (request.method.startsWith("host.workspaceFs.")) {
                this.#requireHostApi("fs")
                if (!this.#options.permissions.workspaceRead) {
                    throw new PluginSandboxError("插件没有 workspace 读权限")
                }
                result = await this.#handleFs(request.method, params, true)
            } else if (request.method === "host.event.subscribe") {
                this.#requireHostApi("event")
                const name = String(params["name"] ?? "")
                if (!this.#eventUnsubscribes.has(name)) {
                    const unsubscribe = eventBus.subscribe(name, (event) => {
                        this.#notify("sandbox.event", { name, data: event.getData() })
                    })
                    this.#eventUnsubscribes.set(name, unsubscribe)
                }
                result = {}
            } else if (request.method === "host.shutdown") {
                this.#requireHostApi("shutdown")
                shutdownHost()
                result = {}
            } else if (request.method.startsWith("host.capabilities.")) {
                this.#requireHostApi("capabilities")
                if (this.#options.capabilities === undefined) {
                    throw new PluginSandboxError("宿主没有 capabilities 服务")
                }
                const name = request.method.slice("host.capabilities.".length)
                if (name === "executeCode") {
                    result = await this.#options.capabilities.executeCode(
                        params as never,
                        this.#activeContext ?? undefined,
                    )
                } else if (name === "startBackgroundCode") {
                    result = await this.#options.capabilities.startBackgroundCode(
                        params as never,
                        this.#activeContext ?? undefined,
                    )
                } else if (name === "queryTask") {
                    result = this.#options.capabilities.queryTask(
                        typeof params["taskId"] === "string" ? params["taskId"] : undefined,
                    )
                } else if (name === "stopTask") {
                    result = this.#options.capabilities.stopTask(
                        typeof params["taskId"] === "string" ? params["taskId"] : undefined,
                        params["mode"] === "ctrl_c" ? "ctrl_c" : "kill",
                    )
                } else if (name === "webSearch") {
                    result = await this.#options.capabilities.webSearch(
                        String(params["query"] ?? ""),
                        typeof params["count"] === "number" ? params["count"] : undefined,
                    )
                } else if (name === "webFetch") {
                    result = await this.#options.capabilities.webFetch(String(params["url"] ?? ""))
                } else {
                    throw new PluginSandboxError(`未知 capability：${name}`)
                }
            } else if (request.method === "host.getHost") {
                this.#requireHostApi("getHost")
                result = hostSnapshotData()
            } else if (request.method === "host.session.exists") {
                result = findSession(String(params["id"] ?? "")) !== null
            } else if (request.method === "host.session.message") {
                const target = findSession(String(params["id"] ?? ""))
                if (target === null) {
                    throw new PluginSandboxError("会话不存在")
                }
                const content = Array.isArray(params["content"])
                    ? params["content"].map(String)
                    : [String(params["content"] ?? "")]
                await target.message(content, String(params["type"] ?? "message"))
                result = {}
            } else {
                throw new Error(`未知 host 方法：${request.method}`)
            }
            this.#respond({ v: 1, type: "response", id: request.id, ok: true, result })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes("权限")) {
                auditSandbox(this.#options.paths, {
                    type: "sandbox.permission",
                    sandboxId: this.#sandboxId,
                    pluginId: this.#options.pluginId,
                    backend: this.#options.backend.name,
                    decision: "denied",
                    method: request.method,
                    reason: message,
                })
            }
            this.#respond({
                v: 1,
                type: "response",
                id: request.id,
                ok: false,
                error: {
                    code: "host.rpc-failed",
                    message,
                },
            })
        }
    }

    async #handleFs(
        method: string,
        params: Record<string, unknown>,
        workspace: boolean,
    ): Promise<unknown> {
        const api: HostFileApi = workspace
            ? createPluginFileApi(process.cwd())
            : createPluginFileApi(this.#pluginDataDir)
        const path = String(params["path"] ?? "")
        const action = method.replace(/^host\.(fs|workspaceFs)\./, "")
        if (workspace && !this.#options.permissions.workspaceWrite) {
            if (["writeText", "writeBytes", "writeJson", "mkdir", "remove"].includes(action)) {
                throw new PluginSandboxError("插件没有 workspace 写权限")
            }
        }
        switch (action) {
            case "readText":
                return { text: await api.readText(path) }
            case "readBytes": {
                const data = await api.readBytes(path)
                return { data: data === null ? null : Buffer.from(data).toString("base64") }
            }
            case "readJson":
                return { value: await api.readJson(path) }
            case "writeText":
                await api.writeText(path, String(params["text"] ?? ""))
                return {}
            case "writeBytes":
                await api.writeBytes(
                    path,
                    new Uint8Array(Buffer.from(String(params["data"] ?? ""), "base64")),
                )
                return {}
            case "writeJson":
                await api.writeJson(path, params["value"])
                return {}
            case "list":
                return { entries: await api.list(path) }
            case "stat":
                return { stat: await api.stat(path) }
            case "mkdir":
                await api.mkdir(path)
                return {}
            case "remove":
                await api.remove(path)
                return {}
            case "exists":
                return { exists: await api.exists(path) }
            default:
                throw new Error(`未知 fs 方法：${method}`)
        }
    }

    #registerRemoteHooks(hooks: readonly string[]): void {
        for (const hook of hooks) {
            const kind = HOOK_KIND_BY_API[hook]
            if (kind === undefined) {
                continue
            }
            const unregister = registerExternalHook(
                kind as never,
                this.#options.pluginId,
                async (payload) => {
                    const result = (await this.runHook(
                        hook,
                        payload as Record<string, unknown>,
                    )) as {
                        prompt?: string[]
                    }
                    if (hook === "onMessage") {
                        const target = payload as { prompt?: string[] }
                        if (Array.isArray(result.prompt) && Array.isArray(target.prompt)) {
                            target.prompt.splice(0, target.prompt.length, ...result.prompt)
                        }
                    }
                },
            )
            this.#hookUnsubscribes.push(unregister)
        }
    }

    async runCommand(
        name: string,
        argv: readonly string[],
        cwd: string,
        json: boolean,
    ): Promise<number> {
        const result = (await this.#request("plugin.command", {
            name,
            argv: [...argv],
            cwd,
            json,
        })) as { exitCode?: number }
        return result.exitCode ?? 0
    }

    async runHook(hook: string, payload: Record<string, unknown>): Promise<unknown> {
        return await this.#request("plugin.hook", { hook, payload }, 30_000)
    }

    commandStubs(): PluginCommand[] {
        if (this.#ready === null) {
            return []
        }
        return this.#ready.commands.map((command) => ({
            name: command.name,
            summary: command.summary,
            usage: command.usage,
            aliases: command.aliases,
            run: async (ctx) => this.runCommand(command.name, ctx.argv, ctx.cwd, ctx.json),
        }))
    }

    async close(): Promise<void> {
        activeClients.delete(this)
        for (const [serverId, record] of this.#httpServers) {
            this.#httpServers.delete(serverId)
            await new Promise<void>((resolveClose) => record.server.close(() => resolveClose()))
        }
        if (this.#child === null) {
            return
        }
        auditSandbox(this.#options.paths, {
            type: "sandbox.plugin.stop",
            sandboxId: this.#sandboxId,
            pluginId: this.#options.pluginId,
            backend: this.#options.backend.name,
        })
        try {
            await this.#request("sandbox.shutdown", {}, 5_000)
        } catch {
            // 超时或已退出
        }
        this.#closed = true
        this.#kill()
        for (const unsubscribe of this.#eventUnsubscribes.values()) {
            unsubscribe()
        }
        for (const unsubscribe of this.#hookUnsubscribes) {
            unsubscribe()
        }
        await rm(this.#sandboxDir, { recursive: true, force: true }).catch(() => undefined)
    }

    async #prepareHostSdk(): Promise<void> {
        const copies: Array<[string, string]> = [
            [
                join(PROJECT_ROOT, "src", "api", "host"),
                join(this.#hostSdkDir, "src", "api", "host"),
            ],
            [
                join(PROJECT_ROOT, "src", "event", "event.ts"),
                join(this.#hostSdkDir, "src", "event", "event.ts"),
            ],
            [
                join(PROJECT_ROOT, "src", "session", "session.ts"),
                join(this.#hostSdkDir, "src", "session", "session.ts"),
            ],
            [
                join(PROJECT_ROOT, "src", "session", "registry.ts"),
                join(this.#hostSdkDir, "src", "session", "registry.ts"),
            ],
            [
                join(PROJECT_ROOT, "src", "session", "replay.ts"),
                join(this.#hostSdkDir, "src", "session", "replay.ts"),
            ],
            [
                join(PROJECT_ROOT, "src", "session", "types.ts"),
                join(this.#hostSdkDir, "src", "session", "types.ts"),
            ],
            [
                join(PROJECT_ROOT, "src", "workspace", "index.ts"),
                join(this.#hostSdkDir, "src", "workspace", "index.ts"),
            ],
            [
                join(PROJECT_ROOT, "src", "sandbox", "bridge-state.ts"),
                join(this.#hostSdkDir, "src", "sandbox", "bridge-state.ts"),
            ],
            [
                join(PROJECT_ROOT, "src", "sandbox", "protocol.ts"),
                join(this.#hostSdkDir, "src", "sandbox", "protocol.ts"),
            ],
            [
                join(PROJECT_ROOT, "src", "sandbox", "plugin-host.ts"),
                join(this.#hostSdkDir, "src", "sandbox", "plugin-host.ts"),
            ],
            [
                join(PROJECT_ROOT, "src", "plugin", "host-alias.ts"),
                join(this.#hostSdkDir, "src", "plugin", "host-alias.ts"),
            ],
            [
                join(PROJECT_ROOT, "src", "plugin", "access-guard.ts"),
                join(this.#hostSdkDir, "src", "plugin", "access-guard.ts"),
            ],
        ]
        for (const [source, target] of copies) {
            await mkdir(dirname(target), { recursive: true })
            await cp(source, target, { recursive: true })
        }
    }

    #failAll(error: Error): void {
        for (const pending of this.#pending.values()) {
            pending.reject(error)
        }
        this.#pending.clear()
    }

    #kill(): void {
        if (this.#child?.pid !== undefined) {
            try {
                process.kill(-this.#child.pid, "SIGKILL")
            } catch {
                this.#child.kill("SIGKILL")
            }
        }
        this.#closed = true
    }
}
