/*
 * 命令执行
 *
 * 命令缺失统一抛 CommandNotFoundError，供候选命令回退；stderr 有内容但退出码为 0 不算失败
 */

import { spawn } from "node:child_process"

const DEFAULT_TIMEOUT_MS = 15_000

/** 命令不存在（ENOENT） */
export class CommandNotFoundError extends Error {
    readonly command: string

    constructor(command: string) {
        super(`命令不存在：${command}`)
        this.name = "CommandNotFoundError"
        this.command = command
    }
}

/** 命令存在但退出码非 0 */
export class CommandFailedError extends Error {
    readonly command: string
    readonly exitCode: number | null
    readonly stderr: string

    constructor(command: string, exitCode: number | null, stderr: string) {
        const detail = stderr.trim()
        super(
            `命令执行失败：${command}（退出码 ${exitCode ?? "signal"}）${detail === "" ? "" : `：${detail}`}`,
        )
        this.name = "CommandFailedError"
        this.command = command
        this.exitCode = exitCode
        this.stderr = stderr
    }
}

export interface RunCommandOptions {
    /** 写入 stdin 的文本 */
    readonly input?: string
    readonly env?: NodeJS.ProcessEnv
    readonly timeoutMs?: number
}

export interface RunCommandResult {
    readonly stdout: string
    readonly stderr: string
}

/** 运行命令并收集输出 */
export function runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {},
): Promise<RunCommandResult> {
    return new Promise((resolve, reject) => {
        let settled = false
        let timer: NodeJS.Timeout | undefined

        const finish = (action: () => void): void => {
            if (settled) {
                return
            }
            settled = true
            if (timer !== undefined) {
                clearTimeout(timer)
            }
            action()
        }

        const child = spawn(command, [...args], {
            env: options.env,
            windowsHide: true,
        })

        let stdout = ""
        let stderr = ""
        child.stdout.setEncoding("utf8")
        child.stderr.setEncoding("utf8")
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk
        })
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk
        })
        // 命令未读取 stdin 就退出时写入会触发 EPIPE
        child.stdin.on("error", () => undefined)

        timer = setTimeout(() => {
            child.kill("SIGKILL")
            finish(() => reject(new Error(`命令执行超时：${command}`)))
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

        child.once("error", (error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                finish(() => reject(new CommandNotFoundError(command)))
                return
            }
            finish(() => reject(error))
        })

        child.once("close", (code) => {
            if (code === 0) {
                finish(() => resolve({ stdout, stderr }))
                return
            }
            finish(() => reject(new CommandFailedError(command, code, stderr)))
        })

        child.stdin.end(options.input)
    })
}

/** PowerShell 脚本编码为 -EncodedCommand 参数，绕开 cmd 的引号与编码问题 */
export function powershellArgs(script: string): string[] {
    const encoded = Buffer.from(script, "utf16le").toString("base64")
    return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]
}

/** 合并 message 与 cause 链，用于候选命令全失败时的报错 */
export function describeError(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error)
    }
    const cause = error.cause
    return cause === undefined ? error.message : `${error.message}（${describeError(cause)}）`
}
