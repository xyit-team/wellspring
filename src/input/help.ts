/*
 * 帮助文本生成
 *
 * 内置命令来自命令表，插件命令来自注册表
 */

import { BUILTIN_COMMANDS, findBuiltin } from "./commands.ts"

export interface HelpPluginCommand {
    readonly name: string
    readonly summary: string
    readonly usage: string
    readonly plugin: string
}

export function formatGlobalHelp(pluginCommands: readonly HelpPluginCommand[]): string {
    const lines: string[] = []
    lines.push("Wellspring 源泉 —— 聚合式 Agent 平台")
    lines.push("")
    lines.push("用法：wellspring <command> [args] [options]")
    lines.push("")
    lines.push("命令：")
    for (const spec of BUILTIN_COMMANDS) {
        lines.push(`  ${spec.name.padEnd(9)} ${spec.summary}`)
    }
    if (pluginCommands.length > 0) {
        lines.push("")
        lines.push("插件命令：")
        for (const command of pluginCommands) {
            lines.push(`  ${command.name.padEnd(9)} ${command.summary}（来自 ${command.plugin}）`)
        }
    }
    lines.push("")
    lines.push("全局参数：")
    lines.push("  -c, --config <file>    指定配置文件")
    lines.push("  --home <dir>           便携模式根目录")
    lines.push("  -l, --log-level <level> 日志级别")
    lines.push("  --json                 机器可读输出")
    lines.push("  -q, --quiet            静默")
    lines.push("  -h, --help             帮助")
    lines.push("  -v, --version          版本")
    lines.push("")
    lines.push('示例：wellspring chat "解释一下 EventBus"')
    lines.push('      wellspring run --session-id 20261021-173000-ab12 "读取 package.json"')
    return lines.join("\n")
}

export function formatCommandHelp(name: string, pluginCommand?: HelpPluginCommand): string | null {
    const spec = findBuiltin(name)
    if (spec !== undefined) {
        return [`用法：${spec.usage}`, "", spec.summary].join("\n")
    }
    if (pluginCommand !== undefined) {
        return [
            `用法：${pluginCommand.usage}`,
            "",
            pluginCommand.summary,
            `来自插件：${pluginCommand.plugin}`,
        ].join("\n")
    }
    return null
}
