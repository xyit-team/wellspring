/*
 * 插件 HTTP 服务：页面、静态资源、认证与对话接口。
 * 所有响应都带安全响应头；HTML 不含内联脚本/样式，因此 CSP 不需要 unsafe-*。
 */

import type {
    HostAgentChatResult,
    HostWorkspaceEntry,
    HttpRequest,
    HttpResponse,
    HttpStreamContext,
    PluginApi,
} from "wellspring/api/host/index.ts"
import { eventBus, getHost, onInit, onShutdown, shutdown } from "wellspring/api/host/index.ts"
import type { SandboxPrepareEvent } from "wellspring/api/host/index.ts"
import { SANDBOX_PREPARE_EVENT } from "wellspring/api/host/index.ts"
import type { HttpServerBusHandle } from "wellspring/api/plugin/http-client.ts"
import { registerHttpServer } from "wellspring/api/plugin/http-client.ts"

import { listNavBottomAddons, subscribeNavBottomAddons, type NavBottomAddon } from "./addon.ts"
import { STATIC_ASSETS } from "./assets/index.ts"
import { AuthStore } from "./auth.ts"
import { parseCookies } from "./cookies.ts"
import {
    extensionAssets,
    hiddenBuiltinExtensions,
    initExtensions,
    installExtension,
    listExtensions,
    removeExtension,
    setBuiltinHidden,
} from "./extensions.ts"
import { ModelContextStore, isValidContextWindow, type ModelContextItem } from "./model-context.ts"
import { loadPageOverride } from "./page-override.ts"
import { renderVueHome, themeAttribute } from "./pages.ts"
import { THEME_COOKIE, parseTheme } from "./theme.ts"
import {
    CONVERSATION_ID,
    MESSAGE_PAGE_LIMIT,
    WORKSPACE_ID,
    ConversationStore,
    normalizeWorkspaceName,
} from "./workspace.ts"

const MAX_API_BODY_BYTES = 3 * 1024 * 1024
/** 插件 zip 用 base64 JSON 上传 */
const MAX_PLUGIN_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_PLUGIN_INSTALL_BODY_BYTES = 15 * 1024 * 1024
const MAX_MESSAGE_CHARS = 32_000
const MAX_ASK_ANSWER_CHARS = 8000
const MAX_ATTEMPTS = 5
const FAILURE_WINDOW_MS = 10 * 60 * 1000
const LOCKOUT_MS = 60 * 1000
const SSE_PING_MS = 15_000

const CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
].join("; ")

let api: PluginApi | null = null
/** sandbox 准备事件订阅；插件重载时先退订 */
let prepareSubscription: (() => void) | null = null
/** 由 wellspring-http 插件托管的服务器句柄（本插件不再直接持有 hostApi.http） */
let server: HttpServerBusHandle | null = null
let auth: AuthStore | null = null
let conversationStore: ConversationStore | null = null
/** 宿主工作区注册表的本地快照；写操作后刷新 */
let workspacesCache: HostWorkspaceEntry[] = []
let modelContexts: ModelContextStore | null = null
let setupInFlight = false
/** 当前打开的侧栏扩展 SSE 连接清理函数 */
const addonStreams = new Set<() => void>()

/* ── 可续接的对话流 ─────────────────────────────────────────
 * 页面刷新会断开 SSE，宿主那一轮仍在跑。把每轮事件按会话 id 缓冲，
 * 刷新后 GET /api/chat/resume 可以重放并继续接收，直到本轮结束。
 */

const CHAT_TURN_RETENTION_MS = 5 * 60 * 1000
const MAX_CHAT_TURNS = 8
/**
 * 单轮事件缓冲上限（字符）
 *
 * 超过后不再缓冲（刷新接不上这一轮），但实时推送继续。
 * 允许用环境变量调小：测试要验证「超限后直播没断」，用 2MB 跑不出来。
 */
function positiveNumber(raw: unknown): number | null {
    const parsed =
        typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}

/**
 * 上限取值：环境变量 > 插件配置 > 默认 2MB
 *
 * 插件配置走 `pluginConfig.turnBufferChars`：sandbox 子进程的 env 是清洗过的，
 * 环境变量传不进插件进程（测试要调小阈值就靠这个）。
 */
function maxChatTurnEventChars(): number {
    const fromEnv = positiveNumber(process.env["WELLSPRING_WEB_TURN_BUFFER_CHARS"])
    if (fromEnv !== null) return fromEnv
    const fromConfig = positiveNumber(api?.pluginConfig["turnBufferChars"])
    if (fromConfig !== null) return fromConfig
    /*
     * 4MB：一轮里工具调用很多时（实测见过 100 步 / 102 次工具调用）事件量不小，
     * 2MB 会在长任务中段就放弃缓冲，导致「刷新后再也接不回来」。
     */
    return 4_000_000
}

let chatTurnEventLimit: number | null = null

function chatTurnEventLimitChars(): number {
    chatTurnEventLimit ??= maxChatTurnEventChars()
    return chatTurnEventLimit
}

interface ChatTurnListener {
    write(chunk: string): void
    end(): void
}

interface ChatTurn {
    readonly conversationId: string
    /** 会话归属的工作区；未分组会话为 null，侧栏据此给工作区加运行标记 */
    readonly workspaceId: string | null
    /** 本轮宿主会话 id，从 session 事件记录；插话按它投递 */
    sessionId: string | null
    /** 已经发出去的事件（SSE 原文，按顺序） */
    readonly events: string[]
    readonly listeners: Set<ChatTurnListener>
    chars: number
    done: boolean
    /** 事件超过上限时丢弃缓冲，本轮不再支持续接 */
    truncated: boolean
    updatedAt: number
}

const chatTurns = new Map<string, ChatTurn>()

function pruneChatTurns(): void {
    const now = Date.now()
    for (const [id, turn] of chatTurns) {
        if (turn.done && now - turn.updatedAt > CHAT_TURN_RETENTION_MS) {
            chatTurns.delete(id)
        }
    }
    if (chatTurns.size <= MAX_CHAT_TURNS) {
        return
    }
    const finished = [...chatTurns.entries()]
        .filter(([, turn]) => turn.done)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    for (const [id] of finished.slice(0, chatTurns.size - MAX_CHAT_TURNS)) {
        chatTurns.delete(id)
    }
}

function beginChatTurn(conversationId: string, workspaceId: string | null): ChatTurn {
    pruneChatTurns()
    const previous = chatTurns.get(conversationId)
    if (previous !== undefined) {
        const replaced = `data: ${JSON.stringify({ type: "replaced" })}\n\n`
        for (const listener of previous.listeners) {
            try {
                listener.write(replaced)
                listener.end()
            } catch {
                /* 连接可能已经断开 */
            }
        }
        previous.listeners.clear()
    }
    const turn: ChatTurn = {
        conversationId,
        workspaceId,
        sessionId: null,
        events: [],
        listeners: new Set(),
        chars: 0,
        done: false,
        truncated: false,
        updatedAt: Date.now(),
    }
    chatTurns.set(conversationId, turn)
    return turn
}

function recordChatTurnEvent(turn: ChatTurn, chunk: string): void {
    turn.updatedAt = Date.now()
    if (!turn.truncated && turn.chars + chunk.length > chatTurnEventLimitChars()) {
        /*
         * 事件太多就放弃缓冲：这一轮之后无法再重放（刷新接不上）。
         * 但**实时推送必须继续**——以前这里直接 return，连正在看的页面也收不到
         * 任何后续事件，表现就是「服务端还在跑、页面卡住不动」。
         */
        turn.truncated = true
        turn.events.length = 0
        turn.chars = 0
        for (const listener of turn.listeners) {
            try {
                listener.write(`data: ${JSON.stringify({ type: "truncated" })}\n\n`)
            } catch {
                turn.listeners.delete(listener)
            }
        }
    }
    if (!turn.truncated) {
        turn.events.push(chunk)
        turn.chars += chunk.length
    }
    // 直播照常：缓冲只是给「刷新后续接」用的
    for (const listener of turn.listeners) {
        try {
            listener.write(chunk)
        } catch {
            turn.listeners.delete(listener)
        }
    }
}

/*
 * 已作答的提问与已审批的命令：清空本轮缓冲里对应的那条事件
 *
 * resume 按 turn.events 原样重放，缓冲里留着 ask 会让刷新后的页面再次弹出同一个提问
 * 这里改写成 request: null，前端忽略 request 非对象的事件
 */
function settleBufferedRequest(kind: "ask" | "approval", id: string): void {
    for (const turn of chatTurns.values()) {
        for (let index = 0; index < turn.events.length; index += 1) {
            const chunk = turn.events[index]
            if (chunk === undefined || !chunk.includes(id)) {
                continue
            }
            const body = chunk.startsWith("data: ") ? chunk.slice(6).trimEnd() : ""
            if (body === "") {
                continue
            }
            let parsed: unknown
            try {
                parsed = JSON.parse(body)
            } catch {
                continue
            }
            if (parsed === null || typeof parsed !== "object") {
                continue
            }
            const record = parsed as Record<string, unknown>
            if (record["type"] !== kind) {
                continue
            }
            const request = record["request"]
            if (request === null || typeof request !== "object") {
                continue
            }
            const requestId =
                kind === "ask"
                    ? (request as Record<string, unknown>)["askId"]
                    : (request as Record<string, unknown>)["approvalId"]
            if (requestId !== id) {
                continue
            }
            turn.events[index] = `data: ${JSON.stringify({ type: kind, request: null })}\n\n`
        }
    }
}

function finishChatTurn(turn: ChatTurn): void {
    turn.done = true
    turn.updatedAt = Date.now()
    for (const listener of turn.listeners) {
        try {
            listener.end()
        } catch {
            /* 连接可能已经断开 */
        }
    }
    turn.listeners.clear()
}

/**
 * 把宿主的“工作区准备”事件转发进正在跑的对话流。
 * 前端用 `sandbox-prepare` 事件显示「正在准备工作区」。
 */
function forwardSandboxPrepare(event: SandboxPrepareEvent): void {
    const chunk = `data: ${JSON.stringify({ type: "sandbox-prepare", ...event })}\n\n`
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : null
    for (const turn of chatTurns.values()) {
        if (turn.done) continue
        if (sessionId !== null && turn.sessionId !== null && turn.sessionId !== sessionId) {
            continue
        }
        recordChatTurnEvent(turn, chunk)
    }
}

function findChatTurn(conversationId: string): ChatTurn | null {
    pruneChatTurns()
    return chatTurns.get(conversationId) ?? null
}

interface AttemptState {
    failures: number
    lastAt: number
    blockedUntil: number
}

/** 登录失败计数：按来源地址累计，超过阈值后短暂锁定 */
class LoginThrottle {
    readonly #attempts = new Map<string, AttemptState>()

    status(key: string): { readonly blocked: boolean; readonly retryAfter: number } {
        const state = this.#attempts.get(key)
        if (state === undefined || state.blockedUntil <= Date.now()) {
            return { blocked: false, retryAfter: 0 }
        }
        return {
            blocked: true,
            retryAfter: Math.max(1, Math.ceil((state.blockedUntil - Date.now()) / 1000)),
        }
    }

    recordFailure(key: string): void {
        const now = Date.now()
        const state = this.#attempts.get(key) ?? { failures: 0, lastAt: now, blockedUntil: 0 }
        if (now - state.lastAt > FAILURE_WINDOW_MS) {
            state.failures = 0
        }
        state.failures += 1
        state.lastAt = now
        if (state.failures >= MAX_ATTEMPTS) {
            state.blockedUntil = now + LOCKOUT_MS
            state.failures = 0
        }
        this.#attempts.set(key, state)
        this.#prune(now)
    }

    reset(key: string): void {
        this.#attempts.delete(key)
    }

    #prune(now: number): void {
        if (this.#attempts.size < 256) {
            return
        }
        for (const [key, state] of this.#attempts) {
            if (state.blockedUntil <= now && now - state.lastAt > FAILURE_WINDOW_MS) {
                this.#attempts.delete(key)
            }
        }
    }
}

const loginThrottle = new LoginThrottle()

export function configureServer(value: PluginApi): Promise<void> {
    api = value
    prepareSubscription?.()
    prepareSubscription = eventBus.subscribe<SandboxPrepareEvent>(
        SANDBOX_PREPARE_EVENT,
        (event) => forwardSandboxPrepare(event.getData()),
    )
    onShutdown(() => {
        prepareSubscription?.()
        prepareSubscription = null
    })
    const authStore = new AuthStore(value.fs)
    const store = new ConversationStore(
        value.fs,
        (id) => findCachedWorkspace(id) !== null,
        (id) => findCachedWorkspace(id)?.root ?? null,
    )
    const contexts = new ModelContextStore(value.fs)
    auth = authStore
    conversationStore = store
    modelContexts = contexts
    return (async () => {
        await authStore.load()
        await store.load()
        await contexts.load()
        await refreshWorkspaces()
        await initExtensions(value)
    })()
}

function getApi(): PluginApi {
    if (api === null) {
        throw new Error("wellspring-web 尚未初始化")
    }
    return api
}

function getAuth(): AuthStore {
    if (auth === null) {
        throw new Error("wellspring-web 认证尚未初始化")
    }
    return auth
}

function getConversationStore(): ConversationStore {
    if (conversationStore === null) {
        throw new Error("wellspring-web 会话存储尚未初始化")
    }
    return conversationStore
}

function findCachedWorkspace(id: string): HostWorkspaceEntry | null {
    for (const workspace of workspacesCache) {
        if (workspace.id === id) {
            return workspace
        }
    }
    return null
}

/** 从宿主工作区注册表刷新本地快照：工作区是宿主级概念，插件只做缓存 */
async function refreshWorkspaces(): Promise<readonly HostWorkspaceEntry[]> {
    const result = await getApi().workspaces.list()
    workspacesCache = [...result.workspaces]
    return workspacesCache
}

/** 给宿主工作区补上 Web 侧才有的会话数与更新时间，保持 /api/workspaces 的既有响应形状 */
async function workspaceView(
    entry: HostWorkspaceEntry,
    knownCount?: number,
): Promise<Record<string, unknown>> {
    const conversationCount =
        knownCount === undefined ? await getConversationStore().countFor(entry.id) : knownCount
    return {
        id: entry.id,
        name: entry.name,
        root: entry.root,
        createdAt: entry.createdAt,
        lastSeenAt: entry.lastSeenAt,
        conversationCount,
        updatedAt: entry.lastSeenAt,
    }
}

/** 解析工作区：本地快照没命中时先向宿主刷新一次 */
async function resolveWorkspace(id: string): Promise<HostWorkspaceEntry | null> {
    const cached = findCachedWorkspace(id)
    if (cached !== null) {
        return cached
    }
    await refreshWorkspaces()
    return findCachedWorkspace(id)
}

async function workspaceViews(): Promise<Array<Record<string, unknown>>> {
    await refreshWorkspaces()
    const views: Array<Record<string, unknown>> = []
    for (const entry of workspacesCache) {
        views.push(await workspaceView(entry))
    }
    return views
}

function getModelContexts(): ModelContextStore {
    if (modelContexts === null) {
        throw new Error("wellspring-web 上下文配置尚未初始化")
    }
    return modelContexts
}

/* ── 响应 ─────────────────────────────────────────────────── */

function baseHeaders(): Record<string, string> {
    return {
        "content-security-policy": CONTENT_SECURITY_POLICY,
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "cross-origin-opener-policy": "same-origin",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
    }
}

function json(status: number, data: unknown, headers: Record<string, string> = {}): HttpResponse {
    return {
        status,
        headers: {
            ...baseHeaders(),
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            ...headers,
        },
        body: JSON.stringify(data),
    }
}

function html(body: string): HttpResponse {
    return {
        status: 200,
        headers: {
            ...baseHeaders(),
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            vary: "cookie",
        },
        body,
    }
}

function text(status: number, body: string): HttpResponse {
    return {
        status,
        headers: {
            ...baseHeaders(),
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
        },
        body,
    }
}

function methodNotAllowed(allowed: readonly string[]): HttpResponse {
    return json(405, { error: "Method Not Allowed" }, { allow: allowed.join(", ") })
}

async function serveExtensionAsset(path: string): Promise<HttpResponse> {
    const match = /^\/extensions\/([^/]+)\.(js|css)$/.exec(path)
    if (match === null) {
        return text(404, "Not Found")
    }
    let id = ""
    try {
        id = decodeURIComponent(match[1] ?? "")
    } catch {
        return text(404, "Not Found")
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
        return text(404, "Not Found")
    }
    const assets = await extensionAssets(id)
    if (assets === null) {
        return text(404, "Not Found")
    }
    const isScript = match[2] === "js"
    const body = isScript ? assets.module : assets.css
    return {
        status: 200,
        headers: {
            ...baseHeaders(),
            "content-type": isScript ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
            "cache-control": "no-store",
        },
        body,
    }
}

function matchesEtag(header: string, etag: string): boolean {
    return header.split(",").some((value) => {
        const trimmed = value.trim()
        return trimmed === etag || trimmed === `W/${etag}`
    })
}

function serveAsset(path: string, request: HttpRequest): HttpResponse | null {
    const asset = STATIC_ASSETS.get(path)
    if (asset === undefined) {
        return null
    }
    const ifNoneMatch = request.headers["if-none-match"]
    if (ifNoneMatch !== undefined && matchesEtag(ifNoneMatch, asset.etag)) {
        return {
            status: 304,
            headers: {
                ...baseHeaders(),
                etag: asset.etag,
                "cache-control": "no-cache",
            },
        }
    }
    return {
        status: 200,
        headers: {
            ...baseHeaders(),
            "content-type": asset.contentType,
            "cache-control": "no-cache",
            etag: asset.etag,
        },
        body: asset.body,
    }
}

/* ── 请求辅助 ─────────────────────────────────────────────── */

function bodyText(request: HttpRequest): string {
    return request.body === "" ? "" : Buffer.from(request.body, "base64").toString("utf8")
}

function bodySize(request: HttpRequest): number {
    const raw = request.headers["content-length"]
    const declared = raw === undefined ? Number.NaN : Number(raw)
    const actual = request.body === "" ? 0 : Math.floor((request.body.length * 3) / 4)
    return Number.isFinite(declared) && declared > actual ? declared : actual
}

function parseJson(request: HttpRequest): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(bodyText(request) || "{}")
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {}
    } catch {
        return {}
    }
}

function isJsonRequest(request: HttpRequest): boolean {
    const contentType = request.headers["content-type"] ?? ""
    return contentType.toLowerCase().startsWith("application/json")
}

/** 同源校验：浏览器发起的跨站写请求会被 Origin 挡住 */
function isSameOrigin(request: HttpRequest): boolean {
    const origin = request.headers["origin"]
    if (origin === undefined || origin === "") {
        return true
    }
    try {
        return new URL(origin).host === request.headers["host"]
    } catch {
        return false
    }
}

function clientKey(request: HttpRequest): string {
    return request.remoteAddress ?? "unknown"
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** 供应商/模型相关错误码 → 界面文案 */
const MODEL_ERRORS: Readonly<Record<string, string>> = {
    "models.provider-not-found": "供应商不存在",
    "models.builtin-provider": "内置供应商不能删除",
    "models.too-many-providers": "自定义供应商数量已达上限",
    "models.invalid": "供应商配置不合法",
    "models.invalid-model": "模型名不合法",
    "config.invalid": "配置不合法",
    "config.invalid-api-key": "API Key 格式不合法",
    "config.credentials-write-failed": "凭据文件写入失败",
    "openai.missing-api-key": "该供应商还没有 API Key",
    "openai.unauthorized": "API Key 无效或已过期",
    "openai.forbidden": "API Key 无权访问模型服务",
    "openai.timeout": "连接超时",
    "openai.connection-failed": "无法连接供应商",
    "openai.not-found": "接口不存在，检查 Base URL",
    "openai.rate-limited": "请求过于频繁，稍后再试",
    "openai.empty-output": "模型服务返回空结果",
}

function modelErrorMessage(code: string | null | undefined): string {
    if (code === null || code === undefined) {
        return "操作失败"
    }
    return MODEL_ERRORS[code] ?? code
}

/** 网络代理相关错误码 → 界面文案 */
const NETWORK_ERRORS: Readonly<Record<string, string>> = {
    "config.invalid:network.proxy.url": "代理地址需要 http:// 或 https:// 开头",
    "config.invalid:network.proxy.type": "只支持 HTTP/HTTPS 代理",
    "config.invalid:network.proxy.noProxy": "不走代理的主机格式不正确",
    "config.invalid:network.proxy": "代理配置不合法",
    "config.write-failed": "配置文件写入失败",
    "config.read-failed": "配置文件读取失败",
}

function networkErrorMessage(code: string | null | undefined): string {
    if (code === null || code === undefined) {
        return "操作失败"
    }
    return NETWORK_ERRORS[code] ?? code
}

/** 对话报错里把“缺 key”翻译成可操作的提示 */
function chatErrorMessage(error: unknown): string {
    const raw = errorMessage(error)
    if (raw.includes("openai.missing-api-key")) {
        return "还没有可用的 API Key：在左下角「供应商」里为当前供应商填写 Key 后再试"
    }
    return raw
}

/**
 * 写接口的统一前置校验，返回响应表示拒绝
 *
 * 要求 JSON 是为了让浏览器先发 preflight：DELETE 这类没有请求体的写请求本来
 * 也不会带 content-type，只有真正带 body 时才校验。同源校验始终生效。
 */
function guardWrite(
    request: HttpRequest,
    maxBytes: number = MAX_API_BODY_BYTES,
): HttpResponse | null {
    if (!isSameOrigin(request)) {
        return json(403, { error: "跨站请求已被拒绝" })
    }
    if (bodySize(request) > maxBytes) {
        return json(413, { error: "请求体过大" })
    }
    if (bodySize(request) > 0 && !isJsonRequest(request)) {
        return json(415, { error: "需要 application/json 请求体" })
    }
    return null
}

/** Agent 运行权限，取值和宿主的 sandbox.access 一致 */
type Permission = "read-only" | "workspace-write" | "danger-full-access"

const PERMISSIONS: readonly Permission[] = ["read-only", "workspace-write", "danger-full-access"]

interface ChatInput {
    readonly message: string
    readonly sessionId?: string
    /** 本轮使用的供应商与模型；缺省用宿主当前配置 */
    readonly provider?: string
    readonly model?: string
    /** 本轮推理强度：off / low / high / max */
    readonly reasoning?: string
    /** 工作区会话：按工作区 id 取目录 */
    readonly workspaceId?: string
    /** 未分组会话：直接使用会话记录的目录 */
    readonly workspaceRoot?: string
    /** 网页会话 id：用于刷新后重连续接本轮回复 */
    readonly conversationId?: string
    /** @ 引用的工作区相对路径 */
    readonly references?: readonly string[]
    /** 本轮 sandbox 权限；缺省时由宿主配置决定 */
    readonly permission?: Permission
}

function readChatInput(request: HttpRequest): ChatInput | HttpResponse {
    const body = parseJson(request)
    const rawMessage = body["message"]
    const message = typeof rawMessage === "string" ? rawMessage.trim() : ""
    if (message === "") {
        return json(400, { error: "消息不能为空" })
    }
    if (message.length > MAX_MESSAGE_CHARS) {
        return json(413, { error: `消息超过 ${MAX_MESSAGE_CHARS} 字符上限` })
    }
    const rawWorkspace = body["workspaceId"]
    const rawRoot = body["workspaceRoot"]
    const workspaceId =
        typeof rawWorkspace === "string" && rawWorkspace !== "" ? rawWorkspace : undefined
    const workspaceRoot =
        typeof rawRoot === "string" && rawRoot.trim() !== "" ? rawRoot.trim() : undefined
    if (workspaceId === undefined && workspaceRoot === undefined) {
        return json(400, { error: "缺少工作区" })
    }
    if (workspaceId !== undefined && !WORKSPACE_ID.test(workspaceId)) {
        return json(400, { error: "工作区 id 不合法" })
    }
    const rawPermission = body["permission"]
    let permission: Permission | undefined
    if (rawPermission !== undefined && rawPermission !== null) {
        if (
            typeof rawPermission !== "string" ||
            !PERMISSIONS.includes(rawPermission as Permission)
        ) {
            return json(400, { error: "权限不合法" })
        }
        permission = rawPermission as Permission
    }
    const rawSession = body["sessionId"]
    const rawReferences = body["references"]
    const references: string[] = []
    if (Array.isArray(rawReferences)) {
        for (const item of rawReferences) {
            if (typeof item !== "string") continue
            const value = item.trim()
            if (value === "" || value.length > 512) continue
            references.push(value)
            if (references.length >= 20) break
        }
    }
    const rawProvider = body["provider"]
    const rawModel = body["model"]
    const rawConversation = body["conversationId"]
    let conversationId: string | undefined
    if (typeof rawConversation === "string" && rawConversation !== "") {
        if (!CONVERSATION_ID.test(rawConversation)) {
            return json(400, { error: "会话 id 不合法" })
        }
        conversationId = rawConversation
    }
    return {
        message,
        sessionId: typeof rawSession === "string" && rawSession !== "" ? rawSession : undefined,
        provider:
            typeof rawProvider === "string" && rawProvider.trim() !== ""
                ? rawProvider.trim()
                : undefined,
        model: typeof rawModel === "string" && rawModel.trim() !== "" ? rawModel.trim() : undefined,
        reasoning:
            typeof body["reasoning"] === "string" && body["reasoning"].trim() !== ""
                ? body["reasoning"].trim()
                : undefined,
        workspaceId,
        workspaceRoot,
        conversationId,
        references: references.length > 0 ? references : undefined,
        permission,
    }
}

/* ── 路由 ─────────────────────────────────────────────────── */

const ALLOWED_METHODS: Readonly<Record<string, readonly string[]>> = {
    "/": ["GET"],
    "/index.html": ["GET"],
    "/favicon.svg": ["GET"],
    "/assets/app.css": ["GET"],
    "/api/state": ["GET"],
    "/api/auth/setup": ["POST"],
    "/api/auth/login": ["POST"],
    "/api/auth/logout": ["POST"],
    "/api/auth/password": ["POST"],
    "/api/host": ["GET"],
    "/api/shutdown": ["POST"],
    "/api/models": ["GET"],
    "/api/models/active": ["POST"],
    "/api/models/provider": ["POST"],
    "/api/models/provider/remove": ["POST"],
    "/api/models/fetch": ["POST"],
    "/api/models/key": ["POST"],
    "/api/models/key/clear": ["POST"],
    "/api/models/context": ["GET", "POST"],
    "/api/network": ["GET", "POST"],
    "/api/plugins": ["GET"],
    "/api/plugins/install": ["POST"],
    "/api/plugins/remove": ["POST"],
    "/api/plugins/enable": ["POST"],
    "/api/plugins/disable": ["POST"],
    "/api/addons": ["GET"],
    "/api/addons/stream": ["GET"],
    "/api/extensions": ["GET"],
    "/api/extensions/install": ["POST"],
    "/api/extensions/hide": ["POST"],
    "/api/extensions/show": ["POST"],
    "/api/workspaces": ["GET", "POST"],
    "/api/picker": ["POST"],
    "/api/files": ["GET"],
    "/api/files/open": ["POST"],
    "/api/approvals": ["POST"],
    "/api/ungrouped/conversations": ["GET"],
    "/api/ungrouped/conversations/active": ["POST"],
    "/api/chat": ["POST"],
    "/api/chat/stream": ["POST"],
    "/api/chat/resume": ["GET"],
    "/api/chat/interject": ["POST"],
    "/api/chat/stop": ["POST"],
    "/api/chat/running": ["GET"],
}

// 分页参数：before 缺省到末尾
function pageBefore(url: URL): number {
    const text = url.searchParams.get("before")
    const value = text === null ? Number.NaN : Number(text)
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

function pageLimit(url: URL): number {
    const text = url.searchParams.get("limit")
    const value = text === null ? Number.NaN : Number(text)
    return Number.isFinite(value) && value > 0 ? value : MESSAGE_PAGE_LIMIT
}

/** SPA 外壳：Vue 客户端路由由前端接管，服务端对已知客户端路径回同一份壳 */
async function renderPageShell(request: HttpRequest): Promise<HttpResponse> {
    const theme = parseTheme(parseCookies(request.headers["cookie"])[THEME_COOKIE])
    const override = await loadPageOverride(getApi().fs, themeAttribute(theme), (error) => {
        getApi().logger.warn({ error: errorMessage(error) }, "读取页面覆盖文件失败")
    })
    const vueStyles = STATIC_ASSETS.has("/assets/app-vue.css")
    return html(override ?? renderVueHome(theme, { styles: vueStyles }))
}

function sseHeaders(): Record<string, string> {
    return {
        ...baseHeaders(),
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
    }
}

/** 首批数据延后写入：宿主在 handler 返回后才设置响应头 */
function createChunkWriter(stream: HttpStreamContext): {
    write(chunk: string): void
    flush(): void
} {
    let opened = false
    let openTimer: ReturnType<typeof setTimeout> | null = null
    const pending: string[] = []
    const flush = (): void => {
        if (openTimer !== null) {
            clearTimeout(openTimer)
            openTimer = null
        }
        opened = true
        const chunk = pending.join("")
        pending.length = 0
        if (chunk === "") {
            return
        }
        try {
            stream.write(chunk)
        } catch {
            /* 客户端可能已经断开 */
        }
    }
    const write = (chunk: string): void => {
        if (opened) {
            try {
                stream.write(chunk)
            } catch {
                /* 客户端可能已经断开 */
            }
            return
        }
        pending.push(chunk)
        if (openTimer === null) {
            openTimer = setTimeout(flush, 25)
        }
    }
    return { write, flush }
}

function streamChat(parsed: ChatInput, cwd: string, stream: HttpStreamContext): HttpResponse {
    const currentApi = getApi()
    const turn =
        parsed.conversationId === undefined
            ? null
            : beginChatTurn(parsed.conversationId, parsed.workspaceId ?? null)
    const writer = createChunkWriter(stream)
    // 原连接也订阅本轮事件：插话等外部产生的碎片同样要写进这条流
    if (turn !== null) {
        turn.listeners.add({ write: (chunk) => writer.write(chunk), end: () => undefined })
    }
    const send = (data: unknown): void => {
        const chunk = `data: ${JSON.stringify(data)}\n\n`
        if (turn === null) {
            writer.write(chunk)
            return
        }
        const record = data as Record<string, unknown> | null
        if (
            record !== null &&
            record["type"] === "session" &&
            typeof record["sessionId"] === "string"
        ) {
            turn.sessionId = record["sessionId"]
        }
        recordChatTurnEvent(turn, chunk)
    }
    let task: Promise<HostAgentChatResult>
    try {
        task = currentApi.agent.stream(
            {
                message: parsed.message,
                sessionId: parsed.sessionId,
                cwd,
                references: parsed.references,
                permission: parsed.permission,
                ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
                ...(parsed.model === undefined ? {} : { model: parsed.model }),
                ...(parsed.reasoning === undefined ? {} : { reasoning: parsed.reasoning }),
            },
            (event) => send(event),
        )
    } catch (error) {
        if (turn !== null) {
            finishChatTurn(turn)
            chatTurns.delete(turn.conversationId)
        }
        return json(500, { error: chatErrorMessage(error) })
    }
    const ping = setInterval(() => {
        writer.write(": ping\n\n")
    }, SSE_PING_MS)
    void task
        .then((result) => {
            send({ ...result, type: "done" })
        })
        .catch((error: unknown) => {
            send({ type: "error", error: chatErrorMessage(error) })
        })
        .finally(() => {
            clearInterval(ping)
            writer.flush()
            try {
                stream.end()
            } catch {
                /* 忽略 */
            }
            if (turn !== null) {
                finishChatTurn(turn)
            }
        })
    return {
        status: 200,
        headers: sseHeaders(),
        stream: true,
    }
}

interface ResumeOptions {
    /** 只重放这个下标之后的事件；前端按已收到的事件数做增量重放 */
    readonly since: number
    /** 只问进度不建流：连接还活着但事件没到，用它判断服务端是不是已经跑在前面 */
    readonly peek: boolean
}

/**
 * 本轮已缓冲的事件数
 *
 * 前端在流里记着自己收到多少条，卡住时用 `peek` 对一下：服务端的数字更大就说明
 * 有事件没送到，立刻按 `since` 增量重放，不用等这一轮跑完。
 */
function chatTurnProgress(turn: ChatTurn): Record<string, unknown> {
    return {
        ok: true,
        active: !turn.done,
        total: turn.events.length,
        done: turn.done,
        truncated: turn.truncated,
    }
}

/** 刷新/断线后重连续接：重放本轮已产生的事件，再继续推送后续事件 */
function resumeChat(
    conversationId: string,
    options: ResumeOptions,
    stream: HttpStreamContext,
): HttpResponse {
    const turn = findChatTurn(conversationId)
    if (turn === null) {
        return json(200, { ok: false, active: false, error: "没有可续接的回复" })
    }
    if (turn.truncated) {
        return json(200, { ok: false, active: false, error: "本轮回复事件过多，无法续接" })
    }
    if (options.peek) {
        return json(200, chatTurnProgress(turn))
    }
    // since 越界（缓冲被重置过、前端计数比服务端多）时退回全量重放
    const since =
        Number.isInteger(options.since) && options.since > 0 && options.since <= turn.events.length
            ? options.since
            : 0
    const writer = createChunkWriter(stream)
    let ping: ReturnType<typeof setInterval> | null = null
    let closed = false
    const close = (): void => {
        if (closed) {
            return
        }
        closed = true
        if (ping !== null) {
            clearInterval(ping)
            ping = null
        }
        writer.flush()
        try {
            stream.end()
        } catch {
            /* 忽略 */
        }
    }
    /*
     * 先发出恢复标记：
     * - from 是这次重放的起点，前端据此判断「增量接续」还是「从头重建」；
     * - total 是服务端当前已有的事件数，前端拿它校准自己的计数。
     */
    writer.write(
        `data: ${JSON.stringify({ type: "resume", active: !turn.done, from: since, total: turn.events.length })}\n\n`,
    )
    for (const chunk of turn.events.slice(since)) {
        writer.write(chunk)
    }
    if (turn.done) {
        close()
        return { status: 200, headers: sseHeaders(), stream: true }
    }
    const listener: ChatTurnListener = { write: (chunk) => writer.write(chunk), end: close }
    turn.listeners.add(listener)
    ping = setInterval(() => {
        writer.write(": ping\n\n")
    }, SSE_PING_MS)
    return { status: 200, headers: sseHeaders(), stream: true }
}

/**
 * 停止正在跑的一轮
 *
 * 浏览器断开 SSE 只是不再显示；宿主那一轮还会继续调用模型与工具。
 * 这里显式让宿主把会话标记为停止，循环在当前步之后收尾；
 * 本轮事件缓冲同时收尾，之后不会再被续接，其它窗口也会收到 stopped。
 */
async function stopChat(request: HttpRequest): Promise<HttpResponse> {
    const guarded = guardWrite(request)
    if (guarded !== null) {
        return guarded
    }
    const body = parseJson(request)
    const conversationId = typeof body["conversationId"] === "string" ? body["conversationId"] : ""
    if (!CONVERSATION_ID.test(conversationId)) {
        return json(400, { error: "会话 id 不合法" })
    }
    const turn = findChatTurn(conversationId)
    if (turn === null || turn.done) {
        // 已经收尾的一轮：停止是幂等的，界面照常把本地流关掉
        return json(200, { ok: true, stopped: false })
    }
    let stopped = false
    if (turn.sessionId !== null) {
        try {
            stopped = await getApi().agent.stop(turn.sessionId)
        } catch (error) {
            getApi().logger.warn({ error: errorMessage(error) }, "停止 Agent 一轮失败")
        }
    }
    recordChatTurnEvent(
        turn,
        `data: ${JSON.stringify({ type: "stopped", at: Date.now() })}

`,
    )
    finishChatTurn(turn)
    return json(200, { ok: true, stopped })
}

/**
 * 向正在跑的一轮插话：消息由宿主会话排队，在下一次模型调用前注入同一轮
 * 轮次已结束时返回 409，界面按下一轮发送
 */
async function interjectChat(request: HttpRequest): Promise<HttpResponse> {
    const guarded = guardWrite(request)
    if (guarded !== null) {
        return guarded
    }
    const body = parseJson(request)
    const conversationId = typeof body["conversationId"] === "string" ? body["conversationId"] : ""
    if (!CONVERSATION_ID.test(conversationId)) {
        return json(400, { error: "会话 id 不合法" })
    }
    const message = typeof body["message"] === "string" ? body["message"].trim() : ""
    if (message === "") {
        return json(400, { error: "消息不能为空" })
    }
    if (message.length > MAX_MESSAGE_CHARS) {
        return json(413, { error: `消息超过 ${MAX_MESSAGE_CHARS} 字符上限` })
    }
    const turn = findChatTurn(conversationId)
    if (turn === null || turn.done || turn.sessionId === null) {
        return json(409, { ok: false, error: "这一轮已经结束" })
    }
    let accepted = false
    try {
        accepted = await getApi().agent.interject(turn.sessionId, message)
    } catch (error) {
        return json(500, { ok: false, error: chatErrorMessage(error) })
    }
    if (!accepted || turn.done) {
        return json(409, { ok: false, error: "这一轮已经结束" })
    }
    // 插话也写进本轮事件：其它窗口和刷新后的续接都能看到
    recordChatTurnEvent(
        turn,
        `data: ${JSON.stringify({ type: "steer", text: message, at: Date.now() })}\n\n`,
    )
    return json(200, { ok: true })
}

function hostSnapshot(): HttpResponse {
    try {
        const host = getHost()
        return json(200, {
            status: host.getStatus(),
            os: host.getOS(),
            paths: host.getPaths(),
            plugins: host.getPlugins().map((plugin) => ({
                id: plugin.id,
                name: plugin.name,
                version: plugin.version,
                deps: plugin.deps,
                commands: plugin.commands,
                status: plugin.getStatus(),
            })),
            pluginVersion: getApi().plugin.version,
            apiVersion: getApi().apiVersion,
        })
    } catch (error) {
        return json(403, { error: errorMessage(error) })
    }
}

function streamAddons(stream: HttpStreamContext): HttpResponse {
    let opened = false
    let closed = false
    let openTimer: ReturnType<typeof setTimeout> | null = null
    const pending: string[] = []

    function cleanup(): void {
        if (closed) {
            return
        }
        closed = true
        if (openTimer !== null) {
            clearTimeout(openTimer)
            openTimer = null
        }
        clearInterval(ping)
        unsubscribe()
        addonStreams.delete(cleanup)
        try {
            stream.end()
        } catch {
            /* 客户端可能已经断开 */
        }
    }

    function sendNow(chunk: string): void {
        try {
            stream.write(chunk)
        } catch {
            cleanup()
        }
    }

    function flush(): void {
        openTimer = null
        opened = true
        const chunk = pending.join("")
        pending.length = 0
        if (chunk !== "") {
            sendNow(chunk)
        }
    }

    function send(addons: readonly NavBottomAddon[]): void {
        if (closed) {
            return
        }
        const chunk = `event: addons\ndata: ${JSON.stringify({ addons })}\n\n`
        if (opened) {
            sendNow(chunk)
            return
        }
        pending.push(chunk)
        if (openTimer === null) {
            // 宿主在 handler 返回后才写响应头，首批数据延后一点
            openTimer = setTimeout(flush, 25)
        }
    }

    const unsubscribe = subscribeNavBottomAddons(send)
    const ping = setInterval(() => {
        if (closed || !opened) {
            return
        }
        sendNow(": ping\n\n")
    }, SSE_PING_MS)
    addonStreams.add(cleanup)
    send(listNavBottomAddons())
    return {
        status: 200,
        headers: {
            ...baseHeaders(),
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
            "x-accel-buffering": "no",
        },
        stream: true,
    }
}

async function route(request: HttpRequest, stream: HttpStreamContext): Promise<HttpResponse> {
    const method = request.method.toUpperCase()
    const url = new URL(request.url, "http://localhost")
    const path = url.pathname

    const allowed = ALLOWED_METHODS[path]
    if (allowed !== undefined && !allowed.includes(method)) {
        return methodNotAllowed(allowed)
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
        return await renderPageShell(request)
    }

    if (method === "GET") {
        const asset = serveAsset(path, request)
        if (asset !== null) {
            return asset
        }
    }

    if (path.startsWith("/assets/") || path === "/favicon.svg") {
        return text(404, "Not Found")
    }

    // Vue Router 使用 history 模式：/extensions、/ext/<id> 等客户端路由也返回页面壳
    if (method === "GET" && !path.startsWith("/api/") && !path.startsWith("/extensions/")) {
        return await renderPageShell(request)
    }

    const currentAuth = getAuth()
    const currentApi = getApi()

    if (method === "GET" && path === "/api/state") {
        return json(200, {
            configured: currentAuth.configured,
            authenticated: currentAuth.authenticated(request),
            version: currentApi.plugin.version,
            apiVersion: currentApi.apiVersion,
        })
    }

    if (method === "POST" && path === "/api/auth/setup") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        if (currentAuth.configured || setupInFlight) {
            return json(409, { error: "密码已经设置过了" })
        }
        const rawPassword = parseJson(request)["password"]
        const password = typeof rawPassword === "string" ? rawPassword : ""
        setupInFlight = true
        try {
            await currentAuth.setPassword(password)
        } catch (error) {
            return json(400, { error: errorMessage(error) })
        } finally {
            setupInFlight = false
        }
        const session = currentAuth.createSession()
        return json(200, { ok: true }, { "set-cookie": currentAuth.cookie(session) })
    }

    if (method === "POST" && path === "/api/auth/login") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const key = clientKey(request)
        const limited = loginThrottle.status(key)
        if (limited.blocked) {
            return json(
                429,
                { error: "尝试过于频繁，请稍后再试", retryAfter: limited.retryAfter },
                { "retry-after": String(limited.retryAfter) },
            )
        }
        if (!currentAuth.configured) {
            return json(409, { error: "还没有设置密码" })
        }
        const rawLoginPassword = parseJson(request)["password"]
        const password = typeof rawLoginPassword === "string" ? rawLoginPassword : ""
        if (!currentAuth.verifyPassword(password)) {
            loginThrottle.recordFailure(key)
            currentApi.logger.warn({ remoteAddress: request.remoteAddress }, "网页登录失败")
            return json(401, { error: "密码错误" })
        }
        loginThrottle.reset(key)
        const session = currentAuth.createSession()
        return json(200, { ok: true }, { "set-cookie": currentAuth.cookie(session) })
    }

    if (method === "POST" && path === "/api/auth/logout") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        currentAuth.logout(request)
        return json(200, { ok: true }, { "set-cookie": currentAuth.clearCookie() })
    }

    if (!currentAuth.authenticated(request)) {
        return json(401, { error: "未登录" })
    }

    // Web 扩展：编译产物与安装管理（扩展模块在页面里按需 import）
    if (method === "GET" && path.startsWith("/extensions/")) {
        return await serveExtensionAsset(path)
    }

    if (method === "GET" && path === "/api/extensions") {
        return json(200, {
            extensions: listExtensions(),
            hiddenBundled: hiddenBuiltinExtensions(),
        })
    }

    if (method === "POST" && path === "/api/extensions/hide") {
        const guarded = guardWrite(request)
        if (guarded !== null) return guarded
        const id =
            typeof parseJson(request)["id"] === "string" ? String(parseJson(request)["id"]) : ""
        if (!(await setBuiltinHidden(id, true))) {
            return json(400, { error: "只能隐藏内置扩展" })
        }
        return json(200, { ok: true, hiddenBundled: hiddenBuiltinExtensions() })
    }

    if (method === "POST" && path === "/api/extensions/show") {
        const guarded = guardWrite(request)
        if (guarded !== null) return guarded
        const id =
            typeof parseJson(request)["id"] === "string" ? String(parseJson(request)["id"]) : ""
        if (!(await setBuiltinHidden(id, false))) {
            return json(400, { error: "只能恢复内置扩展" })
        }
        return json(200, { ok: true, hiddenBundled: hiddenBuiltinExtensions() })
    }

    if (method === "POST" && path === "/api/extensions/install") {
        const guarded = guardWrite(request, 3 * 1024 * 1024)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const filename = typeof body["filename"] === "string" ? body["filename"] : ""
        const dataBase64 = typeof body["dataBase64"] === "string" ? body["dataBase64"] : ""
        if (filename === "" || dataBase64 === "") {
            return json(400, { error: "需要 filename 与 dataBase64" })
        }
        const result = await installExtension(filename, dataBase64)
        if (!result.ok) {
            return json(400, { error: result.error })
        }
        return json(200, {
            ok: true,
            extension: result.extension,
            extensions: listExtensions(),
            hiddenBundled: hiddenBuiltinExtensions(),
        })
    }

    if (method === "DELETE" && path.startsWith("/api/extensions/")) {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        let id = ""
        try {
            id = decodeURIComponent(path.slice("/api/extensions/".length))
        } catch {
            return json(400, { error: "扩展 id 不合法" })
        }
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
            return json(400, { error: "扩展 id 不合法" })
        }
        const removed = await removeExtension(id)
        if (!removed) {
            return json(404, { error: "扩展不存在或是内置扩展" })
        }
        return json(200, {
            ok: true,
            extensions: listExtensions(),
            hiddenBundled: hiddenBuiltinExtensions(),
        })
    }

    // 修改访问密码：校验当前密码，成功后让所有旧会话失效并给当前浏览器换新 cookie
    if (method === "POST" && path === "/api/auth/password") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const key = `password:${clientKey(request)}`
        const limited = loginThrottle.status(key)
        if (limited.blocked) {
            return json(
                429,
                { error: "尝试过于频繁，请稍后再试", retryAfter: limited.retryAfter },
                { "retry-after": String(limited.retryAfter) },
            )
        }
        const body = parseJson(request)
        const currentPassword =
            typeof body["currentPassword"] === "string" ? body["currentPassword"] : ""
        const newPassword = typeof body["newPassword"] === "string" ? body["newPassword"] : ""
        if (!currentAuth.verifyPassword(currentPassword)) {
            loginThrottle.recordFailure(key)
            currentApi.logger.warn({ remoteAddress: request.remoteAddress }, "网页修改密码失败")
            return json(401, { error: "当前密码不正确" })
        }
        try {
            await currentAuth.setPassword(newPassword)
        } catch (error) {
            return json(400, { error: errorMessage(error) })
        }
        loginThrottle.reset(key)
        currentAuth.clearSessions()
        const session = currentAuth.createSession()
        currentApi.logger.info({ remoteAddress: request.remoteAddress }, "网页访问密码已修改")
        return json(200, { ok: true }, { "set-cookie": currentAuth.cookie(session) })
    }

    if (method === "GET" && path === "/api/addons") {
        return json(200, { addons: listNavBottomAddons() })
    }

    if (method === "GET" && path === "/api/addons/stream") {
        return streamAddons(stream)
    }

    if (method === "GET" && path === "/api/host") {
        return hostSnapshot()
    }

    // 关闭 Wellspring：先回响应，再触发宿主的优雅关闭（onShutdown → 停插件 → 清服务记录）
    if (method === "POST" && path === "/api/shutdown") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        currentApi.logger.warn(
            { remoteAddress: request.remoteAddress },
            "网页请求关闭 Wellspring 服务",
        )
        setTimeout(() => {
            try {
                shutdown()
            } catch (error) {
                currentApi.logger.warn({ error: errorMessage(error) }, "网页关闭服务失败")
            }
        }, 200)
        return json(200, { ok: true })
    }

    if (method === "GET" && path === "/api/models") {
        return json(200, await currentApi.models.state())
    }

    if (method === "POST" && path === "/api/models/active") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const providerId = typeof body["providerId"] === "string" ? body["providerId"] : ""
        const rawModel = body["model"]
        const rawReasoning = body["reasoning"]
        try {
            const state = await currentApi.models.setActive(
                providerId,
                typeof rawModel === "string" && rawModel.trim() !== "" ? rawModel.trim() : null,
                typeof rawReasoning === "string" && rawReasoning.trim() !== ""
                    ? rawReasoning.trim()
                    : null,
            )
            return json(200, { ok: true, state })
        } catch (error) {
            return json(400, { error: modelErrorMessage(errorMessage(error)) })
        }
    }

    if (method === "POST" && path === "/api/models/provider") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const modelsRaw = body["models"]
        const models = Array.isArray(modelsRaw)
            ? modelsRaw.filter((item): item is string => typeof item === "string")
            : []
        const result = await currentApi.models.saveProvider({
            id: typeof body["id"] === "string" ? body["id"] : null,
            name: typeof body["name"] === "string" ? body["name"] : "",
            baseUrl: typeof body["baseUrl"] === "string" ? body["baseUrl"] : null,
            models,
            defaultModel: typeof body["defaultModel"] === "string" ? body["defaultModel"] : null,
            apiKeyEnv: typeof body["apiKeyEnv"] === "string" ? body["apiKeyEnv"] : null,
            apiKey: typeof body["apiKey"] === "string" ? body["apiKey"] : null,
        })
        if (!result.ok) {
            return json(400, {
                error: modelErrorMessage(result.code),
                code: result.code ?? null,
                state: result.state,
            })
        }
        return json(200, { ok: true, state: result.state })
    }

    if (method === "POST" && path === "/api/models/provider/remove") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const id =
            typeof parseJson(request)["id"] === "string" ? String(parseJson(request)["id"]) : ""
        const result = await currentApi.models.removeProvider(id)
        if (!result.ok) {
            return json(400, { error: modelErrorMessage(result.code), state: result.state })
        }
        return json(200, { ok: true, state: result.state })
    }

    if (method === "POST" && path === "/api/models/fetch") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const id = typeof body["id"] === "string" ? body["id"] : ""
        const candidate =
            typeof body["apiKey"] === "string" && body["apiKey"].trim() !== ""
                ? body["apiKey"].trim()
                : undefined
        const result = await currentApi.models.fetchModels(id, candidate)
        if (!result.ok) {
            return json(400, { error: modelErrorMessage(result.code), code: result.code ?? null })
        }
        return json(200, { ok: true, models: result.models ?? [] })
    }

    if (method === "POST" && path === "/api/models/key") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const result = await currentApi.models.saveKey(
            typeof body["id"] === "string" ? body["id"] : "",
            typeof body["apiKey"] === "string" ? body["apiKey"] : "",
        )
        if (!result.ok) {
            return json(400, { error: modelErrorMessage(result.code), state: result.state })
        }
        return json(200, { ok: true, state: result.state })
    }

    if (method === "POST" && path === "/api/models/key/clear") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const id =
            typeof parseJson(request)["id"] === "string" ? String(parseJson(request)["id"]) : ""
        try {
            const state = await currentApi.models.clearKey(id)
            return json(200, { ok: true, state })
        } catch (error) {
            return json(400, { error: modelErrorMessage(errorMessage(error)) })
        }
    }

    if (path === "/api/models/context") {
        const store = getModelContexts()
        if (method === "GET") {
            return json(200, { contextWindows: store.all() })
        }
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const rawItems = parseJson(request)["items"]
        if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 500) {
            return json(400, { error: "items 需要 1-500 条" })
        }
        const items: ModelContextItem[] = []
        for (const raw of rawItems) {
            if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
                return json(400, { error: "上下文配置不合法" })
            }
            const item = raw as Record<string, unknown>
            const provider = typeof item["provider"] === "string" ? item["provider"].trim() : ""
            const model = typeof item["model"] === "string" ? item["model"].trim() : ""
            if (provider === "" || model === "") {
                return json(400, { error: "供应商与模型不能为空" })
            }
            const rawWindow = item["contextWindow"]
            if (rawWindow !== null && !isValidContextWindow(rawWindow)) {
                return json(400, { error: "上下文窗口必须是正整数" })
            }
            items.push({
                provider,
                model,
                contextWindow: rawWindow === null ? null : rawWindow,
            })
        }
        try {
            const contexts = await store.apply(items)
            return json(200, { ok: true, contextWindows: contexts })
        } catch (error) {
            return json(400, { error: errorMessage(error) })
        }
    }

    if (path === "/api/network") {
        if (method === "GET") {
            return json(200, await currentApi.network.state())
        }
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const rawUrl = body["url"]
        if (rawUrl !== null && typeof rawUrl !== "string") {
            return json(400, { error: "代理地址不合法" })
        }
        const rawNoProxy = body["noProxy"]
        if (rawNoProxy !== undefined && rawNoProxy !== null && !Array.isArray(rawNoProxy)) {
            return json(400, { error: "不走代理的主机需要是字符串数组" })
        }
        const noProxy: string[] = []
        for (const item of Array.isArray(rawNoProxy) ? rawNoProxy : []) {
            if (typeof item !== "string") continue
            const value = item.trim()
            if (value !== "") noProxy.push(value)
        }
        try {
            const result = await currentApi.network.saveProxy({
                url: rawUrl === null ? null : rawUrl,
                noProxy,
            })
            if (!result.ok) {
                return json(400, { error: networkErrorMessage(result.code) })
            }
            return json(200, { ok: true, ...result.state })
        } catch (error) {
            return json(400, { error: errorMessage(error) })
        }
    }

    if (method === "GET" && path === "/api/workspaces") {
        return json(200, {
            workspaces: await workspaceViews(),
            ungroupedCount: await getConversationStore().ungroupedCount(),
        })
    }

    if (method === "POST" && path === "/api/workspaces") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const rootRaw = body["root"]
        if (typeof rootRaw !== "string" || rootRaw.trim() === "") {
            return json(400, { error: "工作区路径不能为空" })
        }
        if (typeof currentApi.agent.validateWorkspace !== "function") {
            return json(501, { error: "宿主不支持校验工作区目录" })
        }
        const check = await currentApi.agent.validateWorkspace(rootRaw)
        if (!check.ok) {
            return json(400, { error: `工作区不可用：${check.error ?? "目录不可用"}` })
        }
        const nameRaw = body["name"]
        const name =
            typeof nameRaw === "string" && nameRaw.trim() !== ""
                ? (normalizeWorkspaceName(nameRaw) ?? check.name)
                : check.name
        try {
            const result = await currentApi.workspaces.add({ root: check.root, name })
            const entry = findCachedWorkspace(result.workspace.id) ?? result.workspace
            const store = getConversationStore()
            return json(result.duplicate ? 409 : 201, {
                workspace: await workspaceView(entry),
                workspaces: await workspaceViews(),
                ungroupedCount: await store.ungroupedCount(),
                duplicate: result.duplicate,
            })
        } catch (error) {
            return json(400, { error: errorMessage(error) })
        }
    }

    if (path.startsWith("/api/asks/")) {
        if (method !== "POST") {
            return methodNotAllowed(["POST"])
        }
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        let askId = ""
        try {
            askId = decodeURIComponent(path.slice("/api/asks/".length))
        } catch {
            return json(400, { error: "提问 id 不合法" })
        }
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(askId)) {
            return json(400, { error: "提问 id 不合法" })
        }
        const rawAnswer = parseJson(request)["answer"]
        if (typeof rawAnswer !== "string") {
            return json(400, { error: "answer 必须是字符串" })
        }
        const answer = rawAnswer.slice(0, MAX_ASK_ANSWER_CHARS).trim()
        if (typeof currentApi.agent.respondAsk !== "function") {
            return json(501, { error: "宿主不支持回答提问" })
        }
        const accepted = await currentApi.agent.respondAsk(askId, answer)
        if (accepted) {
            settleBufferedRequest("ask", askId)
        }
        // 未接受：提问已作答或本轮已收尾，面板来自重放时同属此情况
        return json(200, { ok: accepted, accepted, stale: !accepted })
    }

    if (path.startsWith("/api/approvals/")) {
        if (method !== "POST") {
            return methodNotAllowed(["POST"])
        }
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        let approvalId = ""
        try {
            approvalId = decodeURIComponent(path.slice("/api/approvals/".length))
        } catch {
            return json(400, { error: "审批 id 不合法" })
        }
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(approvalId)) {
            return json(400, { error: "审批 id 不合法" })
        }
        const approved = parseJson(request)["approved"]
        if (typeof approved !== "boolean") {
            return json(400, { error: "approved 必须是布尔值" })
        }
        if (typeof currentApi.agent.respondApproval !== "function") {
            return json(501, { error: "宿主不支持审批" })
        }
        const accepted = await currentApi.agent.respondApproval(approvalId, approved)
        if (accepted) {
            settleBufferedRequest("approval", approvalId)
        }
        return json(200, { ok: accepted, accepted, stale: !accepted })
    }

    if (method === "GET" && path === "/api/files") {
        const workspaceId = url.searchParams.get("workspaceId") ?? ""
        const workspaceRootRaw = url.searchParams.get("workspaceRoot") ?? ""
        const query = url.searchParams.get("q") ?? ""
        let root: string | null = null
        if (workspaceId !== "") {
            const workspace = findCachedWorkspace(workspaceId)
            if (workspace === null) {
                return json(404, { error: "工作区不存在" })
            }
            root = workspace.root
        } else if (workspaceRootRaw.trim() !== "") {
            root = workspaceRootRaw.trim()
        }
        if (root === null) {
            return json(400, { error: "缺少工作区" })
        }
        if (typeof currentApi.agent.searchWorkspaceFiles !== "function") {
            return json(501, { error: "宿主不支持文件搜索" })
        }
        const result = await currentApi.agent.searchWorkspaceFiles(root, query)
        return json(result.ok ? 200 : 400, result)
    }

    if (method === "POST" && path === "/api/files/open") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const target = typeof body["path"] === "string" ? body["path"].trim() : ""
        if (target === "") {
            return json(400, { error: "路径不能为空" })
        }
        if (typeof currentApi.agent.openPath !== "function") {
            return json(501, { error: "宿主不支持用系统程序打开文件" })
        }
        const mode = body["mode"] === "reveal" ? "reveal" : "default"
        try {
            await currentApi.agent.openPath(target, mode)
            return json(200, { ok: true, path: target, mode })
        } catch (error) {
            return json(400, { error: errorMessage(error) })
        }
    }

    if (method === "POST" && path === "/api/picker") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        if (typeof currentApi.agent.pickDirectory !== "function") {
            return json(501, { error: "宿主不支持文件夹选择" })
        }
        return json(200, await currentApi.agent.pickDirectory())
    }

    if (path.startsWith("/api/workspaces/")) {
        const segments = path.slice("/api/workspaces/".length).split("/")
        let workspaceId = ""
        try {
            workspaceId = decodeURIComponent(segments[0] ?? "")
        } catch {
            return json(400, { error: "工作区 id 不合法" })
        }
        if (!WORKSPACE_ID.test(workspaceId)) {
            return json(400, { error: "工作区 id 不合法" })
        }
        const store = getConversationStore()
        const workspace = await resolveWorkspace(workspaceId)
        if (workspace === null) {
            return json(404, { error: "工作区不存在" })
        }

        if (segments.length === 1) {
            if (method === "GET") {
                return json(200, {
                    workspace: await workspaceView(workspace),
                    workspaces: await workspaceViews(),
                })
            }
            const guarded = guardWrite(request)
            if (guarded !== null) {
                return guarded
            }
            if (method === "PATCH") {
                const name = normalizeWorkspaceName(parseJson(request)["name"])
                if (name === null) {
                    return json(400, { error: "工作区名称需要 1-60 个字符" })
                }
                const renamed = await currentApi.workspaces.rename(workspaceId, name)
                if (renamed === null) {
                    return json(404, { error: "工作区不存在" })
                }
                return json(200, {
                    workspace: await workspaceView(renamed),
                    workspaces: await workspaceViews(),
                })
            }
            if (method === "DELETE") {
                const moved = await store.moveToUngrouped(workspaceId, workspace.root)
                const removed = await currentApi.workspaces.remove(workspaceId)
                await store.dropWorkspaceDir(workspaceId)
                return json(200, {
                    ok: removed.removed,
                    moved,
                    workspaces: await workspaceViews(),
                    ungroupedCount: await store.ungroupedCount(),
                })
            }
            return methodNotAllowed(["GET", "PATCH", "DELETE"])
        }

        if (segments[1] !== "conversations") {
            return json(404, { error: "Not Found" })
        }

        if (segments.length === 2) {
            if (method !== "GET") {
                return methodNotAllowed(["GET"])
            }
            const data = await store.readConversations(workspaceId)
            if (data === null) {
                return json(404, { error: "工作区不存在" })
            }
            const touched = await currentApi.workspaces.touch(workspaceId)
            if (touched !== null) {
                workspacesCache = workspacesCache.map((item) =>
                    item.id === workspaceId ? touched : item,
                )
            }
            return json(200, data)
        }

        if (segments.length === 3 && segments[2] === "active") {
            if (method !== "POST") {
                return methodNotAllowed(["POST"])
            }
            const guarded = guardWrite(request)
            if (guarded !== null) {
                return guarded
            }
            const raw = parseJson(request)["id"]
            if (raw !== null && raw !== undefined && typeof raw !== "string") {
                return json(400, { error: "会话 id 不合法" })
            }
            const activeId = await store.setActive(
                workspaceId,
                typeof raw === "string" ? raw : null,
            )
            return json(200, { activeId })
        }

        if (segments.length === 3) {
            let conversationId = ""
            try {
                conversationId = decodeURIComponent(segments[2] ?? "")
            } catch {
                return json(400, { error: "会话 id 不合法" })
            }
            if (!CONVERSATION_ID.test(conversationId)) {
                return json(400, { error: "会话 id 不合法" })
            }
            if (method === "GET") {
                const conversation = await store.findConversation(workspaceId, conversationId)
                if (conversation === null) {
                    return json(404, { error: "会话不存在" })
                }
                return json(200, { conversation })
            }
            const guarded = guardWrite(request)
            if (guarded !== null) {
                return guarded
            }
            if (method === "PUT") {
                const body = parseJson(request)
                if (body["id"] !== conversationId) {
                    return json(400, { error: "会话 id 不一致" })
                }
                const result = await store.upsertConversation(workspaceId, body)
                if (result === null) {
                    return json(400, { error: "会话数据不合法" })
                }
                if ("conflict" in result) {
                    return json(409, {
                        error: "会话已被其他窗口更新",
                        conversation: result.conflict,
                    })
                }
                return json(200, {
                    ok: true,
                    conversation: {
                        id: result.conversation.id,
                        title: result.conversation.title,
                        createdAt: result.conversation.createdAt,
                        updatedAt: result.conversation.updatedAt,
                        serverSessionId: result.conversation.serverSessionId,
                        model: result.conversation.model,
                        messageCount: result.conversation.messages.length,
                    },
                    trimmed: result.trimmed,
                    workspace: await workspaceView(workspace, result.count),
                })
            }
            if (method === "DELETE") {
                const removed = await store.deleteConversation(workspaceId, conversationId)
                return json(200, {
                    ok: true,
                    removed,
                    workspace: await workspaceView(workspace),
                })
            }
            return methodNotAllowed(["GET", "PUT", "DELETE"])
        }

        if (segments.length === 4 && segments[3] === "messages") {
            if (method !== "GET") {
                return methodNotAllowed(["GET"])
            }
            let conversationId = ""
            try {
                conversationId = decodeURIComponent(segments[2] ?? "")
            } catch {
                return json(400, { error: "会话 id 不合法" })
            }
            if (!CONVERSATION_ID.test(conversationId)) {
                return json(400, { error: "会话 id 不合法" })
            }
            const page = await store.readMessagePage(
                workspaceId,
                conversationId,
                pageBefore(url),
                pageLimit(url),
            )
            if (page === null) {
                return json(404, { error: "会话不存在" })
            }
            return json(200, page)
        }

        return json(404, { error: "Not Found" })
    }

    if (method === "GET" && path === "/api/ungrouped/conversations") {
        return json(200, await getConversationStore().readUngrouped())
    }

    if (path === "/api/ungrouped/conversations/active") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const raw = parseJson(request)["id"]
        if (raw !== null && raw !== undefined && typeof raw !== "string") {
            return json(400, { error: "会话 id 不合法" })
        }
        const activeId = await getConversationStore().setUngroupedActive(
            typeof raw === "string" ? raw : null,
        )
        return json(200, { activeId })
    }

    if (path.startsWith("/api/ungrouped/conversations/")) {
        const rest = path.slice("/api/ungrouped/conversations/".length)
        const slash = rest.indexOf("/")
        const idPart = slash === -1 ? rest : rest.slice(0, slash)
        const tail = slash === -1 ? "" : rest.slice(slash + 1)
        let conversationId = ""
        try {
            conversationId = decodeURIComponent(idPart)
        } catch {
            return json(400, { error: "会话 id 不合法" })
        }
        if (!CONVERSATION_ID.test(conversationId)) {
            return json(400, { error: "会话 id 不合法" })
        }
        const store = getConversationStore()
        if (tail === "messages") {
            if (method !== "GET") {
                return methodNotAllowed(["GET"])
            }
            const page = await store.readUngroupedMessagePage(
                conversationId,
                pageBefore(url),
                pageLimit(url),
            )
            if (page === null) {
                return json(404, { error: "会话不存在" })
            }
            return json(200, page)
        }
        if (tail !== "") {
            return json(404, { error: "Not Found" })
        }
        if (method === "PUT") {
            const guarded = guardWrite(request)
            if (guarded !== null) {
                return guarded
            }
            const body = parseJson(request)
            if (body["id"] !== conversationId) {
                return json(400, { error: "会话 id 不一致" })
            }
            const result = await store.upsertUngroupedConversation(body)
            if (result === null) {
                return json(400, { error: "会话数据不合法" })
            }
            if ("conflict" in result) {
                return json(409, {
                    error: "会话已被其他窗口更新",
                    conversation: result.conflict,
                })
            }
            return json(200, {
                ok: true,
                conversation: {
                    id: result.conversation.id,
                    title: result.conversation.title,
                    updatedAt: result.conversation.updatedAt,
                    messageCount: result.conversation.messages.length,
                    workspaceRoot: result.conversation.workspaceRoot,
                },
                trimmed: result.trimmed,
            })
        }
        if (method === "DELETE") {
            const guarded = guardWrite(request)
            if (guarded !== null) {
                return guarded
            }
            const removed = await store.deleteUngroupedConversation(conversationId)
            return json(200, { ok: true, removed })
        }
        return methodNotAllowed(["PUT", "DELETE"])
    }

    const resolveChatCwd = async (parsed: ChatInput): Promise<{ cwd: string } | HttpResponse> => {
        if (parsed.workspaceId !== undefined) {
            const workspace = await resolveWorkspace(parsed.workspaceId)
            if (workspace === null) {
                return json(404, { error: "工作区不存在" })
            }
            return { cwd: workspace.root }
        }
        if (parsed.workspaceRoot !== undefined) {
            const check = await currentApi.agent.validateWorkspace(parsed.workspaceRoot)
            if (!check.ok) {
                return json(400, { error: `工作区目录不可用：${check.error ?? "目录不存在"}` })
            }
            return { cwd: check.root }
        }
        return json(400, { error: "缺少工作区" })
    }

    if (method === "GET" && path === "/api/plugins") {
        return json(200, await getApi().plugins.list())
    }

    if (method === "POST" && path.startsWith("/api/plugins/")) {
        const guarded = guardWrite(
            request,
            path === "/api/plugins/install" ? MAX_PLUGIN_INSTALL_BODY_BYTES : MAX_API_BODY_BYTES,
        )
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        if (path === "/api/plugins/install") {
            const filename = typeof body["filename"] === "string" ? body["filename"].trim() : ""
            const dataBase64 = typeof body["dataBase64"] === "string" ? body["dataBase64"] : ""
            if (filename === "" || dataBase64 === "") {
                return json(400, { error: "需要 filename 与 dataBase64" })
            }
            if (!/\.zip$/i.test(filename)) {
                return json(400, { error: "只支持 .zip 插件包" })
            }
            if (Math.floor((dataBase64.length * 3) / 4) > MAX_PLUGIN_ARCHIVE_BYTES) {
                return json(413, { error: "插件包超过 10MB" })
            }
            const result = await getApi().plugins.install({
                filename,
                dataBase64,
                force: body["force"] === true,
            })
            return json(result.ok ? 200 : 400, result)
        }
        const id = typeof body["id"] === "string" ? body["id"].trim() : ""
        if (id === "") {
            return json(400, { error: "缺少插件 id" })
        }
        if (path === "/api/plugins/remove") {
            const result = await getApi().plugins.remove(id)
            return json(result.ok ? 200 : 400, result)
        }
        if (path === "/api/plugins/enable") {
            const result = await getApi().plugins.enable(id)
            return json(result.ok ? 200 : 400, result)
        }
        if (path === "/api/plugins/disable") {
            const result = await getApi().plugins.disable(id)
            return json(result.ok ? 200 : 400, result)
        }
        return json(404, { error: "Not Found" })
    }

    if (method === "POST" && path === "/api/chat") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const parsed = readChatInput(request)
        if (!("message" in parsed)) {
            return parsed
        }
        const resolved = await resolveChatCwd(parsed)
        if (!("cwd" in resolved)) {
            return resolved
        }
        try {
            const result = await currentApi.agent.chat({
                message: parsed.message,
                sessionId: parsed.sessionId,
                cwd: resolved.cwd,
                references: parsed.references,
                permission: parsed.permission,
                ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
                ...(parsed.model === undefined ? {} : { model: parsed.model }),
                ...(parsed.reasoning === undefined ? {} : { reasoning: parsed.reasoning }),
            })
            return json(200, result)
        } catch (error) {
            return json(500, { error: chatErrorMessage(error) })
        }
    }

    if (method === "POST" && path === "/api/chat/stream") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const parsed = readChatInput(request)
        if (!("message" in parsed)) {
            return parsed
        }
        const resolved = await resolveChatCwd(parsed)
        if (!("cwd" in resolved)) {
            return resolved
        }
        return streamChat(parsed, resolved.cwd, stream)
    }

    // 向正在跑的一轮插话
    if (method === "POST" && path === "/api/chat/interject") {
        return await interjectChat(request)
    }

    // 停止正在跑的一轮：标记会话停止，循环在下一步前收尾
    if (method === "POST" && path === "/api/chat/stop") {
        return await stopChat(request)
    }

    // 正在跑的会话列表：侧栏据此给会话与工作区加「运行中」提示
    if (method === "GET" && path === "/api/chat/running") {
        pruneChatTurns()
        const running: Array<{ conversationId: string; workspaceId: string | null }> = []
        for (const [conversationId, turn] of chatTurns) {
            if (turn.done) continue
            running.push({ conversationId, workspaceId: turn.workspaceId })
        }
        return json(200, { running })
    }

    // 刷新/断线后重连续接正在进行的回复
    if (method === "GET" && path === "/api/chat/resume") {
        const conversationId = url.searchParams.get("conversationId") ?? ""
        if (!CONVERSATION_ID.test(conversationId)) {
            return json(400, { error: "会话 id 不合法" })
        }
        const sinceRaw = Number(url.searchParams.get("since") ?? "0")
        return resumeChat(
            conversationId,
            {
                since: Number.isFinite(sinceRaw) ? Math.floor(sinceRaw) : 0,
                peek: url.searchParams.get("peek") === "1",
            },
            stream,
        )
    }

    if (path.startsWith("/api/")) {
        return json(404, { error: "Not Found" })
    }
    return text(404, "Not Found")
}

export async function onHttpRequest(
    request: HttpRequest,
    stream: HttpStreamContext,
): Promise<HttpResponse> {
    try {
        return await route(request, stream)
    } catch (error) {
        getApi().logger.error({ error: errorMessage(error) }, "网页请求处理失败")
        return json(500, { error: "服务器内部错误" })
    }
}

onInit(async () => {
    const currentApi = getApi()
    const host =
        typeof currentApi.pluginConfig["host"] === "string"
            ? currentApi.pluginConfig["host"]
            : "127.0.0.1"
    const rawPort = currentApi.pluginConfig["port"]
    const port =
        typeof rawPort === "number" &&
        Number.isInteger(rawPort) &&
        rawPort >= 0 &&
        rawPort <= 65_535
            ? rawPort
            : 8787
    server = await registerHttpServer(
        eventBus,
        { name: "wellspring-web", host, port },
        onHttpRequest,
    )
    currentApi.output.info(`wellspring-web listening on http://${server.host}:${server.port}`)
})

onShutdown(async () => {
    for (const cleanup of [...addonStreams]) {
        cleanup()
    }
    addonStreams.clear()
    await server?.close()
    server = null
})
