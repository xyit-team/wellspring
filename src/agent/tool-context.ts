// 插件工具调用上下文：宿主能力在调用期间读取当前 Agent 权限

import { AsyncLocalStorage } from "node:async_hooks"

import type { SandboxAccess } from "../config/types.ts"
import type { Elog } from "../logger/elog4js.ts"

export interface AgentToolRequest {
    readonly command: string
    readonly argv: readonly string[]
    readonly cwd: string
    readonly currentPermission?: SandboxAccess
    readonly requestedPermission?: SandboxAccess
    readonly justification?: string
    /** 请求联网：和提权是两件事，审阅时也要看到 */
    readonly network?: boolean
    /** 请求后台执行 */
    readonly background?: boolean
    /** 要喂给进程的标准输入（可能很大，界面截断显示） */
    readonly stdin?: string
    /** 请求的超时毫秒 */
    readonly timeoutMs?: number
}

export interface AgentToolContext {
    readonly sessionId: string
    readonly turn: number
    readonly step: number
    readonly workspaceDir: string
    readonly permission: SandboxAccess
    readonly allowExec: boolean
    readonly approveExec?: (request: AgentToolRequest) => Promise<boolean>
    readonly elog: Elog
}

const storage = new AsyncLocalStorage<AgentToolContext>()

export async function withAgentToolContext<T>(
    context: AgentToolContext,
    task: () => Promise<T>,
): Promise<T> {
    return await storage.run(context, task)
}

export function getAgentToolContext(): AgentToolContext | null {
    return storage.getStore() ?? null
}
