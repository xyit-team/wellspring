/*
 * 插件加载。
 * 扫描 <dataDir>/plugins/*，动态 import 入口，把 PluginApi 传给默认导出。
 * 插件在进程内运行，console.* 通过 withConsoleGuard 拦截并转进 Pino child logger。
 */

import { cp, readdir, rm, stat, symlink } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { Logger } from "pino"

import type { HostOutput, PluginApi, PluginCommand } from "../api/host/plugin.ts"
import { HOST_API_VERSION } from "../api/host/version.ts"
import type { AppSetting } from "../config/types.ts"
import { getElog } from "../logger/elog4js.ts"
import { ensureDir, readJsonIfExists } from "../platform/file.ts"
import { getPaths, type ResolvedPaths } from "../platform/path.ts"
import { withConsoleGuard } from "./console-guard.ts"
import { PluginRegistry } from "./registry.ts"

const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

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
    readonly name: string
    readonly version: string | null
    readonly apiVersion: number | null
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

/** 插件根目录 */
export function pluginsRoot(paths: ResolvedPaths = getPaths()): string {
    return join(paths.dataDir, "plugins")
}

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
    candidates.push("index.ts", "index.js", "index.mjs")

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

async function loadOne(
    entryDir: string,
    name: string,
    options: LoadPluginsOptions,
    pkg: PluginPackageJson | null,
): Promise<LoadedPlugin> {
    const apiVersion = pkg?.wellspring?.apiVersion ?? HOST_API_VERSION
    const version = pkg?.version ?? null
    const base = { name, version, apiVersion, dir: entryDir }

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

    const pluginLogger = options.logger.child({ plugin: name })
    const output = createHostOutput(name)

    const api: PluginApi = {
        apiVersion: HOST_API_VERSION,
        pluginName: name,
        paths: options.paths ?? getPaths(),
        config: options.config,
        logger: pluginLogger,
        output,
        registerCommand: (command: PluginCommand): void => {
            options.registry.register(name, command)
        },
    }

    try {
        await withConsoleGuard(name, pluginLogger, async () => {
            const module = (await import(pathToFileURL(entry).href)) as { default?: unknown }
            const register = module.default
            if (typeof register !== "function") {
                throw new Error("入口需要 default 导出 register(api) 函数")
            }
            await (register as (value: PluginApi) => void | Promise<void>)(api)
        })
    } catch (error) {
        options.registry.removePlugin(name)
        return { ...base, status: "failed", commands: [], error: errorText(error) }
    }

    const commands = options.registry
        .list()
        .filter((record) => record.pluginName === name)
        .map((record) => record.command.name)

    return { ...base, status: "ok", commands, error: null }
}

/** 加载全部插件。坏插件记录失败状态，不影响其他插件 */
export async function loadPlugins(options: LoadPluginsOptions): Promise<readonly LoadedPlugin[]> {
    const root = pluginsRoot(options.paths)
    await ensureDir(root)

    let names: string[]
    try {
        names = (await readdir(root)).sort()
    } catch {
        return []
    }

    const loaded: LoadedPlugin[] = []
    for (const name of names) {
        if (!PLUGIN_NAME.test(name)) {
            continue
        }
        const dir = join(root, name)
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
                name,
                version: null,
                apiVersion: null,
                dir,
                status: "failed",
                commands: [],
                error: `package.json 无法解析：${errorText(error)}`,
            })
            continue
        }

        loaded.push(await loadOne(dir, name, options, pkg))
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
    try {
        await stat(target)
        throw new Error(`插件已存在：${name}`)
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("插件已存在")) {
            throw error
        }
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
