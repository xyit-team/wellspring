/*
 * 系统通知
 *
 * Windows 走 PowerShell 的 WinRT toast，脚本内容经 -EncodedCommand 传递
 * WSL 下优先调用 powershell.exe，其余平台使用各自的通知命令
 */

import { describeError, powershellArgs, runCommand } from "./exec.ts"
import { isWsl, platform, type PlatformName } from "./os.ts"

export interface NotifyOptions {
    readonly title: string
    readonly body?: string
}

export interface NotifyCommand {
    readonly command: string
    readonly args: readonly string[]
    readonly env?: Readonly<Record<string, string>>
}

const MACOS_SCRIPT =
    'display notification (system attribute "WELLSPRING_NOTIFY_BODY") with title (system attribute "WELLSPRING_NOTIFY_TITLE")'

// PowerShell 单引号字符串，内部单引号翻倍
function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
}

function powershellToast(title: string, body: string): string[] {
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
        "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
        '$texts = $template.GetElementsByTagName("text")',
        `$texts.Item(0).AppendChild($template.CreateTextNode(${psQuote(title)})) > $null`,
        `$texts.Item(1).AppendChild($template.CreateTextNode(${psQuote(body)})) > $null`,
        "$toast = [Windows.UI.Notifications.ToastNotification]::new($template)",
        '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Wellspring").Show($toast)',
    ].join("\n")
    return powershellArgs(script)
}

function normalize(options: NotifyOptions): { title: string; body: string } {
    const title = options.title.trim()
    if (title === "") {
        throw new Error("通知标题为空")
    }
    return { title, body: options.body ?? "" }
}

/** 生成候选命令，按优先级排列；单独导出以便在任意平台测试 */
export function buildNotifyCommands(
    options: NotifyOptions,
    targetPlatform: PlatformName = platform,
    inWsl: boolean = isWsl,
): NotifyCommand[] {
    const { title, body } = normalize(options)

    if (targetPlatform === "windows") {
        return [{ command: "powershell", args: powershellToast(title, body) }]
    }

    if (targetPlatform === "macos") {
        return [
            {
                command: "osascript",
                args: ["-e", MACOS_SCRIPT],
                env: { WELLSPRING_NOTIFY_TITLE: title, WELLSPRING_NOTIFY_BODY: body },
            },
        ]
    }

    if (targetPlatform === "android") {
        const args = ["--title", title]
        if (body !== "") {
            args.push("--content", body)
        }
        return [{ command: "termux-notification", args }]
    }

    const candidates: NotifyCommand[] = []
    if (inWsl) {
        // WSL 没有桌面通知守护进程，转到 Windows 侧显示
        candidates.push({ command: "powershell.exe", args: powershellToast(title, body) })
    }
    const args = ["-a", "wellspring", "--", title]
    if (body !== "") {
        args.push(body)
    }
    candidates.push({ command: "notify-send", args })
    return candidates
}

/** 发送系统通知；全部候选失败时抛出聚合错误 */
export async function notify(options: NotifyOptions): Promise<void> {
    const failures: string[] = []
    for (const candidate of buildNotifyCommands(options)) {
        try {
            const env =
                candidate.env === undefined ? undefined : { ...process.env, ...candidate.env }
            await runCommand(candidate.command, candidate.args, { env })
            return
        } catch (error) {
            failures.push(`${candidate.command}: ${describeError(error)}`)
        }
    }
    throw new Error(`通知发送失败：${failures.join("；")}`)
}
