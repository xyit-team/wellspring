/*
 * 插件加载。
 * 先 import + setup() 收集元数据，再按 deps 拓扑排序，最后注册命令并执行 init(api)。
 * 支持 plugins-state.json 禁用插件；坏插件只记录失败，不影响其他插件。
 */

import { cp, readdir, rm, stat, symlink } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { Logger } from "pino"

import {
    configureHost,
    setHostPlugins,
    type HostPlugin,
    type HostPluginStatus,
} from "../api/host/host.ts"
import { removeHooksByOwner, withHookOwner } from "../api/host/hooks.ts"
import type {
    AgentTool,
    PluginCommand,
    PluginConfig,
    PluginStatus,
    WellspringPlugin,
} from "../api/host/plugin.ts"
import { HOST_API_VERSION } from "../api/host/version.ts"
import { DEFAULT_SETTINGS } from "../config/defaults.ts"
import type { AppSetting, SandboxSetting } from "../config/types.ts"
import { getElog } from "../logger/elog4js.ts"
import { ensureDir, readJsonIfExists } from "../platform/file.ts"
import { getPaths, type ResolvedPaths } from "../platform/path.ts"
import { BwrapBackend } from "../sandbox/backends/bwrap.ts"
import { PluginSandboxClient, type PluginSandboxPermissions } from "../sandbox/plugin-client.ts"
import type { SandboxBackend } from "../sandbox/types.ts"
import { AgentToolRegistry } from "./agent-tools.ts"
import { createHostCapabilities } from "./capabilities.ts"
import { PluginDataService } from "./data-access.ts"
import { ensureAccessGuard } from "./access-guard.ts"
import { ensureHostAlias } from "./host-alias.ts"
import { PLUGIN_NAME, pluginsRoot } from "./paths.ts"
import { PluginRegistry } from "./registry.ts"
import { loadPluginConfig } from "./runtime.ts"
import { readPluginState } from "./state.ts"

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
}

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
    if (typeof id !== "string" || !PLUGIN_NAME.test(id)) {
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
    readonly dirName: string
    readonly dir: string
    readonly owner: string
    readonly pkg: PluginPackageJson | null
    readonly index: number
    plugin: WellspringPlugin | null
    error: string | null
    disabled: boolean
    sandboxClient: PluginSandboxClient | null
}

function ownerOf(dirName: string, pkg: PluginPackageJson | null): string {
    if (typeof pkg?.name === "string" && PLUGIN_NAME.test(pkg.name)) {
        return pkg.name
    }
    return dirName
}

function sandboxPermissions(pkg: PluginPackageJson | null): PluginSandboxPermissions {
    const raw = pkg?.wellspring?.sandbox
    const manifest =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {}
    const rawHostApi = manifest["hostApi"]
    const hostApi = Array.isArray(rawHostApi)
        ? rawHostApi.filter((item): item is string => typeof item === "string")
        : ["logger", "fs", "event", "getHost", "shutdown", "http"]
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
    }
}

async function loadEntry(
    dirName: string,
    dir: string,
    index: number,
    options: LoadPluginsOptions,
    disabled: ReadonlySet<string>,
    sandboxBackend: SandboxBackend | null,
    dataAccess: PluginDataService,
    sandboxSetting: SandboxSetting,
): Promise<PluginEntry> {
    let pkg: PluginPackageJson | null = null
    try {
        pkg = await readJsonIfExists<PluginPackageJson>(join(dir, "package.json"))
    } catch (error) {
        return {
            dirName,
            dir,
            owner: dirName,
            pkg: null,
            index,
            plugin: null,
            error: `package.json 无法解析：${errorText(error)}`,
            disabled: false,
            sandboxClient: null,
        }
    }

    const owner = ownerOf(dirName, pkg)
    const entry: PluginEntry = {
        dirName,
        dir,
        owner,
        pkg,
        index,
        plugin: null,
        error: null,
        disabled: disabled.has(dirName),
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
                }),
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
export async function loadPlugins(options: LoadPluginsOptions): Promise<readonly LoadedPlugin[]> {
    ensureHostAlias()
    ensureAccessGuard()
    const resolvedPaths = options.paths ?? getPaths()
    configureHost({ paths: resolvedPaths })
    const dataAccess = options.dataAccess ?? new PluginDataService(resolvedPaths)
    const root = pluginsRoot(options.paths)
    await ensureDir(root)

    let names: string[]
    try {
        names = (await readdir(root)).sort()
    } catch {
        return []
    }

    const sandboxSetting: SandboxSetting = options.sandbox ?? {
        ...DEFAULT_SETTINGS.sandbox,
        mode: "best-effort",
    }
    let sandboxBackend: SandboxBackend | null = null
    if (sandboxSetting.mode !== "off") {
        if (options.sandboxBackend !== undefined) {
            sandboxBackend = options.sandboxBackend
        } else if (sandboxSetting.backend === "auto" || sandboxSetting.backend === "bwrap") {
            const bwrap = new BwrapBackend()
            const status = await bwrap.probe()
            // 插件不做 direct 降级：没有 OS 后端就拒绝加载
            sandboxBackend = status.available ? bwrap : null
        }
    }

    const disabled = await readPluginState(options.paths ?? getPaths())
    const entries: PluginEntry[] = []
    let index = 0
    for (const dirName of names) {
        if (!PLUGIN_NAME.test(dirName) || dirName.startsWith(".")) {
            continue
        }
        const dir = join(root, dirName)
        try {
            const info = await stat(dir)
            if (!info.isDirectory()) {
                continue
            }
        } catch {
            continue
        }
        entries.push(
            await loadEntry(
                dirName,
                dir,
                index,
                options,
                disabled,
                sandboxBackend,
                dataAccess,
                sandboxSetting,
            ),
        )
        index += 1
    }

    dataAccess.setPlugins(
        entries.map((entry) => ({
            id: entry.plugin?.id ?? entry.owner,
            deps: entry.plugin?.deps ?? [],
        })),
    )
    const sorted = sortByDeps(entries)

    // 让 init/hook 期间也能看到宿主插件列表（命令列表在 finalize 后补全）
    setHostPlugins(
        entries.map((entry): HostPlugin => ({
            id: entry.plugin?.id ?? entry.owner,
            name:
                entry.plugin?.name ??
                (typeof entry.pkg?.name === "string" ? entry.pkg.name : entry.owner),
            version:
                entry.plugin?.version ??
                (typeof entry.pkg?.version === "string" ? entry.pkg.version : "0.0.0"),
            deps: entry.plugin?.deps ?? [],
            commands: [],
            getStatus: (): HostPluginStatus =>
                entry.disabled ? "disabled" : entry.error ? "failed" : "ok",
        })),
    )

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

    setHostPlugins(
        loaded.map((plugin): HostPlugin => ({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            deps: plugin.deps,
            commands: plugin.commands,
            getStatus: (): HostPluginStatus => plugin.status,
        })),
    )
    return loaded
}

/** 把本地插件目录链接进插件根目录，开发用；没有符号链接权限时退化为复制 */
export async function linkPlugin(
    sourcePath: string,
    paths: ResolvedPaths = getPaths(),
): Promise<string> {
    const source = resolve(sourcePath)
    const name = basename(source)
    if (!PLUGIN_NAME.test(name)) {
        throw new Error(`插件目录名不合法：${name}`)
    }
    const root = pluginsRoot(paths)
    await ensureDir(root)
    const target = join(root, name)

    const existing = await stat(target).catch(() => null)
    if (existing !== null) {
        throw new Error(`插件已存在：${name}`)
    }

    try {
        await symlink(source, target, "dir")
    } catch {
        await cp(source, target, { recursive: true })
    }
    return name
}

/** 删除插件目录 */
export async function removePlugin(name: string, paths: ResolvedPaths = getPaths()): Promise<void> {
    if (!PLUGIN_NAME.test(name)) {
        throw new Error(`插件名不合法：${name}`)
    }
    await rm(join(pluginsRoot(paths), name), { recursive: true, force: true })
}
