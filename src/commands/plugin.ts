/*
 * plugin 命令：list / install / link / remove。
 */

import { Result } from "../api/result/result.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { booleanValue, parseCommandArgs } from "../input/parse-options.ts"
import { installPlugin } from "../plugin/install.ts"
import { linkPlugin, removePlugin } from "../plugin/loader.ts"
import { scaffoldPlugin } from "../plugin/scaffold.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

export async function runPluginCommand(
    ctx: CommandContext,
    argv: readonly string[],
): Promise<CommandOutcome> {
    const [subcommand, ...rest] = argv
    const parsed = parseCommandArgs(rest, {
        force: { type: "boolean" },
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

    try {
        switch (subcommand) {
            case "list": {
                const plugins = await ctx.loadPlugins()
                for (const plugin of plugins) {
                    const commands = plugin.commands.length === 0 ? "-" : plugin.commands.join(",")
                    const deps = plugin.deps.length === 0 ? "-" : plugin.deps.join(",")
                    ctx.elog.print(
                        `${plugin.id}  ${plugin.name}@${plugin.version}  ${plugin.status}  deps=${deps}  [${commands}]`,
                    )
                    if (plugin.error !== null) {
                        ctx.elog.error(`${plugin.id}: ${plugin.error}`)
                    }
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
                return success(created)
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
                await removePlugin(name, ctx.paths)
                ctx.elog.info(`已删除插件 ${name}`)
                return success({ id: name })
            }
            default:
                return failure(`${USAGE_CODES.unknownSubcommand}:plugin ${subcommand ?? ""}`)
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return failure(`plugin.install-failed:${message}`)
    }
}
