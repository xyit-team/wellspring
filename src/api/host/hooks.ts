/*
 * 平台 → 插件的钩子。
 * 插件通过 `wellspring/api/host/index.ts` 导入注册函数；平台在对话生命周期里触发。
 * 注册发生在插件 import / setup / init 期间，用 AsyncLocalStorage 记录归属插件。
 */

import { AsyncLocalStorage } from "node:async_hooks"

import { getHostBridge } from "../../sandbox/bridge-state.ts"

export type HookKind =
    | "message"
    | "beforeTurn"
    | "beforeStep"
    | "afterStep"
    | "afterTurn"
    | "agentRunSync"
    | "agentRunAsync"
    | "agentAsyncTaskComplete"
    | "agentCallTool"
    | "agentAsk"
    | "agentRead"
    | "agentQueryTask"
    | "agentSubmit"
    | "agentSetTasks"
    | "agentSetGoal"
    | "agentRequestPermission"
    | "userAnswer"
    | "init"
    | "shutdown"

export type HookHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>

export type Unregister = () => void

abstract class EventBase {
    constructor(input: Record<string, unknown>) {
        Object.assign(this, input)
    }
}

export class SessionLifecycleEvent extends EventBase {
    declare readonly sessionId: string
    declare readonly mode: "chat" | "run"
    declare readonly turn: number
}

export class SessionMessageEvent extends SessionLifecycleEvent {
    declare readonly role: "user" | "assistant"
    declare readonly phase: "before" | "after"
    declare readonly content: string
    /** before 阶段可追加系统提示；平台会把数组拼进系统消息 */
    declare readonly prompt: string[]
}

export class BeforeTurnEvent extends SessionLifecycleEvent {
    declare readonly input: string
    declare readonly cwd: string
}

export class BeforeStepEvent extends SessionLifecycleEvent {
    declare readonly step: number
    declare readonly input: string
}

export class AfterStepEvent extends SessionLifecycleEvent {
    declare readonly step: number
    declare readonly reply: string
}

export class AfterTurnEvent extends SessionLifecycleEvent {
    declare readonly reason: "completed" | "failed" | "cancelled"
    declare readonly code: string | null
}

export class AgentRunEvent extends EventBase {
    declare readonly sessionId: string
    declare readonly turn: number
    declare readonly input: string
    declare readonly cwd: string
}

/** onAgentRunAsync：Agent 创建异步任务之前 */
export class AgentAsyncTaskEvent extends EventBase {
    declare readonly sessionId: string
    declare readonly taskId: string
    declare readonly task: string
    declare readonly cwd: string
}

/** onAgentAsyncTaskComplete：异步任务结束 */
export class AgentAsyncTaskCompleteEvent extends EventBase {
    declare readonly sessionId: string
    declare readonly taskId: string
    declare readonly status: "completed" | "failed" | "cancelled"
    declare readonly result: unknown
    declare readonly error: string | null
}

export class AgentCallToolEvent extends EventBase {
    declare readonly sessionId: string
    declare readonly turn: number
    declare readonly step: number
    declare readonly callId: string
    declare readonly name: string
    declare readonly arguments: string
}

export class AgentAskEvent extends EventBase {
    declare readonly sessionId: string
    declare readonly question: string
    readonly options?: readonly string[]
}

export class AgentReadEvent extends EventBase {
    declare readonly sessionId: string
    declare readonly turn: number
    declare readonly step: number
    declare readonly path: string
    declare readonly content: string | null
}

export class AgentQueryTaskEvent extends EventBase {
    declare readonly sessionId: string
    readonly query?: string
}

export class AgentSubmitEvent extends EventBase {
    declare readonly sessionId: string
    declare readonly result: unknown
}

export class AgentSetTasksEvent extends EventBase {
    declare readonly sessionId: string
    declare readonly tasks: readonly string[]
}

export class AgentSetGoalEvent extends EventBase {
    declare readonly sessionId: string
    declare readonly goal: string
}

export class AgentRequestPermissionEvent extends EventBase {
    declare readonly sessionId: string
    declare readonly action: string
    readonly resource?: string
}

export class UserAnswerEvent extends EventBase {
    declare readonly sessionId: string
    declare readonly answer: string
}

export interface HookError {
    readonly hook: HookKind
    readonly owner: string | null
    readonly error: unknown
}

const ownerStorage = new AsyncLocalStorage<{ readonly pluginId: string }>()

/** 在插件加载/执行期间设置钩子归属；平台内部使用 */
export async function withHookOwner<T>(pluginId: string, task: () => T | Promise<T>): Promise<T> {
    return await ownerStorage.run({ pluginId }, async () => await task())
}

/** 平台内部：当前正在执行的插件（用于访问守卫） */
export function getHookOwner(): string | null {
    return ownerStorage.getStore()?.pluginId ?? null
}

interface Entry<Args extends unknown[]> {
    readonly owner: string | null
    readonly handler: HookHandler<Args>
}

const messageHooks: Entry<[SessionMessageEvent]>[] = []
const beforeTurnHooks: Entry<[BeforeTurnEvent]>[] = []
const beforeStepHooks: Entry<[BeforeStepEvent]>[] = []
const afterStepHooks: Entry<[AfterStepEvent]>[] = []
const afterTurnHooks: Entry<[AfterTurnEvent]>[] = []
const agentRunSyncHooks: Entry<[AgentRunEvent]>[] = []
const agentRunAsyncHooks: Entry<[AgentAsyncTaskEvent]>[] = []
const agentAsyncTaskCompleteHooks: Entry<[AgentAsyncTaskCompleteEvent]>[] = []
const agentCallToolHooks: Entry<[AgentCallToolEvent]>[] = []
const agentAskHooks: Entry<[AgentAskEvent]>[] = []
const agentReadHooks: Entry<[AgentReadEvent]>[] = []
const agentQueryTaskHooks: Entry<[AgentQueryTaskEvent]>[] = []
const agentSubmitHooks: Entry<[AgentSubmitEvent]>[] = []
const agentSetTasksHooks: Entry<[AgentSetTasksEvent]>[] = []
const agentSetGoalHooks: Entry<[AgentSetGoalEvent]>[] = []
const agentRequestPermissionHooks: Entry<[AgentRequestPermissionEvent]>[] = []
const userAnswerHooks: Entry<[UserAnswerEvent]>[] = []
const initHooks: Entry<[]>[] = []
const shutdownHooks: Entry<[]>[] = []

let errorReporter: ((error: HookError) => void) | null = null

/** 平台注入错误处理，钩子抛错时不打断主流程 */
export function setHookErrorHandler(handler: (error: HookError) => void): void {
    errorReporter = handler
}

type HookGuard = (owner: string, task: () => Promise<void>) => Promise<void>

let hookGuard: HookGuard | null = null

/** 平台内部：在钩子执行期间应用插件级 console 拦截等 */
export function setHookGuard(guard: HookGuard | null): void {
    hookGuard = guard
}

function add<Args extends unknown[]>(
    registry: Entry<Args>[],
    handler: HookHandler<Args>,
): Unregister {
    const entry: Entry<Args> = { owner: getHookOwner(), handler }
    registry.push(entry)
    return () => {
        const index = registry.indexOf(entry)
        if (index !== -1) {
            registry.splice(index, 1)
        }
    }
}

function removeByOwner(registry: Entry<unknown[]>[], owner: string): void {
    for (let index = registry.length - 1; index >= 0; index -= 1) {
        if (registry[index]?.owner === owner) {
            registry.splice(index, 1)
        }
    }
}

/** 插件加载失败时清掉它已注册的钩子 */
export function removeHooksByOwner(owner: string): void {
    const registries: Entry<never>[][] = [
        messageHooks,
        beforeTurnHooks,
        beforeStepHooks,
        afterStepHooks,
        afterTurnHooks,
        agentRunSyncHooks,
        agentRunAsyncHooks,
        agentAsyncTaskCompleteHooks,
        agentCallToolHooks,
        agentAskHooks,
        agentReadHooks,
        agentQueryTaskHooks,
        agentSubmitHooks,
        agentSetTasksHooks,
        agentSetGoalHooks,
        agentRequestPermissionHooks,
        userAnswerHooks,
        initHooks,
        shutdownHooks,
    ] as unknown as Entry<never>[][]
    for (const registry of registries) {
        removeByOwner(registry as Entry<unknown[]>[], owner)
    }
}

const ALL_HOOK_KINDS: readonly HookKind[] = [
    "message",
    "beforeTurn",
    "beforeStep",
    "afterStep",
    "afterTurn",
    "agentRunSync",
    "agentRunAsync",
    "agentAsyncTaskComplete",
    "agentCallTool",
    "agentAsk",
    "agentRead",
    "agentQueryTask",
    "agentSubmit",
    "agentSetTasks",
    "agentSetGoal",
    "agentRequestPermission",
    "userAnswer",
    "init",
    "shutdown",
]

function registryFor(kind: HookKind): Entry<unknown[]>[] {
    switch (kind) {
        case "message":
            return messageHooks as Entry<unknown[]>[]
        case "beforeTurn":
            return beforeTurnHooks as Entry<unknown[]>[]
        case "beforeStep":
            return beforeStepHooks as Entry<unknown[]>[]
        case "afterStep":
            return afterStepHooks as Entry<unknown[]>[]
        case "afterTurn":
            return afterTurnHooks as Entry<unknown[]>[]
        case "agentRunSync":
            return agentRunSyncHooks as Entry<unknown[]>[]
        case "agentRunAsync":
            return agentRunAsyncHooks as Entry<unknown[]>[]
        case "agentAsyncTaskComplete":
            return agentAsyncTaskCompleteHooks as Entry<unknown[]>[]
        case "agentCallTool":
            return agentCallToolHooks as Entry<unknown[]>[]
        case "agentAsk":
            return agentAskHooks as Entry<unknown[]>[]
        case "agentRead":
            return agentReadHooks as Entry<unknown[]>[]
        case "agentQueryTask":
            return agentQueryTaskHooks as Entry<unknown[]>[]
        case "agentSubmit":
            return agentSubmitHooks as Entry<unknown[]>[]
        case "agentSetTasks":
            return agentSetTasksHooks as Entry<unknown[]>[]
        case "agentSetGoal":
            return agentSetGoalHooks as Entry<unknown[]>[]
        case "agentRequestPermission":
            return agentRequestPermissionHooks as Entry<unknown[]>[]
        case "userAnswer":
            return userAnswerHooks as Entry<unknown[]>[]
        case "init":
            return initHooks as Entry<unknown[]>[]
        case "shutdown":
            return shutdownHooks as Entry<unknown[]>[]
    }
}

/** 宿主内部：为 sandbox 插件注册远程钩子 */
export function registerExternalHook(
    kind: HookKind,
    owner: string,
    handler: HookHandler<[unknown]>,
): Unregister {
    const registry = registryFor(kind)
    const entry: Entry<unknown[]> = {
        owner,
        handler: handler as HookHandler<unknown[]>,
    }
    registry.push(entry)
    return () => {
        const index = registry.indexOf(entry)
        if (index !== -1) {
            registry.splice(index, 1)
        }
    }
}

/** 当前 owner 注册了哪些钩子（sandbox runner 上报用） */
export function listHookKinds(owner: string): HookKind[] {
    return ALL_HOOK_KINDS.filter((kind) => registryFor(kind).some((entry) => entry.owner === owner))
}

export function onMessage(handler: HookHandler<[SessionMessageEvent]>): Unregister {
    return add(messageHooks, handler)
}

export function beforeTurn(handler: HookHandler<[BeforeTurnEvent]>): Unregister {
    return add(beforeTurnHooks, handler)
}

export function beforeStep(handler: HookHandler<[BeforeStepEvent]>): Unregister {
    return add(beforeStepHooks, handler)
}

export function afterStep(handler: HookHandler<[AfterStepEvent]>): Unregister {
    return add(afterStepHooks, handler)
}

export function afterTurn(handler: HookHandler<[AfterTurnEvent]>): Unregister {
    return add(afterTurnHooks, handler)
}

/** run 模式开始同步执行前触发 */
export function onAgentRunSync(handler: HookHandler<[AgentRunEvent]>): Unregister {
    return add(agentRunSyncHooks, handler)
}

/** Agent 即将创建异步任务时触发 */
export function onAgentRunAsync(handler: HookHandler<[AgentAsyncTaskEvent]>): Unregister {
    return add(agentRunAsyncHooks, handler)
}

/** Agent 异步任务结束后触发 */
export function onAgentAsyncTaskComplete(
    handler: HookHandler<[AgentAsyncTaskCompleteEvent]>,
): Unregister {
    return add(agentAsyncTaskCompleteHooks, handler)
}

export function onAgentCallTool(handler: HookHandler<[AgentCallToolEvent]>): Unregister {
    return add(agentCallToolHooks, handler)
}

export function onAgentAsk(handler: HookHandler<[AgentAskEvent]>): Unregister {
    return add(agentAskHooks, handler)
}

export function onAgentRead(handler: HookHandler<[AgentReadEvent]>): Unregister {
    return add(agentReadHooks, handler)
}

export function onAgentQueryTask(handler: HookHandler<[AgentQueryTaskEvent]>): Unregister {
    return add(agentQueryTaskHooks, handler)
}

export function onAgentSubmit(handler: HookHandler<[AgentSubmitEvent]>): Unregister {
    return add(agentSubmitHooks, handler)
}

export function onAgentSetTasks(handler: HookHandler<[AgentSetTasksEvent]>): Unregister {
    return add(agentSetTasksHooks, handler)
}

export function onAgentSetGoal(handler: HookHandler<[AgentSetGoalEvent]>): Unregister {
    return add(agentSetGoalHooks, handler)
}

export function onAgentRequestPermission(
    handler: HookHandler<[AgentRequestPermissionEvent]>,
): Unregister {
    return add(agentRequestPermissionHooks, handler)
}

export function onUserAnswer(handler: HookHandler<[UserAnswerEvent]>): Unregister {
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

function eventOf<T extends object>(input: T, ctor: new (input: Record<string, unknown>) => T): T {
    return input instanceof ctor ? input : new ctor({ ...(input as Record<string, unknown>) })
}

export async function emitOnMessage(payload: SessionMessageEvent): Promise<void> {
    await emit("message", messageHooks, [eventOf(payload, SessionMessageEvent)])
}

export async function emitBeforeTurn(payload: BeforeTurnEvent): Promise<void> {
    await emit("beforeTurn", beforeTurnHooks, [eventOf(payload, BeforeTurnEvent)])
}

export async function emitBeforeStep(payload: BeforeStepEvent): Promise<void> {
    await emit("beforeStep", beforeStepHooks, [eventOf(payload, BeforeStepEvent)])
}

export async function emitAfterStep(payload: AfterStepEvent): Promise<void> {
    await emit("afterStep", afterStepHooks, [eventOf(payload, AfterStepEvent)])
}

export async function emitAfterTurn(payload: AfterTurnEvent): Promise<void> {
    await emit("afterTurn", afterTurnHooks, [eventOf(payload, AfterTurnEvent)])
}

export async function emitAgentRunSync(payload: AgentRunEvent): Promise<void> {
    await emit("agentRunSync", agentRunSyncHooks, [eventOf(payload, AgentRunEvent)])
}

export async function emitAgentRunAsync(payload: AgentAsyncTaskEvent): Promise<void> {
    await emit("agentRunAsync", agentRunAsyncHooks, [eventOf(payload, AgentAsyncTaskEvent)])
}

export async function emitAgentAsyncTaskComplete(
    payload: AgentAsyncTaskCompleteEvent,
): Promise<void> {
    await emit("agentAsyncTaskComplete", agentAsyncTaskCompleteHooks, [
        eventOf(payload, AgentAsyncTaskCompleteEvent),
    ])
}

export async function emitAgentCallTool(payload: AgentCallToolEvent): Promise<void> {
    await emit("agentCallTool", agentCallToolHooks, [eventOf(payload, AgentCallToolEvent)])
}

export async function emitAgentAsk(payload: AgentAskEvent): Promise<void> {
    await emit("agentAsk", agentAskHooks, [eventOf(payload, AgentAskEvent)])
}

export async function emitAgentRead(payload: AgentReadEvent): Promise<void> {
    await emit("agentRead", agentReadHooks, [eventOf(payload, AgentReadEvent)])
}

export async function emitAgentQueryTask(payload: AgentQueryTaskEvent): Promise<void> {
    await emit("agentQueryTask", agentQueryTaskHooks, [eventOf(payload, AgentQueryTaskEvent)])
}

export async function emitAgentSubmit(payload: AgentSubmitEvent): Promise<void> {
    await emit("agentSubmit", agentSubmitHooks, [eventOf(payload, AgentSubmitEvent)])
}

export async function emitAgentSetTasks(payload: AgentSetTasksEvent): Promise<void> {
    await emit("agentSetTasks", agentSetTasksHooks, [eventOf(payload, AgentSetTasksEvent)])
}

export async function emitAgentSetGoal(payload: AgentSetGoalEvent): Promise<void> {
    await emit("agentSetGoal", agentSetGoalHooks, [eventOf(payload, AgentSetGoalEvent)])
}

export async function emitAgentRequestPermission(
    payload: AgentRequestPermissionEvent,
): Promise<void> {
    await emit("agentRequestPermission", agentRequestPermissionHooks, [
        eventOf(payload, AgentRequestPermissionEvent),
    ])
}

export async function emitUserAnswer(payload: UserAnswerEvent): Promise<void> {
    await emit("userAnswer", userAnswerHooks, [eventOf(payload, UserAnswerEvent)])
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
    const bridge = getHostBridge()
    if (bridge !== null) {
        bridge.shutdown()
        return
    }
    if (shutdownHandler === null) {
        throw new Error("shutdown() 只能在 wellspring start 进程内调用")
    }
    shutdownHandler()
}
