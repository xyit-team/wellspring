/*
 * plugin 命令：list / install / link / remove。
 */

import { readFile, readdir } from "node:fs/promises"
import { basename, join } from "node:path"

import { Result } from "../api/result/result.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { booleanValue, parseCommandArgs } from "../input/parse-options.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import { statIfExists } from "../platform/file.ts"
import { installPlugin } from "../plugin/install.ts"
import { linkPlugin, removePlugin } from "../plugin/loader.ts"
import { PLUGIN_NAME, pluginsRoot } from "../plugin/paths.ts"
import { scaffoldPlugin } from "../plugin/scaffold.ts"
import { readPluginState, setPluginEnabled } from "../plugin/state.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

interface ScannedPlugin {
    readonly dirName: string
    readonly name: string
    readonly version: string
    readonly enabled: boolean
    readonly deps: readonly string[]
}

/** 只扫插件目录的文件，不启动插件进程（plugin list / enable / disable 用） */
async function scanPluginDirs(paths: ResolvedPaths): Promise<ScannedPlugin[]> {
    const root = pluginsRoot(paths)
    const disabled = await readPluginState(paths)
    let names: string[]
    try {
        names = (await readdir(root)).sort()
    } catch {
        return []
    }
    const plugins: ScannedPlugin[] = []
    for (const dirName of names) {
        if (!PLUGIN_NAME.test(dirName) || dirName.startsWith(".")) continue
        const dir = join(root, dirName)
        const info = await statIfExists(dir)
        if (info === null || !info.isDirectory()) continue
        let name = dirName
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
            dirName,
            name,
            version,
            enabled: !disabled.has(dirName),
            deps: deps.filter((dep) => dep !== ""),
        })
    }
    return plugins
}

/** 依赖目标插件的其它插件目录名 */
function dependentsOf(
    plugins: readonly ScannedPlugin[],
    dirName: string,
    pluginName: string,
): string[] {
    return plugins
        .filter(
            (plugin) =>
                plugin.dirName !== dirName &&
                (plugin.deps.includes(dirName) || plugin.deps.includes(pluginName)),
        )
        .map((plugin) => plugin.dirName)
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

    try {
        switch (subcommand) {
            case "list": {
                const plugins = await scanPluginDirs(ctx.paths)
                for (const plugin of plugins) {
                    const deps = plugin.deps.length === 0 ? "-" : plugin.deps.join(",")
                    const status = plugin.enabled ? "enabled" : "disabled"
                    ctx.elog.print(
                        `${plugin.dirName}  ${plugin.name}@${plugin.version}  ${status}  deps=${deps}`,
                    )
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
                if (!PLUGIN_NAME.test(name)) {
                    return failure(`${USAGE_CODES.invalidValue}:name`)
                }
                const plugins = await scanPluginDirs(ctx.paths)
                const match =
                    plugins.find((plugin) => plugin.dirName === name) ??
                    plugins.find((plugin) => plugin.name === name)
                const dirName = match === undefined ? name : match.dirName
                const dir = join(pluginsRoot(ctx.paths), dirName)
                if ((await statIfExists(dir)) === null) {
                    return failure(`plugin.not-found:${name}`)
                }
                const enabled = subcommand === "enable"
                await setPluginEnabled(dirName, enabled, ctx.paths)
                ctx.elog.info(`${enabled ? "已启用" : "已禁用"}插件 ${dirName}（下次运行生效）`)
                return success({ id: dirName, enabled })
            }
            case "install": {
                const source = line.positionals[0]
                if (source === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:path`)
                }
                const installed = await installPlugin(source, ctx.paths, { force })
                ctx.elog.info(`已安装插件 ${installed.id}`)
                return success(installed)
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
                    plugins.find((plugin) => plugin.dirName === name) ??
                    plugins.find((plugin) => plugin.name === name)
                const dirName = target === undefined ? name : target.dirName
                const dependents = dependentsOf(plugins, dirName, target?.name ?? dirName)
                if (dependents.length > 0 && !ignore) {
                    ctx.elog.error(
                        `插件 ${dirName} 被这些插件依赖：${dependents.join(", ")}；` +
                            "确认要强制卸载请加 --ignore",
                    )
                    return failure(`plugin.has-dependents:${dependents.join(",")}`)
                }
                await removePlugin(dirName, ctx.paths)
                ctx.elog.info(
                    `已删除插件 ${dirName}${ignore && dependents.length > 0 ? "（忽略依赖）" : ""}`,
                )
                return success({ id: dirName })
            }
            default:
                return failure(`${USAGE_CODES.unknownSubcommand}:plugin ${subcommand ?? ""}`)
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return failure(`plugin.install-failed:${message}`)
    }
}
