/*
 * 宿主侧 sandbox 插件客户端：启动 child、握手、命令/钩子 RPC、host API 代理。
 */

import { spawn, type ChildProcess } from "node:child_process"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { WebSocketServer, type WebSocket } from "ws"
import { randomUUID } from "node:crypto"
import { cp, mkdir, rm, stat } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"

import type { Logger } from "pino"

import type { AppSetting } from "../config/types.ts"
import { eventBus, EventEntity } from "../event/event.ts"
import {
    addWorkspace,
    listWorkspaces,
    removeWorkspace,
    renameWorkspace,
    touchWorkspace,
} from "../workspace/registry.ts"
import { getElog } from "../logger/elog4js.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import { createPluginFileApi } from "../plugin/fs.ts"
import type { PluginDataService } from "../plugin/data-access.ts"
import type { HostCapabilities } from "../plugin/capabilities.ts"
import { getAgentToolContext, type AgentToolContext } from "../agent/tool-context.ts"
import { ensurePluginDataDir } from "../plugin/runtime.ts"
import { auditSandbox } from "./audit.ts"
import { RPC_TIMEOUT_MS } from "./rpc-timeouts.ts"
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
import {
    HOST_EXEC_DEFAULT_TIMEOUT_MS,
    HOST_EXEC_MAX_OUTPUT_BYTES,
    type HostExecChunk,
} from "../api/host/exec.ts"
import {
    HOST_PTY_DEFAULT_COLS,
    HOST_PTY_DEFAULT_ROWS,
    HOST_PTY_MAX_COLS,
    HOST_PTY_MAX_OUTPUT_CHARS,
    HOST_PTY_MAX_POLL_CHARS,
    HOST_PTY_MAX_ROWS,
    HOST_PTY_MAX_SESSIONS,
    HOST_PTY_MIN_COLS,
    HOST_PTY_MIN_ROWS,
    type HostPtyChunk,
    type HostPtySession,
} from "../api/host/pty.ts"
import type { HttpRequest, HttpResponse } from "../api/host/http.ts"
import type { HostAgentChatInput } from "../api/host/agent.ts"
import type { HostModelsApi, HostModelProviderInput } from "../api/host/models.ts"
import type { HostNetworkApi, HostNetworkProxyInput } from "../api/host/network.ts"
import type { HostPluginInstallInput, HostPluginsApi } from "../api/host/plugins.ts"
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
    onSessionStart: "sessionStart",
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

/** stat 但不存在时返回 null，用于 cwd 校验 */
async function statSafe(path: string) {
    try {
        return await stat(path)
    } catch {
        return null
    }
}

/** 结束整棵进程树：detached 启动时先杀进程组，再兜底 kill */
function killSession(session: ExecSession): void {
    const child = session.child
    if (child.killed || child.exitCode !== null) return
    if (process.platform !== "win32" && typeof child.pid === "number") {
        try {
            process.kill(-child.pid, "SIGKILL")
            return
        } catch {
            /* 进程组可能已消失，退回单进程 kill */
        }
    }
    try {
        child.kill("SIGKILL")
    } catch {
        /* 已经退出 */
    }
}

/** node-pty 进程的最小结构，避免把可选依赖变成静态类型依赖 */
interface NodePtyProcess {
    readonly pid: number
    onData(handler: (data: string) => void): void
    onExit(handler: (event: { exitCode: number; signal?: number }) => void): void
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: string): void
}

interface NodePtyModule {
    spawn(file: string, args: string[], options: Record<string, unknown>): NodePtyProcess
}

/** 后端无关的 PTY 句柄 */
interface PtyHandle {
    readonly pid: number
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
}

type PtyBackendName = "node-pty" | "python-pty"

/** PTY 会话的宿主侧状态 */
interface PtySession {
    readonly handle: PtyHandle
    readonly backend: PtyBackendName
    readonly file: string
    readonly cwd: string
    cols: number
    rows: number
    output: string
    delivered: number
    done: boolean
    exitCode: number | null
}

/** 无需原生模块的 PTY 后端：python3 + pty-bridge.py */
const PTY_BRIDGE_PATH = join(PROJECT_ROOT, "src", "sandbox", "pty-bridge.py")

let pythonPtyProbe: Promise<string | null> | null = null

/** 探测可用的 python 解释器；没有就返回 null */
async function probePython(): Promise<string | null> {
    if (pythonPtyProbe === null) {
        pythonPtyProbe = (async () => {
            for (const candidate of ["python3", "python"]) {
                const ok = await new Promise<boolean>((resolveOk) => {
                    try {
                        const probe = spawn(candidate, ["-c", "import pty, termios"], {
                            stdio: "ignore",
                        })
                        probe.on("error", () => resolveOk(false))
                        probe.on("close", (code) => resolveOk(code === 0))
                    } catch {
                        resolveOk(false)
                    }
                })
                if (ok) return candidate
            }
            return null
        })()
    }
    return await pythonPtyProbe
}

/** PTY 尺寸夹在合理范围，避免异常值把终端撑爆；cols 与 rows 的最小值不同 */
function clampSize(value: unknown, fallback: number, min: number, max: number): number {
    const size = typeof value === "number" ? Math.round(value) : Number.NaN
    if (!Number.isFinite(size)) return fallback
    return Math.min(max, Math.max(min, size))
}

function clampCols(value: unknown): number {
    return clampSize(value, HOST_PTY_DEFAULT_COLS, HOST_PTY_MIN_COLS, HOST_PTY_MAX_COLS)
}

function clampRows(value: unknown): number {
    return clampSize(value, HOST_PTY_DEFAULT_ROWS, HOST_PTY_MIN_ROWS, HOST_PTY_MAX_ROWS)
}

/** 默认登录 shell */
function defaultShell(): string {
    if (process.platform === "win32") {
        return process.env.ComSpec ?? "powershell.exe"
    }
    return process.env.SHELL ?? "/bin/bash"
}

/** node-pty 是可选依赖：只尝试加载一次，失败就记住不可用 */
let nodePtyPromise: Promise<NodePtyModule | null> | null = null
/** node-pty 加载失败的原因，便于排查是没装还是原生模块装坏了 */
let nodePtyError: string | null = null

async function loadNodePty(): Promise<NodePtyModule | null> {
    if (nodePtyPromise === null) {
        nodePtyPromise = (async () => {
            try {
                // 变量 specifier：node-pty 可能根本没装，不能做成静态 import
                const specifier = "node-pty"
                const module = (await import(specifier)) as unknown as {
                    spawn?: NodePtyModule["spawn"]
                    default?: { spawn?: NodePtyModule["spawn"] }
                }
                const spawnPty = module.spawn ?? module.default?.spawn
                if (typeof spawnPty !== "function") {
                    nodePtyError = "node-pty 已加载但没有导出 spawn"
                    return null
                }
                nodePtyError = null
                return module as unknown as NodePtyModule
            } catch (error) {
                // 未安装与原生模块加载失败是两类问题，原因要原样带出去
                nodePtyError = error instanceof Error ? error.message : String(error)
                return null
            }
        })()
    }
    return await nodePtyPromise
}

/** 终端会话的宿主侧状态 */
interface ExecSession {
    readonly child: ChildProcess
    readonly cwd: string
    readonly startedAt: number
    output: string
    /** 已交付给插件 poll 的字符数 */
    delivered: number
    done: boolean
    exitCode: number | null
    timedOut: boolean
    truncated: boolean
    timer: NodeJS.Timeout | null
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
    readonly models?: HostModelsApi
    readonly network?: HostNetworkApi
    readonly plugins?: HostPluginsApi
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
        {
            readonly response: import("node:http").ServerResponse
            /** 响应头尚未应用时先缓存 chunk，避免 set headers 之后的写入报错 */
            readonly chunks: string[]
            ready: boolean
            ended: boolean
        }
    >()
    readonly #wsConnections = new Map<string, WebSocket>()
    /** 终端执行会话：输出缓冲留在宿主侧，插件按需 poll */
    readonly #execSessions = new Map<string, ExecSession>()
    /** PTY 会话：真 tty，支持键盘输入与 ANSI 全屏程序 */
    readonly #ptySessions = new Map<string, PtySession>()
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
                    return (await this.#request(
                        "plugin.agentTool",
                        { name: meta.name, args: input },
                        RPC_TIMEOUT_MS.agentTool,
                    )) as AgentCallToolResult
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
        /*
         * 总是把宿主 SDK 复制到 dataDir 再运行：
         * - bwrap 后端把 dataDir 里的副本挂到 /host；
         * - direct 后端从 node_modules 里直接跑 .ts 会触发
         *   ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING，复制到 dataDir 后
         *   Node 才能按源码运行插件 host runner。
         */
        await this.#prepareHostSdk()

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
            runnerPath: join(this.#hostSdkDir, "src", "sandbox", "plugin-host.ts"),
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
            if (pending === undefined) {
                return
            }
            if (!pending.ready) {
                if (data["end"] === true) {
                    pending.ended = true
                } else {
                    pending.chunks.push(String(data["chunk"] ?? ""))
                }
                return
            }
            try {
                if (data["end"] === true) {
                    this.#httpResponses.delete(requestId)
                    pending.response.end()
                } else {
                    pending.response.write(String(data["chunk"] ?? ""))
                }
            } catch {
                this.#httpResponses.delete(requestId)
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

    /** 模型供应商与切换：state / setActive / saveProvider / removeProvider / fetchModels / saveKey / clearKey */
    async #handleModels(method: string, params: Record<string, unknown>): Promise<unknown> {
        const service = this.#options.models
        if (service === undefined) {
            throw new PluginSandboxError("宿主没有模型配置服务")
        }
        if (method === "host.models.state") {
            return await service.state()
        }
        if (method === "host.models.setActive") {
            const model = params["model"]
            const reasoning = params["reasoning"]
            return await service.setActive(
                String(params["providerId"] ?? ""),
                typeof model === "string" && model.trim() !== "" ? model : null,
                typeof reasoning === "string" && reasoning.trim() !== "" ? reasoning : null,
            )
        }
        if (method === "host.models.saveProvider") {
            return await service.saveProvider(params as unknown as HostModelProviderInput)
        }
        if (method === "host.models.removeProvider") {
            return await service.removeProvider(String(params["id"] ?? ""))
        }
        if (method === "host.models.fetchModels") {
            const candidate = params["apiKey"]
            return await service.fetchModels(
                String(params["id"] ?? ""),
                typeof candidate === "string" ? candidate : undefined,
            )
        }
        if (method === "host.models.saveKey") {
            return await service.saveKey(String(params["id"] ?? ""), String(params["apiKey"] ?? ""))
        }
        if (method === "host.models.clearKey") {
            return await service.clearKey(String(params["id"] ?? ""))
        }
        throw new PluginSandboxError(`不支持的 models 方法：${method}`)
    }

    async #handleNetwork(method: string, params: Record<string, unknown>): Promise<unknown> {
        const service = this.#options.network
        if (service === undefined) {
            throw new PluginSandboxError("宿主没有网络配置服务")
        }
        if (method === "host.network.state") {
            return await service.state()
        }
        if (method === "host.network.saveProxy") {
            return await service.saveProxy(params as unknown as HostNetworkProxyInput)
        }
        throw new PluginSandboxError(`不支持的 network 方法：${method}`)
    }

    /** 插件管理：list / install / remove / enable / disable */
    async #handlePlugins(method: string, params: Record<string, unknown>): Promise<unknown> {
        const service = this.#options.plugins
        if (service === undefined) {
            throw new PluginSandboxError("宿主没有插件管理服务")
        }
        if (method === "host.plugins.list") {
            return await service.list()
        }
        if (method === "host.plugins.install") {
            return await service.install(params as unknown as HostPluginInstallInput)
        }
        if (method === "host.plugins.remove") {
            return await service.remove(String(params["id"] ?? ""))
        }
        if (method === "host.plugins.enable") {
            return await service.enable(String(params["id"] ?? ""))
        }
        if (method === "host.plugins.disable") {
            return await service.disable(String(params["id"] ?? ""))
        }
        throw new PluginSandboxError(`不支持的 plugins 方法：${method}`)
    }

    /** 终端执行：run/poll/stop 三个动作，输出缓冲留在宿主侧 */
    async #handleExec(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (method === "host.exec.run") {
            return await this.#execRun(params)
        }
        if (method === "host.exec.poll") {
            return this.#execPoll(String(params["sessionId"] ?? ""))
        }
        if (method === "host.exec.stop") {
            this.#execStop(String(params["sessionId"] ?? ""))
            return {}
        }
        throw new PluginSandboxError(`不支持的 exec 方法：${method}`)
    }

    async #execRun(params: Record<string, unknown>): Promise<{
        sessionId: string
        pid: number | null
        cwd: string
    }> {
        const command = String(params["command"] ?? "").trim()
        if (command === "") {
            throw new PluginSandboxError("命令不能为空")
        }
        if (command.length > 8000) {
            throw new PluginSandboxError("命令过长")
        }
        const rawCwd = String(params["cwd"] ?? "")
        const cwd = rawCwd === "" ? process.cwd() : resolve(rawCwd)
        const stat = await statSafe(cwd)
        if (!stat?.isDirectory()) {
            throw new PluginSandboxError(`工作目录不存在或不是目录：${cwd}`)
        }
        const extraEnv: Record<string, string> = {}
        const rawEnv = params["env"]
        if (rawEnv !== null && typeof rawEnv === "object" && !Array.isArray(rawEnv)) {
            for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
                if (typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                    extraEnv[key] = value
                }
            }
        }
        const rawTimeout = params["timeoutMs"]
        const timeoutMs =
            typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
                ? Math.min(rawTimeout, HOST_EXEC_DEFAULT_TIMEOUT_MS)
                : HOST_EXEC_DEFAULT_TIMEOUT_MS

        const sessionId = randomUUID()
        const child = spawn(command, {
            cwd,
            shell: true,
            env: { ...process.env, ...extraEnv, TERM: "dumb", NO_COLOR: "1" },
            stdio: ["ignore", "pipe", "pipe"],
            // 独立进程组，stop 时能连带子进程一起结束
            detached: process.platform !== "win32",
        })
        const session: ExecSession = {
            child,
            cwd,
            startedAt: Date.now(),
            output: "",
            delivered: 0,
            done: false,
            exitCode: null,
            timedOut: false,
            truncated: false,
            timer: null,
        }

        const append = (chunk: Buffer | string): void => {
            if (session.truncated) return
            const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
            if (session.output.length + text.length > HOST_EXEC_MAX_OUTPUT_BYTES) {
                session.output += text.slice(0, HOST_EXEC_MAX_OUTPUT_BYTES - session.output.length)
                session.truncated = true
                killSession(session)
                return
            }
            session.output += text
        }

        child.stdout?.on("data", append)
        child.stderr?.on("data", append)
        child.on("error", (error) => {
            append(`
[exec] ${error.message}
`)
            finish(null)
        })

        const timer = setTimeout(() => {
            session.timedOut = true
            killSession(session)
        }, timeoutMs)
        Object.assign(session, { timer })

        let finished = false
        function finish(code: number | null): void {
            if (finished) return
            finished = true
            session.done = true
            session.exitCode = code
            if (session.timer !== null) clearTimeout(session.timer)
        }
        child.on("close", (code) => finish(code))

        this.#execSessions.set(sessionId, session)
        // 只保留最近 32 个会话，避免长时间使用后内存堆积
        if (this.#execSessions.size > 32) {
            for (const [id, entry] of this.#execSessions) {
                if (this.#execSessions.size <= 32) break
                if (entry.done) this.#execSessions.delete(id)
            }
        }
        return { sessionId, pid: child.pid ?? null, cwd }
    }

    #execPoll(sessionId: string): HostExecChunk {
        const session = this.#execSessions.get(sessionId)
        if (session === undefined) {
            throw new PluginSandboxError("执行会话不存在或已过期")
        }
        const chunk = session.output.slice(session.delivered)
        session.delivered = session.output.length
        return {
            chunk,
            done: session.done,
            exitCode: session.exitCode,
            timedOut: session.timedOut,
            truncated: session.truncated,
        }
    }

    #execStop(sessionId: string): void {
        const session = this.#execSessions.get(sessionId)
        if (session === undefined || session.done) return
        killSession(session)
    }

    /** PTY：available/spawn/poll/write/resize/kill */
    async #handlePty(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (method === "host.pty.available") {
            const module = await loadNodePty()
            if (module !== null) {
                return { available: true, backend: "node-pty" }
            }
            const python = await probePython()
            if (python !== null) {
                // node-pty 缺失时用 python 自建 pty，仍是真 tty
                return { available: true, backend: "python-pty", reason: nodePtyError ?? null }
            }
            return {
                available: false,
                reason: `node-pty 与 python3 均不可用：${nodePtyError ?? "未安装"}`,
            }
        }
        if (method === "host.pty.spawn") {
            return await this.#ptySpawn(params)
        }
        if (method === "host.pty.poll") {
            return this.#ptyPoll(String(params["sessionId"] ?? ""))
        }
        if (method === "host.pty.write") {
            const session = this.#ptySession(String(params["sessionId"] ?? ""))
            const data = String(params["data"] ?? "")
            if (data !== "" && !session.done) session.handle.write(data)
            return {}
        }
        if (method === "host.pty.resize") {
            const session = this.#ptySession(String(params["sessionId"] ?? ""))
            const cols = clampCols(params["cols"])
            const rows = clampRows(params["rows"])
            if (!session.done && (cols !== session.cols || rows !== session.rows)) {
                session.cols = cols
                session.rows = rows
                try {
                    session.handle.resize(cols, rows)
                } catch {
                    /* 进程可能已退出 */
                }
            }
            return {}
        }
        if (method === "host.pty.kill") {
            const session = this.#ptySession(String(params["sessionId"] ?? ""))
            if (!session.done) {
                try {
                    session.handle.kill()
                } catch {
                    /* 已经退出 */
                }
            }
            return {}
        }
        throw new PluginSandboxError(`不支持的 pty 方法：${method}`)
    }

    #ptySession(sessionId: string): PtySession {
        const session = this.#ptySessions.get(sessionId)
        if (session === undefined) {
            throw new PluginSandboxError("PTY 会话不存在或已过期")
        }
        return session
    }

    async #ptySpawn(params: Record<string, unknown>): Promise<HostPtySession> {
        const module = await loadNodePty()
        const python = module === null ? await probePython() : null
        if (module === null && python === null) {
            throw new PluginSandboxError(
                `没有可用的 PTY 后端：node-pty 与 python3 均不可用（${nodePtyError ?? "未安装"}）`,
            )
        }
        const rawCwd = String(params["cwd"] ?? "")
        const cwd = rawCwd === "" ? process.cwd() : resolve(rawCwd)
        const stat = await statSafe(cwd)
        if (!stat?.isDirectory()) {
            throw new PluginSandboxError(`工作目录不存在或不是目录：${cwd}`)
        }
        const file = String(params["file"] ?? "").trim() || defaultShell()
        const rawArgs = params["args"]
        const args = Array.isArray(rawArgs)
            ? rawArgs.filter((item): item is string => typeof item === "string")
            : []
        const extraEnv: Record<string, string> = {}
        const rawEnv = params["env"]
        if (rawEnv !== null && typeof rawEnv === "object" && !Array.isArray(rawEnv)) {
            for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
                if (typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                    extraEnv[key] = value
                }
            }
        }
        const cols = clampCols(params["cols"])
        const rows = clampRows(params["rows"])

        const env = {
            ...process.env,
            ...extraEnv,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
        }
        const onData: Array<(data: string) => void> = []
        const onExit: Array<(code: number | null) => void> = []
        let handle: PtyHandle
        let backend: PtyBackendName

        if (module !== null) {
            // 首选：node-pty 原生模块
            const pty = module.spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env })
            pty.onData((data) => {
                for (const handler of onData) handler(data)
            })
            pty.onExit((event) => {
                const code = typeof event.exitCode === "number" ? event.exitCode : null
                for (const handler of onExit) handler(code)
            })
            handle = {
                pid: pty.pid,
                write: (data) => pty.write(data),
                resize: (nextCols, nextRows) => pty.resize(nextCols, nextRows),
                kill: () => pty.kill(),
            }
            backend = "node-pty"
        } else {
            // 回退：python3 自建 pty，控制命令走 stdin 的 JSON 行
            const config = JSON.stringify({ shell: file, args, cwd, cols, rows, env: extraEnv })
            const child = spawn(python as string, [PTY_BRIDGE_PATH, config], {
                stdio: ["pipe", "pipe", "pipe"],
                cwd,
                env,
                detached: process.platform !== "win32",
            })
            const send = (payload: Record<string, unknown>): void => {
                if (child.stdin === null || child.stdin.destroyed) return
                try {
                    child.stdin.write(`${JSON.stringify(payload)}
`)
                } catch {
                    /* 桥接已退出 */
                }
            }
            child.stdout?.on("data", (chunk: Buffer) => {
                const text = chunk.toString("utf8")
                for (const handler of onData) handler(text)
            })
            child.stderr?.on("data", (chunk: Buffer) => {
                // 桥接的报错也当终端输出，便于在控制台里看到
                const text = chunk.toString("utf8")
                for (const handler of onData) handler(text)
            })
            child.on("close", (code) => {
                for (const handler of onExit) handler(typeof code === "number" ? code : null)
            })
            handle = {
                pid: child.pid ?? 0,
                write: (data) => send({ type: "input", data }),
                resize: (nextCols, nextRows) =>
                    send({ type: "resize", cols: nextCols, rows: nextRows }),
                kill: () => {
                    send({ type: "kill" })
                    if (process.platform !== "win32" && typeof child.pid === "number") {
                        try {
                            process.kill(-child.pid, "SIGKILL")
                            return
                        } catch {
                            /* 进程组已消失 */
                        }
                    }
                    try {
                        child.kill("SIGKILL")
                    } catch {
                        /* 已退出 */
                    }
                },
            }
            backend = "python-pty"
        }

        const session: PtySession = {
            handle,
            backend,
            file,
            cwd,
            cols,
            rows,
            output: "",
            delivered: 0,
            done: false,
            exitCode: null,
        }
        onData.push((data) => {
            session.output += data
            // 超上限时丢最旧的一半，同步回退已读游标
            if (session.output.length > HOST_PTY_MAX_OUTPUT_CHARS) {
                const drop = session.output.length - Math.floor(HOST_PTY_MAX_OUTPUT_CHARS / 2)
                session.output = session.output.slice(drop)
                session.delivered = Math.max(0, session.delivered - drop)
            }
        })
        onExit.push((code) => {
            session.done = true
            session.exitCode = code
        })

        const sessionId = randomUUID()
        this.#ptySessions.set(sessionId, session)
        // 只保留最近的会话，避免长期使用后堆积
        if (this.#ptySessions.size > HOST_PTY_MAX_SESSIONS) {
            for (const [id, entry] of this.#ptySessions) {
                if (this.#ptySessions.size <= HOST_PTY_MAX_SESSIONS) break
                if (entry.done) this.#ptySessions.delete(id)
            }
        }
        return { sessionId, pid: handle.pid, file, cwd, cols, rows }
    }

    #ptyPoll(sessionId: string): HostPtyChunk {
        const session = this.#ptySession(sessionId)
        const pending = session.output.slice(
            session.delivered,
            session.delivered + HOST_PTY_MAX_POLL_CHARS,
        )
        session.delivered += pending.length
        return { chunk: pending, done: session.done, exitCode: session.exitCode }
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
            } else if (request.method === "host.agent.stream") {
                this.#requireHostApi("agent")
                if (this.#options.agent === undefined) {
                    throw new PluginSandboxError("宿主没有 Agent 服务")
                }
                const streamId = String(params["streamId"] ?? "")
                const input = params["input"] as unknown as HostAgentChatInput
                result = await this.#options.agent.stream(input, (event) => {
                    this.#notify("sandbox.agent.stream", { streamId, event })
                })
            } else if (request.method === "host.agent.validateWorkspace") {
                this.#requireHostApi("agent")
                if (this.#options.agent === undefined) {
                    throw new PluginSandboxError("宿主没有 Agent 服务")
                }
                result = await this.#options.agent.validateWorkspace(String(params["path"] ?? ""))
            } else if (request.method === "host.agent.pickDirectory") {
                this.#requireHostApi("agent")
                if (this.#options.agent === undefined) {
                    throw new PluginSandboxError("宿主没有 Agent 服务")
                }
                result = await this.#options.agent.pickDirectory()
            } else if (request.method === "host.agent.searchWorkspaceFiles") {
                this.#requireHostApi("agent")
                if (this.#options.agent === undefined) {
                    throw new PluginSandboxError("宿主没有 Agent 服务")
                }
                result = await this.#options.agent.searchWorkspaceFiles(
                    String(params["root"] ?? ""),
                    String(params["query"] ?? ""),
                )
            } else if (request.method === "host.agent.interject") {
                this.#requireHostApi("agent")
                if (this.#options.agent === undefined) {
                    throw new PluginSandboxError("宿主没有 Agent 服务")
                }
                result = await this.#options.agent.interject(
                    String(params["sessionId"] ?? ""),
                    String(params["message"] ?? ""),
                )
            } else if (request.method === "host.agent.stop") {
                this.#requireHostApi("agent")
                if (this.#options.agent === undefined) {
                    throw new PluginSandboxError("宿主没有 Agent 服务")
                }
                result = await this.#options.agent.stop(String(params["sessionId"] ?? ""))
            } else if (request.method === "host.agent.respondApproval") {
                this.#requireHostApi("agent")
                if (this.#options.agent === undefined) {
                    throw new PluginSandboxError("宿主没有 Agent 服务")
                }
                result = await this.#options.agent.respondApproval(
                    String(params["approvalId"] ?? ""),
                    params["approved"] === true,
                )
            } else if (request.method === "host.agent.respondAsk") {
                this.#requireHostApi("agent")
                if (this.#options.agent === undefined) {
                    throw new PluginSandboxError("宿主没有 Agent 服务")
                }
                result = await this.#options.agent.respondAsk(
                    String(params["askId"] ?? ""),
                    String(params["answer"] ?? ""),
                )
            } else if (request.method.startsWith("host.models.")) {
                this.#requireHostApi("models")
                if (this.#options.models === undefined) {
                    throw new PluginSandboxError("宿主没有模型配置服务")
                }
                result = await this.#handleModels(request.method, params)
            } else if (request.method.startsWith("host.network.")) {
                this.#requireHostApi("network")
                if (this.#options.network === undefined) {
                    throw new PluginSandboxError("宿主没有网络配置服务")
                }
                result = await this.#handleNetwork(request.method, params)
            } else if (request.method.startsWith("host.workspaces.")) {
                this.#requireHostApi("workspaces")
                if (request.method === "host.workspaces.list") {
                    result = await listWorkspaces(this.#options.paths)
                } else if (request.method === "host.workspaces.add") {
                    result = await addWorkspace(
                        {
                            root: String(params["root"] ?? ""),
                            ...(typeof params["name"] === "string" ? { name: params["name"] } : {}),
                        },
                        this.#options.paths,
                    )
                } else if (request.method === "host.workspaces.remove") {
                    result = await removeWorkspace(String(params["id"] ?? ""), this.#options.paths)
                } else if (request.method === "host.workspaces.rename") {
                    result = await renameWorkspace(
                        String(params["id"] ?? ""),
                        String(params["name"] ?? ""),
                        this.#options.paths,
                    )
                } else if (request.method === "host.workspaces.touch") {
                    result = await touchWorkspace(String(params["id"] ?? ""), this.#options.paths)
                } else {
                    throw new Error(`未知 host 方法：${request.method}`)
                }
            } else if (request.method.startsWith("host.plugins.")) {
                this.#requireHostApi("plugins")
                if (this.#options.plugins === undefined) {
                    throw new PluginSandboxError("宿主没有插件管理服务")
                }
                result = await this.#handlePlugins(request.method, params)
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
                        this.#httpResponses.set(requestId, {
                            response: res,
                            chunks: [],
                            ready: false,
                            ended: false,
                        })
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
                            const pending = this.#httpResponses.get(requestId)
                            if (pending !== undefined) {
                                pending.ready = true
                                for (const chunk of pending.chunks) {
                                    try {
                                        pending.response.write(chunk)
                                    } catch {
                                        this.#httpResponses.delete(requestId)
                                        return
                                    }
                                }
                                pending.chunks.length = 0
                                if (pending.ended) {
                                    this.#httpResponses.delete(requestId)
                                    pending.response.end()
                                }
                            }
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
                    // SSE / 长轮询会保持连接，server.close() 要等它们全部断开；
                    // 关闭时给一点收尾时间，然后强制断开剩余连接，避免 Ctrl+C 卡住。
                    const server = record.server
                    await new Promise<void>((resolveClose) => {
                        let settled = false
                        const finish = (): void => {
                            if (settled) {
                                return
                            }
                            settled = true
                            clearTimeout(forceTimer)
                            resolveClose()
                        }
                        server.close(() => finish())
                        server.closeIdleConnections()
                        const forceTimer = setTimeout(() => {
                            server.closeAllConnections()
                            finish()
                        }, 800)
                        forceTimer.unref()
                    })
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
            } else if (request.method.startsWith("host.pty.")) {
                this.#requireHostApi("pty")
                result = await this.#handlePty(request.method, params)
            } else if (request.method.startsWith("host.exec.")) {
                this.#requireHostApi("exec")
                result = await this.#handleExec(request.method, params)
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
        if (
            workspace &&
            ["writeText", "writeBytes", "writeJson", "mkdir", "remove"].includes(action)
        ) {
            if (!this.#options.permissions.workspaceWrite) {
                throw new PluginSandboxError("插件没有 workspace 写权限")
            }
            const context = this.#activeContext
            if (context !== null && context.permission === "read-only") {
                throw new PluginSandboxError("当前 Agent 权限是 read-only，不能修改工作区文件")
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
                    if (hook === "onMessage" || hook === "onSessionStart") {
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
        // 先收掉仍在跑的进程，再清监听，避免成了孤儿
        for (const session of this.#execSessions.values()) {
            if (!session.done) killSession(session)
        }
        this.#execSessions.clear()
        for (const session of this.#ptySessions.values()) {
            if (session.done) continue
            try {
                session.handle.kill()
            } catch {
                /* 已经退出 */
            }
        }
        this.#ptySessions.clear()
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
                join(PROJECT_ROOT, "src", "api", "plugin"),
                join(this.#hostSdkDir, "src", "api", "plugin"),
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
                join(PROJECT_ROOT, "src", "sandbox", "rpc-timeouts.ts"),
                join(this.#hostSdkDir, "src", "sandbox", "rpc-timeouts.ts"),
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
