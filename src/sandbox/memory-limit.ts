/*
 * 沙箱物理内存限制，走 cgroup v2 的 memory.max
 *
 * RLIMIT_AS 限制的是虚拟地址空间，会打死 V8 / JVM / Go 这类需要预留大块地址空间的运行时，且不约束真实物理内存
 *
 * 流程：
 *   1. 用 `systemd-run --user --scope -p MemoryMax=<bytes> -p MemorySwapMax=0`
 *      起一个临时 scope（用户 session 下无需 root）
 *   2. 读 systemctl 的 ControlGroup 拿 cgroup 路径
 *   3. 用一层 /bin/sh 包住真正的 sandbox 命令
 *      shell 先把自己写进 cgroup.procs，再 exec bwrap，bwrap 及后代一出生就在受限 cgroup 里
 *   4. 结束后读 memory.events 判断是否发生过 oom_kill，再停掉 scope
 *
 * 宿主没有 systemd user manager（容器、SSH 非登录环境）时返回 inactive，调用方退回只限制 V8 堆 + 超时的方式
 */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { accessSync, constants, readFileSync } from "node:fs"
import { join } from "node:path"

import type { LaunchSpec } from "./types.ts"

export const CGROUP_V2_ROOT = "/sys/fs/cgroup"

export interface MemoryLimitState {
    /** 是否真的挂上了 cgroup 限制 */
    readonly active: boolean
    /** active=false 时的原因（给结果与日志用） */
    readonly reason: string | null
    /** 把启动命令包进受限 cgroup；inactive 时原样返回 */
    wrap(spec: LaunchSpec): LaunchSpec
    /** 读 oom 事件并清理 scope；可重复调用 */
    finish(): Promise<{ oomKilled: boolean }>
}

export interface MemoryLimitCommandResult {
    readonly code: number | null
    readonly stdout: string
    readonly stderr: string
}

/** 便于单测替换外部命令、文件与时间 */
export interface MemoryLimitDeps {
    readonly platform: NodeJS.Platform
    readonly env: NodeJS.ProcessEnv
    readonly run: (command: string, args: readonly string[]) => Promise<MemoryLimitCommandResult>
    readonly spawnHolder: (command: string, args: readonly string[]) => { readonly pid?: number }
    readonly readText: (path: string) => string | null
    readonly writable: (path: string) => boolean
    readonly sleep: (ms: number) => Promise<void>
    readonly randomSuffix: () => string
}

export interface MemoryLimitOptions {
    /** 物理内存上限，字节 */
    readonly bytes: number
    /** 沙箱超时；为 scope 的 RuntimeMaxSec 留余量，防 scope 泄漏 */
    readonly timeoutMs: number
    readonly deps?: Partial<MemoryLimitDeps>
}

const CGROUP_POLL_TIMES = 10
const CGROUP_POLL_INTERVAL_MS = 50
const SCOPE_RUNTIME_GRACE_MS = 120_000

function runCommand(command: string, args: readonly string[]): Promise<MemoryLimitCommandResult> {
    return new Promise((resolveCommand) => {
        const child = spawn(command, [...args], {
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
        })
        const out: Buffer[] = []
        const err: Buffer[] = []
        child.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
        child.stderr?.on("data", (chunk: Buffer) => err.push(chunk))
        child.once("error", (error) => {
            resolveCommand({ code: null, stdout: "", stderr: error.message })
        })
        child.once("close", (code) => {
            resolveCommand({
                code,
                stdout: Buffer.concat(out).toString("utf8"),
                stderr: Buffer.concat(err).toString("utf8"),
            })
        })
    })
}

const defaultDeps: MemoryLimitDeps = {
    platform: process.platform,
    env: process.env,
    run: runCommand,
    spawnHolder: (command, args) => {
        const child = spawn(command, [...args], {
            stdio: "ignore",
            env: process.env,
            detached: true,
        })
        child.unref()
        return { pid: child.pid }
    },
    readText: (path) => {
        try {
            return readFileSync(path, "utf8")
        } catch {
            return null
        }
    },
    writable: (path) => {
        try {
            accessSync(path, constants.W_OK)
            return true
        } catch {
            return false
        }
    },
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    randomSuffix: () => randomUUID().slice(0, 8),
}

function inactive(reason: string): MemoryLimitState {
    return {
        active: false,
        reason,
        wrap: (spec) => spec,
        finish: async () => ({ oomKilled: false }),
    }
}

/** 从 memory.events 里读 oom_kill 计数 */
export function parseOomKill(memoryEvents: string | null): boolean {
    if (memoryEvents === null) {
        return false
    }
    const match = /^oom_kill\s+(\d+)\s*$/m.exec(memoryEvents)
    return match !== null && Number(match[1]) > 0
}

/** sandbox 命令外层包一层 sh：先把自己放进 cgroup，再 exec 原命令 */
export function wrapSpecInCgroup(spec: LaunchSpec, cgroupPath: string): LaunchSpec {
    return {
        ...spec,
        command: "/bin/sh",
        args: [
            "-c",
            'echo $$ > "$1/cgroup.procs" || exit 126; shift; exec "$@"',
            "sh",
            cgroupPath,
            spec.command,
            ...spec.args,
        ],
    }
}

export async function createSandboxMemoryLimit(
    options: MemoryLimitOptions,
): Promise<MemoryLimitState> {
    const deps: MemoryLimitDeps = { ...defaultDeps, ...options.deps }
    const bytes = Math.trunc(options.bytes)
    if (deps.platform !== "linux") {
        return inactive("非 Linux 平台不使用 cgroup 内存限制")
    }
    if (!Number.isFinite(bytes) || bytes < 16 * 1024 * 1024) {
        return inactive("内存上限过小，跳过 cgroup 限制")
    }

    const unit = `wellspring-sandbox-${process.pid}-${deps.randomSuffix()}`
    const runtimeSec = Math.ceil((Math.max(1, options.timeoutMs) + SCOPE_RUNTIME_GRACE_MS) / 1000)
    const holderArgs = [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--unit",
        unit,
        "--property",
        `MemoryMax=${bytes}`,
        // 物理内存不挤进 swap，swap 会让 memory.max 被换页绕过
        "--property",
        "MemorySwapMax=0",
        "--property",
        `RuntimeMaxSec=${runtimeSec}`,
        "--",
        "/bin/sleep",
        "infinity",
    ]
    try {
        deps.spawnHolder("systemd-run", holderArgs)
    } catch (error) {
        return inactive(
            `systemd-run 不可用：${error instanceof Error ? error.message : String(error)}`,
        )
    }

    const unitName = `${unit}.scope`
    let cgroup: string | null = null
    let lastError = ""
    for (let attempt = 0; attempt < CGROUP_POLL_TIMES; attempt += 1) {
        const shown = await deps.run("systemctl", [
            "--user",
            "show",
            "-p",
            "ControlGroup",
            "--value",
            unitName,
        ])
        const value = shown.stdout.trim()
        if (value.startsWith("/")) {
            cgroup = value
            break
        }
        lastError = shown.stderr.trim()
        await deps.sleep(CGROUP_POLL_INTERVAL_MS)
    }
    const stop = async (): Promise<void> => {
        await deps.run("systemctl", ["--user", "stop", unitName])
    }
    if (cgroup === null) {
        await stop()
        return inactive(`systemd user scope 不可用${lastError === "" ? "" : `：${lastError}`}`)
    }

    const cgroupPath = join(CGROUP_V2_ROOT, cgroup)
    if (!deps.writable(join(cgroupPath, "cgroup.procs"))) {
        await stop()
        return inactive(`无法写入 cgroup：${cgroupPath}`)
    }

    let finished: Promise<{ oomKilled: boolean }> | null = null
    return {
        active: true,
        reason: null,
        wrap: (spec) => wrapSpecInCgroup(spec, cgroupPath),
        finish: () => {
            finished ??= (async () => {
                const oomKilled = parseOomKill(deps.readText(join(cgroupPath, "memory.events")))
                await stop()
                return { oomKilled }
            })()
            return finished
        },
    }
}
