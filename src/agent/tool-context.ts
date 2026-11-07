// 插件工具调用上下文：宿主能力在调用期间读取当前 Agent 权限

import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

import type { SandboxAccess } from "../config/types.ts"
import type { Elog } from "../logger/elog4js.ts"

export interface AgentToolRequest {
    readonly command: string
    readonly argv: readonly string[]
    readonly cwd: string
    readonly currentPermission?: SandboxAccess
    readonly requestedPermission?: SandboxAccess
    readonly justification?: string
    /** 请求联网；与提权独立的审阅项 */
    readonly network?: boolean
    /** 请求后台执行 */
    readonly background?: boolean
    /** 标准输入；可能很大，界面截断显示 */
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

/*
 * 跨进程的身份注册表：一次 Agent 工具调用一个 id
 *
 * 插件工具调用走 RPC 出宿主进程，插件回访宿主时（host.capabilities.*、host.workspaceFs.*）
 * 不在发起调用的 async 链上，ALS 取不到上下文
 * 传的是 id，上下文本身留在宿主进程：AgentToolContext 含函数与 elog，不可序列化
 * 并发调用各有各的 id，与调用退出顺序无关
 */
const registry = new Map<string, AgentToolContext>()

// 登记一次工具调用，返回跨进程传递的 id
export function registerAgentToolContext(context: AgentToolContext): string {
    const id = `agent-ctx-${randomUUID()}`
    registry.set(id, context)
    return id
}

// 注销工具调用身份；此后按该 id 查不到上下文
export function releaseAgentToolContext(id: string): void {
    registry.delete(id)
}

/** 按 id 取回上下文；缺失或已注销返回 null */
export function resolveAgentToolContext(id: string | undefined | null): AgentToolContext | null {
    if (id === undefined || id === null || id === "") {
        return null
    }
    return registry.get(id) ?? null
}

/** 当前登记数，测试与诊断用 */
export function activeAgentToolContextCount(): number {
    return registry.size
}

export async function withAgentToolContext<T>(
    context: AgentToolContext,
    task: () => Promise<T>,
): Promise<T> {
    return await storage.run(context, task)
}

/** 进程内的当前上下文 */
export function getAgentToolContext(): AgentToolContext | null {
    return storage.getStore() ?? null
}
