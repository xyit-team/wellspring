/*
 * 剪贴板读写
 *
 * 各平台通过系统命令实现；命令缺失或不可用时按候选顺序回退
 * Windows 的文本按 UTF-8 字节经 stdin/stdout 收发，避开控制台代码页
 */

import { describeError, powershellArgs, runCommand, type RunCommandResult } from "./exec.ts"
import { isTermux, platform, type PlatformName } from "./os.ts"

export interface ClipboardCommand {
    readonly command: string
    readonly args: readonly string[]
}

export interface ClipboardCommands {
    readonly write: readonly ClipboardCommand[]
    readonly read: readonly ClipboardCommand[]
}

const POWERSHELL_WRITE = powershellArgs(
    [
        "$input = [Console]::OpenStandardInput()",
        "$buffer = New-Object byte[] 8192",
        "$memory = New-Object System.IO.MemoryStream",
        "while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) { $memory.Write($buffer, 0, $read) }",
        "Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString($memory.ToArray()))",
    ].join("\n"),
)

const POWERSHELL_READ = powershellArgs(
    [
        "$text = Get-Clipboard -Raw",
        "if ($null -eq $text) { $text = '' }",
        "$bytes = [System.Text.Encoding]::UTF8.GetBytes($text)",
        "$output = [Console]::OpenStandardOutput()",
        "$output.Write($bytes, 0, $bytes.Length)",
        "$output.Flush()",
    ].join("\n"),
)

/** 生成候选命令，按优先级排列；单独导出以便在任意平台测试 */
export function buildClipboardCommands(
    targetPlatform: PlatformName = platform,
    inTermux: boolean = isTermux,
): ClipboardCommands {
    switch (targetPlatform) {
        case "windows":
            return {
                write: [{ command: "powershell", args: POWERSHELL_WRITE }],
                read: [{ command: "powershell", args: POWERSHELL_READ }],
            }
        case "macos":
            return {
                write: [{ command: "pbcopy", args: [] }],
                read: [{ command: "pbpaste", args: [] }],
            }
        case "android":
            // Android 应用沙箱内只有 Termux:API 提供的命令
            if (!inTermux) {
                return { write: [], read: [] }
            }
            return {
                write: [{ command: "termux-clipboard-set", args: [] }],
                read: [{ command: "termux-clipboard-get", args: [] }],
            }
        default:
            return {
                write: [
                    { command: "wl-copy", args: [] },
                    { command: "xclip", args: ["-selection", "clipboard"] },
                    { command: "xsel", args: ["--clipboard", "--input"] },
                ],
                read: [
                    { command: "wl-paste", args: [] },
                    { command: "xclip", args: ["-selection", "clipboard", "-o"] },
                    { command: "xsel", args: ["--clipboard", "--output"] },
                ],
            }
    }
}

async function runCandidates(
    commands: readonly ClipboardCommand[],
    input?: string,
): Promise<RunCommandResult> {
    const failures: string[] = []
    for (const candidate of commands) {
        try {
            return await runCommand(candidate.command, candidate.args, { input })
        } catch (error) {
            failures.push(`${candidate.command}: ${describeError(error)}`)
        }
    }
    const detail = failures.length === 0 ? "当前平台没有可用命令" : failures.join("；")
    throw new Error(`剪贴板不可用：${detail}`)
}

/** 写入剪贴板 */
export async function writeClipboard(text: string): Promise<void> {
    await runCandidates(buildClipboardCommands().write, text)
}

/** 读取剪贴板；返回命令原始输出，不做换行裁剪 */
export async function readClipboard(): Promise<string> {
    const result = await runCandidates(buildClipboardCommands().read)
    return result.stdout
}
