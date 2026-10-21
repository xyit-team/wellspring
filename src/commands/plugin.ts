/*
 * plugin 命令：list / link / remove。
 */

import { Result } from "../api/result/result.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { parseCommandArgs } from "../input/parse-options.ts"
import { linkPlugin, removePlugin } from "../plugin/loader.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

export async function runPluginCommand(
    ctx: CommandContext,
    argv: readonly string[],
): Promise<CommandOutcome> {
    const [subcommand, ...rest] = argv
    const parsed = parseCommandArgs(rest, {})
    if (!parsed.isSuccess()) {
        return { result: Result.error<unknown>(parsed.getCode() ?? USAGE_CODES.invalidValue) }
    }
    const line = parsed.getData()
    if (line === null) {
        return failure(USAGE_CODES.invalidValue)
    }

    try {
        switch (subcommand) {
            case "list": {
                const plugins = await ctx.loadPlugins()
                for (const plugin of plugins) {
                    const commands = plugin.commands.length === 0 ? "-" : plugin.commands.join(",")
                    ctx.elog.print(
                        `${plugin.name}  ${plugin.version ?? "?"}  ${plugin.status}  [${commands}]`,
                    )
                    if (plugin.error !== null) {
                        ctx.elog.error(`${plugin.name}: ${plugin.error}`)
                    }
                }
                return success(plugins)
            }
            case "link": {
                const source = line.positionals[0]
                if (source === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:path`)
                }
                const name = await linkPlugin(source, ctx.paths)
                ctx.elog.info(`已链接插件 ${name}`)
                return success({ name })
            }
            case "remove": {
                const name = line.positionals[0]
                if (name === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:name`)
                }
                await removePlugin(name, ctx.paths)
                ctx.elog.info(`已删除插件 ${name}`)
                return success({ name })
            }
            default:
                return failure(`${USAGE_CODES.unknownSubcommand}:plugin ${subcommand ?? ""}`)
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return failure(`plugin.load-failed:${message}`)
    }
}
