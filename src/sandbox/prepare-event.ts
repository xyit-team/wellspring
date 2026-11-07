/*
 * 沙盒工作区准备事件
 *
 * 宿主与插件（Web UI）之间传递工作区准备状态
 */

import type { SandboxAccess } from "../config/types.ts"

export const SANDBOX_PREPARE_EVENT = "sandbox.workspace.prepare"

export type SandboxPreparePhase = "started" | "completed" | "failed"

export interface SandboxPrepareEvent {
    /** 触发的 Agent 会话；缺失时按 workspace 广播 */
    readonly sessionId?: string
    readonly workspaceDir: string
    readonly access?: SandboxAccess
    readonly phase: SandboxPreparePhase
    /** completed/failed 时的耗时 */
    readonly elapsedMs?: number
    /** failed 时的错误摘要 */
    readonly error?: string
}
