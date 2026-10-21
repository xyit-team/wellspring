/*
 * 平台 → 插件的钩子。
 * 插件通过 `wellspring/api/host/index.ts` 导入注册函数；平台在对话生命周期里触发。
 * 注册发生在插件 import / setup / init 期间，用 AsyncLocalStorage 记录归属插件。
 */

import { AsyncLocalStorage } from "node:async_hooks"

export type HookKind =
    | "beforeMessage"
    | "afterMessage"
    | "afterStep"
    | "afterTurn"
    | "agentCallTool"
    | "agentAsk"
    | "agentSetTask"
    | "agentSetGoal"
    | "userAnswer"
    | "init"
    | "shutdown"

export type HookHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>

export type Unregister = () => void

export interface BeforeMessagePayload {
    readonly input: string
    /** 当前会话的 cwd */
    readonly context: string
    /** 可追加系统提示；平台会把数组拼进系统消息 */
    readonly prompt: string[]
}

export interface AfterMessagePayload {
    readonly sessionId: string
    readonly mode: "chat" | "run"
    readonly input: string
    readonly reply: string
    readonly model: string
    readonly inputTokens: number | null
    readonly outputTokens: number | null
}

export interface AfterStepPayload {
    readonly sessionId: string
    readonly mode: "chat" | "run"
    readonly turn: number
    readonly step: number
    readonly reply: string
    readonly model: string
}

export interface AfterTurnPayload {
    readonly sessionId: string
    readonly mode: "chat" | "run"
    readonly turn: number
    readonly reason: "completed" | "failed" | "cancelled"
    readonly code: string | null
}

export interface AgentCallToolPayload {
    readonly sessionId: string
    readonly turn: number
    readonly step: number
    readonly callId: string
    readonly name: string
    readonly arguments: string
}

export interface AgentAskPayload {
    readonly sessionId: string
    readonly question: string
    readonly options?: readonly string[]
}

export interface AgentSetTaskPayload {
    readonly sessionId: string
    readonly task: string
}

export interface AgentSetGoalPayload {
    readonly sessionId: string
    readonly goal: string
}

export interface UserAnswerPayload {
    readonly sessionId: string
    readonly answer: string
}

export interface HookError {
    readonly hook: HookKind
    readonly owner: string | null
    readonly error: unknown
}

const ownerStorage = new AsyncLocalStorage<{ readonly pluginId: string }>()

/** 在插件加载期间设置钩子归属；平台内部使用 */
export async function withHookOwner<T>(pluginId: string, task: () => T | Promise<T>): Promise<T> {
    return await ownerStorage.run({ pluginId }, async () => await task())
}

function currentOwner(): string | null {
    return ownerStorage.getStore()?.pluginId ?? null
}

interface Entry<Args extends unknown[]> {
    readonly owner: string | null
    readonly handler: HookHandler<Args>
}

const beforeMessageHooks: Entry<[BeforeMessagePayload]>[] = []
const afterMessageHooks: Entry<[AfterMessagePayload]>[] = []
const afterStepHooks: Entry<[AfterStepPayload]>[] = []
const afterTurnHooks: Entry<[AfterTurnPayload]>[] = []
const agentCallToolHooks: Entry<[AgentCallToolPayload]>[] = []
const agentAskHooks: Entry<[AgentAskPayload]>[] = []
const agentSetTaskHooks: Entry<[AgentSetTaskPayload]>[] = []
const agentSetGoalHooks: Entry<[AgentSetGoalPayload]>[] = []
const userAnswerHooks: Entry<[UserAnswerPayload]>[] = []
const initHooks: Entry<[]>[] = []
const shutdownHooks: Entry<[]>[] = []

let errorReporter: ((error: HookError) => void) | null = null

/** 平台注入错误处理，钩子抛错时不打断主流程 */
export function setHookErrorHandler(handler: (error: HookError) => void): void {
    errorReporter = handler
}

function add<Args extends unknown[]>(
    registry: Entry<Args>[],
    handler: HookHandler<Args>,
): Unregister {
    const entry: Entry<Args> = { owner: currentOwner(), handler }
    registry.push(entry)
    return () => {
        const index = registry.indexOf(entry)
        if (index !== -1) {
            registry.splice(index, 1)
        }
    }
}

function removeByOwner(registry: Entry<never>[] | Entry<unknown[]>[], owner: string): void {
    for (let index = registry.length - 1; index >= 0; index -= 1) {
        if (registry[index]?.owner === owner) {
            registry.splice(index, 1)
        }
    }
}

/** 插件加载失败时清掉它已注册的钩子 */
export function removeHooksByOwner(owner: string): void {
    const registries: Entry<never>[][] = [
        beforeMessageHooks,
        afterMessageHooks,
        afterStepHooks,
        afterTurnHooks,
        agentCallToolHooks,
        agentAskHooks,
        agentSetTaskHooks,
        agentSetGoalHooks,
        userAnswerHooks,
        initHooks,
        shutdownHooks,
    ] as unknown as Entry<never>[][]
    for (const registry of registries) {
        removeByOwner(registry as Entry<unknown[]>[], owner)
    }
}

export function beforeMessage(handler: HookHandler<[BeforeMessagePayload]>): Unregister {
    return add(beforeMessageHooks, handler)
}

export function afterMessage(handler: HookHandler<[AfterMessagePayload]>): Unregister {
    return add(afterMessageHooks, handler)
}

export function afterStep(handler: HookHandler<[AfterStepPayload]>): Unregister {
    return add(afterStepHooks, handler)
}

export function afterTurn(handler: HookHandler<[AfterTurnPayload]>): Unregister {
    return add(afterTurnHooks, handler)
}

export function onAgentCallTool(handler: HookHandler<[AgentCallToolPayload]>): Unregister {
    return add(agentCallToolHooks, handler)
}

export function onAgentAsk(handler: HookHandler<[AgentAskPayload]>): Unregister {
    return add(agentAskHooks, handler)
}

export function onAgentSetTask(handler: HookHandler<[AgentSetTaskPayload]>): Unregister {
    return add(agentSetTaskHooks, handler)
}

export function onAgentSetGoal(handler: HookHandler<[AgentSetGoalPayload]>): Unregister {
    return add(agentSetGoalHooks, handler)
}

export function onUserAnswer(handler: HookHandler<[UserAnswerPayload]>): Unregister {
    return add(userAnswerHooks, handler)
}

/** 服务进程加载完插件后触发 */
export function onInit(handler: HookHandler<[]>): Unregister {
    return add(initHooks, handler)
}

/** 服务进程关闭前触发；Ctrl+C 或 shutdown() 后执行 */
export function onShutdown(handler: HookHandler<[]>): Unregister {
    return add(shutdownHooks, handler)
}

type HookGuard = (owner: string, task: () => Promise<void>) => Promise<void>

let hookGuard: HookGuard | null = null

/** 平台内部：在钩子执行期间应用插件级 console 拦截等 */
export function setHookGuard(guard: HookGuard | null): void {
    hookGuard = guard
}

async function emit<Args extends unknown[]>(
    kind: HookKind,
    registry: Entry<Args>[],
    args: Args,
): Promise<void> {
    for (const entry of [...registry]) {
        const task = async (): Promise<void> => {
            await entry.handler(...args)
        }
        try {
            if (entry.owner !== null && hookGuard !== null) {
                await hookGuard(entry.owner, task)
            } else {
                await task()
            }
        } catch (error) {
            errorReporter?.({ hook: kind, owner: entry.owner, error })
        }
    }
}

/** 平台内部：对话前，可修改 prompt 数组 */
export async function emitBeforeMessage(payload: BeforeMessagePayload): Promise<void> {
    await emit("beforeMessage", beforeMessageHooks, [payload])
}

export async function emitAfterMessage(payload: AfterMessagePayload): Promise<void> {
    await emit("afterMessage", afterMessageHooks, [payload])
}

export async function emitAfterStep(payload: AfterStepPayload): Promise<void> {
    await emit("afterStep", afterStepHooks, [payload])
}

export async function emitAfterTurn(payload: AfterTurnPayload): Promise<void> {
    await emit("afterTurn", afterTurnHooks, [payload])
}

export async function emitAgentCallTool(payload: AgentCallToolPayload): Promise<void> {
    await emit("agentCallTool", agentCallToolHooks, [payload])
}

export async function emitAgentAsk(payload: AgentAskPayload): Promise<void> {
    await emit("agentAsk", agentAskHooks, [payload])
}

export async function emitAgentSetTask(payload: AgentSetTaskPayload): Promise<void> {
    await emit("agentSetTask", agentSetTaskHooks, [payload])
}

export async function emitAgentSetGoal(payload: AgentSetGoalPayload): Promise<void> {
    await emit("agentSetGoal", agentSetGoalHooks, [payload])
}

export async function emitUserAnswer(payload: UserAnswerPayload): Promise<void> {
    await emit("userAnswer", userAnswerHooks, [payload])
}

export async function emitInitHooks(): Promise<void> {
    await emit("init", initHooks, [])
}

export async function emitShutdownHooks(): Promise<void> {
    await emit("shutdown", shutdownHooks, [])
}

let shutdownHandler: (() => void) | null = null

/** 平台内部：start 命令注册关闭回调 */
export function setShutdownHandler(handler: (() => void) | null): void {
    shutdownHandler = handler
}

/**
 * 请求服务进程优雅关闭。
 * 只能在 `wellspring start` 进程内调用；关闭流程会先执行 onShutdown 钩子。
 */
export function shutdown(): void {
    if (shutdownHandler === null) {
        throw new Error("shutdown() 只能在 wellspring start 进程内调用")
    }
    shutdownHandler()
}
