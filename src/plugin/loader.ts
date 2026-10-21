/*
 * 插件加载。
 * 扫描 <dataDir>/plugins/*，import 入口后调用 setup() 拿到 WellspringPlugin，
 * 注册 commands、执行可选 init(api)；插件内 console.* 会被拦截并转进 Pino child logger。
 */

import { cp, readdir, rm, stat, symlink } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { Logger } from "pino"

import { removeHooksByOwner, withHookOwner } from "../api/host/hooks.ts"
import type { HostOutput, PluginApi, PluginCommand, WellspringPlugin } from "../api/host/plugin.ts"
import { HOST_API_VERSION } from "../api/host/version.ts"
import type { AppSetting } from "../config/types.ts"
import { getElog } from "../logger/elog4js.ts"
import { ensureDir, readJsonIfExists } from "../platform/file.ts"
import { getPaths, type ResolvedPaths } from "../platform/path.ts"
import { withConsoleGuard } from "./console-guard.ts"
import { ensureHostAlias } from "./host-alias.ts"
import { PLUGIN_NAME, pluginsRoot } from "./paths.ts"
import { PluginRegistry } from "./registry.ts"

interface PluginPackageJson {
    readonly name?: string
    readonly version?: string
    readonly main?: string
    readonly wellspring?: {
        readonly apiVersion?: number
        readonly entry?: string
    }
}

export interface LoadedPlugin {
    readonly id: string
    readonly name: string
    readonly version: string
    readonly deps: readonly string[]
    readonly dir: string
    readonly status: "ok" | "failed"
    readonly commands: readonly string[]
    readonly error: string | null
}

export interface LoadPluginsOptions {
    readonly paths?: ResolvedPaths
    readonly config: AppSetting
    readonly logger: Logger
    readonly registry: PluginRegistry
}

const ENTRY_CANDIDATES = ["index.ts", "index.js", "index.mjs", "index.mts"]

function createHostOutput(pluginName: string): HostOutput {
    return {
        info: (text) => getElog().plugin("info", pluginName, text),
        warn: (text) => getElog().plugin("warn", pluginName, text),
        error: (text) => getElog().plugin("error", pluginName, text),
        print: (text = "") => getElog().plugin("info", pluginName, text),
    }
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
    const init = value["init"]
    if (init !== undefined && typeof init !== "function") {
        throw new Error("插件 init 必须是函数")
    }
    return value as unknown as WellspringPlugin
}

async function loadOne(
    entryDir: string,
    owner: string,
    options: LoadPluginsOptions,
    pkg: PluginPackageJson | null,
): Promise<LoadedPlugin> {
    const apiVersion = pkg?.wellspring?.apiVersion ?? HOST_API_VERSION
    const base = {
        id: owner,
        name: typeof pkg?.name === "string" ? pkg.name : owner,
        version: typeof pkg?.version === "string" ? pkg.version : "0.0.0",
        deps: [] as readonly string[],
        dir: entryDir,
    }

    if (apiVersion !== HOST_API_VERSION) {
        return {
            ...base,
            status: "failed",
            commands: [],
            error: `不支持的 apiVersion：${apiVersion}`,
        }
    }

    const entry = await resolveEntry(entryDir, pkg)
    if (entry === null) {
        return { ...base, status: "failed", commands: [], error: "找不到插件入口" }
    }

    const pluginLogger = options.logger.child({ plugin: owner })
    const output = createHostOutput(owner)
    const state: { plugin: WellspringPlugin | null } = { plugin: null }

    const api: PluginApi = {
        apiVersion: HOST_API_VERSION,
        plugin: { id: owner, name: owner, version: base.version },
        paths: options.paths ?? getPaths(),
        config: options.config,
        logger: pluginLogger,
        output,
        registerCommand: (command: PluginCommand): void => {
            options.registry.register(state.plugin?.id ?? owner, command)
        },
    }

    try {
        await withHookOwner(owner, async () => {
            await withConsoleGuard(owner, pluginLogger, async () => {
                const module = (await import(pathToFileURL(entry).href)) as { setup?: unknown }
                if (typeof module.setup !== "function") {
                    throw new Error("入口需要导出 setup() 函数")
                }
                const created = await (module.setup as () => unknown)()
                const registered = validatePlugin(created)
                state.plugin = registered

                for (const command of registered.commands ?? []) {
                    options.registry.register(registered.id, command)
                }

                if (registered.init !== undefined) {
                    const initApi: PluginApi = {
                        ...api,
                        plugin: {
                            id: registered.id,
                            name: registered.name,
                            version: registered.version,
                        },
                        logger: options.logger.child({ plugin: registered.id }),
                    }
                    await registered.init(initApi)
                }
            })
        })
    } catch (error) {
        options.registry.removePlugin(state.plugin?.id ?? owner)
        options.registry.removePlugin(owner)
        removeHooksByOwner(owner)
        return { ...base, status: "failed", commands: [], error: errorText(error) }
    }

    const plugin = state.plugin
    if (plugin === null) {
        return { ...base, status: "failed", commands: [], error: "setup() 未返回插件" }
    }

    const commands = options.registry
        .list()
        .filter((record) => record.pluginName === plugin.id)
        .map((record) => record.command.name)

    return {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        deps: plugin.deps ?? [],
        dir: entryDir,
        status: "ok",
        commands,
        error: null,
    }
}

/** 加载全部插件。坏插件记录失败状态，不影响其他插件 */
export async function loadPlugins(options: LoadPluginsOptions): Promise<readonly LoadedPlugin[]> {
    ensureHostAlias()
    const root = pluginsRoot(options.paths)
    await ensureDir(root)

    let names: string[]
    try {
        names = (await readdir(root)).sort()
    } catch {
        return []
    }

    const loaded: LoadedPlugin[] = []
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

        let pkg: PluginPackageJson | null = null
        try {
            pkg = await readJsonIfExists<PluginPackageJson>(join(dir, "package.json"))
        } catch (error) {
            loaded.push({
                id: dirName,
                name: dirName,
                version: "0.0.0",
                deps: [],
                dir,
                status: "failed",
                commands: [],
                error: `package.json 无法解析：${errorText(error)}`,
            })
            continue
        }

        const owner =
            typeof pkg?.name === "string" && PLUGIN_NAME.test(pkg.name) ? pkg.name : dirName
        loaded.push(await loadOne(dir, owner, options, pkg))
    }
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
