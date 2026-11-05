/*
 * Sandbox 公共类型。
 * plugin profile 与 agent-code profile 共用 backend / supervisor；这里先定义 agent-code。
 */

import type { SandboxAccess, SandboxSetting } from "../config/types.ts"
import type { ResolvedPaths } from "../platform/path.ts"

export interface SandboxLimits {
    readonly timeoutMs: number
    readonly memoryMB: number
    readonly pids: number
    readonly outputLimitBytes: number
}

export interface SandboxArtifact {
    readonly path: string
    readonly size: number
    readonly sha256: string
}

export interface AgentCodeRequest {
    readonly sessionId?: string
    readonly command: string
    readonly argv: readonly string[]
    /** 默认 process.cwd() */
    readonly workspaceDir?: string
    /** 必须位于 workspaceDir 内；默认 workspaceDir */
    readonly cwd?: string
    readonly stdin?: string
    readonly timeoutMs?: number
    readonly memoryMB?: number
    readonly outputLimitBytes?: number
    readonly access?: SandboxAccess
    readonly network?: boolean
    /** 模型给出的提权理由 */
    readonly justification?: string
}

export interface AgentCodeResult {
    readonly sandboxId: string
    readonly backend: string
    readonly access: SandboxAccess
    readonly exitCode: number | null
    readonly signal: string | null
    readonly stdout: string
    readonly stderr: string
    readonly truncated: boolean
    readonly timedOut: boolean
    /** 本次 access 的实际强度，缺口见 enforcementNotes */
    readonly enforcement: SandboxEnforcement
    /** partial / none 的具体缺口 */
    readonly enforcementNotes: readonly string[]
    /** 物理内存限制方式：cgroup = 已挂 systemd user scope 的 MemoryMax；none = 宿主不支持/未启用 */
    readonly memoryLimit: "cgroup" | "none"
    /** memoryLimit 为 none 时的原因 */
    readonly memoryLimitReason: string | null
    /** cgroup 记录到 oom_kill（进程被内存上限杀掉） */
    readonly oomKilled: boolean
    readonly durationMs: number
    readonly artifacts: readonly SandboxArtifact[]
    /** sandbox 内可见路径；bwrap 下为 /scratch/artifacts */
    readonly artifactDir: string | null
    /** sandbox 内可见路径；bwrap 下为 /scratch */
    readonly sandboxDir: string
    /** 宿主侧路径，仅宿主使用 */
    readonly hostArtifactDir: string | null
    readonly hostSandboxDir: string
}

export type StopMode = "ctrl_c" | "kill"

export interface AgentCodeTaskHandle {
    readonly sandboxId: string
    readonly backend: string
    readonly access: SandboxAccess
    readonly stdout: string
    readonly stderr: string
    stop(mode: StopMode): void
    wait(): Promise<AgentCodeResult>
}

export interface SandboxBackendStatus {
    readonly available: boolean
    readonly backend: string
    readonly reason: string | null
    readonly version: string | null
}

export interface LaunchSpec {
    readonly command: string
    readonly args: readonly string[]
    /** spawn 的宿主 cwd；sandbox 内部的 cwd 由 backend 参数控制 */
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
}

/** 后端在启动命令前需要做的异步准备工作（例如 Windows ACL 授予） */
export interface SandboxPrepareInput {
    readonly workspaceDir: string
    readonly scratchDir: string
    readonly access?: SandboxAccess
}

export interface PluginLaunchInput {
    readonly pluginDir: string
    /** 插件内入口的相对路径，例如 index.ts */
    readonly pluginEntryRel: string
    readonly pluginDataDir: string
    /** 宿主编译后的 SDK 根目录（bwrap 下挂载到 /host） */
    readonly hostSdkDir: string
    /** runner 在宿主上的路径 */
    readonly runnerPath: string
    readonly env: Readonly<Record<string, string>>
    readonly limits: SandboxLimits
    /**
     * 是否放开出网
     *
     * 插件清单里写 `sandbox.network: true` 才给；用来让插件自己查更新
     * （版本探针要访问 npm registry）。默认断网。
     */
    readonly network?: boolean
}

export interface AgentLaunchInput {
    readonly workspaceDir: string
    readonly scratchDir: string
    readonly cwd: string
    readonly access?: SandboxAccess
    readonly network?: boolean
    readonly command: string
    readonly argv: readonly string[]
    readonly env: Readonly<Record<string, string>>
    readonly limits: SandboxLimits
}

/**
 * 后端对某个 access 实际能保证的强度
 *
 * full = 承诺的每种文件效果都被强制，partial = 强制了其中一部分，none = 无隔离
 * 需要绝对边界的调用方只接受 full
 */
export type SandboxEnforcement = "full" | "partial" | "none"

/**
 * 沙箱内的路径视图
 *
 * mount = 有独立挂载命名空间，沙箱内是 /workspace、/scratch 这类重映射路径
 * host = 使用宿主真实路径，沙箱内外路径字符串一致
 */
export type SandboxPathStyle = "mount" | "host"

export interface SandboxBackend {
    readonly name: string
    /** 决定结果里的 artifactDir / sandboxDir 是沙箱内路径还是宿主路径 */
    readonly pathStyle: SandboxPathStyle
    /** 是否提供 cgroup v2 物理内存限制，与 pathStyle 无关 */
    readonly memoryLimit: boolean
    /** 该后端对给定 access 实际能保证的强度 */
    enforcement(access: SandboxAccess): SandboxEnforcement
    /** partial / none 的具体缺口，full 返回空数组 */
    enforcementNotes(access: SandboxAccess): readonly string[]
    /** 可选：启动前的异步准备（Windows ACL 等）；必须 fail-closed */
    prepare?(input: SandboxPrepareInput): Promise<void>
    /** 可选：删除 prepare 加到 workspace/scratch 上的 ACL（工作区删除前调用） */
    cleanup?(input: SandboxPrepareInput): Promise<void>
    probe(): Promise<SandboxBackendStatus>
    buildAgentLaunch(input: AgentLaunchInput): LaunchSpec
    buildPluginLaunch(input: PluginLaunchInput): LaunchSpec
}

export interface SandboxManagerOptions {
    readonly settings: SandboxSetting
    readonly paths: ResolvedPaths
    /** 测试注入；生产由 probe 选择 */
    readonly backend?: SandboxBackend
    readonly logger?: {
        warn(fields: Record<string, unknown>, message: string): void
        info(fields: Record<string, unknown>, message: string): void
    }
}

export class SandboxUnavailableError extends Error {
    constructor(reason: string) {
        super(`sandbox 不可用：${reason}`)
        this.name = "SandboxUnavailableError"
    }
}

export class SandboxExecutionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "SandboxExecutionError"
    }
}
