/*
 * 插件加载。
 * 先 import + setup() 收集元数据，再按 deps 拓扑排序，最后注册命令并执行 init(api)。
 * 支持 plugins-state.json 禁用插件；坏插件只记录失败，不影响其他插件。
 */

import { cp, lstat, readdir, readlink, rm, stat, symlink } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { Logger } from "pino"

import {
    configureHost,
    setHostPlugins,
    type HostPlugin,
    type HostPluginStatus,
} from "../api/host/host.ts"
import {
    emitInitHooksForOwner,
    emitShutdownHooksForOwner,
    removeHooksByOwner,
    withHookOwner,
} from "../api/host/hooks.ts"
import type {
    AgentTool,
    PluginCommand,
    PluginConfig,
    PluginLatestVersion,
    PluginStatus,
    WellspringPlugin,
} from "../api/host/plugin.ts"
import { HOST_API_VERSION } from "../api/host/version.ts"
import { DEFAULT_SETTINGS } from "../config/defaults.ts"
import { SETTING_FILE_NAME } from "../config/loader.ts"
import type { AppSetting, SandboxSetting } from "../config/types.ts"
import { getElog } from "../logger/elog4js.ts"
import { ensureDir, readJsonIfExists, removePath } from "../platform/file.ts"
import { getPaths, type ResolvedPaths } from "../platform/path.ts"
import { isLinux, isMacOS, isWindows } from "../platform/os.ts"
import { BwrapBackend } from "../sandbox/backends/bwrap.ts"
import { NodePermissionBackend } from "../sandbox/backends/node-permission.ts"
import { SeatbeltBackend } from "../sandbox/backends/seatbelt.ts"
import { PluginSandboxClient, type PluginSandboxPermissions } from "../sandbox/plugin-client.ts"
import type { HostMigrateApi } from "../api/host/migrate.ts"
import type { SandboxBackend } from "../sandbox/types.ts"
import { AgentToolRegistry } from "./agent-tools.ts"
import { createHostCapabilities } from "./capabilities.ts"
import { PluginDataService } from "./data-access.ts"
import { ensureAccessGuard } from "./access-guard.ts"
import { ensureHostAlias } from "./host-alias.ts"
import { PLUGIN_ID, listPluginDirs, pluginDirOf, pluginsRoot } from "./paths.ts"
import { PluginRegistry } from "./registry.ts"
import { createHostAgentService, type HostAgentService } from "./agent-service.ts"
import { createHostModelsService } from "./models-service.ts"
import { createHostNetworkService } from "./network-service.ts"
import { loadPluginConfig } from "./runtime.ts"
import { readPluginState, setPluginEnabled } from "./state.ts"
import { removeVersionProbe, setVersionProbe } from "./version-probes.ts"
import { createHostMigrator } from "./migrate.ts"
import {
    createHostPluginManager,
    type HostPluginManager,
    type PluginHotController,
    type PluginHotOutcome,
} from "./manage.ts"

interface PluginPackageJson {
    readonly name?: string
    readonly version?: string
    readonly main?: string
    readonly wellspring?: {
        readonly apiVersion?: number
        readonly entry?: string
        readonly sandbox?: unknown
    }
}

export type PluginLoadStatus = PluginStatus | "disabled"
export type { PluginStatus } from "../api/host/plugin.ts"

export interface LoadedPlugin {
    readonly id: string
    readonly name: string
    readonly version: string
    readonly deps: readonly string[]
    readonly dir: string
    readonly status: PluginLoadStatus
    readonly commands: readonly string[]
    readonly error: string | null
}

export interface LoadPluginsOptions {
    readonly paths?: ResolvedPaths
    readonly config: AppSetting
    readonly logger: Logger
    readonly registry: PluginRegistry
    readonly sandbox?: SandboxSetting
    readonly agentTools?: AgentToolRegistry
    /** 测试注入 */
    readonly dataAccess?: PluginDataService
    /** 测试注入；生产根据 sandbox.mode 探测 */
    readonly sandboxBackend?: SandboxBackend
    /** 测试注入；默认按 settings 构造 */
    readonly agent?: HostAgentService
}

/** 当前进程内的插件运行时；热启用/禁用用 */
interface RuntimeState {
    readonly options: LoadPluginsOptions
    readonly paths: ResolvedPaths
    readonly root: string
    readonly sandboxSetting: SandboxSetting
    readonly sandboxBackend: SandboxBackend | null
    readonly dataAccess: PluginDataService
    readonly agentService: HostAgentService
    readonly modelsService: ReturnType<typeof createHostModelsService>
    readonly networkService: ReturnType<typeof createHostNetworkService>
    pluginManager: HostPluginManager
    migrator: HostMigrateApi
    readonly queueHost: { current: Promise<void> }
    entries: PluginEntry[]
}

const runtimes = new Map<string, RuntimeState>()

const ENTRY_CANDIDATES = ["index.ts", "index.js", "index.mjs", "index.mts"]

function errorText(error: unknown): string {
    if (error instanceof Error) {
        const cause = error.cause
        return cause instanceof Error ? `${error.message}（${cause.message}）` : error.message
    }
    return String(error)
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function resolveEntry(dir: string, pkg: PluginPackageJson | null): Promise<string | null> {
    const candidates: string[] = []
    if (pkg?.wellspring?.entry !== undefined) {
        candidates.push(pkg.wellspring.entry)
    }
    if (pkg?.main !== undefined) {
        candidates.push(pkg.main)
    }
    candidates.push(...ENTRY_CANDIDATES)

    for (const candidate of candidates) {
        const file = resolve(dir, candidate)
        try {
            const info = await stat(file)
            if (info.isFile()) {
                return file
            }
        } catch {
            // 尝试下一个候选
        }
    }
    return null
}

function validatePlugin(value: unknown): WellspringPlugin {
    if (!isObject(value)) {
        throw new Error("setup() 必须返回 WellspringPlugin 对象")
    }
    const id = value["id"]
    const name = value["name"]
    const version = value["version"]
    if (typeof id !== "string" || !PLUGIN_ID.test(id)) {
        throw new Error(`插件 id 不合法：${String(id)}`)
    }
    if (typeof name !== "string" || name.trim() === "") {
        throw new Error(`插件 name 不合法：${String(name)}`)
    }
    if (typeof version !== "string" || version.trim() === "") {
        throw new Error(`插件 version 不合法：${String(version)}`)
    }
    const status = value["status"]
    if (status !== "ok" && status !== "failed") {
        throw new Error(`插件 status 必须是 ok / failed：${String(status)}`)
    }
    const deps = value["deps"]
    if (deps !== undefined) {
        if (!Array.isArray(deps) || deps.some((item) => typeof item !== "string")) {
            throw new Error("插件 deps 必须是字符串数组")
        }
    }
    const commands = value["commands"]
    if (commands !== undefined && !Array.isArray(commands)) {
        throw new Error("插件 commands 必须是数组")
    }
    const agentTools = value["agentTools"]
    if (agentTools !== undefined) {
        if (!Array.isArray(agentTools)) {
            throw new Error("插件 agentTools 必须是数组")
        }
        for (const tool of agentTools) {
            if (!isObject(tool) || typeof tool["name"] !== "string") {
                throw new Error("Agent 工具缺少 name")
            }
            if (!isObject(tool["introduction"]) || typeof tool["call"] !== "function") {
                throw new Error(`Agent 工具缺少 introduction / call：${tool["name"]}`)
            }
        }
    }
    const init = value["init"]
    if (init !== undefined && typeof init !== "function") {
        throw new Error("插件 init 必须是函数")
    }
    return value as unknown as WellspringPlugin
}

interface PluginEntry {
    /** 完整 id，可带 @scope 前缀；同时是启用状态与数据的 key */
    readonly id: string
    readonly dir: string
    readonly owner: string
    readonly pkg: PluginPackageJson | null
    readonly index: number
    plugin: WellspringPlugin | null
    error: string | null
    disabled: boolean
    sandboxClient: PluginSandboxClient | null
}

/**
 * 收集插件的版本探针
 *
 * 探针在 init 里注册，运行于 sandbox 进程，宿主侧存 RPC 包装
 * init 回报 hasVersionProbe 时才注册
 */
function attachVersionProbe(
    client: PluginSandboxClient,
    owner: string,
    ready: { readonly hasVersionProbe?: boolean },
): void {
    if (ready.hasVersionProbe !== true) {
        return
    }
    setVersionProbe(owner, async () => {
        const value = await client.getLatestVersion()
        if (value === null || value === undefined) {
            throw new Error("插件没有注册版本探针")
        }
        // 形态交给 version-probes 校验：字符串或 { version, downloadUrl }
        return value as string | PluginLatestVersion
    })
}

function ownerOf(id: string, pkg: PluginPackageJson | null): string {
    if (typeof pkg?.name === "string" && PLUGIN_ID.test(pkg.name)) {
        return pkg.name
    }
    return id
}

export function sandboxPermissions(pkg: PluginPackageJson | null): PluginSandboxPermissions {
    const raw = pkg?.wellspring?.sandbox
    const manifest =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {}
    const rawHostApi = manifest["hostApi"]
    const hostApi = Array.isArray(rawHostApi)
        ? rawHostApi.filter((item): item is string => typeof item === "string")
        : ["logger", "fs", "event", "getHost", "shutdown", "agent"]
    const rawFs = manifest["fs"]
    const fs =
        typeof rawFs === "object" && rawFs !== null && !Array.isArray(rawFs)
            ? (rawFs as Record<string, unknown>)
            : {}
    const read = Array.isArray(fs["read"])
        ? fs["read"].filter((item): item is string => typeof item === "string")
        : []
    const write = Array.isArray(fs["write"])
        ? fs["write"].filter((item): item is string => typeof item === "string")
        : []
    return {
        hostApi,
        workspaceRead: read.includes("${workspace}") || write.includes("${workspace}"),
        workspaceWrite: write.includes("${workspace}"),
        // 默认断网；插件要自己查更新（版本探针访问 npm）才在清单里显式声明
        network: manifest["network"] === true,
    }
}

async function loadEntry(
    id: string,
    dir: string,
    index: number,
    options: LoadPluginsOptions,
    disabled: ReadonlySet<string>,
    sandboxBackend: SandboxBackend | null,
    dataAccess: PluginDataService,
    sandboxSetting: SandboxSetting,
    agentService: HostAgentService,
    modelsService: ReturnType<typeof createHostModelsService>,
    networkService: ReturnType<typeof createHostNetworkService>,
    pluginManager: HostPluginManager,
    migrator: HostMigrateApi,
): Promise<PluginEntry> {
    let pkg: PluginPackageJson | null = null
    try {
        pkg = await readJsonIfExists<PluginPackageJson>(join(dir, "package.json"))
    } catch (error) {
        return {
            id,
            dir,
            owner: id,
            pkg: null,
            index,
            plugin: null,
            error: `package.json 无法解析：${errorText(error)}`,
            disabled: false,
            sandboxClient: null,
        }
    }

    const owner = ownerOf(id, pkg)
    const entry: PluginEntry = {
        id,
        dir,
        owner,
        pkg,
        index,
        plugin: null,
        error: null,
        disabled: disabled.has(id),
        sandboxClient: null,
    }
    if (entry.disabled) {
        return entry
    }

    const apiVersion = pkg?.wellspring?.apiVersion ?? HOST_API_VERSION
    if (apiVersion !== HOST_API_VERSION) {
        entry.error = `不支持的 apiVersion：${apiVersion}`
        return entry
    }

    const entryFile = await resolveEntry(dir, pkg)
    if (entryFile === null) {
        entry.error = "找不到插件入口"
        return entry
    }

    if (sandboxSetting.mode === "off") {
        entry.error = "sandbox.mode = off，插件禁止在宿主进程内运行"
        return entry
    }
    if (sandboxBackend === null) {
        entry.error = "sandbox backend 不可用（插件必须运行在 sandbox 内）"
        return entry
    }
    {
        let client: PluginSandboxClient | null = null
        try {
            const paths = options.paths ?? getPaths()
            const pluginConfig = await loadPluginConfig(owner, paths)
            client = new PluginSandboxClient({
                pluginId: owner,
                pluginName: typeof pkg?.name === "string" ? pkg.name : owner,
                pluginVersion: typeof pkg?.version === "string" ? pkg.version : "0.0.0",
                pluginDir: dir,
                pluginEntry: entryFile,
                paths,
                config: options.config,
                pluginConfig,
                backend: sandboxBackend,
                limits: {
                    timeoutMs: sandboxSetting.defaultTimeoutMs,
                    memoryMB: sandboxSetting.defaultMemoryMB,
                    pids: 64,
                    outputLimitBytes: sandboxSetting.outputLimitBytes,
                },
                logger: options.logger,
                permissions: sandboxPermissions(pkg),
                dataAccess,
                capabilities: createHostCapabilities({
                    config: options.config,
                    paths,
                    logger: options.logger,
                    settingsFile: join(paths.configDir, SETTING_FILE_NAME),
                }),
                agent: agentService,
                models: modelsService,
                network: networkService,
                plugins: pluginManager,
                migrate: migrator,
            })
            const ready = await client.start({ deferInit: true })
            entry.sandboxClient = client
            entry.plugin = {
                id: ready.plugin.id,
                name: ready.plugin.name,
                version: ready.plugin.version,
                status: ready.plugin.status,
                deps: ready.plugin.deps,
                commands: [],
            }
        } catch (error) {
            await client?.close().catch(() => undefined)
            entry.error = errorText(error)
            entry.plugin = null
            removeHooksByOwner(owner)
        }
        return entry
    }
}

async function cleanupEntry(entry: PluginEntry, options: LoadPluginsOptions): Promise<void> {
    if (entry.sandboxClient !== null) {
        await entry.sandboxClient.close().catch(() => undefined)
    }
    if (entry.plugin !== null) {
        options.registry.removePlugin(entry.plugin.id)
    }
    options.agentTools?.removePlugin(entry.plugin?.id ?? entry.owner)
    removeHooksByOwner(entry.owner)
    // 插件已经关掉了，探针再留着只会让检查更新报「sandbox 已关闭」
    removeVersionProbe(entry.owner)
    if (entry.plugin !== null) {
        removeVersionProbe(entry.plugin.id)
    }
}

/** 按 deps 做稳定拓扑排序；循环依赖 / 缺失依赖的节点会写入 error */
function sortByDeps(entries: readonly PluginEntry[]): PluginEntry[] {
    const byId = new Map<string, PluginEntry>()
    for (const entry of entries) {
        const id = entry.plugin?.id ?? entry.owner
        if (!byId.has(id)) {
            byId.set(id, entry)
        }
    }

    const active = entries.filter((entry) => entry.plugin !== null && entry.error === null)
    const indegree = new Map<PluginEntry, number>()
    const dependents = new Map<PluginEntry, PluginEntry[]>()

    for (const entry of active) {
        const deps = entry.plugin?.deps ?? []
        let count = 0
        for (const dep of deps) {
            const target = byId.get(dep)
            if (target === undefined) {
                entry.error = `依赖不存在：${dep}`
                break
            }
            if (target === entry) {
                entry.error = `循环依赖：${dep}`
                break
            }
            if (target.disabled) {
                entry.error = `依赖被禁用：${dep}`
                break
            }
            if (target.error !== null || target.plugin === null) {
                entry.error = `依赖不可用：${dep}`
                break
            }
            count += 1
            const list = dependents.get(target) ?? []
            list.push(entry)
            dependents.set(target, list)
        }
        if (entry.error === null) {
            indegree.set(entry, count)
        }
    }

    const ready = active
        .filter((entry) => entry.error === null && (indegree.get(entry) ?? 0) === 0)
        .sort((left, right) => left.index - right.index)
    const sorted: PluginEntry[] = []
    while (ready.length > 0) {
        const current = ready.shift()
        if (current === undefined) {
            break
        }
        sorted.push(current)
        for (const dependent of dependents.get(current) ?? []) {
            const remaining = (indegree.get(dependent) ?? 0) - 1
            indegree.set(dependent, remaining)
            if (remaining === 0) {
                ready.push(dependent)
                ready.sort((left, right) => left.index - right.index)
            }
        }
    }

    for (const entry of active) {
        if (entry.error === null && !sorted.includes(entry)) {
            entry.error = "循环依赖"
        }
    }
    return sorted
}

/** 加载全部插件。坏插件记录失败状态，不影响其他插件 */
function pluginIdOf(entry: PluginEntry): string {
    return entry.plugin?.id ?? entry.owner
}

/** 把当前 entries 写回宿主快照；热变更后管理页与 /api/host 立即反映 */
function publishHostPlugins(entries: readonly PluginEntry[], registry: PluginRegistry): void {
    setHostPlugins(
        entries.map((entry): HostPlugin => {
            const plugin = entry.plugin
            const id = pluginIdOf(entry)
            const commands =
                plugin === null || entry.error !== null || entry.disabled
                    ? []
                    : registry
                          .list()
                          .filter((record) => record.pluginName === id)
                          .map((record) => record.command.name)
            return {
                id,
                name:
                    plugin?.name ??
                    (typeof entry.pkg?.name === "string" ? entry.pkg.name : entry.owner),
                version:
                    plugin?.version ??
                    (typeof entry.pkg?.version === "string" ? entry.pkg.version : "0.0.0"),
                deps: plugin?.deps ?? [],
                commands,
                getStatus: (): HostPluginStatus =>
                    entry.disabled ? "disabled" : entry.error ? "failed" : "ok",
            }
        }),
    )
}

/** 依赖数据访问按运行中的插件刷新 */
function refreshDataAccess(state: RuntimeState): void {
    state.dataAccess.setPlugins(
        state.entries.map((entry) => ({
            id: pluginIdOf(entry),
            deps: entry.plugin?.deps ?? [],
        })),
    )
}

function runExclusive<T>(state: RuntimeState, task: () => Promise<T>): Promise<T> {
    const next = state.queueHost.current.then(task, task)
    state.queueHost.current = next.then(
        () => undefined,
        () => undefined,
    )
    return next
}

async function hotEnableEntry(state: RuntimeState, idOrDir: string): Promise<PluginHotOutcome> {
    const existing = state.entries.find(
        (entry) => entry.id === idOrDir || pluginIdOf(entry) === idOrDir || entry.owner === idOrDir,
    )
    if (
        existing !== undefined &&
        existing.plugin !== null &&
        existing.error === null &&
        existing.sandboxClient !== null
    ) {
        return { ok: true, id: existing.plugin.id, changed: false }
    }
    const id = existing?.id ?? idOrDir
    const dir = pluginDirOf(state.root, id)
    if (dir === null) {
        return { ok: false, id, error: "插件名不合法" }
    }
    const info = await stat(dir).catch(() => null)
    if (info === null || !info.isDirectory()) {
        return { ok: false, id, error: "plugin.not-found" }
    }
    if (existing !== undefined) {
        state.entries = state.entries.filter((entry) => entry !== existing)
    }
    const disabled = new Set(await readPluginState(state.paths))
    disabled.delete(id)
    const entry = await loadEntry(
        id,
        dir,
        state.entries.length,
        state.options,
        disabled,
        state.sandboxBackend,
        state.dataAccess,
        state.sandboxSetting,
        state.agentService,
        state.modelsService,
        state.networkService,
        state.pluginManager,
        state.migrator,
    )
    if (entry.plugin === null || entry.error !== null) {
        state.entries.push(entry)
        publishHostPlugins(state.entries, state.options.registry)
        return { ok: false, id: pluginIdOf(entry), error: entry.error ?? "插件加载失败" }
    }
    const plugin = entry.plugin
    for (const dep of plugin.deps ?? []) {
        const target = state.entries.find(
            (candidate) =>
                pluginIdOf(candidate) === dep &&
                candidate.plugin !== null &&
                candidate.error === null &&
                candidate.sandboxClient !== null,
        )
        if (target === undefined) {
            await cleanupEntry(entry, state.options)
            entry.error = `依赖未启动：${dep}`
            state.entries.push(entry)
            publishHostPlugins(state.entries, state.options.registry)
            return { ok: false, id: plugin.id, error: entry.error }
        }
    }
    if (entry.sandboxClient === null) {
        entry.error = "插件未运行在 sandbox 内"
        state.entries.push(entry)
        publishHostPlugins(state.entries, state.options.registry)
        return { ok: false, id: plugin.id, error: entry.error }
    }
    // 先恢复依赖图再执行 init：插件 init 里可能通过 api.pluginData 读取依赖插件的数据
    state.entries.push(entry)
    refreshDataAccess(state)
    publishHostPlugins(state.entries, state.options.registry)
    try {
        const ready = await entry.sandboxClient.initialize()
        attachVersionProbe(entry.sandboxClient, entry.owner, ready)
        for (const command of entry.sandboxClient.commandStubs()) {
            state.options.registry.register(ready.plugin.id, command)
        }
        for (const tool of entry.sandboxClient.agentToolStubs()) {
            state.options.agentTools?.register(ready.plugin.id, tool)
        }
        await setPluginEnabled(id, true, state.paths)
        await emitInitHooksForOwner(ready.plugin.id)
        refreshDataAccess(state)
        publishHostPlugins(state.entries, state.options.registry)
        return { ok: true, id: ready.plugin.id, changed: true }
    } catch (error) {
        entry.error = errorText(error)
        await cleanupEntry(entry, state.options)
        refreshDataAccess(state)
        publishHostPlugins(state.entries, state.options.registry)
        return { ok: false, id: plugin.id, error: entry.error }
    }
}

async function hotDisableEntry(state: RuntimeState, idOrDir: string): Promise<PluginHotOutcome> {
    const entry = state.entries.find(
        (candidate) =>
            candidate.id === idOrDir ||
            pluginIdOf(candidate) === idOrDir ||
            candidate.owner === idOrDir,
    )
    if (entry === undefined) {
        return { ok: false, id: idOrDir, error: "plugin.not-found" }
    }
    const id = pluginIdOf(entry)
    // 内置网页插件依赖热加载自身，只能走重启
    if (id === "wellspring-web" || entry.id === "wellspring-web") {
        return {
            ok: false,
            id,
            error: "wellspring-web 不支持热禁用，请走重启流程",
        }
    }
    const dependents = state.entries
        .filter((candidate) => {
            if (candidate === entry) return false
            if (candidate.plugin === null || candidate.error !== null) return false
            return (candidate.plugin.deps ?? []).includes(id)
        })
        .map(pluginIdOf)
    if (dependents.length > 0) {
        return {
            ok: false,
            id,
            dependents,
            error: `插件被依赖：${dependents.join(", ")}`,
        }
    }
    try {
        await emitShutdownHooksForOwner(entry.owner)
    } catch {
        // 关闭钩子的错误不阻止停用
    }
    await cleanupEntry(entry, state.options)
    // 留一个禁用占位，宿主快照与管理页仍能看到它
    entry.disabled = true
    entry.plugin = null
    entry.error = null
    entry.sandboxClient = null
    await setPluginEnabled(entry.id, false, state.paths)
    refreshDataAccess(state)
    publishHostPlugins(state.entries, state.options.registry)
    return { ok: true, id, changed: true }
}

async function hotForgetEntry(state: RuntimeState, idOrDir: string): Promise<void> {
    const entry = state.entries.find(
        (candidate) =>
            candidate.id === idOrDir ||
            pluginIdOf(candidate) === idOrDir ||
            candidate.owner === idOrDir,
    )
    if (entry === undefined) {
        return
    }
    state.entries = state.entries.filter((candidate) => candidate !== entry)
    refreshDataAccess(state)
    publishHostPlugins(state.entries, state.options.registry)
}

function controllerOf(state: RuntimeState): PluginHotController {
    return {
        hotEnable: (id: string) => runExclusive(state, () => hotEnableEntry(state, id)),
        hotDisable: (id: string) => runExclusive(state, () => hotDisableEntry(state, id)),
        hotForget: (id: string) => runExclusive(state, () => hotForgetEntry(state, id)),
    }
}

/** 取当前进程的插件热加载控制器；未经过 loadPlugins 时返回 null */
export function getPluginRuntime(paths: ResolvedPaths = getPaths()): PluginHotController | null {
    const state = runtimes.get(paths.dataDir)
    if (state === undefined) {
        return null
    }
    return controllerOf(state)
}

export async function hotEnablePlugin(
    id: string,
    paths: ResolvedPaths = getPaths(),
): Promise<PluginHotOutcome> {
    const runtime = getPluginRuntime(paths)
    if (runtime === null) {
        return { ok: false, id, error: "插件运行时未初始化" }
    }
    return await runtime.hotEnable(id)
}

export async function hotDisablePlugin(
    id: string,
    paths: ResolvedPaths = getPaths(),
): Promise<PluginHotOutcome> {
    const runtime = getPluginRuntime(paths)
    if (runtime === null) {
        return { ok: false, id, error: "插件运行时未初始化" }
    }
    return await runtime.hotDisable(id)
}

export async function loadPlugins(options: LoadPluginsOptions): Promise<readonly LoadedPlugin[]> {
    ensureHostAlias()
    ensureAccessGuard()
    const resolvedPaths = options.paths ?? getPaths()
    configureHost({ paths: resolvedPaths })
    const dataAccess = options.dataAccess ?? new PluginDataService(resolvedPaths)
    const root = pluginsRoot(options.paths)
    await ensureDir(root)

    const dirs = await listPluginDirs(root)

    const sandboxSetting: SandboxSetting = options.sandbox ?? {
        ...DEFAULT_SETTINGS.sandbox,
        mode: "best-effort",
    }
    let sandboxBackend: SandboxBackend | null = null
    if (sandboxSetting.mode !== "off") {
        if (options.sandboxBackend !== undefined) {
            sandboxBackend = options.sandboxBackend
        } else {
            /*
             * 按 backend 配置展开候选：bwrap（Linux）与 Seatbelt（macOS）
             * 显式指定不跨后端回退，auto 按平台挑
             */
            const candidates: SandboxBackend[] = []
            if (sandboxSetting.backend === "bwrap" || sandboxSetting.backend === "auto") {
                candidates.push(new BwrapBackend())
            }
            if (
                sandboxSetting.backend === "seatbelt" ||
                (sandboxSetting.backend === "auto" && isMacOS)
            ) {
                candidates.push(new SeatbeltBackend())
            }
            /*
             * win-restricted 只用于 Agent 代码执行；插件仍使用 Node permission model。
             * 显式配置该后端时，插件沙箱降级为 node-permission，避免插件全部拒绝加载。
             */
            if (sandboxSetting.backend === "win-restricted" && isWindows) {
                candidates.push(new NodePermissionBackend())
            }
            for (const candidate of candidates) {
                const status = await candidate.probe()
                if (status.available) {
                    sandboxBackend = candidate
                    break
                }
                options.logger?.warn(
                    { backend: candidate.name, reason: status.reason },
                    "插件 sandbox backend 不可用",
                )
            }
            if (sandboxBackend === null && sandboxSetting.backend === "auto" && !isLinux) {
                /*
                 * 非 Linux（Windows、Android/Termux）没有内核级后端，退回 Node permission model
                 * 只限制文件读写，仅给插件用，不做 Agent 命令后端
                 */
                const nodePermission = new NodePermissionBackend()
                const nodeStatus = await nodePermission.probe()
                if (nodeStatus.available) {
                    sandboxBackend = nodePermission
                    options.logger?.warn(
                        { backend: nodePermission.name, reason: nodeStatus.reason },
                        "使用受限插件 sandbox（Node permission model）",
                    )
                }
            }
        }
    }

    const agentService =
        options.agent ??
        createHostAgentService({
            settings: options.config,
            paths: resolvedPaths,
            logger: options.logger,
            registry: options.registry,
            agentTools: options.agentTools ?? new AgentToolRegistry(),
        })
    // 自定义供应商与模型切换：直接读写 app-setting.json，改完下一轮对话生效
    const modelsService = createHostModelsService({
        settings: options.config,
        settingsFile: join(resolvedPaths.configDir, SETTING_FILE_NAME),
        configDir: resolvedPaths.configDir,
        logger: options.logger,
    })
    const networkService = createHostNetworkService({
        settings: options.config,
        settingsFile: join(resolvedPaths.configDir, SETTING_FILE_NAME),
        logger: options.logger,
    })
    const state: RuntimeState = {
        options,
        paths: resolvedPaths,
        root,
        sandboxSetting,
        sandboxBackend,
        dataAccess,
        agentService,
        modelsService,
        networkService,
        pluginManager: null as unknown as HostPluginManager,
        // 与 pluginManager 一样先占位，创建后回填（控制器创建时就要拿到 state）
        migrator: null as unknown as HostMigrateApi,
        queueHost: { current: Promise.resolve() },
        entries: [],
    }
    const pluginManager = createHostPluginManager({
        paths: resolvedPaths,
        logger: options.logger,
        runtime: controllerOf(state),
    })
    state.pluginManager = pluginManager
    const migrator = createHostMigrator({ paths: resolvedPaths, logger: options.logger })
    state.migrator = migrator
    runtimes.set(resolvedPaths.dataDir, state)
    const disabled = await readPluginState(options.paths ?? getPaths())
    const entries: PluginEntry[] = []
    let index = 0
    for (const found of dirs) {
        entries.push(
            await loadEntry(
                found.id,
                found.dir,
                index,
                options,
                disabled,
                sandboxBackend,
                dataAccess,
                sandboxSetting,
                agentService,
                modelsService,
                networkService,
                pluginManager,
                migrator,
            ),
        )
        index += 1
    }

    state.entries = entries
    refreshDataAccess(state)
    const sorted = sortByDeps(entries)

    // 让 init/hook 期间也能看到宿主插件列表（命令列表在 finalize 后补全）
    publishHostPlugins(entries, options.registry)

    const finished = new Set<PluginEntry>()

    for (const entry of sorted) {
        const plugin = entry.plugin
        if (plugin === null || entry.error !== null) {
            continue
        }
        const deps = plugin.deps ?? []
        let blocked = false
        for (const dep of deps) {
            const target = entries.find(
                (candidate) => (candidate.plugin?.id ?? candidate.owner) === dep,
            )
            if (target === undefined || !finished.has(target)) {
                entry.error = `依赖未就绪：${dep}`
                blocked = true
                break
            }
        }
        if (blocked) {
            await cleanupEntry(entry, options)
            continue
        }
        if (entry.sandboxClient !== null) {
            try {
                const ready = await entry.sandboxClient.initialize()
                attachVersionProbe(entry.sandboxClient, entry.owner, ready)
                for (const command of entry.sandboxClient.commandStubs()) {
                    options.registry.register(ready.plugin.id, command)
                }
                for (const tool of entry.sandboxClient.agentToolStubs()) {
                    options.agentTools?.register(ready.plugin.id, tool)
                }
                finished.add(entry)
            } catch (error) {
                entry.error = errorText(error)
                await cleanupEntry(entry, options)
            }
            continue
        }
        entry.error = "插件未运行在 sandbox 内"
        await cleanupEntry(entry, options)
    }

    for (const entry of entries) {
        if (
            (entry.plugin !== null || entry.sandboxClient !== null) &&
            entry.error !== null &&
            !finished.has(entry)
        ) {
            await cleanupEntry(entry, options)
        }
    }

    const loaded: LoadedPlugin[] = entries.map((entry) => {
        const plugin = entry.plugin
        const base = {
            id: plugin?.id ?? entry.owner,
            name:
                plugin?.name ??
                (typeof entry.pkg?.name === "string" ? entry.pkg.name : entry.owner),
            version:
                plugin?.version ??
                (typeof entry.pkg?.version === "string" ? entry.pkg.version : "0.0.0"),
            deps: plugin?.deps ?? [],
            dir: entry.dir,
        }
        if (entry.disabled) {
            return { ...base, status: "disabled", commands: [], error: null }
        }
        if (plugin === null || entry.error !== null) {
            return {
                ...base,
                status: "failed",
                commands: [],
                error: entry.error ?? "插件加载失败",
            }
        }
        const commands = options.registry
            .list()
            .filter((record) => record.pluginName === plugin.id)
            .map((record) => record.command.name)
        return { ...base, status: "ok", commands, error: null }
    })

    state.entries = entries
    publishHostPlugins(entries, options.registry)
    return loaded
}

/**
 * 链接插件目录，开发用；没有符号链接权限时退化为复制
 *
 * 目标位置已有条目时按条目类型决定：
 * - 符号链接：指向同一个源则幂等返回，否则替换（源目录被删或改名后重链走这条路径）
 * - 真实目录：报「插件已存在」，不覆盖
 *
 * 存在性用 lstat：悬空符号链接的 stat 为 ENOENT，会被判成不存在，
 * 随后的 symlink 撞 EEXIST 再回落 cp，报 Cannot overwrite non-directory with directory
 */
export async function linkPlugin(
    sourcePath: string,
    paths: ResolvedPaths = getPaths(),
): Promise<string> {
    const source = resolve(sourcePath)
    const pkg = await readJsonIfExists<PluginPackageJson>(join(source, "package.json")).catch(
        () => null,
    )
    // id 取 package.json 的 name，缺失时用目录名
    const declared = typeof pkg?.name === "string" && PLUGIN_ID.test(pkg.name) ? pkg.name : null
    const name = declared ?? basename(source)
    if (!PLUGIN_ID.test(name)) {
        throw new Error(`插件目录名不合法：${name}`)
    }

    const sourceInfo = await stat(source).catch(() => null)
    if (sourceInfo === null || !sourceInfo.isDirectory()) {
        throw new Error(`源目录不存在或不是目录：${source}`)
    }

    const root = pluginsRoot(paths)
    const target = pluginDirOf(root, name)
    if (target === null) {
        throw new Error(`插件名不合法：${name}`)
    }
    // scope 目录要先建出来
    await ensureDir(dirname(target))

    const existing = await lstat(target).catch(() => null)
    if (existing !== null) {
        if (existing.isSymbolicLink()) {
            const previous = await readlink(target).catch(() => null)
            if (previous !== null && resolve(root, previous) === source) {
                return name
            }
            await rm(target, { force: true })
        } else {
            throw new Error(`插件已存在：${name}`)
        }
    }

    try {
        await symlink(source, target, "dir")
    } catch (error) {
        // 只有平台不支持符号链接才回落复制，其它错误原样抛
        const code = (error as NodeJS.ErrnoException).code ?? ""
        if (code !== "EPERM" && code !== "EACCES" && code !== "ENOSYS") {
            throw error
        }
        await cp(source, target, { recursive: true })
    }
    return name
}

/**
 * 删除插件目录
 *
 * 两个「说到做到」的约束：
 * - 删之前先看有没有：`rm` 带 force 时目标不存在也不报错，以前输入一个不存在的名字
 *   照样打印「已删除插件 xxx」，看着成功其实什么都没发生。
 * - 删完再确认一次：Windows 上目录被进程占成 cwd / 有句柄没关时会删不掉，
 *   这里等到重试也无用时给出可执行的说明，而不是把错误码直接丢给用户。
 */
export async function removePlugin(name: string, paths: ResolvedPaths = getPaths()): Promise<void> {
    const target = pluginDirOf(pluginsRoot(paths), name)
    if (target === null) {
        throw new Error(`插件名不合法：${name}`)
    }
    const existing = await lstat(target).catch(() => null)
    if (existing === null) {
        throw new Error(`插件不存在：${name}`)
    }
    try {
        await removePath(target)
    } catch (error) {
        throw new Error(describeRemoveFailure(error, target))
    }
    if ((await lstat(target).catch(() => null)) !== null) {
        throw new Error(`插件目录没有删掉，可能还有进程在用：${target}；先停止服务再试`)
    }
}

/** 删除失败的说明：Windows 的 EBUSY/EPERM 基本都是「还有进程占着」 */
function describeRemoveFailure(error: unknown, target: string): string {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? ""
    if (TRANSIENT_REMOVE_CODES.has(code)) {
        return (
            `插件目录被占用，删不掉：${target}；` +
            "先停掉正在运行的 Wellspring（wellspring stop）再卸载"
        )
    }
    return error instanceof Error ? error.message : String(error)
}

const TRANSIENT_REMOVE_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"])
