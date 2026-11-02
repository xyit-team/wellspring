/*
 * 前端状态与业务动作（Vue reactive 版，逐步对齐旧 app.ts）。
 * 纯数据逻辑复用 ./logic/conversations.ts / ./logic/mentions.ts。
 */

import { reactive } from "vue"

import { toast as notifyToast } from "vue3-toastify"

import {
    AuthError,
    StreamResyncError,
    StreamStalledError,
    apiJson,
    consumeSse,
    jsonBody,
    reloadOnAuth,
} from "./api"
import {
    MAX_MESSAGES,
    MAX_MESSAGE_CHARS,
    MESSAGE_PAGE_LIMIT,
    conversationPath,
    conversationPayload,
    formatRelativeTime,
    normalizeConversation,
    normalizeMessage,
    titleFromText,
} from "./logic/conversations"
import { collectReferences } from "./logic/mentions"
import { createSaveTracker } from "./logic/saves"
import { parseNoProxy } from "./logic/network"
import {
    defaultVisibleFrom,
    earlierVisibleFrom,
    hiddenRounds,
    resolveVisibleFrom,
} from "./logic/windowing"
import { normalizeUsage, sumUsage } from "./logic/usage"
import {
    adoptLiveConversations,
    isNetworkError,
    retryDelayMs,
    serverAhead,
    shouldProbeAfterStream,
    shouldSettle,
    shouldTakeover,
    unfinished,
} from "./logic/resume"
import type { MarkdownMessage, TokenUsage } from "./types"

export { conversationPath }

export const PERMISSIONS: Record<string, { label: string; hint: string }> = {
    "read-only": { label: "只读", hint: "Agent 不能修改文件，也不能执行命令" },
    "workspace-write": { label: "工作区可写", hint: "Agent 只能修改当前工作区里的文件" },
    "danger-full-access": { label: "完全访问", hint: "Agent 可以读写任意路径、执行任意命令" },
}

/**
 * 发送键：一个组合键发送，其余 Enter 换行。
 *
 * 三选一而不是自由组合：聊天输入框的约定就是“一个组合发送、裸 Enter 换行”，
 * 给太多自由度反而让人不知道 Enter 会做什么。
 */
export type SendMode = "enter" | "shift-enter" | "ctrl-enter"

export interface SendModeInfo {
    /** 菜单里的一行标题 */
    readonly label: string
    /** 菜单里的说明：另一个键做什么 */
    readonly hint: string
    /** 提示行里显示的按键，如 ["Shift", "Enter"] */
    readonly keys: readonly string[]
    /** 占位符里的短句，如 "Shift+Enter 发送" */
    readonly short: string
}

/**
 * 默认 Shift+Enter 发送
 *
 * 这是本界面一直以来的行为（Enter 换行），保留成默认值，
 * 不给老用户改习惯；想要“Enter 直接发送”的人自己去切。
 */
export const DEFAULT_SEND_MODE: SendMode = "shift-enter"

export const SEND_MODES: Record<SendMode, SendModeInfo> = {
    enter: {
        label: "Enter 发送",
        hint: "Shift+Enter 换行",
        keys: ["Enter"],
        short: "Enter 发送",
    },
    "shift-enter": {
        label: "Shift+Enter 发送",
        hint: "Enter 换行",
        keys: ["Shift", "Enter"],
        short: "Shift+Enter 发送",
    },
    "ctrl-enter": {
        label: "Ctrl+Enter 发送",
        hint: "Enter 换行，Ctrl 与 ⌘ 都可以",
        keys: ["Ctrl", "Enter"],
        short: "Ctrl+Enter 发送",
    },
}

export const SUGGESTIONS = [
    {
        icon: "file",
        label: "读懂这个仓库",
        desc: "先给一份目录导览",
        prompt: "介绍一下这个仓库的结构，按目录说明各自的职责。",
    },
    {
        icon: "terminal",
        label: "查一下最近的改动",
        desc: "git 提交与文件变化",
        prompt: "看一下最近的 git 提交，总结这几轮改动做了什么。",
    },
    {
        icon: "code",
        label: "写一个插件",
        desc: "照现有示例加功能",
        prompt: "参考 plugins/hello-plugin 的写法，写一个能读取插件配置并输出摘要的插件。",
    },
]

/**
 * 长会话默认只渲染最近这么多轮，更早的折在「加载更早」后面。
 * 一轮 = 一条提问 + 它之后的回复、工具行、插话行。
 */
export const VISIBLE_ROUNDS = 10

/** 每点一次「加载更早」多露出来的轮数 */
export const ROUND_PAGE = 10

// 一页正文的条数，服务端按字符预算再收一次
export const MESSAGE_PAGE = MESSAGE_PAGE_LIMIT
export const UNGROUPED = "ungrouped"
const PERMISSION_STORAGE_KEY = "wellspring.web.permission"
const SEND_MODE_STORAGE_KEY = "wellspring.web.sendMode"
const GROUP_PREF_KEY = "wellspring.group.v1"

export interface WorkspaceView {
    id: string
    name: string
    root: string
    conversationCount: number
    lastSeenAt: number
}

export interface Conversation {
    id: string
    /**
     * 会话归属的工作区；null 表示未分组。
     * 保存必须用它而不是「当前选中的工作区」：运行中切换工作区时，
     * 拿当前选中去拼 URL 会把会话写进另一个工作区，两边的对话就串了。
     */
    workspaceId: string | null
    serverSessionId: string | null
    title: string
    createdAt: number
    updatedAt: number
    provider: string | null
    model: string | null
    reasoning: string | null
    permission: string | null
    workspaceRoot: string | null
    // 已加载的一段正文，分片加载时是尾部若干条
    messages: MarkdownMessage[]
    // 正文总条数，含未加载部分
    messageCount?: number
    // messages[0] 在正文里的下标，0 表示已到开头
    messagesFrom?: number
}

interface ChatStreamEvent {
    type: string
    /** resume 事件：本次重放的起点（对应服务端事件缓冲的下标） */
    from?: number
    /** resume 事件：服务端当时已缓冲的条数，前端拿它校准进度 */
    total?: number
    /** resume 事件：这一轮是否还在跑 */
    active?: boolean
    [key: string]: any
}

export interface AskRequest {
    askId?: string
    question: string
    options?: string[]
}

export interface Addon {
    label: string
    to: string
    external: boolean
}

export interface ApprovalRequest {
    approvalId: string
    command: string
    argv?: string[]
    cwd?: string
    currentPermission?: string
    requestedPermission?: string
    justification?: string
    /** 是否请求联网 */
    network?: boolean
    /** 是否请求后台执行 */
    background?: boolean
    /** 标准输入（可能很长，对话框里截断） */
    stdin?: string
    /** 请求的超时毫秒 */
    timeoutMs?: number
}

export const store = reactive({
    ready: false,
    configured: false,
    authenticated: false,
    shutdownRequested: false,
    version: "1.0.0",
    apiVersion: 1,
    theme: "system",
    hostStatus: "running",
    groupsLoaded: false,
    workspaces: [] as WorkspaceView[],
    workspacesError: "" as string,
    ungroupedCount: 0,
    group: "none" as "workspace" | "ungrouped" | "none",
    workspace: null as WorkspaceView | null,
    conversations: [] as Conversation[],
    activeId: null as string | null,
    /**
     * 每个会话的显示窗口起点（第一条可见消息的下标）
     *
     * 只有用户点过「加载更早」才会出现；没有值时用默认窗口（最近 VISIBLE_ROUNDS 轮）。
     * 读窗口时绝不回写这里——在 computed 里写响应式状态会让渲染自激。
     */
    windowStarts: {} as Record<string, number>,
    /**
     * 本地正在跑一轮的会话 id：runtimes 的响应式镜像，界面靠它即时重算
     * （runtimes 是普通 Map，写 controller 不会触发 computed）
     */
    localRunning: [] as string[],
    /**
     * 流式消息的版本号
     *
     * streaming 存在 runtimes（普通 Map）里，写它不会触发重算；activeStreaming()
     * 读这个计数建立响应式依赖，换消息时依赖才会重建（否则正文增量不会触发贴底滚动）
     */
    streamingVersion: 0,
    permission: readPermission(),
    sendMode: readSendMode(),
    ask: null as AskRequest | null,
    askMinimized: false,
    approval: null as ApprovalRequest | null,
    sidebarOpen: false,
    addons: [] as Addon[],
    /**
     * 服务端报告的正在跑一轮的会话 id（含其它窗口发起的），侧栏「运行中」用
     * 与 localRunning 的分工：这里允许滞后（4 秒轮询），本地状态优先
     */
    runningIds: [] as string[],
    /** 有会话在跑的工作区 id */
    runningWorkspaces: [] as string[],
    /** 输入框草稿：切到设置页再回来时不丢 */
    draft: "",
    pickedReferences: [] as string[],
})

const resumeAttempts = new Set<string>()

/**
 * 流式看门狗
 *
 * 服务端每 15s 发一条注释 ping。超过 STREAM_STALL_MS 连字节都收不到就是连接死了；
 * 连接还活着但 PROGRESS_PROBE_MS 没有 data 事件，就问一次服务端进度——
 * 服务端已经有更多事件说明这条流漏了（工具调用超时、反代掐连接、事件回调异常），
 * 立刻按已有进度增量重放，不用等这一轮跑完。
 */
const STREAM_STALL_MS = 45_000
const PROGRESS_PROBE_MS = 6_000

/** 问服务端这一轮已经产生多少条事件；拿不到返回 null */
async function probeTurnTotal(conversationId: string): Promise<number | null> {
    try {
        const data = await apiJson<{ total?: number }>(
            `/api/chat/resume?conversationId=${encodeURIComponent(conversationId)}&peek=1`,
            undefined,
            { silent: true },
        )
        return typeof data.total === "number" ? data.total : null
    } catch (error) {
        reloadOnAuth(error)
        return null
    }
}

/**
 * 服务端跑得比本地收到的多吗
 *
 * `received` 是这条流里已回调的 data 事件数，`base` 是这条流开始前服务端已有的条数。
 * 原始流 base 为 0；续接流多一条 `resume` 标记（不在本轮事件缓冲里），
 * 所以调用方把 base 传 `since - 1` 抵消它。
 */
async function serverIsAhead(
    conversationId: string,
    received: number,
    base: number,
): Promise<boolean> {
    return serverAhead(await probeTurnTotal(conversationId), received, base)
}
/*
 * 每个会话自己的一套运行状态
 *
 * 参照 DeepSeekHarness 的模型：一个会话一个 driver（自己持有 phase / inbox /
 * abort），会话内部一轮串行，会话之间天然并行。所以这里不能再用单个全局
 * controller / queued / streamingMessage——那会强迫「播放中不许切会话」。
 */
interface ConversationRuntime {
    /** 打断当前会话的流 */
    controller: AbortController | null
    /** 这一轮忙完后要接着发的消息（本会话内排队） */
    queued: string[]
    /** 正在流式输出的那条消息 */
    streaming: MarkdownMessage | null
    /** 用户对本次运行按过停止 */
    stopRequested: boolean
    /** 正在向服务端续接这一轮（resume 事件到达前 controller 还是空的） */
    resuming: boolean
    /**
     * 这一轮正在用的会话对象（runTurn / resumeTurn 里那个响应式代理）
     *
     * 切换工作区会整体替换 store.conversations，正在跑的这一轮却还在往这个对象里
     * 追加增量。记下来，重新加载列表时才能把它换回列表，见 localAheadConversations()。
     */
    conversation: Conversation | null
}

const runtimes = new Map<string, ConversationRuntime>()

function runtimeOf(conversationId: string): ConversationRuntime {
    let runtime = runtimes.get(conversationId)
    if (runtime === undefined) {
        runtime = {
            controller: null,
            queued: [],
            streaming: null,
            stopRequested: false,
            resuming: false,
            conversation: null,
        }
        runtimes.set(conversationId, runtime)
    }
    return runtime
}

/*
 * runtime 是普通 Map（AbortController 不适合交给响应式代理），
 * 所以「本地在跑哪些会话」另用一份响应式镜像暴露给界面。
 * 否则 computed 读不到 controller 的变化：一轮结束后按钮会一直停在「插话/停止」。
 */
function syncLocalRunning(conversationId: string): void {
    const runtime = runtimeOf(conversationId)
    const busy = runtime.controller !== null || runtime.resuming
    const listed = store.localRunning.includes(conversationId)
    if (busy && !listed) {
        store.localRunning = [...store.localRunning, conversationId]
    } else if (!busy && listed) {
        store.localRunning = store.localRunning.filter((id) => id !== conversationId)
    }
}

/** 写入 controller 并同步镜像；所有写入都必须走这两个函数 */
function setController(conversationId: string, controller: AbortController | null): void {
    runtimeOf(conversationId).controller = controller
    syncLocalRunning(conversationId)
}

function setResuming(conversationId: string, resuming: boolean): void {
    runtimeOf(conversationId).resuming = resuming
    syncLocalRunning(conversationId)
}

/** 写入流式消息并同步版本号；所有写入都必须走它 */
function setStreaming(conversationId: string, message: MarkdownMessage | null): void {
    runtimeOf(conversationId).streaming = message
    store.streamingVersion += 1
}

/**
 * 还没落盘的会话
 *
 * 一轮刚写完、PUT 还在路上时，服务端快照仍是上一版。这期间切工作区再切回来，
 * 列表里就会少最后一条回复。记下来，落地前继续用本地对象，见 localAheadConversations()。
 */
const pendingSaves = createSaveTracker<Conversation>()

/**
 * 本地比服务端快照新的会话（id → 会话对象）
 *
 * 两种都算：正在流式输出的（内容还在增量里），以及刚写完、PUT 还没落地的
 * （服务端手上还是上一版）。已经落地又不在跑的以服务端快照为准。
 */
function localAheadConversations(): Map<string, Conversation> {
    const ahead = pendingSaves.pending()
    for (const [id, runtime] of runtimes) {
        if (runtime.conversation === null) continue
        if (runtime.streaming === null) continue
        ahead.set(id, runtime.conversation)
    }
    return ahead
}

/** 这个会话是否正在跑一轮（含别的窗口发起的，由服务端 running 列表补） */
export function isConversationBusy(conversationId: string | null): boolean {
    if (conversationId === null) return false
    return store.localRunning.includes(conversationId) || store.runningIds.includes(conversationId)
}

/** 当前会话是否在跑（输入框、停止按钮看这个） */
export function activeBusy(): boolean {
    return isConversationBusy(store.activeId)
}

/** 当前会话正在流式输出的消息 */
export function activeStreaming(): MarkdownMessage | null {
    if (store.activeId === null) return null
    // 读一下版本号：streaming 本身不是响应式的，靠它把依赖建立在「换了哪条消息」上
    void store.streamingVersion
    return runtimeOf(store.activeId).streaming
}

/*
 * 刷新/关页时浏览器会中断进行中的 SSE 读取，Chrome 抛的是 "network error"。
 * 这一轮在服务端还在跑，不能当成回复失败：标记成可续接，回来后再接上。
 */
let pageUnloading = false

function watchPageLifecycle(): void {
    if (typeof window === "undefined") return
    window.addEventListener("pagehide", () => {
        pageUnloading = true
    })
    // bfcache 恢复：同一个 JS 上下文被复用，状态要复位
    window.addEventListener("pageshow", () => {
        pageUnloading = false
    })
}

watchPageLifecycle()

/** DELETE 也带上 JSON 头与空 body：写接口按 JSON 调用识别 */
function deleteInit(): RequestInit {
    return {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
    }
}

/* ── 运行中的会话 ─────────────────────────────────────────── */

/**
 * 谁在跑只有服务端知道：本地 busy 只是本窗口发起的那一轮，
 * 别的窗口、刷新前的轮次都要靠服务端这份列表。
 */
export async function refreshRunning(): Promise<void> {
    try {
        const data = await apiJson<{
            running: Array<{ conversationId: string; workspaceId: string | null }>
        }>("/api/chat/running", undefined, { silent: true })
        const list = Array.isArray(data.running) ? data.running : []
        store.runningIds = list
            .map((item) => item.conversationId)
            .filter((id): id is string => typeof id === "string")
        store.runningWorkspaces = [
            ...new Set(
                list
                    .map((item) => item.workspaceId)
                    .filter((id): id is string => typeof id === "string"),
            ),
        ]
    } catch (error) {
        reloadOnAuth(error)
    }
}

/** 本窗口开始/结束一轮时先就地更新，避免等下一次轮询 */
function markRunning(conversationId: string, running: boolean): void {
    if (running) {
        if (!store.runningIds.includes(conversationId))
            store.runningIds = [...store.runningIds, conversationId]
        const workspaceId = store.group === "workspace" ? (store.workspace?.id ?? null) : null
        if (workspaceId !== null && !store.runningWorkspaces.includes(workspaceId)) {
            store.runningWorkspaces = [...store.runningWorkspaces, workspaceId]
        }
        return
    }
    store.runningIds = store.runningIds.filter((id) => id !== conversationId)
    void refreshRunning()
}

let runningTimer = 0

function startRunningPoll(): void {
    if (runningTimer !== 0) return
    runningTimer = window.setInterval(() => {
        if (document.visibilityState === "hidden") return
        void refreshRunning()
    }, 4000)
}

/* ── 提示 ─────────────────────────────────────────────────── */

export function toast(
    message: string,
    kind: "info" | "warn" | "error" = "info",
    timeout = 3200,
): void {
    notifyToast(message, {
        type: kind === "warn" ? "warning" : kind === "error" ? "error" : "info",
        autoClose: timeout,
    })
}

/* ── 主题 ─────────────────────────────────────────────────── */

export function currentTheme(): string {
    const value = store.theme
    return value === "light" || value === "dark" ? value : store.theme
}

export function cycleTheme(): void {
    const order = ["system", "light", "dark"]
    const index = order.indexOf(store.theme)
    const next = order[(index + 1) % order.length] ?? "system"
    store.theme = next
    document.documentElement.setAttribute("data-theme", next === "system" ? "" : next)
    if (next === "system") document.documentElement.removeAttribute("data-theme")
    document.cookie = `wellspring_theme=${next}; path=/; max-age=31536000; samesite=lax`
}

/* ── 权限 ─────────────────────────────────────────────────── */

function readPermission(): string {
    try {
        const value = window.localStorage.getItem(PERMISSION_STORAGE_KEY)
        return value === "read-only" ||
            value === "danger-full-access" ||
            value === "workspace-write"
            ? value
            : "workspace-write"
    } catch {
        return "workspace-write"
    }
}

export function saveSendMode(value: SendMode): void {
    store.sendMode = value
    try {
        window.localStorage.setItem(SEND_MODE_STORAGE_KEY, value)
    } catch {
        /* 忽略 */
    }
}

export function savePermission(value: string): void {
    store.permission = value
    try {
        window.localStorage.setItem(PERMISSION_STORAGE_KEY, value)
    } catch {
        /* 忽略 */
    }
}

/* ── 发送键 ───────────────────────────────────────────────── */

function readSendMode(): SendMode {
    try {
        const value = window.localStorage.getItem(SEND_MODE_STORAGE_KEY)
        return value === "enter" || value === "shift-enter" || value === "ctrl-enter"
            ? value
            : DEFAULT_SEND_MODE
    } catch {
        return DEFAULT_SEND_MODE
    }
}

/* ── 分组与工作区 ─────────────────────────────────────────── */

function readGroupPreference(): string | null {
    try {
        return window.localStorage.getItem(GROUP_PREF_KEY)
    } catch {
        return null
    }
}

function writeGroupPreference(value: string): void {
    try {
        window.localStorage.setItem(GROUP_PREF_KEY, value)
    } catch {
        /* 忽略 */
    }
}

function currentEndpoint(): string | null {
    if (store.group === "workspace") {
        return store.workspace === null
            ? null
            : `/api/workspaces/${encodeURIComponent(store.workspace.id)}/conversations`
    }
    if (store.group === UNGROUPED) return "/api/ungrouped/conversations"
    return null
}

export function activeConversation(): Conversation | null {
    for (const conv of store.conversations) {
        if (conv.id === store.activeId) return conv
    }
    return null
}

export async function refreshWorkspaces(): Promise<void> {
    try {
        const data = await apiJson<{ workspaces: WorkspaceView[]; ungroupedCount: number }>(
            "/api/workspaces",
        )
        store.workspaces = Array.isArray(data.workspaces) ? data.workspaces : []
        store.ungroupedCount = Number(data.ungroupedCount) || 0
        store.workspacesError = ""
    } catch (error) {
        if (reloadOnAuth(error)) return
        store.workspacesError = error instanceof Error ? error.message : String(error)
    }
    store.groupsLoaded = true
}

/** 路由守卫与 App 挂载都会调 start()；共用同一个进行中的调用，避免重复拉状态 */
let starting: Promise<void> | null = null

export function start(): Promise<void> {
    if (starting !== null) return starting
    starting = runStart().finally(() => {
        starting = null
    })
    return starting
}

async function runStart(): Promise<void> {
    try {
        const state = await apiJson<{
            configured?: boolean
            authenticated?: boolean
            version?: string
            apiVersion?: number
            theme?: string
        }>("/api/state")
        store.configured = state.configured === true
        store.authenticated = state.authenticated === true
        if (typeof state.version === "string") store.version = state.version
        if (typeof state.apiVersion === "number") store.apiVersion = state.apiVersion
    } catch (error) {
        if (reloadOnAuth(error)) return
    }
    store.ready = true
    if (!store.authenticated) return
    await refreshWorkspaces()
    void refreshRunning().then(startRunningPoll)
    await Promise.all([loadModels(), loadModelContexts()])
    await decideGroup()
}

async function decideGroup(): Promise<void> {
    const preferred = readGroupPreference()
    if (preferred === UNGROUPED && store.ungroupedCount >= 0) {
        // 未分组里只有已有会话时可进入
        await selectGroup(UNGROUPED)
        return
    }
    const workspace =
        store.workspaces.find((item) => item.id === preferred) ?? store.workspaces[0] ?? null
    if (workspace !== null) {
        await selectGroup("workspace", workspace.id)
    } else {
        await selectGroup(UNGROUPED)
    }
}

export async function selectGroup(
    group: "workspace" | "ungrouped",
    workspaceId?: string,
): Promise<void> {
    store.group = group
    if (group === "workspace") {
        store.workspace =
            store.workspaces.find((item) => item.id === workspaceId) ?? store.workspaces[0] ?? null
        if (store.workspace === null) {
            store.group = UNGROUPED
        }
    } else {
        store.workspace = null
    }
    writeGroupPreference(
        store.group === "workspace" && store.workspace !== null ? store.workspace.id : UNGROUPED,
    )
    await loadConversations()
}

export async function loadConversations(): Promise<void> {
    const endpoint = currentEndpoint()
    if (endpoint === null) {
        store.conversations = []
        store.activeId = null
        return
    }
    try {
        const data = await apiJson<{ activeId: string | null; conversations: unknown[] }>(endpoint)
        const conversations: Conversation[] = []
        // 会话归属由「从哪个工作区读出来的」决定，之后保存不再看当前选中
        const ownerId = store.group === "workspace" ? (store.workspace?.id ?? null) : null
        for (const raw of Array.isArray(data.conversations) ? data.conversations : []) {
            const conv = normalizeConversation(raw) as Conversation | null
            if (conv === null) continue
            conv.workspaceId = ownerId
            conversations.push(conv)
        }
        conversations.sort((a, b) => b.updatedAt - a.updatedAt)
        // 本地更新的会话继续用本地对象：不然切工作区回来时流式输出就断了
        store.conversations = adoptLiveConversations(conversations, localAheadConversations())
        store.activeId =
            typeof data.activeId === "string" &&
            conversations.some((conv) => conv.id === data.activeId)
                ? data.activeId
                : (conversations[0]?.id ?? null)
        legacyMigrated = false
        void migrateLegacyStore()
        // 摘要无正文：先取最近一页，续接与窗口按真实条数计算
        await ensureMessagesLoaded(activeConversation())
        void maybeResume()
    } catch (error) {
        if (reloadOnAuth(error)) return
        toast(error instanceof Error ? error.message : String(error), "error")
    }
}

export async function selectConversation(id: string): Promise<void> {
    // 会话之间互不影响：别的会话在跑也照样可以切过去，那一轮在后台继续
    store.activeId = id
    await rememberActive(id)
    await ensureMessagesLoaded(activeConversation())
    void maybeResume()
}

/**
 * 按地址打开会话
 *
 * 会话按工作区存储，地址里只有会话 id；当前分组没有时依次查其它工作区与未分组，
 * 这样刷新 /c/:id 或从别的页面直达都不会落到空会话。找不到时返回 false。
 */
export async function openConversation(id: string): Promise<boolean> {
    if (store.conversations.some((conv) => conv.id === id)) {
        await selectConversation(id)
        return true
    }
    // 当前分组先查（本地列表可能是别的窗口写入前的旧数据），再依次找其它工作区
    const currentWorkspace = store.group === "workspace" ? store.workspace : null
    const targets: Array<{ group: "workspace"; workspaceId: string } | { group: "ungrouped" }> = []
    if (currentWorkspace !== null) {
        targets.push({ group: "workspace", workspaceId: currentWorkspace.id })
    } else if (store.group === UNGROUPED) {
        targets.push({ group: "ungrouped" })
    }
    for (const workspace of store.workspaces) {
        if (currentWorkspace !== null && workspace.id === currentWorkspace.id) continue
        targets.push({ group: "workspace", workspaceId: workspace.id })
    }
    if (store.group !== UNGROUPED && store.ungroupedCount > 0) {
        targets.push({ group: "ungrouped" })
    }
    for (const target of targets) {
        const endpoint =
            target.group === "workspace"
                ? `/api/workspaces/${encodeURIComponent(target.workspaceId)}/conversations`
                : "/api/ungrouped/conversations"
        try {
            const data = await apiJson<{ conversations?: unknown[] }>(endpoint)
            const found = (Array.isArray(data.conversations) ? data.conversations : []).some(
                (raw) =>
                    raw !== null &&
                    typeof raw === "object" &&
                    (raw as { id?: unknown }).id === id,
            )
            if (!found) continue
            if (target.group === "workspace") {
                await selectGroup("workspace", target.workspaceId)
            } else {
                await selectGroup(UNGROUPED)
            }
            store.activeId = id
            await rememberActive(id)
            await ensureMessagesLoaded(activeConversation())
            void maybeResume()
            return true
        } catch (error) {
            reloadOnAuth(error)
        }
    }
    return false
}

/**
 * 把当前选中的会话告诉服务端
 *
 * 服务端按工作区保存 activeId，刷新/重开浏览器时据此回到同一个会话。
 * 新建会话、发送消息后会话被顶到最前，都要跟着更新，否则刷新会跳回旧的那条。
 */
async function rememberActive(id: string | null): Promise<void> {
    const endpoint = currentEndpoint()
    if (endpoint === null || id === null) return
    try {
        await apiJson(`${endpoint}/active`, jsonBody({ id }))
    } catch (error) {
        reloadOnAuth(error)
    }
}

export async function addWorkspace(): Promise<void> {
    try {
        /*
         * 必须是 POST：服务端 /api/picker 只注册了 POST。
         * 以前这里没传 init，fetch 走默认 GET，直接被判 405 "Method Not Allowed"，
         * 点「添加工作区」永远弹不出选择框。
         */
        const picked = await apiJson<{ ok: boolean; root?: string; name?: string; error?: string }>(
            "/api/picker",
            jsonBody({}),
        )
        if (!picked.ok) {
            /*
             * 用户主动取消是正常路径，不要弹提示；
             * 但选择框起不来（没装 zenity、没有图形会话、脚本报错）必须说出来，
             * 否则界面上表现和「点了没反应」完全一样，没法排查。
             */
            const reason = typeof picked.error === "string" ? picked.error : ""
            if (reason !== "" && reason !== "已取消") toast(reason, "error")
            return
        }
        const created = await apiJson<{ workspace: WorkspaceView }>(
            "/api/workspaces",
            jsonBody({ root: picked.root }),
        )
        await refreshWorkspaces()
        await selectGroup("workspace", created.workspace.id)
    } catch (error) {
        if (reloadOnAuth(error)) return
        toast(error instanceof Error ? error.message : String(error), "error")
    }
}

/**
 * 按路径添加工作区
 *
 * 路径由调用方给，不走原生选择框
 */
export async function addWorkspaceAt(root: string): Promise<boolean> {
    const path = root.trim()
    if (path === "") return false
    try {
        const created = await apiJson<{ workspace: WorkspaceView }>(
            "/api/workspaces",
            jsonBody({ root: path }),
        )
        await refreshWorkspaces()
        await selectGroup("workspace", created.workspace.id)
        return true
    } catch (error) {
        if (reloadOnAuth(error)) return false
        toast(error instanceof Error ? error.message : String(error), "error")
        return false
    }
}

/** 用宿主系统打开文件：default = 默认程序，reveal = 在文件管理器里定位 */
export async function openFile(path: string, mode: "default" | "reveal" = "default"): Promise<void> {
    try {
        await apiJson("/api/files/open", jsonBody({ path, mode }))
    } catch (error) {
        if (reloadOnAuth(error)) return
        toast(error instanceof Error ? error.message : String(error), "error")
    }
}

export async function removeWorkspace(id: string): Promise<void> {
    try {
        await apiJson(`/api/workspaces/${encodeURIComponent(id)}`, deleteInit())
    } catch (error) {
        if (reloadOnAuth(error)) return
        toast(error instanceof Error ? error.message : String(error), "error")
        return
    }
    await refreshWorkspaces()
    const next = store.workspaces[0] ?? null
    if (next !== null) await selectGroup("workspace", next.id)
    else await selectGroup(UNGROUPED)
}

export function newConversation(): Conversation | null {
    if (store.group !== "workspace") {
        toast("未分组里不能新建会话，先添加或选择工作区", "warn")
        return null
    }
    const conv: Conversation = {
        id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        workspaceId: store.workspace?.id ?? null,
        serverSessionId: null,
        title: "新对话",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provider: null,
        model: null,
        reasoning: null,
        permission: store.permission,
        workspaceRoot: store.workspace?.root ?? null,
        messages: [],
    }
    store.conversations.unshift(conv)
    store.activeId = conv.id
    void rememberActive(conv.id)
    return conv
}

export async function deleteConversation(id: string): Promise<void> {
    const target = store.conversations.find((item) => item.id === id)
    if (target === undefined) return
    const endpoint = endpointFor(target)
    try {
        await apiJson(`${endpoint}/${encodeURIComponent(id)}`, deleteInit())
    } catch (error) {
        if (reloadOnAuth(error)) return
        toast(error instanceof Error ? error.message : String(error), "error")
        return
    }
    store.conversations = store.conversations.filter((conv) => conv.id !== id)
    forgetWindow(id)
    if (store.activeId === id) store.activeId = store.conversations[0]?.id ?? null
    await refreshWorkspaces()
}

/* ── 消息发送与流式回复 ───────────────────────────────────── */

/** 把会话对象换成 store 里的响应式代理，直接改原始对象不会触发视图更新 */
function reactiveConversation(conv: Conversation): Conversation {
    return store.conversations.find((item) => item.id === conv.id) ?? conv
}

function ensureConversation(): Conversation | null {
    if (store.group !== "workspace") return null
    return activeConversation()
}

function moveToFront(conv: Conversation): void {
    const index = store.conversations.indexOf(conv)
    if (index > 0) {
        store.conversations.splice(index, 1)
        store.conversations.unshift(conv)
    }
}

/** 会话自己的存储端点；不依赖当前选中的工作区 */
function endpointFor(conv: Conversation): string {
    return conv.workspaceId === null
        ? "/api/ungrouped/conversations"
        : `/api/workspaces/${encodeURIComponent(conv.workspaceId)}/conversations`
}

function saveConversation(conv: Conversation): void {
    const endpoint = endpointFor(conv)
    // body 先取快照：PUT 在路上时消息还可能被继续追加
    const body = JSON.stringify(conversationPayload(conv))
    const token = pendingSaves.begin(conv)
    void apiJson(`${endpoint}/${encodeURIComponent(conv.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
    })
        .then(() => {
            pendingSaves.settle(conv.id, token)
        })
        .catch((error) => {
            // 失败时故意不清：那份内容只有本地有，清掉的话切一次工作区就看不见了，
            // 等下一次保存成功再交给服务端
            reloadOnAuth(error)
        })
}

export async function submitMessage(text: string): Promise<boolean> {
    const value = text.trim()
    if (value === "") return false
    if (value.length > MAX_MESSAGE_CHARS) {
        toast(`消息超过 ${MAX_MESSAGE_CHARS} 字符上限`, "warn")
        return false
    }
    // 只判断当前会话：别的会话在跑不该影响这里的发送
    if (activeBusy()) {
        await interject(value)
        return true
    }
    if (store.group === "workspace" && store.workspace === null) {
        toast("先添加工作区", "warn")
        return false
    }
    const conv =
        store.group === "workspace"
            ? (ensureConversation() ?? createLocalConversation())
            : activeConversation()
    if (conv === null) {
        toast("未分组里没有可继续的会话", "warn")
        return false
    }
    const userMessage = { role: "user" as const, text: value, at: Date.now(), process: [] }
    conv.messages.push(userMessage)
    if (conv.messages.length === 1) conv.title = titleFromText(value)
    conv.updatedAt = Date.now()
    moveToFront(conv)
    saveConversation(conv)
    await runTurn(conv, value)
    return true
}

function createLocalConversation(): Conversation {
    const conv: Conversation = {
        id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        workspaceId: store.workspace?.id ?? null,
        serverSessionId: null,
        title: "新对话",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provider: null,
        model: null,
        reasoning: null,
        permission: store.permission,
        workspaceRoot: store.workspace?.root ?? null,
        messages: [],
    }
    store.conversations.unshift(conv)
    store.activeId = conv.id
    void rememberActive(conv.id)
    return store.conversations[0] ?? conv
}

async function interject(text: string): Promise<void> {
    const conv = activeConversation()
    if (conv === null) return
    try {
        const data = await apiJson<{ ok?: boolean }>(
            "/api/chat/interject",
            jsonBody({ conversationId: conv.id, message: text }),
        )
        if (data.ok === true) {
            toast("已插话", "info", 1600)
            return
        }
    } catch (error) {
        if (reloadOnAuth(error)) return
        toast(error instanceof Error ? error.message : String(error), "error")
        return
    }
    runtimeOf(conv.id).queued.push(text)
    toast("这一轮刚好结束，消息作为下一轮发送", "info", 3000)
}

async function runTurn(input: Conversation, text: string): Promise<void> {
    const conv = reactiveConversation(input)
    const runtime = runtimeOf(conv.id)
    runtime.stopRequested = false
    // 记住这一轮用的对象：切工作区会换掉列表，回来时要靠它接上流式输出
    runtime.conversation = conv
    const assistant: MarkdownMessage = {
        role: "assistant",
        text: "",
        at: Date.now(),
        streaming: true,
        interrupted: true,
        process: [],
    }
    conv.messages.push(assistant)
    const liveAssistant = conv.messages[conv.messages.length - 1] as MarkdownMessage
    setStreaming(conv.id, liveAssistant)
    markRunning(conv.id, true)
    const turnAbort = new AbortController()
    setController(conv.id, turnAbort)
    /** 网络层中断（挂后台、切网、服务重启）：不是回复失败，交给续接 */
    let networkDropped = false
    /** 读到过 done / error / stopped 之一，说明这一轮在服务端已经收尾 */
    let terminalSeen = false
    /** 服务端跑在前面、需要立即增量重放的起点（-1 表示不需要） */
    let resyncFrom = -1
    try {
        const body: Record<string, unknown> = {
            message: text,
            sessionId: conv.serverSessionId,
            conversationId: conv.id,
            permission: store.permission,
        }
        if (conv.provider !== null) body.provider = conv.provider
        if (conv.model !== null) body.model = conv.model
        if (conv.reasoning !== null) body.reasoning = conv.reasoning
        const references = collectReferences(text, store.pickedReferences)
        store.pickedReferences = []
        if (references.length > 0) body.references = references
        if (conv.workspaceId !== null) body.workspaceId = conv.workspaceId
        else body.workspaceRoot = conv.workspaceRoot
        const response = await fetch("/api/chat/stream", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: turnAbort.signal,
        })
        if (response.status === 401) throw new AuthError()
        if (!response.ok) {
            const detail = await response.json().catch(() => null)
            throw new Error(
                detail !== null && typeof detail.error === "string"
                    ? detail.error
                    : `HTTP ${response.status}`,
            )
        }
        await consumeSse(
            response,
            (_event, data) => {
                const parsed = parseEvent(data)
                if (parsed === null) return
                if (
                    parsed.type === "done" ||
                    parsed.type === "error" ||
                    parsed.type === "stopped"
                ) {
                    terminalSeen = true
                }
                applyStreamEvent(conv, liveAssistant, parsed)
            },
            {
                stallMs: STREAM_STALL_MS,
                idleMs: PROGRESS_PROBE_MS,
                // 原始流里每个 data 事件都对应本轮缓冲的一条，计数相等
                onIdle: (received) => serverIsAhead(conv.id, received, 0),
            },
        )
    } catch (error) {
        if (error instanceof AuthError) {
            liveAssistant.error = "登录状态已失效，请重新登录。"
            window.location.reload()
        } else if (pageUnloading) {
            /* 页面正在刷新：读取被中断不等于回复失败，留给续接 */
        } else if (error instanceof StreamResyncError) {
            // 服务端有事件没送到：记下起点，收尾后立刻增量重放
            resyncFrom = error.received
            console.warn(`[wellspring] 流漏了事件（本地收到 ${error.received} 条），正在增量补齐`)
        } else if (error instanceof StreamStalledError) {
            // 连 ping 都收不到了：按网络中断处理，立即重连
            networkDropped = true
            console.warn("[wellspring] 实时流已停滞（长时间无任何数据），正在重连续接")
        } else if (error instanceof DOMException && error.name === "AbortError") {
            liveAssistant.stopped = true
        } else if (isNetworkError(error)) {
            /*
             * 挂后台很久、切网、服务重启都会让流悄悄断开，浏览器抛的原文是
             * "network error" / "Failed to fetch"。这不是回复失败：
             * 已经收到的内容保留，标成可续接，等服务恢复后接着补。
             */
            networkDropped = true
        } else {
            liveAssistant.error = error instanceof Error ? error.message : String(error)
        }
    } finally {
        liveAssistant.streaming = false
        // 刷新打断 / 网络断开的那一轮要留成 interrupted，下次进入页面才知道还要续接
        liveAssistant.interrupted =
            pageUnloading ||
            networkDropped ||
            (liveAssistant.stopped === true && !runtime.stopRequested)
        finalizeProcess(liveAssistant)
        setStreaming(conv.id, null)
        // 这一轮到此为止：之后的列表刷新以服务端落盘的快照为准
        runtime.conversation = null
        setController(conv.id, null)
        markRunning(conv.id, false)
        conv.updatedAt = Date.now()
        moveToFront(conv)
        saveConversation(conv)
        /*
         * 需要续接的三种情况，全部立即重放（不等这一轮跑完，也不退避）：
         * 1. 看门狗发现服务端已经有本地没收到的事件（工具调用超时、反代掐连接、
         *    事件回调异常都会这样）——按 resyncFrom 增量重放，正文不重建；
         * 2. 连接彻底没字节了（挂后台、切网）——重连并从服务端缓冲重放；
         * 3. 流读完了却没有收尾事件——服务端那一轮其实还在跑。
         */
        const stoppedByUser = runtime.stopRequested || liveAssistant.stopped === true
        /*
         * 点了停止，但本地一个字都没收到、服务端可能已经写了不少：
         * 这不叫「用户不要了」，而是「界面没跟上」。留着空白的「已停止」最糟，
         * 补一次把已经产生的内容显示出来；用户真要停，服务端那边也已经被通知停了。
         */
        const lostEverything = stoppedByUser && liveAssistant.text === "" && !terminalSeen
        const shouldResume =
            resyncFrom >= 0 ||
            networkDropped ||
            lostEverything ||
            shouldProbeAfterStream({
                terminalSeen,
                stoppedByUser,
                networkDropped,
                pageUnloading,
            })
        if (shouldResume && !pageUnloading) {
            resumeAttempts.delete(conv.id)
            if (networkDropped) {
                toast("网络中断，已保留收到的内容；正在接着补", "warn", 4000)
            }
            /*
             * 只在用户正看着这个会话时自己续：切走了就等回来时按进入页面的流程处理。
             * 立即发起、不走定时器：重放的每一秒都是用户盯着半截正文等的时间。
             */
            if (store.activeId === conv.id) {
                liveAssistant.interrupted = true
                delete liveAssistant.stopped
                void resumeTurn(conv, { since: resyncFrom > 0 ? resyncFrom : 0 })
            }
        }
        await flushQueued(conv)
    }
}

function parseEvent(data: string): ChatStreamEvent | null {
    try {
        const value = JSON.parse(data)
        return value !== null && typeof value === "object" ? (value as ChatStreamEvent) : null
    } catch {
        return null
    }
}

function applyStreamEvent(
    conv: Conversation,
    assistant: MarkdownMessage,
    event: ChatStreamEvent,
): void {
    switch (event.type) {
        case "session":
            if (typeof event.sessionId === "string") conv.serverSessionId = event.sessionId
            return
        case "delta":
            endRunningReasoning(assistant)
            if (typeof event.text === "string") assistant.text += event.text
            return
        case "reasoning":
            if (typeof event.text === "string") appendReasoning(assistant, event.text)
            return
        case "tool":
            endRunningReasoning(assistant)
            applyTool(assistant, event)
            return
        case "steer":
            // 插话作为一条过程行插进回复，和其它过程行共用同一条时间线
            if (typeof event.text === "string" && event.text !== "") {
                if (!Array.isArray(assistant.process)) assistant.process = []
                assistant.process.push({
                    kind: "steer",
                    text: event.text,
                    at: assistant.text.length,
                })
            }
            return
        case "ask":
            if (event.request !== null && typeof event.request === "object") {
                store.ask = event.request as AskRequest
                store.askMinimized = false
            }
            return
        case "approval":
            if (event.request !== null && typeof event.request === "object") {
                store.approval = event.request as ApprovalRequest
            }
            return
        case "done":
            endRunningReasoning(assistant)
            /*
             * 正文已经边流边拼好了：工具行记的 at 是基于「增量拼接出的正文」的偏移，
             * 这时候用最终 reply 整体覆盖会让偏移对不上，总结就插进代码调用中间。
             * 只有本地还没收到正文（例如续接重放）时才用 reply 兜底。
             */
            if (typeof event.reply === "string" && assistant.text === "") {
                assistant.text = event.reply
            }
            if (typeof event.turn === "number") assistant.turn = event.turn
            if (typeof event.steps === "number") assistant.steps = event.steps
            // 本轮 token 用量（含缓存命中与上下文占用）：统计与缓存命中的唯一来源
            const usage = normalizeUsage(event.usage)
            if (usage !== null) assistant.usage = usage
            return
        case "error":
            assistant.error = typeof event.error === "string" ? event.error : "回复失败"
            return
        case "stopped":
            // 停止由 /api/chat/stop 发起：这一轮的结果以已收到的内容为准
            assistant.stopped = true
            return
        case "truncated":
            /*
             * 服务端放弃了本轮事件缓冲（内容太多）：实时推送还在，但刷新后接不回来。
             * 以前这个事件被直接丢掉，用户只会觉得「刷新就丢内容」莫名其妙。
             */
            toast("本轮内容较多，刷新后将无法续接这一轮", "warn", 6000)
            return
        case "replaced":
            // 同一会话开了新的一轮，这条流被顶掉；内容已由新的一轮接手
            assistant.interrupted = true
            return
        default:
            return
    }
}

function finalizeProcess(message: MarkdownMessage): void {
    if (!Array.isArray(message.process)) return
    for (const item of message.process) {
        if (item.kind === "reasoning" && item.running === true) {
            item.running = false
            // 收尾时补上结束时间，界面据此显示「思考了 N 秒」
            if (item.endedAt === undefined) item.endedAt = Date.now()
        }
        if (item.kind === "tool" && item.status === "running") item.status = "stopped"
    }
}

/**
 * 结束进行中的思考行
 *
 * 模型先出 reasoning 再出正文/工具调用，所以正文或工具一到，思考就算结束；
 * 否则「思考中」会一直闪到整轮收尾，耗时也没法算。
 */
function endRunningReasoning(assistant: MarkdownMessage): void {
    if (!Array.isArray(assistant.process)) return
    for (const item of assistant.process) {
        if (item.kind === "reasoning" && item.running === true) {
            item.running = false
            if (item.endedAt === undefined) item.endedAt = Date.now()
        }
    }
}

function appendReasoning(assistant: MarkdownMessage, text: string): void {
    if (!Array.isArray(assistant.process)) assistant.process = []
    let item = assistant.process[assistant.process.length - 1]
    if (item === undefined || item.kind !== "reasoning" || item.running !== true) {
        item = {
            kind: "reasoning",
            text: "",
            at: assistant.text.length,
            running: true,
            startedAt: Date.now(),
        } as any
        assistant.process.push(item)
    }
    item.text += text
}

function applyTool(assistant: MarkdownMessage, event: ChatStreamEvent): void {
    const phase = event.phase === "end" ? "end" : "start"
    const id = typeof event.id === "string" ? event.id : ""
    if (id === "") return
    if (!Array.isArray(assistant.process)) assistant.process = []
    let item = assistant.process.find((entry) => entry.kind === "tool" && entry.id === id) as any
    if (item === undefined) {
        item = {
            kind: "tool",
            id,
            name: typeof event.name === "string" ? event.name : "tool",
            at: assistant.text.length,
            status: "running",
        }
        assistant.process.push(item)
    }
    if (phase === "start") {
        item.status = "running"
        if (typeof event.arguments === "string") item.arguments = event.arguments
        return
    }
    item.status = event.ok === true ? "ok" : "error"
    if (typeof event.result === "string") item.result = event.result
}

async function flushQueued(conv: Conversation): Promise<void> {
    const runtime = runtimeOf(conv.id)
    // 续接中不算空闲：resumeTurn 的 controller 要等 resume 事件才设，这里得一起等
    while (runtime.queued.length > 0 && runtime.controller === null && !runtime.resuming) {
        const text = runtime.queued.shift() ?? ""
        if (text === "") continue
        const userMessage = { role: "user" as const, text, at: Date.now(), process: [] }
        conv.messages.push(userMessage)
        if (conv.messages.length === 1) conv.title = titleFromText(text)
        saveConversation(conv)
        await runTurn(conv, text)
    }
}

/**
 * 停止当前回复
 *
 * 只关掉浏览器这边的 SSE 不会让宿主停下来：那一轮还在调模型、跑工具。
 * 所以先请求服务端停止（标记会话停止，循环在下一步前收尾），再断开本地流。
 */
export function stopGeneration(): void {
    const conv = activeConversation()
    if (conv === null) return
    const runtime = runtimeOf(conv.id)
    if (runtime.controller === null) return
    runtime.stopRequested = true
    void apiJson("/api/chat/stop", jsonBody({ conversationId: conv.id })).catch((error) => {
        reloadOnAuth(error)
    })
    runtime.controller.abort()
}

export async function answerAsk(answer: string | null): Promise<void> {
    const ask = store.ask
    if (ask === null) return
    store.ask = null
    const askId = ask.askId
    if (askId === undefined) return
    try {
        const result = await apiJson<{ accepted?: boolean }>(
            `/api/asks/${encodeURIComponent(askId)}`,
            jsonBody({ answer: answer ?? "" }),
        )
        // 未接受：提问已作答，面板来自重放时同属此情况
        if (result !== null && result.accepted === false) {
            toast("这一问已经答过了", "info", 1800)
        }
    } catch (error) {
        reloadOnAuth(error)
        toast(error instanceof Error ? error.message : String(error), "error")
    }
}

export async function respondApproval(approved: boolean): Promise<void> {
    const approval = store.approval
    if (approval === null) return
    store.approval = null
    try {
        const result = await apiJson<{ accepted?: boolean }>(
            `/api/approvals/${encodeURIComponent(approval.approvalId)}`,
            jsonBody({ approved }),
        )
        if (result !== null && result.accepted === false) {
            toast("这次调用已经处理过了", "info", 1800)
        }
    } catch (error) {
        reloadOnAuth(error)
        toast(error instanceof Error ? error.message : String(error), "error")
    }
}

export function conversationLabel(conv: Conversation | null): string {
    return conv === null ? "新对话" : conv.title
}

export function relativeTime(timestamp: number): string {
    return formatRelativeTime(timestamp)
}

/**
 * 当前显示窗口的起点：这个下标之前的消息都折叠起来
 *
 * 纯计算，不在渲染期写任何状态。存下来的起点可能因为会话被裁剪而失效，
 * 所以先夹到合法范围，再吸附到轮起点——保证第一条可见的永远是一轮的开头。
 */
export function visibleFrom(conv: Conversation | null): number {
    if (conv === null) return 0
    return resolveVisibleFrom(conv.messages, store.windowStarts[conv.id], VISIBLE_ROUNDS)
}

/**
 * 按默认窗口给会话钉一次起点
 *
 * 调用时机是「切到/打开一个会话」，不是每次渲染：默认窗口盯着最近 N 轮，
 * 会话每多一轮起点就往后挪，不钉住的话流式回复时用户正在读的旧轮会被自动收起。
 * 钉住之后窗口只在两处变化——重新打开会话，或用户点「加载更早」。
 */
export function pinWindow(conv: Conversation | null): void {
    if (conv === null) return
    store.windowStarts[conv.id] = defaultVisibleFrom(conv.messages, VISIBLE_ROUNDS)
}

/** 被折叠起来、需要「加载更早」才能看到的消息条数 */
export function hiddenCount(conv: Conversation | null): number {
    return visibleFrom(conv)
}

/** 被折叠的轮数：按钮文案按轮说，比「还有 83 条」好读 */
export function hiddenRoundCount(conv: Conversation | null): number {
    if (conv === null) return 0
    return hiddenRounds(conv.messages, visibleFrom(conv))
}

// 正文总条数，分片加载后 messages 只是其中一段
export function conversationTotal(conv: Conversation | null): number {
    if (conv === null) return 0
    const declared = conv.messageCount
    if (typeof declared === "number" && isFinite(declared) && declared >= conv.messages.length) {
        return Math.floor(declared)
    }
    return conv.messages.length
}

// 尚未从服务端加载的消息条数
export function unloadedCount(conv: Conversation | null): number {
    if (conv === null) return 0
    const from = conv.messagesFrom
    if (typeof from !== "number" || !isFinite(from) || from <= 0) return 0
    return Math.floor(from)
}

interface MessagePage {
    from: number
    total: number
    messages: MarkdownMessage[]
}

// 取一页正文，before 是结束下标（不含）
async function fetchMessagePage(conv: Conversation, before: number): Promise<MessagePage | null> {
    const endpoint = endpointFor(conv)
    const url = `${endpoint}/${encodeURIComponent(conv.id)}/messages?before=${before}&limit=${MESSAGE_PAGE}`
    try {
        const data = await apiJson<{ from?: number; total?: number; messages?: unknown[] }>(url)
        const messages: MarkdownMessage[] = []
        for (const raw of Array.isArray(data.messages) ? data.messages : []) {
            const message = normalizeMessage(raw) as MarkdownMessage | null
            if (message !== null) messages.push(message)
        }
        const total =
            typeof data.total === "number" && isFinite(data.total)
                ? Math.floor(data.total)
                : messages.length
        const from = typeof data.from === "number" && isFinite(data.from) ? Math.floor(data.from) : 0
        return { from, total, messages }
    } catch (error) {
        if (reloadOnAuth(error)) return null
        toast(error instanceof Error ? error.message : String(error), "error")
        return null
    }
}

/*
 * 补齐当前会话的尾部正文
 *
 * 列表接口只回摘要，进入页面与切换会话时先取最近一页
 * 按条数计算窗口的逻辑依赖这段正文
 */
export async function ensureMessagesLoaded(conv: Conversation | null): Promise<void> {
    if (conv === null || conv.messages.length > 0) return
    const total = conversationTotal(conv)
    if (total <= 0) return
    const page = await fetchMessagePage(conv, total)
    if (page === null) return
    const live = reactiveConversation(conv)
    live.messages = page.messages
    live.messagesFrom = page.from
    live.messageCount = page.total
}

export { MAX_MESSAGES }

export function rememberReference(path: string): void {
    if (typeof path !== "string" || path === "" || path === ".") return
    if (store.pickedReferences.includes(path)) return
    store.pickedReferences.push(path)
    if (store.pickedReferences.length > 20) store.pickedReferences.shift()
}

/*
 * 往回加载一页
 *
 * 先展开本地窗口，展开到头后从服务端取更早的一页
 * 取回的一段放在最前并保持可见，返回是否加载到内容
 */
export async function loadEarlier(conv: Conversation): Promise<boolean> {
    const current = visibleFrom(conv)
    if (current > 0) {
        store.windowStarts[conv.id] = earlierVisibleFrom(conv.messages, current, ROUND_PAGE)
        return true
    }
    const before = unloadedCount(conv)
    if (before <= 0) return false
    const page = await fetchMessagePage(conv, before)
    if (page === null || page.messages.length === 0) return false
    const live = reactiveConversation(conv)
    live.messages = [...page.messages, ...live.messages]
    live.messagesFrom = page.from
    live.messageCount = page.total
    // 新取回的一段直接可见
    store.windowStarts[conv.id] = 0
    return true
}

/** 会话被删掉时清掉它的窗口记录，别让这张表无限涨 */
function forgetWindow(id: string): void {
    delete store.windowStarts[id]
}

/* ── 消息操作 ─────────────────────────────────────────────── */

export async function copyText(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text)
        toast("已复制")
        return
    } catch {
        /* 回退到 execCommand */
    }
    const area = document.createElement("textarea")
    area.value = text
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    try {
        document.execCommand("copy")
        toast("已复制")
    } catch {
        toast("复制失败", "error")
    }
    area.remove()
}

export function exportConversation(conv: Conversation | null): void {
    if (conv === null || conv.messages.length === 0) {
        if (conv !== null && conversationTotal(conv) > 0) {
            toast("正文还没加载完，先点「加载更早」再导出", "warn")
        } else {
            toast("当前会话还是空的", "warn")
        }
        return
    }
    if (unloadedCount(conv) > 0) {
        toast("只导出已加载的部分；要完整导出请先点「加载更早」", "warn", 4200)
    }
    const lines = [`# ${conv.title}`, ""]
    for (const message of conv.messages) {
        lines.push(`## ${message.role === "user" ? "你" : "Wellspring"}`, "", message.text, "")
    }
    let name = conv.title.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 48)
    if (name === "") name = "wellspring"
    const fileName = `${name}.md`
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast(`已导出 ${fileName}`)
}

/** 失败后重试：保留用户消息，丢掉失败的回复，再跑一轮 */
export async function retryMessage(conv: Conversation | null, index: number): Promise<void> {
    if (conv === null || isConversationBusy(conv.id)) return
    const target = conv.messages[index]
    if (target === undefined || target.role !== "assistant") return
    let userText = ""
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const message = conv.messages[cursor]
        if (message !== undefined && message.role === "user") {
            userText = message.text
            break
        }
    }
    if (userText === "") return
    conv.messages.splice(index)
    await runTurn(conv, userText)
}

/* ── 断线续接 ─────────────────────────────────────────────── */

/** 刷新/断线后如果最后一轮没写完，向服务端续接并重放事件 */
export async function maybeResume(): Promise<void> {
    const conv = activeConversation()
    if (conv === null || conv.messages.length === 0) return
    /*
     * 只看本地在不在跑。服务端 running 列表包含正在跑的这一轮——那正是要续的对象，
     * 用它判断会直接把自己挡掉，只能等服务端跑完，表现就是「轮次结束才同步」。
     */
    const runtime = runtimeOf(conv.id)
    if (runtime.controller !== null || runtime.resuming) return
    /**
     * 这一轮还在不在跑，只有服务端知道：前端本地的 interrupted 标记要靠
     * 关页前的 PUT 落盘，刷新时那个请求经常被取消。所以每个会话进页面只问一次。
     */
    if (resumeAttempts.has(conv.id)) return
    resumeAttempts.add(conv.id)
    await resumeTurn(conv)
}

/** 把最后一条 assistant 清空，交给服务端重放的内容重建 */
function resetAssistant(conv: Conversation): MarkdownMessage {
    const tail = conv.messages[conv.messages.length - 1]
    if (tail === undefined || tail.role !== "assistant") {
        conv.messages.push({
            role: "assistant",
            text: "",
            at: Date.now(),
            streaming: true,
            process: [],
        })
        return conv.messages[conv.messages.length - 1] as MarkdownMessage
    }
    const target = tail as MarkdownMessage
    target.text = ""
    target.process = []
    target.streaming = true
    delete target.model
    delete target.turn
    delete target.steps
    delete target.error
    delete target.stopped
    delete target.interrupted
    target.usage = undefined
    return target
}

/** 服务端已经没有这一轮可续：把没写完的回复就地收尾，不留悬念 */
async function settleUnfinished(conv: Conversation): Promise<void> {
    const tail = conv.messages[conv.messages.length - 1]
    if (tail === undefined) return
    if (tail.role === "user") {
        // 用户消息还在但没有回复：留一条可重试的失败记录
        conv.messages.push({
            role: "assistant",
            text: "",
            at: Date.now(),
            error: "这一轮的回复已中断，点重试再跑一次",
            process: [],
        })
    } else if (unfinished(tail as MarkdownMessage)) {
        const partial = tail as MarkdownMessage
        delete partial.interrupted
        partial.stopped = true
        finalizeProcess(partial)
        toast("这一轮的回复已中断，可以点重试再跑一次", "warn", 4200)
    } else {
        return
    }
    saveConversation(conv)
}

/**
 * 重连续接正在跑的一轮
 *
 * 服务端先发 resume 事件说明这一轮是否还在跑（active），前端据此决定接管与否：
 * 还在跑就清空最后一条回复从头重放；已经跑完则只在本地内容不完整时对齐一次，
 * 正常完成的会话不受影响。
 */
/** 续接失败时的重试次数：手机切网、挂后台回来经常要试几次 */
const RESUME_MAX_ATTEMPTS = 3

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms)
    })
}

/**
 * 重连续接正在跑的一轮
 *
 * 服务端先发 resume 事件说明这一轮是否还在跑（active），前端据此决定接管与否：
 * 还在跑就清空最后一条回复从头重放；已经跑完则只在本地内容不完整时对齐一次，
 * 正常完成的会话不受影响。
 *
 * 网络类失败（切网、挂后台、服务重启）按退避重试几次；仍不成功时保留已收到的
 * 内容并标成「可续接」，等回到前台或刷新时再试，不把浏览器原文当回复错误。
 */
async function resumeTurn(input: Conversation, options: { since?: number } = {}): Promise<void> {
    const conv = reactiveConversation(input)
    const runtime = runtimeOf(conv.id)
    /*
     * 只看本地在不在跑：服务端 running 列表里的「在跑」正是我们要续的那一轮，
     * 拿它判断会把自己挡在门外——以前中断后要等服务端这一轮彻底结束才补得上内容。
     */
    if (runtime.controller !== null || runtime.resuming) return
    if (currentEndpoint() === null) return

    /** 本次要从服务端缓冲的哪一条开始重放 */
    let replayFrom = options.since !== undefined && options.since > 0 ? options.since : 0
    /** 本地已经消费到服务端缓冲的哪个位置 */
    let cursor = replayFrom
    /** 已经为同一轮重放了几次（防止服务端一直不出事件时反复重连） */
    let rounds = 0
    setResuming(conv.id, true)
    // 同 runTurn：续接也在往这个对象里写，切工作区回来还要用它
    runtime.conversation = conv
    const abort = new AbortController()
    /** 服务端这一轮是否还在跑 */
    let live = false
    /** 是否接管最后那条回复（from 为 0 时清空后按重放内容重建） */
    let takeover = false
    let assistant: MarkdownMessage | null = null
    /** 是否因为网络问题没接上（区别于「服务端已收尾」） */
    let networkFailed = false
    /** 是否已经问到了服务端的结论（避免把网络失败当成已收尾） */
    let answered = false
    /** 读到过 done / error / stopped 之一 */
    let terminalSeen = false

    try {
        for (let attempt = 0; attempt < RESUME_MAX_ATTEMPTS; attempt += 1) {
            if (attempt > 0) await sleep(retryDelayMs(attempt - 1))
            if (pageUnloading || abort.signal.aborted) break

            const tail = conv.messages[conv.messages.length - 1]
            if (tail === undefined) return
            if (tail.role !== "user" && tail.role !== "assistant") return

            let response: Response
            try {
                response = await fetch(
                    `/api/chat/resume?conversationId=${encodeURIComponent(conv.id)}&since=${replayFrom}`,
                    { headers: { accept: "text/event-stream" }, signal: abort.signal },
                )
            } catch (error) {
                if (abort.signal.aborted) break
                if (!isNetworkError(error)) break
                networkFailed = true
                continue
            }
            if (response.status === 401) {
                window.location.reload()
                return
            }
            const contentType = response.headers.get("content-type") ?? ""
            if (!response.ok || !contentType.includes("text/event-stream")) {
                // 服务端已经没有这一轮（重启过或超出缓冲保留期）
                answered = true
                await settleUnfinished(conv)
                return
            }
            networkFailed = false
            /** 这条流上又发现了漏事件：从它的起点再重放一次 */
            let resynced = false
            try {
                await consumeSse(
                    response,
                    (_event, data) => {
                        const parsed = parseEvent(data)
                        if (parsed === null) return
                        if (parsed.type === "resume") {
                            answered = true
                            live = parsed.active === true
                            /*
                             * 增量重放（服务端从 replayFrom 接着发）时不清空正文：
                             * 已显示的内容就是这条流之前收到的，重建会让正文闪一下。
                             */
                            const incremental =
                                replayFrom > 0 &&
                                parsed.from === replayFrom &&
                                tail.role === "assistant"
                            takeover =
                                assistant !== null ||
                                (incremental ? true : shouldTakeover(live, tail as MarkdownMessage))
                            if (!takeover) return
                            assistant =
                                assistant ??
                                (incremental ? (tail as MarkdownMessage) : resetAssistant(conv))
                            assistant.streaming = true
                            delete assistant.stopped
                            delete assistant.error
                            setStreaming(conv.id, assistant)
                            // live 为 false 时这一轮已经收尾，只做一次内容对齐，不算忙碌
                            setController(conv.id, live ? abort : null)
                            return
                        }
                        if (!takeover || assistant === null) return
                        if (
                            parsed.type === "done" ||
                            parsed.type === "error" ||
                            parsed.type === "stopped"
                        ) {
                            terminalSeen = true
                        }
                        cursor += 1
                        applyStreamEvent(conv, assistant, parsed)
                    },
                    {
                        stallMs: STREAM_STALL_MS,
                        idleMs: PROGRESS_PROBE_MS,
                        // 续接流的第一个 data 事件是 resume 标记，不在本轮缓冲里
                        onIdle: (received) => serverIsAhead(conv.id, received, replayFrom - 1),
                    },
                )
            } catch (error) {
                if (abort.signal.aborted || pageUnloading) break
                if (error instanceof StreamResyncError) {
                    /*
                     * 服务端又跑到前面去了：从已消费到的位置继续增量重放。
                     * 这条流已经断了，但那一轮还在跑，所以这不算失败。
                     */
                    resynced = true
                    replayFrom = cursor
                    rounds += 1
                    if (rounds <= 6) continue
                    break
                }
                if (error instanceof StreamStalledError || isNetworkError(error)) {
                    networkFailed = true
                    continue
                }
                throw error
            }
            // 正常读完
            if (resynced) continue
            break
        }
    } finally {
        setResuming(conv.id, false)
        if (assistant !== null) {
            const settled = assistant as MarkdownMessage
            settled.streaming = false
            if (networkFailed) {
                // 连接断了但有进展：留成可续接，别标成「已停止」把续接挡掉
                settled.interrupted = true
                delete settled.stopped
            } else if (terminalSeen) {
                // 增量重放补到了收尾事件：这一轮是正常结束，清掉可续接标记
                delete settled.interrupted
                delete settled.stopped
            } else if (shouldSettle(live, settled)) {
                // 服务端说已经收尾、内容却还是半截（没 done 事件）就地标停止
                settled.stopped = true
            }
            finalizeProcess(settled)
            setStreaming(conv.id, null)
            runtime.conversation = null
            setController(conv.id, null)
            conv.updatedAt = Date.now()
            moveToFront(conv)
            saveConversation(conv)
            /*
             * 续接的流也可能被提前掐掉（工具超时、反代截断）：服务端说这一轮还在跑，
             * 却没等到收尾事件，就留成可续接并立即再问一次，别把半截当「已停止」。
             */
            const again =
                live &&
                rounds <= 6 &&
                shouldProbeAfterStream({
                    terminalSeen,
                    stoppedByUser: runtime.stopRequested,
                    networkDropped: networkFailed,
                    pageUnloading,
                })
            if (again && !pageUnloading) {
                settled.interrupted = true
                delete settled.stopped
                resumeAttempts.delete(conv.id)
                if (store.activeId === conv.id) {
                    void resumeTurn(conv, { since: cursor })
                }
            }
        }
        if (networkFailed && !pageUnloading) {
            // 允许下次（回到前台 / 刷新 / 手动重试）再续
            resumeAttempts.delete(conv.id)
            toast("网络中断，已保留收到的内容；网络恢复后会自动接着补", "warn", 5000)
            if (!answered) {
                // 连服务端结论都没拿到：过一会儿自己再试一次
                window.setTimeout(() => {
                    void maybeResume()
                }, retryDelayMs(2))
            }
        }
    }
}

/* ── 自动重连 ─────────────────────────────────────────────── */

/**
 * 回到前台 / 网络恢复后重新对上这一轮
 *
 * 手机浏览器挂后台会把流挂断，回来时界面可能停在半路。这里按服务端的
 * running 列表判断真实状态：还在跑就续接，已经收尾就把本地收尾并刷新列表。
 * 同时清掉一次性的续接记录，允许重新尝试。
 */
export async function reconnect(): Promise<void> {
    if (!store.authenticated) return
    await refreshRunning()
    /*
     * 逐个会话核对：本地以为在跑、服务端说已经收尾的，就地收掉本地这一轮，
     * 交给续接把内容对齐。别的会话正在跑的不受影响。
     */
    for (const [conversationId, runtime] of [...runtimes]) {
        const busyLocally = runtime.controller !== null || runtime.resuming
        if (!busyLocally) continue
        if (store.runningIds.includes(conversationId)) continue
        runtime.stopRequested = false
        runtime.controller?.abort()
        setController(conversationId, null)
        setStreaming(conversationId, null)
        setResuming(conversationId, false)
    }
    resumeAttempts.clear()
    await maybeResume()
    if (store.ready) await refreshWorkspaces()
}

let reconnectBound = false

/** 只在浏览器前台恢复或网络恢复时触发，避免后台标签页空转 */
export function bindReconnect(): void {
    if (reconnectBound || typeof window === "undefined") return
    reconnectBound = true
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return
        void reconnect()
    })
    window.addEventListener("online", () => {
        void reconnect()
    })
}

/* ── 侧栏扩展（addon） ────────────────────────────────────── */

export function connectAddons(): void {
    if (typeof window.EventSource !== "function") {
        void apiJson<{ addons: Addon[] }>("/api/addons")
            .then((data) => {
                store.addons = Array.isArray(data.addons) ? data.addons : []
            })
            .catch(() => undefined)
        return
    }
    const source = new EventSource("/api/addons/stream")
    source.addEventListener("addons", (event) => {
        try {
            const data = JSON.parse((event as MessageEvent).data)
            if (data !== null && Array.isArray(data.addons)) {
                store.addons = data.addons.filter(
                    (addon: Addon) =>
                        typeof addon.label === "string" && typeof addon.to === "string",
                )
            }
        } catch {
            /* 忽略非法事件 */
        }
    })
}

/* ── 模型与供应商 ─────────────────────────────────────────── */

export interface ModelProvider {
    id: string
    name: string
    baseUrl: string | null
    models: string[]
    defaultModel: string | null
    builtin: boolean
    keyConfigured: boolean
    keyMasked: string | null
    keyStored: boolean
    apiKeyEnv: string | null
    envVar: string | null
}

export interface ModelsState {
    providers: ModelProvider[]
    activeProvider: string
    activeModel: string | null
    activeReasoning: string
    reasoningLevels: string[]
}

export const modelsState = reactive({
    models: null as ModelsState | null,
    contexts: {} as Record<string, number>,
    loading: false,
})

export function findProvider(id: string): ModelProvider | null {
    return modelsState.models?.providers.find((provider) => provider.id === id) ?? null
}

export function activeProviderName(): string {
    return modelsState.models?.activeProvider ?? "openai"
}

export function activeModelName(): string {
    const models = modelsState.models
    if (models === null) return ""
    if (typeof models.activeModel === "string" && models.activeModel !== "")
        return models.activeModel
    const provider = findProvider(models.activeProvider)
    if (provider !== null) {
        if (provider.defaultModel) return provider.defaultModel
        if (provider.models.length > 0) return provider.models[0] ?? ""
    }
    return ""
}

export function activeReasoningName(): string {
    return modelsState.models?.activeReasoning ?? "off"
}

export function conversationSettings(conv: Conversation | null): {
    provider: string
    model: string
    reasoning: string
    permission: string
} {
    let provider = activeProviderName()
    if (
        conv !== null &&
        typeof conv.provider === "string" &&
        conv.provider !== "" &&
        findProvider(conv.provider) !== null
    ) {
        provider = conv.provider
    }
    let model = ""
    if (
        conv !== null &&
        typeof conv.model === "string" &&
        conv.model !== "" &&
        conv.provider === provider
    ) {
        model = conv.model
    }
    if (model === "") {
        const info = findProvider(provider)
        model =
            provider === (modelsState.models?.activeProvider ?? "")
                ? activeModelName()
                : (info?.defaultModel ?? info?.models[0] ?? activeModelName())
    }
    const reasoning =
        conv !== null && typeof conv.reasoning === "string" && conv.reasoning !== ""
            ? conv.reasoning
            : activeReasoningName()
    return { provider, model, reasoning, permission: conv?.permission ?? store.permission }
}

export async function loadModels(): Promise<void> {
    if (modelsState.loading) return
    modelsState.loading = true
    try {
        const data = await apiJson<ModelsState>("/api/models")
        modelsState.models = data
    } catch (error) {
        reloadOnAuth(error)
    } finally {
        modelsState.loading = false
    }
}

export async function loadModelContexts(): Promise<void> {
    try {
        const data = await apiJson<{ contextWindows: Record<string, number> }>(
            "/api/models/context",
        )
        modelsState.contexts = data.contextWindows ?? {}
    } catch (error) {
        reloadOnAuth(error)
    }
}

export function contextWindowOf(provider: string, model: string): number | null {
    if (provider === "" || model === "") return null
    const value = modelsState.contexts[`${provider}/${model}`]
    return typeof value === "number" ? value : null
}

export function formatContextTokens(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens <= 0) return ""
    if (tokens >= 1048576) {
        const millions = tokens / 1048576
        return `${millions % 1 === 0 ? millions : millions.toFixed(1)}M`
    }
    if (tokens >= 1024) {
        const thousands = tokens / 1024
        return `${thousands % 1 === 0 ? thousands : thousands.toFixed(1)}K`
    }
    return String(tokens)
}

export function estimateConversationTokens(conv: Conversation | null): number {
    if (conv === null || !Array.isArray(conv.messages)) return 0
    let chars = 0
    for (const message of conv.messages) {
        if (typeof message.text === "string") chars += message.text.length
        if (Array.isArray(message.process)) {
            for (const item of message.process) {
                if (typeof item.text === "string") chars += item.text.length
                if (typeof item.arguments === "string") chars += item.arguments.length
                if (typeof item.result === "string") chars += item.result.length
            }
        }
        chars += 16
    }
    return Math.ceil(chars / 4)
}

export interface ConversationContextInfo {
    /** 已占用的 tokens：优先用最近一次真实请求的 prompt tokens，否则按字符数粗估 */
    used: number
    window: number
    percent: number
    /** used 是否来自字符数估算（没有真实 usage 的旧会话） */
    estimated: boolean
}

/** 最近一次请求的 prompt tokens（收尾时占用的上下文）；没有真实用量时为 null */
export function latestContextTokens(conv: Conversation | null): number | null {
    if (conv === null || !Array.isArray(conv.messages)) return null
    for (let index = conv.messages.length - 1; index >= 0; index -= 1) {
        const usage = conv.messages[index]?.usage
        const value = usage?.contextTokens
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            return Math.floor(value)
        }
    }
    return null
}

export function conversationContextInfo(conv: Conversation | null): ConversationContextInfo | null {
    if (conv === null || conv.messages.length === 0 || modelsState.models === null) return null
    const settings = conversationSettings(conv)
    const window = contextWindowOf(settings.provider, settings.model)
    if (window === null) return null
    const real = latestContextTokens(conv)
    const used = real ?? estimateConversationTokens(conv)
    return {
        used,
        window,
        percent: Math.min(100, Math.round((used / window) * 100)),
        estimated: real === null,
    }
}

/** 会话累计 token 用量（各轮求和）；没有真实 usage 时返回 null */
export function conversationUsageTotals(conv: Conversation | null): TokenUsage | null {
    if (conv === null || !Array.isArray(conv.messages)) return null
    return sumUsage(conv.messages.map((message) => message.usage))
}

export function modelLabel(conv: Conversation | null): string {
    const settings = conversationSettings(conv)
    if (settings.model === "") return "模型"
    return settings.reasoning === "off"
        ? settings.model
        : `${settings.model} · ${settings.reasoning}`
}

export function chooseModel(providerId: string, model: string): void {
    const conv = activeConversation()
    if (conv === null) {
        toast("先开始一个会话", "warn")
        return
    }
    conv.provider = providerId
    conv.model = model
    conv.updatedAt = Date.now()
    saveConversation(conv)
    toast(`本会话模型：${model}`)
}

export function chooseReasoning(level: string): void {
    const conv = activeConversation()
    if (conv === null) return
    conv.reasoning = level
    conv.updatedAt = Date.now()
    saveConversation(conv)
    toast(`本会话推理等级：${level}`)
}

export async function setDefaultModel(providerId: string, model: string): Promise<void> {
    try {
        const result = await apiJson<{ state: ModelsState }>(
            "/api/models/active",
            jsonBody({ providerId, model, reasoning: activeReasoningName() }),
        )
        modelsState.models = result.state
        toast(`默认模型：${model}（新会话生效）`)
    } catch (error) {
        reloadOnAuth(error)
        toast(error instanceof Error ? error.message : String(error), "error")
    }
}

/* ── 供应商弹窗动作 ───────────────────────────────────────── */

export const modelsMessage = reactive({ text: "", tone: "ok" as "ok" | "error" })

export function setModelsMessage(text: string, tone: "ok" | "error" = "ok"): void {
    modelsMessage.text = text
    modelsMessage.tone = tone
}

export interface ProviderForm {
    name: string
    baseUrl: string
    models: string
    apiKey: string
}

export async function saveProvider(form: ProviderForm): Promise<boolean> {
    const name = form.name.trim()
    if (name === "") {
        setModelsMessage("供应商名称不能为空", "error")
        return false
    }
    const models = form.models
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter((item) => item !== "")
    try {
        const result = await apiJson<{ state: ModelsState }>(
            "/api/models/provider",
            jsonBody({
                name,
                baseUrl: form.baseUrl.trim(),
                models,
                apiKey: form.apiKey.trim() || undefined,
            }),
        )
        modelsState.models = result.state
        setModelsMessage("供应商已保存。可以点它的模型按钮切换过去。")
        return true
    } catch (error) {
        reloadOnAuth(error)
        setModelsMessage(error instanceof Error ? error.message : String(error), "error")
        return false
    }
}

export async function removeProvider(provider: ModelProvider): Promise<void> {
    try {
        const result = await apiJson<{ state: ModelsState }>(
            "/api/models/provider/remove",
            jsonBody({ id: provider.id }),
        )
        modelsState.models = result.state
        setModelsMessage(`已删除供应商 ${provider.name}`)
    } catch (error) {
        reloadOnAuth(error)
        setModelsMessage(error instanceof Error ? error.message : String(error), "error")
    }
}

export async function saveProviderKey(provider: ModelProvider, apiKey: string): Promise<void> {
    const value = apiKey.trim()
    if (value === "") {
        setModelsMessage("请先填写 API Key", "error")
        return
    }
    try {
        const result = await apiJson<{ state: ModelsState }>(
            "/api/models/key",
            jsonBody({ id: provider.id, apiKey: value }),
        )
        modelsState.models = result.state
        setModelsMessage(`已保存 ${provider.name} 的 Key`)
    } catch (error) {
        reloadOnAuth(error)
        setModelsMessage(error instanceof Error ? error.message : String(error), "error")
    }
}

export async function clearProviderKey(provider: ModelProvider): Promise<void> {
    try {
        const result = await apiJson<{ state: ModelsState }>(
            "/api/models/key/clear",
            jsonBody({ id: provider.id }),
        )
        modelsState.models = result.state
        setModelsMessage(`已清除 ${provider.name} 的本地 Key`)
    } catch (error) {
        reloadOnAuth(error)
        setModelsMessage(error instanceof Error ? error.message : String(error), "error")
    }
}

export async function fetchProviderModels(provider: ModelProvider, apiKey: string): Promise<void> {
    try {
        const result = await apiJson<{ models: string[] }>(
            "/api/models/fetch",
            jsonBody({ id: provider.id, apiKey: apiKey.trim() || undefined }),
        )
        const models = Array.isArray(result.models) ? result.models : []
        if (models.length === 0) {
            setModelsMessage("接口没有返回模型", "error")
            return
        }
        const saved = await apiJson<{ state: ModelsState }>(
            "/api/models/provider",
            jsonBody({
                id: provider.id,
                name: provider.name,
                baseUrl: provider.baseUrl,
                models,
                defaultModel: models[0] ?? null,
            }),
        )
        modelsState.models = saved.state
        setModelsMessage(`已拉取 ${models.length} 个模型`)
    } catch (error) {
        reloadOnAuth(error)
        setModelsMessage(error instanceof Error ? error.message : String(error), "error")
    }
}

export function parseContextTokens(text: string): { ok: boolean; value: number | null } {
    const value = text.trim()
    if (value === "") return { ok: true, value: null }
    const match = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(value)
    if (match === null) return { ok: false, value: null }
    let number = Number(match[1])
    const unit = (match[2] ?? "").toLowerCase()
    if (unit === "k") number *= 1024
    else if (unit === "m") number *= 1048576
    number = Math.round(number)
    if (!(number >= 256 && number <= 10000000)) return { ok: false, value: null }
    return { ok: true, value: number }
}

export async function saveModelContexts(
    items: Array<{ provider: string; model: string; contextWindow: number | null }>,
): Promise<void> {
    try {
        const result = await apiJson<{ contextWindows: Record<string, number> }>(
            "/api/models/context",
            jsonBody({ items }),
        )
        modelsState.contexts = result.contextWindows ?? {}
        setModelsMessage("上下文窗口已保存")
    } catch (error) {
        reloadOnAuth(error)
        setModelsMessage(error instanceof Error ? error.message : String(error), "error")
    }
}

/* ── 网络代理 ─────────────────────────────────────────────── */

export interface NetworkProxy {
    readonly type: string
    readonly url: string
    readonly noProxy: readonly string[]
}

export const networkState = reactive({
    proxy: null as NetworkProxy | null,
    loading: false,
})

export async function loadNetwork(): Promise<void> {
    networkState.loading = true
    try {
        const data = await apiJson<{ proxy: NetworkProxy | null }>("/api/network")
        networkState.proxy = data.proxy ?? null
    } catch (error) {
        reloadOnAuth(error)
        toast(error instanceof Error ? error.message : String(error), "error")
    } finally {
        networkState.loading = false
    }
}

/** 保存代理；url 为空表示改为直连 */
export async function saveNetworkProxy(url: string, noProxyText: string): Promise<boolean> {
    const value = url.trim()
    try {
        const data = await apiJson<{ ok: boolean; proxy: NetworkProxy | null }>(
            "/api/network",
            jsonBody({ url: value === "" ? null : value, noProxy: parseNoProxy(noProxyText) }),
        )
        networkState.proxy = data.proxy ?? null
        toast(value === "" ? "已改为直连，下一轮请求生效" : "代理已保存，下一轮请求生效")
        return true
    } catch (error) {
        reloadOnAuth(error)
        toast(error instanceof Error ? error.message : String(error), "error")
        return false
    }
}

export async function clearNetworkProxy(): Promise<boolean> {
    return await saveNetworkProxy("", "")
}

/* ── 插件管理 ─────────────────────────────────────────────── */

export interface PluginEntry {
    id: string
    name: string
    version: string
    status: string
    enabled: boolean
    deps: string[]
    commands: string[]
    dir: string
}

export const pluginsState = reactive({
    plugins: null as PluginEntry[] | null,
    message: "",
    tone: "ok" as "ok" | "error",
    busy: false,
})

export function setPluginsMessage(text: string, tone: "ok" | "error" = "ok"): void {
    pluginsState.message = text
    pluginsState.tone = tone
}

export async function loadPlugins(): Promise<void> {
    try {
        const data = await apiJson<{ plugins: PluginEntry[] }>("/api/plugins")
        pluginsState.plugins = Array.isArray(data.plugins) ? data.plugins : []
    } catch (error) {
        reloadOnAuth(error)
        setPluginsMessage(
            `读取插件失败：${error instanceof Error ? error.message : String(error)}`,
            "error",
        )
    }
}

function pluginDependents(plugin: PluginEntry): string[] {
    return (pluginsState.plugins ?? [])
        .filter((item) => item.id !== plugin.id && item.deps.includes(plugin.id))
        .map((item) => item.id)
}

export async function togglePlugin(plugin: PluginEntry, enable: boolean): Promise<void> {
    if (!enable && plugin.id === "wellspring-web") {
        const confirmed = await confirmDialog({
            title: "禁用 wellspring-web？",
            body: "重启后网页管理界面将完全无法打开，只能用 CLI 恢复。",
            confirmLabel: "继续",
            danger: true,
        })
        if (!confirmed) return
    } else if (!enable) {
        const dependents = pluginDependents(plugin)
        const hint =
            dependents.length === 0
                ? "即将禁用该插件，确定吗？"
                : `重启后这些插件会一起加载失败：${dependents.join(", ")}`
        const confirmed = await confirmDialog({
            title: enable ? "启用插件" : "禁用插件",
            body: hint,
            confirmLabel: enable ? "启用" : "禁用",
            danger: !enable,
        })
        if (!confirmed) return
    }
    pluginsState.busy = true
    try {
        const result = await apiJson<{
            ok: boolean
            hot?: boolean
            restartRequired?: boolean
            error?: string
        }>(enable ? "/api/plugins/enable" : "/api/plugins/disable", jsonBody({ id: plugin.id }))
        if (!result.ok) {
            setPluginsMessage(result.error ?? "操作失败", "error")
            return
        }
        setPluginsMessage(
            (enable ? "已启用 " : "已禁用 ") +
                plugin.id +
                (result.hot === true ? "，已即时生效" : "，重启 Wellspring 后生效"),
        )
        await loadPlugins()
    } catch (error) {
        reloadOnAuth(error)
        setPluginsMessage(error instanceof Error ? error.message : String(error), "error")
    } finally {
        pluginsState.busy = false
    }
}

export async function removePluginById(plugin: PluginEntry): Promise<void> {
    const dependents = pluginDependents(plugin)
    const hint =
        dependents.length === 0
            ? "删除插件目录不会清理插件数据与配置；重启后不再加载。"
            : `这些插件依赖它，必须先处理依赖：${dependents.join(", ")}`
    const confirmed = await confirmDialog({
        title: `卸载 ${plugin.name || plugin.id}？`,
        body: hint,
        confirmLabel: "卸载",
        danger: true,
    })
    if (!confirmed) return
    pluginsState.busy = true
    try {
        const result = await apiJson<{ ok: boolean; hot?: boolean; error?: string }>(
            "/api/plugins/remove",
            jsonBody({ id: plugin.id }),
        )
        if (!result.ok) {
            setPluginsMessage(result.error ?? "卸载失败", "error")
            return
        }
        setPluginsMessage(
            `已卸载 ${plugin.id}` + (result.hot === true ? "，已即时生效" : "，重启后生效"),
        )
        await loadPlugins()
    } catch (error) {
        reloadOnAuth(error)
        setPluginsMessage(error instanceof Error ? error.message : String(error), "error")
    } finally {
        pluginsState.busy = false
    }
}

function readFileBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error("读取文件失败"))
        reader.onload = () => {
            const text = String(reader.result || "")
            const index = text.indexOf(",")
            resolve(index === -1 ? text : text.slice(index + 1))
        }
        reader.readAsDataURL(file)
    })
}

export async function installPlugin(file: File, force: boolean): Promise<void> {
    if (!/\.zip$/i.test(file.name)) {
        setPluginsMessage("只支持 .zip 插件包", "error")
        return
    }
    if (file.size > 10 * 1024 * 1024) {
        setPluginsMessage("插件包超过 10MB", "error")
        return
    }
    pluginsState.busy = true
    setPluginsMessage("安装中（有依赖时会自动下载）…")
    try {
        const dataBase64 = await readFileBase64(file)
        const result = await apiJson<{
            ok: boolean
            id?: string
            error?: string
            packageManager?: string | null
            dependenciesInstalled?: boolean
        }>("/api/plugins/install", jsonBody({ filename: file.name, dataBase64, force }))
        if (!result.ok) {
            setPluginsMessage(result.error ?? "安装失败", "error")
            return
        }
        const dependencyNote =
            result.dependenciesInstalled === true
                ? `，已用 ${result.packageManager ?? "包管理器"} 安装依赖`
                : ""
        setPluginsMessage(`已安装 ${result.id ?? file.name}${dependencyNote}，重启 Wellspring 后生效`)
        await loadPlugins()
    } catch (error) {
        reloadOnAuth(error)
        setPluginsMessage(error instanceof Error ? error.message : String(error), "error")
    } finally {
        pluginsState.busy = false
    }
}

/* ── 通用确认弹窗 ─────────────────────────────────────────── */

export interface ConfirmOptions {
    readonly title?: string
    readonly body: string
    readonly confirmLabel?: string
    readonly cancelLabel?: string
    readonly danger?: boolean
}

export const confirmState = reactive({
    open: false,
    options: null as ConfirmOptions | null,
})

let confirmResolver: ((value: boolean) => void) | null = null

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
    if (confirmResolver !== null) {
        confirmResolver(false)
        confirmResolver = null
    }
    confirmState.options = options
    confirmState.open = true
    return new Promise((resolve) => {
        confirmResolver = resolve
    })
}

export function settleConfirm(value: boolean): void {
    confirmState.open = false
    confirmState.options = null
    const resolver = confirmResolver
    confirmResolver = null
    resolver?.(value)
}

/* ── Token 统计弹窗 ───────────────────────────────────────── */

/** 单条回复的统计快照；打开弹窗时取一次，之后不随会话刷新变化 */
export interface TurnStats {
    readonly usage: TokenUsage
    readonly model: string
    readonly turn: number | null
    /** 这条回复所用模型的上下文窗口；没配置时为 null */
    readonly window: number | null
}

export const statsState = reactive({
    open: false,
    kind: "session" as "session" | "turn",
    turn: null as TurnStats | null,
})

export function openSessionStats(): void {
    statsState.turn = null
    statsState.kind = "session"
    statsState.open = true
}

/** 回复下方的用量按钮：展示了哪一轮就统计哪一轮 */
export function openTurnStats(message: MarkdownMessage): void {
    const usage = message.usage
    if (usage === undefined) return
    const conv = activeConversation()
    const settings = conversationSettings(conv)
    statsState.turn = {
        usage,
        model: typeof message.model === "string" ? message.model : "",
        turn: typeof message.turn === "number" ? message.turn : null,
        window: contextWindowOf(settings.provider, settings.model),
    }
    statsState.kind = "turn"
    statsState.open = true
}

export function closeStats(): void {
    statsState.open = false
    statsState.turn = null
}

/* ── 旧版 localStorage 会话迁移 ───────────────────────────── */

const LEGACY_STORAGE_KEY = "wellspring.web.v1"
let legacyMigrated = false

/** 旧版界面把会话存在 localStorage；升级后第一次进入工作区时搬到服务端 */
async function migrateLegacyStore(): Promise<void> {
    if (legacyMigrated || store.group !== "workspace") return
    legacyMigrated = true
    let raw: string | null = null
    try {
        raw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
    } catch {
        return
    }
    if (raw === null || raw === "") return
    let restored: { conversations?: unknown[]; activeId?: unknown } | null = null
    try {
        restored = JSON.parse(raw)
    } catch {
        restored = null
    }
    if (restored === null || !Array.isArray(restored.conversations)) {
        try {
            window.localStorage.removeItem(LEGACY_STORAGE_KEY)
        } catch {
            /* 忽略 */
        }
        return
    }
    const existing = new Set(store.conversations.map((conv) => conv.id))
    const endpoint = currentEndpoint()
    if (endpoint === null) return
    let migrated = 0
    let failed = 0
    for (const item of restored.conversations) {
        const conv = normalizeConversation(item) as Conversation | null
        if (conv === null || conv.messages.length === 0 || existing.has(conv.id)) continue
        try {
            await apiJson(`${endpoint}/${encodeURIComponent(conv.id)}`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(conversationPayload(conv)),
            })
            store.conversations.push(conv)
            existing.add(conv.id)
            migrated += 1
        } catch {
            failed += 1
        }
        if (migrated >= 40) break
    }
    if (failed === 0) {
        try {
            window.localStorage.removeItem(LEGACY_STORAGE_KEY)
        } catch {
            /* 忽略 */
        }
        if (migrated > 0) {
            store.conversations.sort((left, right) => right.updatedAt - left.updatedAt)
            if (store.activeId === null && typeof restored.activeId === "string") {
                store.activeId = restored.activeId
            }
            if (store.activeId === null && store.conversations.length > 0) {
                store.activeId = store.conversations[0]?.id ?? null
            }
            await refreshWorkspaces()
            toast(`已把 ${migrated} 个浏览器本地会话迁移到当前工作区`)
        }
    } else {
        toast("旧会话迁移未完成，浏览器里的旧数据已保留", "error", 6000)
    }
}
