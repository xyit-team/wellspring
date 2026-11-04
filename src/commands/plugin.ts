/*
 * plugin 命令：list / new / install / update / link / enable / disable / remove。
 */

import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"

import { Result } from "../api/result/result.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { booleanValue, parseCommandArgs } from "../input/parse-options.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import { statIfExists } from "../platform/file.ts"
import { installPlugin } from "../plugin/install.ts"
import { linkPlugin, removePlugin } from "../plugin/loader.ts"
import { PLUGIN_ID, listPluginDirs, pluginDirOf, pluginsRoot } from "../plugin/paths.ts"
import { scaffoldPlugin } from "../plugin/scaffold.ts"
import { readPluginState, setPluginEnabled } from "../plugin/state.ts"
import { checkPluginUpdates, type PluginUpdateCheck } from "../plugin/version-probes.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

interface ScannedPlugin {
    /** 完整 id，可带 @scope 前缀 */
    readonly id: string
    readonly name: string
    readonly version: string
    readonly enabled: boolean
    readonly deps: readonly string[]
}

/** 只扫插件目录的文件，不启动插件进程（plugin list / enable / disable 用） */
async function scanPluginDirs(paths: ResolvedPaths): Promise<ScannedPlugin[]> {
    const root = pluginsRoot(paths)
    const disabled = await readPluginState(paths)
    const plugins: ScannedPlugin[] = []
    for (const found of await listPluginDirs(root)) {
        const dir = found.dir
        let name = found.id
        let version = "0.0.0"
        try {
            const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
                name?: unknown
                version?: unknown
            }
            if (typeof pkg.name === "string" && pkg.name !== "") name = pkg.name
            if (typeof pkg.version === "string" && pkg.version !== "") version = pkg.version
        } catch {
            /* 没有 package.json 时用目录名 */
        }
        let deps: string[] = []
        try {
            const source = await readFile(join(dir, "index.ts"), "utf8")
            const match = /deps\s*:\s*\[([^\]]*)\]/.exec(source)
            if (match !== null) {
                deps = [...(match[1] ?? "").matchAll(/["']([^"']+)["']/g)].map(
                    (item) => item[1] ?? "",
                )
            }
        } catch {
            /* 读不到入口时按没有依赖处理 */
        }
        plugins.push({
            id: found.id,
            name,
            version,
            enabled: !disabled.has(found.id),
            deps: deps.filter((dep) => dep !== ""),
        })
    }
    return plugins
}

/** 依赖目标插件的其它插件 */
function dependentsOf(plugins: readonly ScannedPlugin[], id: string, pluginName: string): string[] {
    return plugins
        .filter(
            (plugin) =>
                plugin.id !== id && (plugin.deps.includes(id) || plugin.deps.includes(pluginName)),
        )
        .map((plugin) => plugin.id)
}

/**
 * 加载插件并获取各自的最新版本
 *
 * 探针在 init 里注册，需先启动插件进程
 * 该开销仅属 `list --check`；普通 list 只读目录
 */
async function loadAndCheckUpdates(ctx: CommandContext): Promise<Map<string, PluginUpdateCheck>> {
    await ctx.loadPlugins()
    const plugins = await scanPluginDirs(ctx.paths)
    const checks = await checkPluginUpdates(
        plugins.map((plugin) => ({
            id: plugin.id,
            version: plugin.version,
            // 探针以 package.json 的 name 注册，缺失时退回目录名
            probeIds: [plugin.name],
        })),
    )
    return new Map(checks.map((check) => [check.id, check]))
}

/** 检查结果行 */
function describeUpdate(check: PluginUpdateCheck | undefined): string {
    if (check === undefined) {
        return "检查更新：没有结果"
    }
    if (!check.hasProbe) {
        return "检查更新：插件没有注册版本探针"
    }
    if (check.error !== null) {
        return `检查更新失败：${check.error}`
    }
    if (!check.updateAvailable) {
        return `已是最新（${check.installed}）`
    }
    const download = check.downloadUrl === null ? "" : `  下载：${check.downloadUrl}`
    return `可更新：${check.installed} → ${check.latest}${download}`
}

export async function runPluginCommand(
    ctx: CommandContext,
    argv: readonly string[],
): Promise<CommandOutcome> {
    const [subcommand, ...rest] = argv
    const parsed = parseCommandArgs(rest, {
        force: { type: "boolean" },
        ignore: { type: "boolean" },
        dir: { type: "string" },
        // 只对 list 有意义：问每个插件「最新版本是多少」
        check: { type: "boolean" },
    })
    if (!parsed.isSuccess()) {
        return { result: Result.error<unknown>(parsed.getCode() ?? USAGE_CODES.invalidValue) }
    }
    const line = parsed.getData()
    if (line === null) {
        return failure(USAGE_CODES.invalidValue)
    }
    const force = booleanValue(line.values, "force")
    const ignore = booleanValue(line.values, "ignore")
    const check = booleanValue(line.values, "check")

    try {
        switch (subcommand) {
            case "list": {
                const plugins = await scanPluginDirs(ctx.paths)
                // --check 需插件进程在场（探针在 init 里注册）
                // 仅此路径加载插件，默认 list 只读目录
                const updates = check ? await loadAndCheckUpdates(ctx) : null
                for (const plugin of plugins) {
                    const deps = plugin.deps.length === 0 ? "-" : plugin.deps.join(",")
                    const status = plugin.enabled ? "enabled" : "disabled"
                    ctx.elog.print(
                        `${plugin.id}  ${plugin.name}@${plugin.version}  ${status}  deps=${deps}`,
                    )
                    if (updates === null) continue
                    ctx.elog.print(`  ${describeUpdate(updates.get(plugin.id))}`)
                }
                if (updates !== null) {
                    const count = [...updates.values()].filter(
                        (item) => item.updateAvailable,
                    ).length
                    ctx.elog.print(count === 0 ? "没有可用更新" : `${count} 个插件有可用更新`)
                }
                return success(plugins)
            }
            case "new": {
                const name = line.positionals[0]
                if (name === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:name`)
                }
                const created = await scaffoldPlugin({
                    name,
                    parentDir:
                        typeof line.values["dir"] === "string" ? line.values["dir"] : undefined,
                    force,
                })
                ctx.elog.info(`已创建插件 ${name}：${created.dir}`)
                ctx.elog.print("下一步：")
                ctx.elog.print(`  wellspring plugin link ${created.dir}`)
                ctx.elog.print(`  wellspring plugin list`)
                ctx.elog.print(`  wellspring ${created.commandName}`)
                ctx.elog.print("类型检查：先把 Wellspring 链接进插件（见插件 README）")
                return success(created)
            }
            case "enable":
            case "disable": {
                const name = line.positionals[0]
                if (name === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:name`)
                }
                if (!PLUGIN_ID.test(name)) {
                    return failure(`${USAGE_CODES.invalidValue}:name`)
                }
                const plugins = await scanPluginDirs(ctx.paths)
                const match =
                    plugins.find((plugin) => plugin.id === name) ??
                    plugins.find((plugin) => plugin.name === name)
                const id = match === undefined ? name : match.id
                const dir = pluginDirOf(pluginsRoot(ctx.paths), id)
                if (dir === null || (await statIfExists(dir)) === null) {
                    return failure(`plugin.not-found:${name}`)
                }
                const enabled = subcommand === "enable"
                await setPluginEnabled(id, enabled, ctx.paths)
                ctx.elog.info(`${enabled ? "已启用" : "已禁用"}插件 ${id}（下次运行生效）`)
                return success({ id, enabled })
            }
            case "install": {
                const source = line.positionals[0]
                if (source === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:path`)
                }
                const installed = await installPlugin(source, ctx.paths, { force })
                ctx.elog.info(
                    installed.dependenciesInstalled
                        ? `已安装插件 ${installed.id}，已用 ${installed.packageManager ?? "包管理器"} 安装依赖`
                        : `已安装插件 ${installed.id}`,
                )
                return success(installed)
            }
            case "update": {
                const source = line.positionals[0]
                if (source === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:path`)
                }
                const updated = await installPlugin(source, ctx.paths, { mode: "update" })
                ctx.elog.info(
                    updated.dependenciesInstalled
                        ? `已更新插件 ${updated.id}，已用 ${updated.packageManager ?? "包管理器"} 安装依赖`
                        : `已更新插件 ${updated.id}`,
                )
                return success(updated)
            }
            case "link": {
                const source = line.positionals[0]
                if (source === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:path`)
                }
                const name = await linkPlugin(source, ctx.paths)
                ctx.elog.info(`已链接插件 ${name}`)
                return success({ id: name })
            }
            case "remove": {
                const name = line.positionals[0]
                if (name === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:name`)
                }
                const plugins = await scanPluginDirs(ctx.paths)
                const target =
                    plugins.find((plugin) => plugin.id === name) ??
                    plugins.find((plugin) => plugin.name === name)
                const id = target === undefined ? name : target.id
                const dependents = dependentsOf(plugins, id, target?.name ?? id)
                if (dependents.length > 0 && !ignore) {
                    ctx.elog.error(
                        `插件 ${id} 被这些插件依赖：${dependents.join(", ")}；` +
                            "确认要强制卸载请加 --ignore",
                    )
                    return failure(`plugin.has-dependents:${dependents.join(",")}`)
                }
                await removePlugin(id, ctx.paths)
                ctx.elog.info(
                    `已删除插件 ${id}${ignore && dependents.length > 0 ? "（忽略依赖）" : ""}`,
                )
                return success({ id })
            }
            default:
                return failure(`${USAGE_CODES.unknownSubcommand}:plugin ${subcommand ?? ""}`)
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return failure(`plugin.install-failed:${message}`)
    }
}
