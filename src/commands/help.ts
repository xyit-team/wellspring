/*
 * help 命令：内置命令与已注册插件命令
 */

import { Result } from "../api/result/result.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { BUILTIN_COMMANDS } from "../input/commands.ts"
import { formatCommandHelp, formatGlobalHelp, type HelpPluginCommand } from "../input/help.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

export async function runHelpCommand(
    ctx: CommandContext,
    argv: readonly string[],
): Promise<CommandOutcome> {
    await ctx.loadPlugins()
    const pluginCommands: HelpPluginCommand[] = ctx.registry.list().map((record) => ({
        name: record.command.name,
        summary: record.command.summary,
        usage: record.command.usage ?? `wellspring ${record.command.name}`,
        plugin: record.pluginName,
    }))

    const builtins = BUILTIN_COMMANDS.map((spec) => ({
        name: spec.name,
        summary: spec.summary,
        usage: spec.usage,
    }))
    const target = argv[0]
    if (target === undefined) {
        ctx.elog.print(formatGlobalHelp(pluginCommands))
        return success({ builtins, plugins: pluginCommands })
    }

    const plugin = pluginCommands.find((command) => command.name === target)
    const text = formatCommandHelp(target, plugin)
    if (text === null) {
        return failure(`${USAGE_CODES.unknownCommand}:${target}`)
    }
    ctx.elog.print(text)
    return success({ command: target })
}
