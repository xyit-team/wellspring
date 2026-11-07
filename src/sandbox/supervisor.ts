/*
 * sandbox 进程 supervisor
 *
 * 职责：输出上限、超时、SIGTERM → SIGKILL（2s 后）、退出码
 */

import { spawn } from "node:child_process"

import { SandboxExecutionError, type LaunchSpec, type StopMode } from "./types.ts"

export interface ProcessLimits {
    readonly timeoutMs: number
    readonly outputLimitBytes: number
}

export interface ProcessResult {
    readonly exitCode: number | null
    readonly signal: string | null
    readonly stdout: string
    readonly stderr: string
    readonly truncated: boolean
    readonly timedOut: boolean
    readonly durationMs: number
}

export interface ProcessHooks {
    readonly onStdout?: (text: string) => void
    readonly onStderr?: (text: string) => void
}

export interface ProcessOptions {
    readonly stdin?: string
    readonly hooks?: ProcessHooks
}

export interface SandboxProcessHandle {
    readonly pid: number | undefined
    readonly done: Promise<ProcessResult>
    readonly stdout: string
    readonly stderr: string
    stop(mode: StopMode): void
}

export function startSandboxProcess(
    spec: LaunchSpec,
    limits: ProcessLimits,
    options: ProcessOptions = {},
): SandboxProcessHandle {
    const startedAt = Date.now()
    const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        stdio: ["pipe", "pipe", "pipe"],
        /*
         * POSIX 下 detached 建独立进程组，信号按组转发
         * Windows 下 detached 会让受限 token 子进程在 CreateProcessAsUser 后 DLL 初始化失败（0xC0000142）
         * 且没有进程组可取
         */
        detached: process.platform !== "win32",
    })

    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let totalBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const append = (target: Buffer[], chunk: Buffer): void => {
        const remaining = Math.max(0, limits.outputLimitBytes - totalBytes)
        if (chunk.length > remaining) {
            if (remaining > 0) {
                target.push(chunk.subarray(0, remaining))
                totalBytes += remaining
            }
            truncated = true
            return
        }
        target.push(chunk)
        totalBytes += chunk.length
    }

    child.stdout?.on("data", (chunk: Buffer) => {
        append(outChunks, chunk)
        options.hooks?.onStdout?.(chunk.toString("utf8"))
    })
    child.stderr?.on("data", (chunk: Buffer) => {
        append(errChunks, chunk)
        options.hooks?.onStderr?.(chunk.toString("utf8"))
    })

    const signal = (name: NodeJS.Signals): void => {
        try {
            if (child.pid !== undefined) {
                process.kill(-child.pid, name)
                return
            }
        } catch {
            // 进程组不存在，退回单进程 kill
        }
        child.kill(name)
    }

    let forceKillTimer: NodeJS.Timeout | null = null
    const timeoutTimer = setTimeout(
        () => {
            timedOut = true
            signal("SIGTERM")
            forceKillTimer = setTimeout(() => {
                if (!settled) {
                    signal("SIGKILL")
                }
            }, 2_000)
            forceKillTimer.unref()
        },
        Math.max(100, limits.timeoutMs),
    )
    timeoutTimer.unref()

    const cleanup = (): void => {
        settled = true
        clearTimeout(timeoutTimer)
        if (forceKillTimer !== null) {
            clearTimeout(forceKillTimer)
        }
    }

    try {
        child.stdin?.end(options.stdin ?? "")
    } catch {
        // 子进程可能已关闭 stdin
    }

    const done = new Promise<ProcessResult>((resolveExit, rejectExit) => {
        child.once("error", (error) => {
            cleanup()
            rejectExit(
                new SandboxExecutionError(
                    `sandbox 启动失败：${error instanceof Error ? error.message : String(error)}`,
                ),
            )
        })
        child.once("exit", (code, exitSignal) => {
            cleanup()
            resolveExit({
                exitCode: code,
                signal: exitSignal,
                stdout: Buffer.concat(outChunks).toString("utf8"),
                stderr: Buffer.concat(errChunks).toString("utf8"),
                truncated,
                timedOut,
                durationMs: Date.now() - startedAt,
            })
        })
    })

    const handle: SandboxProcessHandle = {
        pid: child.pid,
        done,
        get stdout() {
            return Buffer.concat(outChunks).toString("utf8")
        },
        get stderr() {
            return Buffer.concat(errChunks).toString("utf8")
        },
        stop(mode) {
            signal(mode === "ctrl_c" ? "SIGINT" : "SIGKILL")
        },
    }
    return handle
}

export async function runSandboxProcess(
    spec: LaunchSpec,
    limits: ProcessLimits,
    options: ProcessOptions = {},
): Promise<ProcessResult> {
    return await startSandboxProcess(spec, limits, options).done
}
