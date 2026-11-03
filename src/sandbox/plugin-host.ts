/*
 * sandbox 插件进程入口。
 * 由宿主通过 bwrap/direct backend 启动；stdio 上跑 frame 协议，插件代码只通过 bridge 访问宿主。
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { Readable } from "node:stream"
import { pathToFileURL } from "node:url"

import type { Logger } from "pino"

import type { Host, HostOSInfo, HostPluginStatus, HostStatus } from "../api/host/host.ts"
import type { HostFileApi, HostFileEntry, HostFileStat } from "../api/host/fs.ts"
import type {
    HostExecApi,
    HostExecChunk,
    HostExecRunOptions,
    HostExecSession,
} from "../api/host/exec.ts"
import type {
    HostModelProviderInput,
    HostModelsApi,
    HostModelsFetchResult,
    HostModelsState,
    HostModelsStateResult,
} from "../api/host/models.ts"
import type {
    HostNetworkApi,
    HostNetworkProxyInput,
    HostNetworkResult,
    HostNetworkState,
} from "../api/host/network.ts"
import type {
    HostPluginInstallInput,
    HostPluginsApi,
    HostPluginListResult,
    HostPluginMutationResult,
    HostPluginUpdateResult,
} from "../api/host/plugins.ts"
import type {
    HostWorkspaceAddInput,
    HostWorkspaceAddResult,
    HostWorkspaceEntry,
    HostWorkspaceListResult,
    HostWorkspaceRemoveResult,
    HostWorkspacesApi,
} from "../api/host/workspace.ts"
import type {
    HostPtyApi,
    HostPtyAvailability,
    HostPtyChunk,
    HostPtySession,
    HostPtySpawnOptions,
} from "../api/host/pty.ts"
import type {
    HostAgentApi,
    HostAgentChatInput,
    HostAgentOpenMode,
    HostAgentStreamEvent,
    HostWorkspaceCheck,
    HostWorkspaceFilesResult,
} from "../api/host/agent.ts"
import type {
    HostHttpApi,
    HttpHandler,
    HttpRequest,
    HttpResponse,
    PluginWebSocket,
    WebSocketHandler,
} from "../api/host/http.ts"
import {
    emitAfterStep,
    emitAfterTurn,
    emitAgentAsyncTaskComplete,
    emitAgentAsk,
    emitAgentCallTool,
    emitAgentQueryTask,
    emitAgentRead,
    emitAgentRequestPermission,
    emitAgentRunAsync,
    emitAgentRunSync,
    emitAgentSetGoal,
    emitAgentSetTasks,
    emitAgentSubmit,
    emitBeforeStep,
    emitBeforeTurn,
    emitInitHooks,
    emitOnMessage,
    emitSessionStart,
    emitShutdownHooks,
    emitUserAnswer,
    listHookKinds,
    withHookOwner,
    type HookKind,
} from "../api/host/hooks.ts"
import type {
    AgentCallToolResult,
    AgentTool,
    HostOutput,
    PluginApi,
    PluginCommand,
    PluginCommandContext,
    PluginConfig,
    PluginStatus,
    PluginVersionProbe,
    WellspringPlugin,
} from "../api/host/plugin.ts"
import { eventBus } from "../event/event.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import type { AppSetting } from "../config/types.ts"
import { ensureAccessGuard } from "../plugin/access-guard.ts"
import { ensureHostAlias } from "../plugin/host-alias.ts"
import { setHostBridge, type HostBridge } from "./bridge-state.ts"
import {
    FrameDecoder,
    encodeMessage,
    nextRequestId,
    type RpcMessage,
    type RpcRequest,
} from "./protocol.ts"
import { RPC_TIMEOUT_MS } from "./rpc-timeouts.ts"

interface HostSnapshotData {
    readonly status: HostStatus
    readonly os: HostOSInfo
    readonly paths: ResolvedPaths
    readonly plugins: ReadonlyArray<{
        readonly id: string
        readonly name: string
        readonly version: string
        readonly deps: readonly string[]
        readonly commands: readonly string[]
        readonly status: HostPluginStatus
    }>
}

interface ConfigurePayload {
    readonly pluginId: string
    readonly pluginName: string
    readonly pluginVersion: string
    readonly pluginEntry: string
    readonly pluginDataDir: string
    readonly pluginConfig: PluginConfig
    readonly paths: ResolvedPaths
    readonly config: AppSetting
    readonly host: HostSnapshotData | null
    readonly deferInit?: boolean
}

interface HostRequest {
    readonly method: string
    readonly params: Record<string, unknown>
    readonly id: string
}

const rawStdoutWrite = process.stdout.write.bind(process.stdout)
const rawStderrWrite = process.stderr.write.bind(process.stderr)

function writeFrame(message: RpcMessage): void {
    rawStdoutWrite(encodeMessage(message))
}

const pending = new Map<
    string,
    {
        resolve: (value: unknown) => void
        reject: (error: Error) => void
        timer: NodeJS.Timeout | null
    }
>()

/*
 * 当前 Agent 工具调用的 id：宿主在 plugin.agentTool 信封上下发
 *
 * 插件在这条调用期间发出的每个 host 请求都原样回填，宿主据此判断权限与归属
 * 插件的工具调用可以并发（两个会话同调一个插件），身份跟着调用链走
 * 脱离调用链的异步续作（定时器 / 后台任务）取不到 id
 */
const toolContext = new AsyncLocalStorage<string>()

function bridgeRequest(
    method: string,
    params: unknown,
    timeoutMs: number | null = RPC_TIMEOUT_MS.default,
): Promise<unknown> {
    const id = nextRequestId("child")
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
        // timeoutMs 为 null 时不挂定时器：长任务 RPC（例如 agent.stream）由运行过程自身结束
        const timer =
            timeoutMs === null
                ? null
                : setTimeout(() => {
                      pending.delete(id)
                      rejectRequest(new Error(`host RPC 超时：${method}`))
                  }, timeoutMs)
        timer?.unref()
        const clearTimer = (): void => {
            if (timer !== null) {
                clearTimeout(timer)
            }
        }
        pending.set(id, {
            resolve: (value) => {
                clearTimer()
                resolveRequest(value)
            },
            reject: (error) => {
                clearTimer()
                rejectRequest(error)
            },
            timer,
        })
        const contextId = toolContext.getStore()
        writeFrame({
            v: 1,
            type: "request",
            id,
            method,
            params,
            ...(timeoutMs === null ? {} : { timeoutMs }),
            ...(contextId === undefined ? {} : { contextId }),
        })
    })
}

function bridgeNotify(method: string, params: unknown): void {
    writeFrame({ v: 1, type: "event", method, params })
}

let hostSnapshot: Host | null = null

const bridge: HostBridge = {
    request: bridgeRequest,
    notify: bridgeNotify,
    getHostSnapshot: () => {
        if (hostSnapshot === null) {
            throw new Error("插件未获得 getHost 权限")
        }
        return hostSnapshot
    },
    shutdown: () => {
        void bridgeRequest("host.shutdown", {}).catch(() => undefined)
    },
}

setHostBridge(bridge)
ensureHostAlias()
ensureAccessGuard()

interface PluginRuntime {
    readonly owner: string
    readonly plugin: WellspringPlugin
    readonly commands: PluginCommand[]
    readonly agentTools: AgentTool[]
    hooks: readonly HookKind[]
    readonly api: PluginApi
    /** init 里交出来的版本探针；宿主通过 plugin.getLatestVersion 请求调用 */
    versionProbe: PluginVersionProbe | null
    initialized: boolean
}

const HOOK_API_NAME: Readonly<Record<HookKind, string>> = {
    message: "onMessage",
    sessionStart: "onSessionStart",
    beforeTurn: "beforeTurn",
    beforeStep: "beforeStep",
    afterStep: "afterStep",
    afterTurn: "afterTurn",
    agentRunSync: "onAgentRunSync",
    agentRunAsync: "onAgentRunAsync",
    agentAsyncTaskComplete: "onAgentAsyncTaskComplete",
    agentCallTool: "onAgentCallTool",
    agentAsk: "onAgentAsk",
    agentRead: "onAgentRead",
    agentQueryTask: "onAgentQueryTask",
    agentSubmit: "onAgentSubmit",
    agentSetTasks: "onAgentSetTasks",
    agentSetGoal: "onAgentSetGoal",
    agentRequestPermission: "onAgentRequestPermission",
    userAnswer: "onUserAnswer",
    init: "onInit",
    shutdown: "onShutdown",
}

let runtime: PluginRuntime | null = null

const httpHandlers = new Map<string, HttpHandler>()
const agentStreamHandlers = new Map<string, (event: HostAgentStreamEvent) => void>()
const websocketHandlers = new Map<string, WebSocketHandler>()
const wsMessages = new Map<string, Array<(data: string) => void>>()
const wsCloses = new Map<string, Array<(code: number, reason: string) => void>>()

function remoteExec(): HostExecApi {
    return {
        async run(options: HostExecRunOptions): Promise<HostExecSession> {
            return (await bridgeRequest("host.exec.run", {
                command: options.command,
                cwd: options.cwd,
                env: options.env ?? {},
                timeoutMs: options.timeoutMs,
            })) as HostExecSession
        },
        async poll(sessionId: string): Promise<HostExecChunk> {
            return (await bridgeRequest("host.exec.poll", { sessionId })) as HostExecChunk
        },
        async stop(sessionId: string): Promise<void> {
            await bridgeRequest("host.exec.stop", { sessionId })
        },
    }
}

function remotePty(): HostPtyApi {
    return {
        async available(): Promise<HostPtyAvailability> {
            const result = (await bridgeRequest("host.pty.available", {})) as {
                available?: boolean
                backend?: string
                reason?: string
            }
            const backend =
                result.backend === "node-pty" || result.backend === "python-pty"
                    ? result.backend
                    : undefined
            return {
                available: result.available === true,
                backend,
                reason: typeof result.reason === "string" ? result.reason : undefined,
            }
        },
        async spawn(options: HostPtySpawnOptions): Promise<HostPtySession> {
            return (await bridgeRequest("host.pty.spawn", {
                file: options.file ?? "",
                args: options.args ?? [],
                cwd: options.cwd,
                env: options.env ?? {},
                cols: options.cols,
                rows: options.rows,
            })) as HostPtySession
        },
        async poll(sessionId: string): Promise<HostPtyChunk> {
            return (await bridgeRequest("host.pty.poll", { sessionId })) as HostPtyChunk
        },
        async write(sessionId: string, data: string): Promise<void> {
            await bridgeRequest("host.pty.write", { sessionId, data })
        },
        async resize(sessionId: string, cols: number, rows: number): Promise<void> {
            await bridgeRequest("host.pty.resize", { sessionId, cols, rows })
        },
        async kill(sessionId: string): Promise<void> {
            await bridgeRequest("host.pty.kill", { sessionId })
        },
    }
}

function remoteAgent(): HostAgentApi {
    return {
        async chat(input: HostAgentChatInput) {
            return await bridgeRequest(
                "host.agent.chat",
                input as unknown as Record<string, unknown>,
                RPC_TIMEOUT_MS.agentChat,
            )
        },
        async stream(input: HostAgentChatInput, onEvent: (event: HostAgentStreamEvent) => void) {
            const streamId = nextRequestId("agent-stream")
            agentStreamHandlers.set(streamId, onEvent)
            try {
                // 一轮 Agent 可能跑很久（多步工具调用），不设 RPC 上限
                return await bridgeRequest(
                    "host.agent.stream",
                    { streamId, input },
                    RPC_TIMEOUT_MS.agentStream,
                )
            } finally {
                agentStreamHandlers.delete(streamId)
            }
        },
        async validateWorkspace(path: string) {
            return (await bridgeRequest("host.agent.validateWorkspace", {
                path,
            })) as HostWorkspaceCheck
        },
        async pickDirectory() {
            return (await bridgeRequest("host.agent.pickDirectory", {})) as HostWorkspaceCheck
        },
        async openPath(path: string, mode: HostAgentOpenMode = "default") {
            await bridgeRequest("host.agent.openPath", { path, mode })
        },
        async searchWorkspaceFiles(root: string, query: string) {
            return (await bridgeRequest("host.agent.searchWorkspaceFiles", {
                root,
                query,
            })) as HostWorkspaceFilesResult
        },
        async interject(sessionId: string, message: string) {
            return (await bridgeRequest("host.agent.interject", {
                sessionId,
                message,
            })) as boolean
        },
        async stop(sessionId: string) {
            return (await bridgeRequest("host.agent.stop", { sessionId })) as boolean
        },
        async respondApproval(approvalId: string, approved: boolean) {
            return (await bridgeRequest("host.agent.respondApproval", {
                approvalId,
                approved,
            })) as boolean
        },
        async respondAsk(askId: string, answer: string) {
            return (await bridgeRequest("host.agent.respondAsk", {
                askId,
                answer,
            })) as boolean
        },
    } as HostAgentApi
}

function remoteModels(): HostModelsApi {
    return {
        async state(): Promise<HostModelsState> {
            return (await bridgeRequest("host.models.state", {})) as HostModelsState
        },
        async setActive(
            providerId: string,
            model: string | null,
            reasoning?: string | null,
        ): Promise<HostModelsState> {
            return (await bridgeRequest("host.models.setActive", {
                providerId,
                model,
                reasoning,
            })) as HostModelsState
        },
        async saveProvider(input: HostModelProviderInput): Promise<HostModelsStateResult> {
            return (await bridgeRequest(
                "host.models.saveProvider",
                input as unknown as Record<string, unknown>,
            )) as HostModelsStateResult
        },
        async removeProvider(id: string): Promise<HostModelsStateResult> {
            return (await bridgeRequest("host.models.removeProvider", {
                id,
            })) as HostModelsStateResult
        },
        async fetchModels(id: string, apiKey?: string): Promise<HostModelsFetchResult> {
            const payload: Record<string, unknown> = { id }
            if (apiKey !== undefined) {
                payload["apiKey"] = apiKey
            }
            return (await bridgeRequest(
                "host.models.fetchModels",
                payload,
                RPC_TIMEOUT_MS.modelsFetch,
            )) as HostModelsFetchResult
        },
        async saveKey(id: string, apiKey: string): Promise<HostModelsStateResult> {
            return (await bridgeRequest("host.models.saveKey", {
                id,
                apiKey,
            })) as HostModelsStateResult
        },
        async clearKey(id: string): Promise<HostModelsState> {
            return (await bridgeRequest("host.models.clearKey", { id })) as HostModelsState
        },
    }
}

function remoteNetwork(): HostNetworkApi {
    return {
        async state(): Promise<HostNetworkState> {
            return (await bridgeRequest("host.network.state", {})) as HostNetworkState
        },
        async saveProxy(input: HostNetworkProxyInput): Promise<HostNetworkResult> {
            return (await bridgeRequest(
                "host.network.saveProxy",
                input as unknown as Record<string, unknown>,
            )) as HostNetworkResult
        },
    }
}

function remotePlugins(): HostPluginsApi {
    return {
        async list(): Promise<HostPluginListResult> {
            return (await bridgeRequest("host.plugins.list", {})) as HostPluginListResult
        },
        async install(input: HostPluginInstallInput): Promise<HostPluginMutationResult> {
            return (await bridgeRequest(
                "host.plugins.install",
                input as unknown as Record<string, unknown>,
                RPC_TIMEOUT_MS.pluginsInstall,
            )) as HostPluginMutationResult
        },
        async remove(id: string): Promise<HostPluginMutationResult> {
            return (await bridgeRequest("host.plugins.remove", { id })) as HostPluginMutationResult
        },
        async enable(id: string): Promise<HostPluginMutationResult> {
            return (await bridgeRequest("host.plugins.enable", { id })) as HostPluginMutationResult
        },
        async checkUpdates(): Promise<HostPluginUpdateResult> {
            return (await bridgeRequest(
                "host.plugins.checkUpdates",
                {},
                RPC_TIMEOUT_MS.pluginsCheckUpdates,
            )) as HostPluginUpdateResult
        },
        async disable(id: string): Promise<HostPluginMutationResult> {
            return (await bridgeRequest("host.plugins.disable", { id })) as HostPluginMutationResult
        },
    }
}

function remoteWorkspaces(): HostWorkspacesApi {
    return {
        async list(): Promise<HostWorkspaceListResult> {
            return (await bridgeRequest("host.workspaces.list", {})) as HostWorkspaceListResult
        },
        async add(input: HostWorkspaceAddInput): Promise<HostWorkspaceAddResult> {
            return (await bridgeRequest(
                "host.workspaces.add",
                input as unknown as Record<string, unknown>,
            )) as HostWorkspaceAddResult
        },
        async remove(id: string): Promise<HostWorkspaceRemoveResult> {
            return (await bridgeRequest("host.workspaces.remove", {
                id,
            })) as HostWorkspaceRemoveResult
        },
        async rename(id: string, name: string): Promise<HostWorkspaceEntry | null> {
            return (await bridgeRequest("host.workspaces.rename", {
                id,
                name,
            })) as HostWorkspaceEntry | null
        },
        async touch(id: string): Promise<HostWorkspaceEntry | null> {
            return (await bridgeRequest("host.workspaces.touch", {
                id,
            })) as HostWorkspaceEntry | null
        },
    }
}

function remoteHttp(): HostHttpApi {
    return {
        async createServer(options, handler) {
            const serverId = nextRequestId("http")
            httpHandlers.set(serverId, handler)
            if (typeof options.websocket === "function") {
                websocketHandlers.set(serverId, options.websocket)
            }
            try {
                const ready = (await bridgeRequest("host.http.createServer", {
                    serverId,
                    host: options.host,
                    port: options.port,
                    tls: options.tls,
                    websocket: typeof options.websocket === "function",
                })) as { serverId: string; host: string; port: number }
                return {
                    serverId: ready.serverId,
                    host: ready.host,
                    port: ready.port,
                    async close() {
                        httpHandlers.delete(serverId)
                        await bridgeRequest("host.http.closeServer", { serverId })
                    },
                }
            } catch (error) {
                httpHandlers.delete(serverId)
                throw error
            }
        },
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validatePlugin(value: unknown): WellspringPlugin {
    if (!isObject(value)) {
        throw new Error("setup() 必须返回 WellspringPlugin 对象")
    }
    const id = value["id"]
    const name = value["name"]
    const version = value["version"]
    const status = value["status"]
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
        throw new Error(`插件 id 不合法：${String(id)}`)
    }
    if (typeof name !== "string" || name.trim() === "") {
        throw new Error(`插件 name 不合法：${String(name)}`)
    }
    if (typeof version !== "string" || version.trim() === "") {
        throw new Error(`插件 version 不合法：${String(version)}`)
    }
    if (status !== "ok" && status !== "failed") {
        throw new Error(`插件 status 必须是 ok / failed：${String(status)}`)
    }
    return value as unknown as WellspringPlugin
}

function createLogger(): Logger {
    const make = (bindings: Record<string, unknown> = {}): Record<string, unknown> => {
        const log =
            (level: string) =>
            (first: unknown, second?: unknown): void => {
                const fields = isObject(first) ? first : bindings
                const message = isObject(first) ? String(second ?? "") : String(first ?? "")
                bridgeNotify("host.log", { level, message, fields })
            }
        const logger: Record<string, unknown> = {
            trace: log("trace"),
            debug: log("debug"),
            info: log("info"),
            warn: log("warn"),
            error: log("error"),
            fatal: log("fatal"),
            child: (childBindings: Record<string, unknown>) =>
                make({ ...bindings, ...childBindings }),
        }
        return logger
    }
    return make() as unknown as Logger
}

const logger = createLogger()

const output: HostOutput = {
    info: (text) => bridgeNotify("host.output", { kind: "info", text }),
    warn: (text) => bridgeNotify("host.output", { kind: "warn", text }),
    error: (text) => bridgeNotify("host.output", { kind: "error", text }),
    print: (text = "") => bridgeNotify("host.output", { kind: "print", text }),
}

type FileApiCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

function fileApi(root: string | (() => string), call: FileApiCall): HostFileApi {
    return {
        get root(): string {
            return typeof root === "string" ? root : root()
        },
        async readText(path) {
            const result = (await call("readText", { path })) as { text: string | null }
            return result.text
        },
        async readBytes(path) {
            const result = (await call("readBytes", { path })) as { data: string | null }
            if (result.data === null) {
                return null
            }
            return new Uint8Array(Buffer.from(result.data, "base64"))
        },
        async readJson<T = unknown>(path: string) {
            const result = (await call("readJson", { path })) as { value: T | null }
            return result.value
        },
        async writeText(path, text) {
            await call("writeText", { path, text })
        },
        async writeBytes(path, bytes) {
            await call("writeBytes", {
                path,
                data: Buffer.from(bytes).toString("base64"),
            })
        },
        async writeJson(path, value) {
            await call("writeJson", { path, value })
        },
        async list(path = "") {
            const result = (await call("list", { path })) as { entries: HostFileEntry[] }
            return result.entries
        },
        async stat(path) {
            const result = (await call("stat", { path })) as { stat: HostFileStat | null }
            return result.stat
        },
        async mkdir(path) {
            await call("mkdir", { path })
        },
        async remove(path) {
            await call("remove", { path })
        },
        async exists(path) {
            const result = (await call("exists", { path })) as { exists: boolean }
            return result.exists
        },
    }
}

/*
 * workspace 的真实根目录，由宿主应答带回
 *
 * 插件进程看到的是挂载后视图（bwrap 下为 /workspace）
 * workspaceFs 应答带 root，取最近一次
 */
let workspaceRoot = ""

function createFileApi(scope: "fs" | "workspaceFs", dataRoot = ""): HostFileApi {
    const call = async (method: string, params: Record<string, unknown> = {}) => {
        const result = (await bridgeRequest(`host.${scope}.${method}`, params)) as
            | { readonly root?: unknown }
            | null
            | undefined
        if (scope === "workspaceFs" && typeof result?.root === "string" && result.root !== "") {
            workspaceRoot = result.root
        }
        return result
    }
    return scope === "workspaceFs" ? fileApi(() => workspaceRoot, call) : fileApi(dataRoot, call)
}

function createRootedFileApi(root: string): HostFileApi {
    return fileApi(root, (method, params = {}) =>
        bridgeRequest(`host.fileRoots.${method}`, { root, ...params }),
    )
}

function patchConsole(): void {
    const methods: Array<[string, string]> = [
        ["log", "info"],
        ["info", "info"],
        ["debug", "debug"],
        ["warn", "warn"],
        ["error", "error"],
        ["trace", "trace"],
        ["dir", "info"],
        ["table", "info"],
    ]
    for (const [method, level] of methods) {
        ;(console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (
            ...args: unknown[]
        ): void => {
            bridgeNotify("host.console", { level, args: args.map((item) => String(item)) })
        }
    }
    console.assert = (condition: unknown, ...args: unknown[]): void => {
        if (!condition) {
            bridgeNotify("host.console", { level: "error", args: args.map(String) })
        }
    }
}

function patchProcessStreams(): void {
    process.stdout.write = ((chunk: unknown): boolean => {
        bridgeNotify("host.log", { level: "info", message: String(chunk), fields: {} })
        return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: unknown): boolean => {
        bridgeNotify("host.log", { level: "error", message: String(chunk), fields: {} })
        return true
    }) as typeof process.stderr.write
}

function remotePluginData(targetId: string): HostFileApi {
    const call = async (method: string, args: unknown[]): Promise<unknown> =>
        await bridgeRequest("host.pluginData", { targetId, method, args })
    return {
        root: "",
        async readText(path) {
            return (await call("readText", [path])) as string | null
        },
        async readBytes(path) {
            const value = (await call("readBytes", [path])) as number[] | null
            return value === null ? null : Uint8Array.from(value)
        },
        async readJson<T = unknown>(path: string) {
            return (await call("readJson", [path])) as T | null
        },
        async writeText(path, text) {
            await call("writeText", [path, text])
        },
        async writeBytes(path, bytes) {
            await call("writeBytes", [path, [...bytes]])
        },
        async writeJson(path, value) {
            await call("writeJson", [path, value])
        },
        async list(path = "") {
            return (await call("list", [path])) as HostFileEntry[]
        },
        async stat(path) {
            return (await call("stat", [path])) as HostFileStat | null
        },
        async mkdir(path) {
            await call("mkdir", [path])
        },
        async remove(path) {
            await call("remove", [path])
        },
        async exists(path) {
            return (await call("exists", [path])) as boolean
        },
    }
}

async function bootstrap(params: ConfigurePayload): Promise<{
    plugin: { id: string; name: string; version: string; status: PluginStatus; deps: string[] }
    commands: Array<{
        name: string
        summary: string
        usage?: string
        aliases?: readonly string[]
    }>
    agentTools: Array<{
        name: string
        introduction: { params: Record<string, unknown>; content: string }
    }>
    hooks: string[]
}> {
    const hostData = params.host
    hostSnapshot =
        hostData === null
            ? null
            : {
                  getStatus: () => hostData.status,
                  getOS: () => hostData.os,
                  getPaths: () => hostData.paths,
                  getPlugins: () =>
                      hostData.plugins.map((plugin) => ({
                          id: plugin.id,
                          name: plugin.name,
                          version: plugin.version,
                          deps: plugin.deps,
                          commands: plugin.commands,
                          getStatus: () => plugin.status,
                      })),
              }
    const pluginId = params.pluginId
    const commands: PluginCommand[] = []
    const agentTools: AgentTool[] = []
    /** init 里注册的版本探针；宿主通过 plugin.getLatestVersion 请求取最新版本 */
    let versionProbe: PluginVersionProbe | null = null

    const api: PluginApi = {
        apiVersion: 1,
        plugin: { id: pluginId, name: params.pluginName, version: params.pluginVersion },
        paths: params.paths,
        config: params.config,
        logger,
        output,
        pluginDataDir: params.pluginDataDir,
        pluginConfig: params.pluginConfig,
        fs: createFileApi("fs", params.pluginDataDir),
        workspaceFs: createFileApi("workspaceFs"),
        fileRoots: {
            async open(root: string): Promise<HostFileApi> {
                const result = (await bridgeRequest("host.fileRoots.open", { root })) as {
                    root: string
                }
                return createRootedFileApi(result.root)
            },
        },
        registerCommand: (command: PluginCommand): void => {
            commands.push(command)
        },
        registerAgentTool: (tool: AgentTool): void => {
            agentTools.push(tool)
        },
        registerVersionProbe: (probe: PluginVersionProbe): void => {
            if (typeof probe !== "function") {
                throw new TypeError("版本探针必须是函数")
            }
            // 每个插件一个探针，重复注册报错
            if (versionProbe !== null || (runtime !== null && runtime.versionProbe !== null)) {
                throw new Error("版本探针已经注册过，每个插件只能注册一个")
            }
            versionProbe = probe
            // runtime 在 bootstrap 创建，init 后回填探针
            // 不回填则 plugin.getLatestVersion 始终读到 null
            if (runtime !== null) {
                runtime.versionProbe = probe
            }
        },
        pluginData: async (targetId: string): Promise<HostFileApi | null> => {
            return remotePluginData(targetId)
        },
        capabilities: {
            async executeCode(input: unknown) {
                // 沙箱自己的命令超时最长 600s，RPC 用更长的上限，避免宿主先放弃等待
                return await bridgeRequest(
                    "host.capabilities.executeCode",
                    input as Record<string, unknown>,
                    RPC_TIMEOUT_MS.sandboxExec,
                )
            },
            async startBackgroundCode(input: unknown) {
                return await bridgeRequest(
                    "host.capabilities.startBackgroundCode",
                    input as Record<string, unknown>,
                )
            },
            async queryTask(taskId?: string) {
                return await bridgeRequest("host.capabilities.queryTask", { taskId })
            },
            async stopTask(taskId: string | undefined, mode: string) {
                return await bridgeRequest("host.capabilities.stopTask", { taskId, mode })
            },
            async webSearch(query: string, count?: number) {
                return await bridgeRequest("host.capabilities.webSearch", { query, count })
            },
            async webFetch(url: string) {
                return await bridgeRequest("host.capabilities.webFetch", { url })
            },
        } as never,
        http: remoteHttp(),
        agent: remoteAgent(),
        models: remoteModels(),
        network: remoteNetwork(),
        plugins: remotePlugins(),
        workspaces: remoteWorkspaces(),
        exec: remoteExec(),
        pty: remotePty(),
    }

    const module = (await withHookOwner(pluginId, async () => {
        return (await import(pathToFileURL(params.pluginEntry).href)) as { setup?: unknown }
    })) as { setup?: unknown }

    if (typeof module.setup !== "function") {
        throw new Error("入口需要导出 setup() 函数")
    }

    let created: WellspringPlugin | null = null
    await withHookOwner(pluginId, async () => {
        const declared = validatePlugin(await (module.setup as () => unknown)())
        if (declared.status !== "ok") {
            throw new Error(`插件自报状态：${declared.status}`)
        }
        /*
         * 版本以 package.json 为准：清单是分发单位，插件自己再写一遍只会漂移
         * （plugin list 读清单、网页读 setup() 返回值，两处曾出现过不同数字）
         */
        if (params.pluginVersion !== declared.version) {
            logger.warn(
                `插件 version 以 package.json 为准：${pluginId} 声明 ${declared.version}，清单 ${params.pluginVersion}`,
            )
        }
        created = { ...declared, version: params.pluginVersion }
        commands.push(...(created.commands ?? []))
        agentTools.push(...(created.agentTools ?? []))
    })
    if (created === null) {
        throw new Error("插件未初始化")
    }
    const plugin: WellspringPlugin = created
    const current: PluginRuntime = {
        owner: pluginId,
        plugin,
        commands,
        agentTools,
        hooks: listHookKinds(pluginId),
        api,
        versionProbe,
        initialized: false,
    }
    runtime = current
    if (params.deferInit !== true) {
        await initializeRuntime(current)
    }
    return readyOf(current)
}

async function initializeRuntime(current: PluginRuntime): Promise<void> {
    if (current.initialized) {
        return
    }
    await withHookOwner(current.owner, async () => {
        await current.plugin.init?.(current.api)
    })
    for (const tool of current.agentTools) {
        if (typeof tool.name !== "string" || typeof tool.call !== "function") {
            throw new Error("Agent 工具缺少 name / call")
        }
    }
    current.initialized = true
    current.hooks = listHookKinds(current.owner)
}

function readyOf(current: PluginRuntime): {
    plugin: { id: string; name: string; version: string; status: PluginStatus; deps: string[] }
    commands: Array<{
        name: string
        summary: string
        usage?: string
        aliases?: readonly string[]
    }>
    agentTools: Array<{
        name: string
        introduction: { params: Record<string, unknown>; content: string }
    }>
    hooks: string[]
    /** init 里是否注册了版本探针 */
    hasVersionProbe: boolean
} {
    return {
        plugin: {
            id: current.plugin.id,
            name: current.plugin.name,
            version: current.plugin.version,
            status: current.plugin.status,
            deps: [...(current.plugin.deps ?? [])],
        },
        commands: current.commands.map((command) => ({
            name: command.name,
            summary: command.summary,
            usage: command.usage,
            aliases: command.aliases,
        })),
        agentTools: current.agentTools.map((tool) => ({
            name: tool.name,
            introduction: {
                params: { ...tool.introduction.params },
                content: tool.introduction.content,
            },
        })),
        hooks: current.hooks.map((kind) => HOOK_API_NAME[kind]),
        hasVersionProbe: current.versionProbe !== null,
    }
}

async function dispatchHook(name: string, payload: Record<string, unknown>): Promise<unknown> {
    switch (name) {
        case "onMessage":
            await emitOnMessage(payload as never)
            return { prompt: (payload["prompt"] as string[] | undefined) ?? [] }
        case "onSessionStart":
            await emitSessionStart(payload as never)
            return { prompt: (payload["prompt"] as string[] | undefined) ?? [] }
        case "beforeTurn":
            await emitBeforeTurn(payload as never)
            return {}
        case "beforeStep":
            await emitBeforeStep(payload as never)
            return {}
        case "afterStep":
            await emitAfterStep(payload as never)
            return {}
        case "afterTurn":
            await emitAfterTurn(payload as never)
            return {}
        case "onAgentRunSync":
            await emitAgentRunSync(payload as never)
            return {}
        case "onAgentRunAsync":
            await emitAgentRunAsync(payload as never)
            return {}
        case "onAgentAsyncTaskComplete":
            await emitAgentAsyncTaskComplete(payload as never)
            return {}
        case "onAgentCallTool":
            await emitAgentCallTool(payload as never)
            return {}
        case "onAgentAsk":
            await emitAgentAsk(payload as never)
            return {}
        case "onAgentRead":
            await emitAgentRead(payload as never)
            return {}
        case "onAgentQueryTask":
            await emitAgentQueryTask(payload as never)
            return {}
        case "onAgentSubmit":
            await emitAgentSubmit(payload as never)
            return {}
        case "onAgentSetTasks":
            await emitAgentSetTasks(payload as never)
            return {}
        case "onAgentSetGoal":
            await emitAgentSetGoal(payload as never)
            return {}
        case "onAgentRequestPermission":
            await emitAgentRequestPermission(payload as never)
            return {}
        case "onUserAnswer":
            await emitUserAnswer(payload as never)
            return {}
        case "onInit":
            await emitInitHooks()
            return {}
        case "onShutdown":
            await emitShutdownHooks()
            return {}
        default:
            throw new Error(`未知钩子：${name}`)
    }
}

async function runCommand(request: RpcRequest): Promise<unknown> {
    if (runtime === null) {
        throw new Error("插件尚未初始化")
    }
    const params = request.params as {
        name: string
        argv: string[]
        cwd: string
        json: boolean
        stdin?: string
    }
    const command = runtime.commands.find((item) => item.name === params.name)
    if (command === undefined) {
        throw new Error(`命令不存在：${params.name}`)
    }
    const context: PluginCommandContext = {
        argv: params.argv,
        env: {},
        paths: runtime.api.paths,
        config: runtime.api.config,
        logger,
        output,
        pluginDataDir: runtime.api.pluginDataDir,
        pluginConfig: runtime.api.pluginConfig,
        fs: runtime.api.fs,
        workspaceFs: runtime.api.workspaceFs,
        cwd: params.cwd,
        json: params.json,
        stdin: Readable.from([params.stdin ?? ""]),
        stdout: process.stdout,
        stderr: process.stderr,
    }
    const code = await withHookOwner(runtime.owner, async () => await command.run(context))
    return { exitCode: typeof code === "number" ? code : 0 }
}

async function handleHostRequest(request: RpcRequest): Promise<void> {
    try {
        let result: unknown
        if (request.method === "plugin.command") {
            result = await runCommand(request)
        } else if (request.method === "plugin.agentTool") {
            if (runtime === null) {
                throw new Error("插件尚未初始化")
            }
            const params = request.params as { name: string; args: unknown }
            const tool = runtime.agentTools.find((item) => item.name === params.name)
            if (tool === undefined) {
                throw new Error(`Agent 工具不存在：${params.name}`)
            }
            /* 身份在 RPC 信封上，不在工具参数里 */
            const contextId =
                typeof request.contextId === "string" && request.contextId !== ""
                    ? request.contextId
                    : undefined
            result = await withHookOwner(runtime.owner, async () => {
                const invoke = async (): Promise<AgentCallToolResult> =>
                    (await tool.call(params.args)) as AgentCallToolResult
                return contextId === undefined
                    ? await invoke()
                    : await toolContext.run(contextId, invoke)
            })
        } else if (request.method === "plugin.getLatestVersion") {
            if (runtime === null) {
                throw new Error("插件尚未初始化")
            }
            /*
             * 探针由插件在 init 里注册，可能查网络：这里不加额外超时，
             * 由宿主的检查更新统一控制（超时就放弃这一项，不影响其它插件）
             * 原样透传：字符串或 { version, downloadUrl }，校验交给宿主
             */
            const probe = runtime.versionProbe
            result = probe === null ? null : await withHookOwner(runtime.owner, probe)
        } else if (request.method === "plugin.init") {
            if (runtime === null) {
                throw new Error("插件尚未初始化")
            }
            await initializeRuntime(runtime)
            result = readyOf(runtime)
        } else if (request.method === "plugin.websocket.connect") {
            if (runtime === null) {
                throw new Error("插件尚未初始化")
            }
            const params = request.params as {
                serverId: string
                connectionId: string
                request: HttpRequest
            }
            const handler = websocketHandlers.get(params.serverId)
            if (handler === undefined) {
                throw new Error("WebSocket handler 不存在")
            }
            const connectionId = params.connectionId
            const socket: PluginWebSocket = {
                connectionId,
                async send(data: string) {
                    await bridgeRequest("host.websocket.send", { connectionId, data })
                },
                async close(code = 1000, reason = "") {
                    await bridgeRequest("host.websocket.close", {
                        connectionId,
                        code,
                        reason,
                    })
                },
                onMessage(handler) {
                    const list = wsMessages.get(connectionId) ?? []
                    list.push(handler)
                    wsMessages.set(connectionId, list)
                },
                onClose(handler) {
                    const list = wsCloses.get(connectionId) ?? []
                    list.push(handler)
                    wsCloses.set(connectionId, list)
                },
            }
            await withHookOwner(runtime.owner, async () => handler(socket, params.request))
            result = {}
        } else if (request.method === "plugin.websocket.message") {
            const params = request.params as {
                connectionId: string
                data: string
                binary: boolean
            }
            const text = params.binary
                ? Buffer.from(params.data, "base64").toString("utf8")
                : Buffer.from(params.data, "base64").toString("utf8")
            for (const handler of wsMessages.get(params.connectionId) ?? []) {
                handler(text)
            }
            result = {}
        } else if (request.method === "plugin.websocket.close") {
            const params = request.params as {
                connectionId: string
                code: number
                reason: string
            }
            for (const handler of wsCloses.get(params.connectionId) ?? []) {
                handler(params.code, params.reason)
            }
            wsMessages.delete(params.connectionId)
            wsCloses.delete(params.connectionId)
            result = {}
        } else if (request.method === "plugin.http") {
            if (runtime === null) {
                throw new Error("插件尚未初始化")
            }
            const params = request.params as {
                serverId: string
                requestId: string
                request: HttpRequest
            }
            const handler = httpHandlers.get(params.serverId)
            if (handler === undefined) {
                throw new Error(`HTTP handler 不存在：${params.serverId}`)
            }
            const requestId = params.requestId
            let flushed = false
            let ended = false
            const buffered: string[] = []
            const flush = (): void => {
                if (flushed) {
                    return
                }
                flushed = true
                for (const chunk of buffered) {
                    bridgeNotify("host.http.stream", { requestId, chunk })
                }
                buffered.length = 0
                if (ended) {
                    bridgeNotify("host.http.stream", { requestId, end: true })
                }
            }
            const stream = {
                write(chunk: string) {
                    if (flushed) {
                        bridgeNotify("host.http.stream", { requestId, chunk })
                    } else {
                        buffered.push(chunk)
                    }
                },
                end() {
                    if (flushed) {
                        bridgeNotify("host.http.stream", { requestId, end: true })
                    } else {
                        ended = true
                    }
                },
            }
            const response = (await withHookOwner(runtime.owner, async () =>
                handler(params.request, stream),
            )) as HttpResponse
            if (response.stream === true) {
                setImmediate(flush)
            }
            result = response
        } else if (request.method === "plugin.hook") {
            const params = request.params as { hook: string; payload: Record<string, unknown> }
            if (runtime === null) {
                throw new Error("插件尚未初始化")
            }
            result = await withHookOwner(runtime.owner, async () =>
                dispatchHook(params.hook, params.payload),
            )
        } else if (request.method === "sandbox.ping") {
            result = { time: Date.now() }
        } else if (request.method === "sandbox.shutdown") {
            await emitShutdownHooks()
            result = {}
            writeFrame({ v: 1, type: "response", id: request.id, ok: true, result })
            setTimeout(() => process.exit(0), 10)
            return
        } else {
            throw new Error(`未知方法：${request.method}`)
        }
        writeFrame({ v: 1, type: "response", id: request.id, ok: true, result })
    } catch (error) {
        writeFrame({
            v: 1,
            type: "response",
            id: request.id,
            ok: false,
            error: {
                code:
                    request.method === "plugin.hook"
                        ? "plugin.hook-failed"
                        : "plugin.command-failed",
                message: error instanceof Error ? error.message : String(error),
            },
        })
    }
}

const configureResolvers: Array<(params: ConfigurePayload) => void> = []

async function main(): Promise<void> {
    const decoder = new FrameDecoder()
    process.stdin.on("data", async (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
            if (message.type === "response") {
                const entry = pending.get(message.id)
                if (entry !== undefined) {
                    pending.delete(message.id)
                    if (message.ok) {
                        entry.resolve(message.result)
                    } else {
                        entry.reject(new Error(message.error?.message ?? "host RPC 失败"))
                    }
                }
                continue
            }
            if (message.type === "event") {
                /*
                 * 事件回调出错不能拖垮 stdin 读取
                 *
                 * 这里在 data 监听里同步执行插件侧回调；一旦抛出就是未捕获异常，
                 * 插件可能直接挂掉或丢掉这一帧里剩下的事件——宿主还在跑、界面却再也
                 * 收不到任何事件，表现就是「服务端一直有日志、页面卡住不动」。
                 */
                try {
                    if (message.method === "sandbox.event") {
                        const params = message.params as { name: string; data: unknown }
                        eventBus.receive(params.name, params.data)
                    } else if (message.method === "sandbox.agent.stream") {
                        const params = message.params as {
                            streamId: string
                            event: HostAgentStreamEvent
                        }
                        agentStreamHandlers.get(params.streamId)?.(params.event)
                    }
                } catch (error) {
                    process.stderr.write(
                        `事件处理失败（${message.method}）：${error instanceof Error ? error.message : String(error)}\n`,
                    )
                }
                continue
            }
            const request = message
            if (request.method === "sandbox.configure") {
                const params = request.params as ConfigurePayload
                try {
                    patchConsole()
                    patchProcessStreams()
                    const ready = await bootstrap(params)
                    writeFrame({ v: 1, type: "response", id: request.id, ok: true, result: ready })
                } catch (error) {
                    writeFrame({
                        v: 1,
                        type: "response",
                        id: request.id,
                        ok: false,
                        error: {
                            code: "plugin.init-failed",
                            message: error instanceof Error ? error.message : String(error),
                        },
                    })
                    setTimeout(() => process.exit(1), 10)
                }
                continue
            }
            void handleHostRequest(request)
        }
    })
    process.stdin.resume()
    await new Promise<void>(() => undefined)
}

await main()
