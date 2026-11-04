/** 内置命令元数据，帮助文本与命令校验共用这一份 */

export interface BuiltinCommandSpec {
    readonly name: string
    readonly summary: string
    readonly usage: string
    readonly aliases?: readonly string[]
}

export const BUILTIN_COMMANDS: readonly BuiltinCommandSpec[] = [
    {
        name: "chat",
        summary: "对话模式，单轮对话或进入交互式会话",
        usage: "wellspring chat [--session-id <id>] [--new] [--model <name>] [--reasoning off|low|high|max] [--system <text>] <context...>",
    },
    {
        name: "run",
        summary: "Agent 模式，单轮执行或进入交互式会话",
        usage: "wellspring run [--session-id <id>] [--new] [--agent <name>] [--model <name>] [--reasoning off|low|high|max] [--permission read-only|workspace-write|danger-full-access] [--allow-exec] [--max-steps <n>] <context...>",
    },
    {
        name: "start",
        summary: "以服务进程启动，加载插件并触发 onInit",
        usage: "wellspring start",
    },
    {
        name: "stop",
        summary: "停止正在运行的 Wellspring 服务",
        usage: "wellspring stop",
    },
    {
        name: "session",
        summary: "查看、切换与删除会话",
        usage: "wellspring session <list|show|delete> [args]",
    },
    {
        name: "config",
        summary: "配置路径、查看与读写配置项",
        usage: "wellspring config <path|show|get|set> [args]",
    },
    {
        name: "key",
        summary: "查看、设置、清除与测试 OpenAI API Key",
        usage: "wellspring key <status|set|clear|test|path> [--provider <id>] [args]",
    },
    {
        name: "plugin",
        summary: "插件列表、安装与删除",
        usage: "wellspring plugin <list|new|install|link|enable|disable|remove> [args]",
    },
    {
        name: "sandbox",
        summary: "沙盒维护：清理工作区上留下的 ACL",
        usage: "wellspring sandbox cleanup [--workspace <path>]",
    },
    {
        name: "doctor",
        summary: "环境与配置诊断",
        usage: "wellspring doctor [--json]",
    },
    {
        name: "version",
        summary: "显示版本与运行环境",
        usage: "wellspring version [--json]",
        aliases: ["-v"],
    },
    {
        name: "help",
        summary: "显示帮助",
        usage: "wellspring help [command]",
        aliases: ["-h"],
    },
]

export const BUILTIN_NAMES: ReadonlySet<string> = new Set(BUILTIN_COMMANDS.map((spec) => spec.name))

export function findBuiltin(name: string): BuiltinCommandSpec | undefined {
    return BUILTIN_COMMANDS.find(
        (spec) => spec.name === name || (spec.aliases ?? []).includes(name),
    )
}
