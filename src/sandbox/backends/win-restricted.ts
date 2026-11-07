/*
 * Windows 用户态沙盒后端：受限 token + NTFS ACL + Job Object
 *
 * 身份模型（与 DSH 对齐）：
 *   - 每个 workspace 生成两个稳定 SID：SID_R（读/执行）、SID_W（读/写/删）
 *   - workspace 根写可继承 ACE：SID_R 只读，SID_W 可写；scratch 两者都可写
 *   - 命令按 access 选 token：read-only 用 SID_R，workspace-write 用 SID_W
 *   - 读全局放开（WRITE_RESTRICTED 只约束写），不做读隔离
 *
 * 真实 ACL/token/Job Object 操作在 native/win-sandbox，TS 侧只负责状态、策略与参数
 */

import { spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { SandboxAccess } from "../../config/types.ts"
import { platform as currentPlatform, type PlatformName } from "../../platform/os.ts"
import {
    SandboxExecutionError,
    type AgentLaunchInput,
    type LaunchSpec,
    type PluginLaunchInput,
    type SandboxBackend,
    type SandboxBackendStatus,
    type SandboxEnforcement,
    type SandboxPrepareInput,
} from "../types.ts"

const BACKEND_NAME = "win-restricted"
const LAUNCHER_NAME = "win-sandbox.exe"
const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

export interface WinSidState {
    readonly sidR: string
    readonly sidW: string
}

export function createSidState(random: (size: number) => Buffer = randomBytes): WinSidState {
    const component = (): number => {
        const value = random(4).readUInt32LE(0)
        return value === 0 ? 1 : value
    }
    return {
        sidR: `S-1-5-21-${component()}-${component()}-${component()}-${component()}`,
        sidW: `S-1-5-21-${component()}-${component()}-${component()}-${component()}`,
    }
}

export function workspaceStateKey(workspaceDir: string): string {
    return createHash("sha256")
        .update(resolve(workspaceDir).toLowerCase())
        .digest("hex")
        .slice(0, 32)
}

/** 随包分发的 launcher；不存在时返回 null */
export function packagedLauncherPath(
    arch: string = process.arch,
    exists: (path: string) => boolean = existsSync,
): string | null {
    const binary = join(PACKAGE_ROOT, "bin", `win32-${arch}`, LAUNCHER_NAME)
    return exists(binary) ? binary : null
}

export function buildWindowsSandboxEnv(input: AgentLaunchInput): Record<string, string> {
    const scratch = resolve(input.scratchDir)
    const env: Record<string, string> = {}
    const keep = [
        "SystemRoot",
        "WINDIR",
        "SystemDrive",
        "COMSPEC",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "NUMBER_OF_PROCESSORS",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "ALLUSERSPROFILE",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "COMMONPROGRAMFILES",
        "PUBLIC",
        "HOMEDRIVE",
        "HOMEPATH",
        "USERNAME",
        "USERDOMAIN",
        "OS",
        "LANG",
        "LC_ALL",
        "TERM",
    ]
    for (const key of keep) {
        const value = process.env[key]
        if (value !== undefined && value !== "") {
            env[key] = value
        }
    }
    env["PATH"] = process.env["PATH"] ?? ""
    env["TEMP"] = join(scratch, "tmp")
    env["TMP"] = env["TEMP"]
    env["HOME"] = scratch
    env["SCRATCH"] = scratch
    env["WORKSPACE"] = resolve(input.workspaceDir)
    env["NODE_OPTIONS"] =
        `${env["NODE_OPTIONS"] ?? ""} --max-old-space-size=${input.limits.memoryMB}`.trim()
    return env
}

/** 纯函数：agent-code launch spec，便于单测 */
export function buildWinSandboxLaunch(
    input: AgentLaunchInput,
    launcher: string,
    sids: WinSidState,
): LaunchSpec {
    const access = input.access ?? "read-only"
    const args = [
        "--exec",
        "--access",
        access,
        "--workspace",
        resolve(input.workspaceDir),
        "--scratch",
        resolve(input.scratchDir),
        "--cwd",
        resolve(input.cwd),
        "--sid-r",
        sids.sidR,
        "--sid-w",
        sids.sidW,
        "--memory-mb",
        String(input.limits.memoryMB),
        "--pids",
        String(input.limits.pids),
        "--",
        input.command,
        ...input.argv,
    ]
    return {
        command: launcher,
        args,
        cwd: resolve(input.cwd),
        env: buildWindowsSandboxEnv(input),
    }
}

export interface WinRestrictedBackendOptions {
    /** 沙箱状态目录；生产由 SandboxManager 的 paths.dataDir 注入 */
    readonly dataDir?: string
    /** 显式指定 launcher；测试/自定义构建用 */
    readonly launcher?: string
    readonly platform?: PlatformName
    readonly exists?: (path: string) => boolean
    readonly selfTest?: (binary: string) => boolean
}

interface PrepareRecord {
    readonly sids: WinSidState
}

export class WinRestrictedBackend implements SandboxBackend {
    readonly name = BACKEND_NAME
    readonly pathStyle = "host" as const
    /** Job Object 有提交内存上限，但不属于 cgroup，不能顶替 memoryLimit */
    readonly memoryLimit = false

    readonly #dataDir: string | null
    readonly #launcher: string | null
    readonly #platform: PlatformName
    readonly #exists: (path: string) => boolean
    readonly #selfTest: (binary: string) => boolean
    readonly #records = new Map<string, PrepareRecord>()
    readonly #prepared = new Set<string>()
    readonly #pending = new Map<string, Promise<void>>()
    readonly #sidLoads = new Map<string, Promise<WinSidState>>()

    constructor(options: WinRestrictedBackendOptions = {}) {
        this.#dataDir = options.dataDir ?? null
        this.#launcher =
            options.launcher ?? (options.exists === undefined ? packagedLauncherPath() : null)
        this.#platform = options.platform ?? currentPlatform
        this.#exists = options.exists ?? existsSync
        this.#selfTest = options.selfTest ?? defaultSelfTest
    }

    enforcement(access: SandboxAccess): SandboxEnforcement {
        return access === "danger-full-access" ? "none" : "partial"
    }

    enforcementNotes(access: SandboxAccess): readonly string[] {
        if (access === "danger-full-access") {
            return ["绕开 win-sandbox，以宿主身份执行"]
        }
        return [
            "network: 不隔离（未安装 WFP 围栏）",
            "fs: 读全局放开（与 DSH 对齐），写边界由受限 token + NTFS ACL 强制",
            "fs: restricting SIDs 含 Everyone/RESTRICTED（node/PowerShell 兼容所需），Everyone 显式可写的位置可能例外",
            "process: Job Object 限制进程数/内存，但无 PID namespace",
        ]
    }

    async probe(): Promise<SandboxBackendStatus> {
        if (this.#platform !== "windows") {
            return {
                available: false,
                backend: this.name,
                reason: "win-restricted 仅 Windows 可用",
                version: null,
            }
        }
        const launcher = this.#resolveLauncher()
        if (launcher === null) {
            return {
                available: false,
                backend: this.name,
                reason: "找不到 win-sandbox.exe：先 pnpm win-sandbox:build",
                version: null,
            }
        }
        if (!this.#exists(launcher)) {
            return {
                available: false,
                backend: this.name,
                reason: `指定的 launcher 不存在：${launcher}`,
                version: null,
            }
        }
        if (!this.#selfTest(launcher)) {
            return {
                available: false,
                backend: this.name,
                reason: "win-sandbox --self-test 未通过（受限 token / Job Object 不可用）",
                version: null,
            }
        }
        return {
            available: true,
            backend: this.name,
            reason: null,
            version: `${LAUNCHER_NAME}:${process.arch}`,
        }
    }

    /**
     * 异步准备工作区：加载/生成 SID，调用 native --prepare 写入可继承 ACE
     *
     * 同一 workspace+scratch 的并发调用复用同一个 Promise
     */
    async prepare(input: SandboxPrepareInput): Promise<void> {
        const workspace = resolve(input.workspaceDir)
        const scratch = resolve(input.scratchDir)
        const key = `${workspace.toLowerCase()}|${scratch.toLowerCase()}`
        if (this.#prepared.has(key)) {
            return
        }
        const pending = this.#pending.get(key)
        if (pending !== undefined) {
            return await pending
        }
        const task = (async () => {
            const launcher = this.#resolveLauncher()
            if (launcher === null || !this.#exists(launcher)) {
                throw new SandboxExecutionError(
                    "win-sandbox.exe 不可用：先运行 pnpm win-sandbox:build",
                )
            }
            const sids = await this.#loadSids(workspace)
            await runLauncher(
                launcher,
                [
                    "--prepare",
                    "--workspace",
                    workspace,
                    "--scratch",
                    scratch,
                    "--sid-r",
                    sids.sidR,
                    "--sid-w",
                    sids.sidW,
                ],
                "prepare",
            )
            this.#records.set(workspace.toLowerCase(), { sids })
            this.#prepared.add(key)
        })().finally(() => {
            this.#pending.delete(key)
        })
        this.#pending.set(key, task)
        await task
    }

    /**
     * 删除 prepare 写入 workspace/scratch 的 ACL
     *
     * 没有状态文件与内存记录时为 no-op：从未准备过，没有要清理的 SID
     */
    async cleanup(input: SandboxPrepareInput): Promise<void> {
        const workspace = resolve(input.workspaceDir)
        const scratch = resolve(input.scratchDir)
        const sids =
            this.#records.get(workspace.toLowerCase())?.sids ?? (await this.#readSids(workspace))
        if (sids === undefined || sids === null) {
            return
        }
        const launcher = this.#resolveLauncher()
        if (launcher === null || !this.#exists(launcher)) {
            throw new SandboxExecutionError("win-sandbox.exe 不可用：先运行 pnpm win-sandbox:build")
        }
        await runLauncher(
            launcher,
            [
                "--cleanup",
                "--workspace",
                workspace,
                "--scratch",
                scratch,
                "--sid-r",
                sids.sidR,
                "--sid-w",
                sids.sidW,
            ],
            "cleanup",
        )
        this.#records.delete(workspace.toLowerCase())
        for (const key of this.#prepared) {
            if (key.startsWith(`${workspace.toLowerCase()}|`)) {
                this.#prepared.delete(key)
            }
        }
    }

    buildAgentLaunch(input: AgentLaunchInput): LaunchSpec {
        const workspace = resolve(input.workspaceDir)
        const record = this.#records.get(workspace.toLowerCase())
        if (record === undefined) {
            throw new SandboxExecutionError("workspace 尚未准备完成")
        }
        const launcher = this.#resolveLauncher()
        if (launcher === null) {
            throw new SandboxExecutionError("win-sandbox.exe 不可用")
        }
        return buildWinSandboxLaunch(input, launcher, record.sids)
    }

    buildPluginLaunch(_input: PluginLaunchInput): LaunchSpec {
        throw new Error("win-restricted 后端只用于 Agent 代码执行，插件继续使用 node-permission")
    }

    #resolveLauncher(): string | null {
        if (this.#launcher !== null) {
            return this.#launcher
        }
        return packagedLauncherPath(process.arch, this.#exists)
    }

    async #readSids(workspace: string): Promise<WinSidState | null> {
        const file = this.#stateFile(workspace)
        if (file === null) {
            return null
        }
        try {
            const raw = await readFile(file, "utf8")
            const parsed = JSON.parse(raw) as Partial<WinSidState>
            if (isSid(parsed.sidR) && isSid(parsed.sidW)) {
                return { sidR: parsed.sidR, sidW: parsed.sidW }
            }
        } catch {
            /* 状态文件不存在/损坏 */
        }
        return null
    }

    async #loadSids(workspace: string): Promise<WinSidState> {
        const key = workspace.toLowerCase()
        const cached = this.#records.get(key)?.sids
        if (cached !== undefined) {
            return cached
        }
        const loading = this.#sidLoads.get(key)
        if (loading !== undefined) {
            return await loading
        }
        const task = (async (): Promise<WinSidState> => {
            const persisted = await this.#readSids(workspace)
            if (persisted !== null) {
                return persisted
            }
            const sids = createSidState()
            const file = this.#stateFile(workspace)
            if (file !== null) {
                await mkdir(dirname(file), { recursive: true })
                await writeFile(file, `${JSON.stringify(sids, null, 2)}\n`, { mode: 0o600 })
            }
            return sids
        })().finally(() => {
            this.#sidLoads.delete(key)
        })
        this.#sidLoads.set(key, task)
        return await task
    }

    #stateFile(workspace: string): string | null {
        if (this.#dataDir === null) {
            return null
        }
        return join(this.#dataDir, "sandbox", "win", `${workspaceStateKey(workspace)}.json`)
    }
}

function isSid(value: unknown): value is string {
    return typeof value === "string" && /^S-1-5-21-(\d+-){3}\d+$/.test(value)
}

function defaultSelfTest(binary: string): boolean {
    const result = spawnSync(binary, ["--self-test"], {
        timeout: 15_000,
        encoding: "utf8",
        windowsHide: true,
    })
    return result.status === 0
}

async function runLauncher(
    binary: string,
    args: readonly string[],
    action: "prepare" | "cleanup",
): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(binary, [...args], {
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
        })
        let stderr = ""
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8")
        })
        const timer = setTimeout(() => {
            child.kill()
            rejectPromise(new SandboxExecutionError(`win-sandbox --${action} 超时`))
        }, 120_000)
        timer.unref()
        child.once("error", (error) => {
            clearTimeout(timer)
            rejectPromise(
                new SandboxExecutionError(
                    `win-sandbox --${action} 启动失败：${error instanceof Error ? error.message : String(error)}`,
                ),
            )
        })
        child.once("exit", (code) => {
            clearTimeout(timer)
            if (code === 0) {
                resolvePromise()
                return
            }
            rejectPromise(
                new SandboxExecutionError(
                    `win-sandbox --${action} 失败（exit=${String(code)}）：${stderr.trim() || "无输出"}`,
                ),
            )
        })
    })
}
