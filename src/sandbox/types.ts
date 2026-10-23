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

export interface SandboxBackend {
    readonly name: string
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
