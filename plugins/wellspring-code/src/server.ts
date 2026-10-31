/*
 * 插件 HTTP 服务：页面、静态资源与工作区 API。
 * 所有响应都带安全响应头；HTML 不含内联脚本/样式，因此 CSP 不需要 unsafe-*。
 */

import { createHash } from "node:crypto"
import { isAbsolute, resolve } from "node:path"

import {
    EventEntity,
    eventBus,
    getHost,
    onInit,
    onShutdown,
} from "wellspring/api/host/index.ts"
import type {
    HostFileStat,
    HttpRequest,
    HttpResponse,
    HostOSInfo,
    PluginApi,
} from "wellspring/api/host/index.ts"
import type { HttpServerBusHandle } from "wellspring/api/plugin/http-client.ts"
import { registerHttpServer } from "wellspring/api/plugin/http-client.ts"

import { STATIC_ASSETS } from "./assets/index.ts"
import { CodeAuthStore, LoginThrottle, MAX_PASSWORD_CHARS, MIN_PASSWORD_CHARS } from "./auth.ts"
import { readGitDiff, readGitStatus, stageGitPaths, unstageGitPaths } from "./git.ts"
import { kindOf } from "./kinds.ts"
import {
    isLoopbackAddress,
    isLoopbackHost,
    resolveListenConfig,
    type ListenConfig,
} from "./listen.ts"
import { renderHome } from "./pages.ts"
import {
    commandHistory,
    pollCommand,
    shutdownTerminals,
    startCommand,
    stopCommand,
} from "./terminal.ts"
import {
    closeConsole,
    consoleAvailable,
    consoleBackend,
    consoleUnavailableReason,
    listConsoles,
    openConsole,
    pollConsole,
    resizeConsole,
    shutdownConsoles,
    writeConsole,
} from "./console.ts"
import {
    MAX_STAT_PATHS,
    WorkspaceError,
    WorkspaceService,
    detectIndent,
    nameOf,
    normalizePath,
    workspaceNameOf,
} from "./workspace.ts"

const MAX_API_BODY_BYTES = 4 * 1024 * 1024
const MAX_QUICK_OPEN_QUERY = 200
const MAX_STAT_QUERY_CHARS = 8000

const CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
].join("; ")

/** 插件自己的工作区；root 是用户可以任意选择的绝对目录 */
export interface WorkspaceDescriptor {
    readonly id: string
    readonly name: string
    readonly root: string
    readonly accessible: boolean
    readonly reason: string | null
    readonly lastSeenAt: number
    readonly source: "plugin"
}

interface StoredWorkspace {
    readonly id: string
    name: string
    readonly root: string
    readonly createdAt: number
    lastSeenAt: number
}

interface WorkspaceStore {
    activeId: string | null
    readonly workspaces: StoredWorkspace[]
}

interface WorkspaceCatalog {
    readonly entries: readonly WorkspaceDescriptor[]
    readonly error: string | null
}

const WORKSPACE_STORE = "workspaces.json"
const MAX_WORKSPACE_NAME = 120

let api: PluginApi | null = null
/** 由 wellspring-http 插件托管的服务器句柄（本插件不再直接持有 hostApi.http） */
let server: HttpServerBusHandle | null = null
let authStore: CodeAuthStore | null = null
const loginThrottle = new LoginThrottle()
let workspace: WorkspaceService | null = null
let activeWorkspace: WorkspaceDescriptor | null = null
let hostRoot = ""
let readOnly = false
let workspaceStore: WorkspaceStore = { activeId: null, workspaces: [] }
/** 按工作区 id 缓存文件服务；切换工作区不重建宿主连接 */
const workspaceCache = new Map<string, WorkspaceService>()

export async function configureServer(value: PluginApi): Promise<void> {
    api = value
    const store = new CodeAuthStore(value.fs)
    await store.load()
    authStore = store
    readOnly = value.pluginConfig["readOnly"] === true
    hostRoot = resolveRoot(value)
    await loadWorkspaceStore()
    /*
     * 首次启动没有工作区时，把服务进程当前目录作为默认工作区写进插件自己的
     * workspaces.json；之后完全由插件管理，不再读宿主工作区注册表。
     */
    if (workspaceStore.workspaces.length === 0) {
        try {
            await addWorkspaceRecord(hostRoot, workspaceNameOf(hostRoot))
        } catch {
            /* 目录不可访问时留空；用户可以在「添加工作区」里重新选择 */
        }
    }
    await ensureActiveWorkspace()
}

function resolveRoot(value: PluginApi): string {
    try {
        return getHost().getOS().cwd
    } catch {
        return value.paths.dataDir
    }
}

function getApi(): PluginApi {
    if (api === null) {
        throw new Error("wellspring-code 尚未初始化")
    }
    return api
}

function getAuth(): CodeAuthStore {
    if (authStore === null) {
        throw new Error("wellspring-code 认证尚未初始化")
    }
    return authStore
}

function clientKey(request: HttpRequest): string {
    return request.remoteAddress ?? "unknown"
}

interface RequestAuthState {
    readonly configured: boolean
    readonly authenticated: boolean
    readonly loopback: boolean
}

function requestAuthState(request: HttpRequest): RequestAuthState {
    const store = getAuth()
    return {
        configured: store.configured,
        authenticated: store.configured && store.authenticated(request),
        loopback: isLoopbackAddress(request.remoteAddress),
    }
}

function getWorkspace(): WorkspaceService {
    if (workspace === null) {
        throw new Error("wellspring-code 工作区尚未初始化")
    }
    return workspace
}

function getActiveWorkspace(): WorkspaceDescriptor {
    if (activeWorkspace === null) {
        throw new Error("wellspring-code 还没有选中工作区")
    }
    return activeWorkspace
}

function workspaceIdOf(root: string): string {
    return createHash("sha256").update(root).digest("hex").slice(0, 16)
}

function normalizeWorkspaceName(value: unknown, fallback: string): string {
    const text = typeof value === "string" ? value.trim() : ""
    const name = text === "" ? fallback : text
    return name.slice(0, MAX_WORKSPACE_NAME)
}

function normalizeStoredWorkspace(value: unknown): StoredWorkspace | null {
    if (value === null || typeof value !== "object") return null
    const record = value as Record<string, unknown>
    const root = typeof record["root"] === "string" ? record["root"].trim() : ""
    if (root === "" || !isAbsolute(root)) return null
    const absolute = resolve(root)
    const createdAt =
        typeof record["createdAt"] === "number" && Number.isFinite(record["createdAt"])
            ? record["createdAt"]
            : Date.now()
    const lastSeenAt =
        typeof record["lastSeenAt"] === "number" && Number.isFinite(record["lastSeenAt"])
            ? record["lastSeenAt"]
            : createdAt
    return {
        id: workspaceIdOf(absolute),
        name: normalizeWorkspaceName(record["name"], workspaceNameOf(absolute)),
        root: absolute,
        createdAt,
        lastSeenAt,
    }
}

async function loadWorkspaceStore(): Promise<void> {
    const raw = await getApi().fs.readJson<unknown>(WORKSPACE_STORE).catch(() => null)
    const source = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
    const list = Array.isArray(source["workspaces"]) ? source["workspaces"] : []
    const workspaces: StoredWorkspace[] = []
    const seen = new Set<string>()
    for (const item of list) {
        const record = normalizeStoredWorkspace(item)
        if (record === null || seen.has(record.id)) continue
        workspaces.push(record)
        seen.add(record.id)
    }
    const activeId =
        typeof source["activeId"] === "string" && workspaces.some((w) => w.id === source["activeId"])
            ? source["activeId"]
            : (workspaces[0]?.id ?? null)
    workspaceStore = { activeId, workspaces }
}

async function saveWorkspaceStore(): Promise<void> {
    await getApi().fs.writeJson(WORKSPACE_STORE, workspaceStore)
}

function descriptorOf(record: StoredWorkspace): WorkspaceDescriptor {
    return {
        id: record.id,
        name: record.name,
        root: record.root,
        accessible: true,
        reason: null,
        lastSeenAt: record.lastSeenAt,
        source: "plugin",
    }
}

/** 插件自己的目录列表；不读宿主工作区注册表，也不再依赖 wellspring-web */
async function readWorkspaceCatalog(): Promise<WorkspaceCatalog> {
    return { entries: workspaceStore.workspaces.map(descriptorOf), error: null }
}

async function workspaceServiceFor(record: StoredWorkspace): Promise<WorkspaceService> {
    const cached = workspaceCache.get(record.id)
    if (cached !== undefined) {
        return cached
    }
    const fs = await getApi().fileRoots.open(record.root)
    const service = new WorkspaceService(fs)
    workspaceCache.set(record.id, service)
    return service
}

async function applyWorkspace(record: StoredWorkspace): Promise<void> {
    const service = await workspaceServiceFor(record)
    workspace = service
    activeWorkspace = descriptorOf(record)
    workspaceStore.activeId = record.id
    await saveWorkspaceStore()
}

function findWorkspaceRecord(id: string): StoredWorkspace | null {
    return workspaceStore.workspaces.find((item) => item.id === id) ?? null
}

/**
 * 解析请求指定的工作区：优先使用 x-workspace-id 请求头，缺省回退到当前工作区。
 * 多个浏览器窗口可以各自停留在不同工作区，不会互相覆盖。
 */
async function resolveWorkspaceEntry(request: HttpRequest): Promise<WorkspaceDescriptor> {
    const requestedId = request.headers["x-workspace-id"]
    if (requestedId === undefined || requestedId === "") {
        await ensureActiveWorkspace()
        return getActiveWorkspace()
    }
    const record = findWorkspaceRecord(requestedId)
    if (record === null) {
        throw new WorkspaceError(404, "工作区不存在")
    }
    return descriptorOf(record)
}

async function requestWorkspace(request: HttpRequest): Promise<WorkspaceService> {
    const entry = await resolveWorkspaceEntry(request)
    const record = findWorkspaceRecord(entry.id)
    if (record === null) {
        throw new WorkspaceError(404, "工作区不存在")
    }
    return await workspaceServiceFor(record)
}

async function ensureActiveWorkspace(): Promise<void> {
    if (workspace !== null) {
        return
    }
    const record =
        (workspaceStore.activeId === null ? null : findWorkspaceRecord(workspaceStore.activeId)) ??
        workspaceStore.workspaces[0] ??
        null
    if (record === null) {
        activeWorkspace = null
        workspace = null
        return
    }
    await applyWorkspace(record)
}

/** 添加工作区：root 必须是已存在的目录；重复目录只刷新 lastSeenAt */
async function addWorkspaceRecord(root: string, name?: string): Promise<StoredWorkspace> {
    const fs = await getApi().fileRoots.open(root)
    const absolute = fs.root
    const existing = workspaceStore.workspaces.find((item) => item.root === absolute)
    if (existing !== undefined) {
        existing.lastSeenAt = Date.now()
        existing.name = normalizeWorkspaceName(name, existing.name)
        workspaceCache.set(existing.id, new WorkspaceService(fs))
        workspaceStore.activeId = existing.id
        await saveWorkspaceStore()
        return existing
    }
    const now = Date.now()
    const record: StoredWorkspace = {
        id: workspaceIdOf(absolute),
        name: normalizeWorkspaceName(name, workspaceNameOf(absolute)),
        root: absolute,
        createdAt: now,
        lastSeenAt: now,
    }
    workspaceStore.workspaces.push(record)
    workspaceStore.activeId = record.id
    workspaceCache.set(record.id, new WorkspaceService(fs))
    await saveWorkspaceStore()
    return record
}

async function removeWorkspaceRecord(id: string): Promise<boolean> {
    const index = workspaceStore.workspaces.findIndex((item) => item.id === id)
    if (index === -1) return false
    workspaceStore.workspaces.splice(index, 1)
    workspaceCache.delete(id)
    if (workspaceStore.activeId === id) {
        workspaceStore.activeId = workspaceStore.workspaces[0]?.id ?? null
    }
    await saveWorkspaceStore()
    if (activeWorkspace?.id === id) {
        workspace = null
        activeWorkspace = null
        await ensureActiveWorkspace()
    }
    return true
}

function workspaceView(entry: WorkspaceDescriptor, activeId: string): Record<string, unknown> {
    return {
        id: entry.id,
        name: entry.name,
        root: entry.root,
        relativeRoot: "",
        accessible: entry.accessible,
        reason: entry.reason,
        conversationCount: 0,
        lastSeenAt: entry.lastSeenAt,
        source: entry.source,
        active: entry.id === activeId,
    }
}

async function workspaceCatalogResponse(request: HttpRequest): Promise<HttpResponse> {
    const current = await resolveWorkspaceEntry(request)
    const catalog = await readWorkspaceCatalog()
    return json(200, {
        workspaces: catalog.entries.map((entry) => workspaceView(entry, current.id)),
        active: workspaceView(current, current.id),
        hostRoot,
        error: catalog.error,
    })
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
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

/** 写接口的统一前置校验，返回响应表示拒绝 */
function guardWrite(
    request: HttpRequest,
    requireJson = true,
    allowWhenReadOnly = false,
): HttpResponse | null {
    if (readOnly && !allowWhenReadOnly) {
        return json(403, { error: "插件以只读模式运行" })
    }
    if (!isSameOrigin(request)) {
        return json(403, { error: "跨站请求已被拒绝" })
    }
    if (bodySize(request) > MAX_API_BODY_BYTES) {
        return json(413, { error: "请求体过大" })
    }
    if (requireJson && !isJsonRequest(request)) {
        return json(415, { error: "需要 application/json 请求体" })
    }
    return null
}

function readString(value: unknown): string {
    return typeof value === "string" ? value : ""
}

/**
 * 终端工作目录：默认活动工作区根，显式传入时必须在根内。
 * 只允许相对路径，避免把命令跑到根目录之外。
 */
function terminalCwd(value: unknown): string {
    const root = activeWorkspace?.root ?? hostRoot
    const relative = readString(value).trim()
    if (relative === "") return root
    const normalized = normalizePath(relative)
    if (normalized === "" || normalized.startsWith("..")) {
        throw new WorkspaceError(400, "工作目录超出工作区")
    }
    return root.endsWith("/") ? root + normalized : root + "/" + normalized
}

function readBaseMtime(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function baseMtimeOf(stat: HostFileStat): number {
    return Math.round(stat.mtimeMs)
}

/* ── 路由 ─────────────────────────────────────────────────── */

const ALLOWED_METHODS: Readonly<Record<string, readonly string[]>> = {
    "/": ["GET"],
    "/index.html": ["GET"],
    "/favicon.svg": ["GET"],
    "/assets/app.css": ["GET"],
    "/assets/app.js": ["GET"],
    "/api/auth/state": ["GET"],
    "/api/auth/login": ["POST"],
    "/api/auth/logout": ["POST"],
    "/api/auth/password": ["POST"],
    "/api/state": ["GET"],
    "/api/workspaces": ["GET"],
    "/api/workspace": ["POST"],
    "/api/host": ["GET"],
    "/api/tree": ["GET"],
    "/api/symbols": ["GET"],
    "/api/git/status": ["GET"],
    "/api/git/diff": ["GET"],
    "/api/git/stage": ["POST"],
    "/api/git/unstage": ["POST"],
    "/api/file": ["GET", "POST", "PUT", "DELETE"],
    "/api/raw": ["GET"],
    "/api/term/history": ["GET"],
    "/api/term/run": ["POST"],
    "/api/term/poll": ["GET"],
    "/api/term/stop": ["POST"],
    "/api/console/state": ["GET"],
    "/api/console/list": ["GET"],
    "/api/console/open": ["POST"],
    "/api/console/poll": ["GET"],
    "/api/console/input": ["POST"],
    "/api/console/resize": ["POST"],
    "/api/console/close": ["POST"],
    "/api/stat": ["GET"],
    "/api/rename": ["POST"],
    "/api/search/files": ["GET"],
    "/api/search/text": ["GET"],
}

function hostSnapshot(): HttpResponse {
    const current = getApi()
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
                status: plugin.getStatus(),
            })),
            pluginVersion: current.plugin.version,
            apiVersion: current.apiVersion,
        })
    } catch (error) {
        return json(501, { error: errorText(error) })
    }
}

async function readBranchName(service: WorkspaceService): Promise<string> {
    try {
        const head = await service.readTextAtRoot(".git/HEAD")
        if (head === null) {
            return ""
        }
        const trimmed = head.trim()
        const prefix = "ref: refs/heads/"
        if (trimmed.startsWith(prefix)) {
            return trimmed.slice(prefix.length)
        }
        return trimmed.slice(0, 8)
    } catch {
        return ""
    }
}

function osInfo(): {
    readonly platform: string
    readonly arch: string
    readonly node: string
    readonly status: string
} {
    try {
        const host = getHost()
        const os: HostOSInfo = host.getOS()
        return {
            platform: os.platform,
            arch: os.arch,
            node: os.node,
            status: host.getStatus(),
        }
    } catch {
        return { platform: "", arch: "", node: process.version, status: "" }
    }
}

async function route(request: HttpRequest): Promise<HttpResponse> {
    const method = request.method.toUpperCase()
    const url = new URL(request.url, "http://localhost")
    const path = url.pathname

    const allowed = ALLOWED_METHODS[path]
    if (allowed !== undefined && !allowed.includes(method)) {
        return methodNotAllowed(allowed)
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
        const auth = requestAuthState(request)
        const state =
            auth.configured && !auth.authenticated
                ? "login"
                : !auth.configured && !auth.loopback
                  ? "blocked"
                  : "none"
        return {
            status: 200,
            headers: {
                ...baseHeaders(),
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                vary: "cookie",
            },
            body: renderHome({ state, configured: auth.configured }),
        }
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

    const store = getAuth()
    if (method === "GET" && path === "/api/auth/state") {
        const authenticated = store.configured && store.authenticated(request)
        return json(200, {
            configured: store.configured,
            authenticated,
            loopback: isLoopbackAddress(request.remoteAddress),
            tls: store.secure,
        })
    }

    if (method === "POST" && path === "/api/auth/login") {
        const guarded = guardWrite(request, true, true)
        if (guarded !== null) {
            return guarded
        }
        if (!store.configured) {
            return json(409, { error: "还没有设置访问密码" })
        }
        const key = `login:${clientKey(request)}`
        const limited = loginThrottle.status(key)
        if (limited.blocked) {
            return json(
                429,
                {
                    error: `尝试过于频繁，请 ${limited.retryAfter} 秒后重试`,
                    retryAfter: limited.retryAfter,
                },
                { "retry-after": String(limited.retryAfter) },
            )
        }
        const password = readString(parseJson(request)["password"])
        if (!store.verifyPassword(password)) {
            loginThrottle.recordFailure(key)
            return json(401, { error: "密码不正确" })
        }
        loginThrottle.reset(key)
        const session = store.createSession()
        return json(200, { ok: true }, { "set-cookie": store.cookie(session) })
    }

    if (method === "POST" && path === "/api/auth/logout") {
        const guarded = guardWrite(request, true, true)
        if (guarded !== null) {
            return guarded
        }
        store.logout(request)
        return json(200, { ok: true }, { "set-cookie": store.clearCookie() })
    }

    if (method === "POST" && path === "/api/auth/password") {
        const guarded = guardWrite(request, true, true)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const newPassword = readString(body["newPassword"])
        const currentPassword = readString(body["currentPassword"])
        if (newPassword.length < MIN_PASSWORD_CHARS || newPassword.length > MAX_PASSWORD_CHARS) {
            return json(400, {
                error: `密码长度需要在 ${MIN_PASSWORD_CHARS}-${MAX_PASSWORD_CHARS} 位之间`,
            })
        }
        if (store.configured) {
            if (!store.authenticated(request)) {
                return json(401, { error: "未登录" })
            }
            if (!store.verifyPassword(currentPassword)) {
                return json(403, { error: "当前密码不正确" })
            }
        } else if (!isLoopbackAddress(request.remoteAddress)) {
            // 远程请求在没设密码时会被下面的守卫拒绝，这里再兜一次
            return json(403, { error: "首次设置访问密码需要在服务器本机进行" })
        }
        await store.setPassword(newPassword)
        store.clearSessions()
        const session = store.createSession()
        loginThrottle.reset(`login:${clientKey(request)}`)
        return json(200, { ok: true, configured: true }, { "set-cookie": store.cookie(session) })
    }

    // 没设密码时只允许本机访问：0.0.0.0 上首次设密码要通过本机完成
    if (!store.configured && !isLoopbackAddress(request.remoteAddress)) {
        return json(403, { error: "远程访问未启用：请先在服务器本机设置访问密码" })
    }
    // 设了密码后，除认证接口外的所有 API 都要求登录
    if (store.configured && path.startsWith("/api/") && !store.authenticated(request)) {
        return json(401, { error: "未登录" })
    }

    let requestService: Promise<WorkspaceService> | null = null
    const serviceForRequest = (): Promise<WorkspaceService> => {
        if (requestService === null) {
            requestService = requestWorkspace(request)
        }
        return requestService
    }

    if (method === "GET" && path === "/api/state") {
        const active = await resolveWorkspaceEntry(request)
        return json(200, {
            ok: true,
            root: active.root,
            name: active.name,
            workspaceId: active.id,
            workspaceSource: active.source,
            workspaceCount: workspaceStore.workspaces.length,
            hostRoot,
            version: getApi().plugin.version,
            apiVersion: getApi().apiVersion,
            readOnly,
            branch: await readBranchName(await serviceForRequest()),
            host: osInfo(),
        })
    }

    if (method === "GET" && path === "/api/workspaces") {
        return await workspaceCatalogResponse(request)
    }

    if (method === "POST" && path === "/api/workspaces/add") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        let root = readString(body["root"]).trim()
        let name = readString(body["name"])
        if (root === "") {
            const picked = await getApi().agent.pickDirectory()
            if (!picked.ok) {
                return json(400, { error: picked.error ?? "没有选择文件夹" })
            }
            root = picked.root
            name = name === "" ? picked.name : name
        }
        if (!isAbsolute(root)) {
            return json(400, { error: "工作区必须是绝对路径" })
        }
        try {
            const record = await addWorkspaceRecord(root, name)
            await applyWorkspace(record)
        } catch (error) {
            return json(400, { error: errorText(error) })
        }
        const refreshed = await readWorkspaceCatalog()
        return json(200, {
            ok: true,
            active: workspaceView(getActiveWorkspace(), workspaceStore.activeId ?? ""),
            workspaces: refreshed.entries.map((entry) =>
                workspaceView(entry, workspaceStore.activeId ?? ""),
            ),
            hostRoot,
            error: refreshed.error,
        })
    }

    if (method === "POST" && path === "/api/workspaces/remove") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const id = readString(body["id"])
        if (id === "") {
            return json(400, { error: "缺少工作区 id" })
        }
        if (workspaceStore.workspaces.length <= 1) {
            return json(400, { error: "至少保留一个工作区" })
        }
        const removed = await removeWorkspaceRecord(id)
        if (!removed) {
            return json(404, { error: "工作区不存在" })
        }
        await ensureActiveWorkspace()
        const current = getActiveWorkspace()
        const refreshed = await readWorkspaceCatalog()
        return json(200, {
            ok: true,
            active: workspaceView(current, current.id),
            workspaces: refreshed.entries.map((entry) => workspaceView(entry, current.id)),
            hostRoot,
            error: refreshed.error,
        })
    }

    if (method === "POST" && path === "/api/workspace") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const id = readString(body["id"])
        const root = readString(body["root"])
        const target =
            id !== ""
                ? findWorkspaceRecord(id)
                : workspaceStore.workspaces.find((record) => record.root === resolve(root)) ?? null
        if (target === null) {
            return json(404, { error: id !== "" ? "工作区不存在" : "缺少工作区 id" })
        }
        await applyWorkspace(target)
        const refreshed = await readWorkspaceCatalog()
        return json(200, {
            ok: true,
            active: workspaceView(descriptorOf(target), target.id),
            workspaces: refreshed.entries.map((entry) => workspaceView(entry, target.id)),
            hostRoot,
            error: refreshed.error,
        })
    }

    if (method === "GET" && path === "/api/host") {
        return hostSnapshot()
    }

    if (method === "GET" && path === "/api/tree") {
        const target = url.searchParams.get("path") ?? ""
        const entries = await (await serviceForRequest()).list(target)
        return json(200, {
            path: normalizePath(target),
            entries: entries.map((entry) => {
                if (entry.type === "directory") {
                    return {
                        ...entry,
                        badge: "DIR",
                        tone: "plain",
                        language: "plaintext",
                        label: "文件夹",
                    }
                }
                const kind = kindOf(entry.path)
                return {
                    ...entry,
                    badge: kind.badge,
                    tone: kind.tone,
                    language: kind.language,
                    label: kind.label,
                }
            }),
        })
    }

    if (method === "GET" && path === "/api/symbols") {
        const query = (url.searchParams.get("q") ?? "").slice(0, 100)
        const limitRaw = Number(url.searchParams.get("limit") ?? "60")
        const limit = Number.isInteger(limitRaw) ? limitRaw : 60
        const result = await (await serviceForRequest()).searchSymbols(query, limit)
        return json(200, { query, ...result })
    }

    if (method === "GET" && path === "/api/git/status") {
        const entry = await resolveWorkspaceEntry(request)
        try {
            return json(200, await readGitStatus(getApi(), entry.root))
        } catch (error) {
            return json(503, {
                available: false,
                repo: false,
                root: "",
                branch: "",
                ahead: 0,
                behind: 0,
                changes: [],
                truncated: false,
                error: `Git 不可用：${errorText(error)}`,
            })
        }
    }

    if (method === "GET" && path === "/api/git/diff") {
        const entry = await resolveWorkspaceEntry(request)
        const target = normalizePath(url.searchParams.get("path") ?? "")
        if (target === "") {
            return json(400, { error: "缺少文件路径" })
        }
        const staged = url.searchParams.get("staged") === "1"
        try {
            return json(200, await readGitDiff(getApi(), entry.root, target, staged))
        } catch (error) {
            return json(503, {
                available: false,
                repo: false,
                staged,
                path: target,
                content: "",
                truncated: false,
                error: `Git 不可用：${errorText(error)}`,
            })
        }
    }

    if (method === "POST" && (path === "/api/git/stage" || path === "/api/git/unstage")) {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const entry = await resolveWorkspaceEntry(request)
        const body = parseJson(request)
        const raw = body["paths"]
        if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) {
            return json(400, { ok: false, error: "paths 需要 1-500 个路径" })
        }
        const paths: string[] = []
        try {
            for (const item of raw) {
                if (typeof item !== "string") {
                    throw new WorkspaceError(400, "路径不合法")
                }
                const normalized = normalizePath(item)
                if (normalized === "") {
                    throw new WorkspaceError(400, "路径不能为空")
                }
                paths.push(normalized)
            }
        } catch (error) {
            if (error instanceof WorkspaceError) {
                return json(error.status, { ok: false, error: error.message })
            }
            throw error
        }
        try {
            const result =
                path === "/api/git/stage"
                    ? await stageGitPaths(getApi(), entry.root, paths)
                    : await unstageGitPaths(getApi(), entry.root, paths)
            return json(200, result)
        } catch (error) {
            return json(503, {
                available: false,
                repo: false,
                ok: false,
                error: `Git 不可用：${errorText(error)}`,
            })
        }
    }

    if (method === "GET" && path === "/api/file") {
        const target = url.searchParams.get("path") ?? ""
        const relative = normalizePath(target)
        const kind = kindOf(relative)
        if (relative === "") {
            return json(400, { error: "缺少文件路径" })
        }
        if (kind.media !== "text") {
            const info = await (await serviceForRequest()).statInfo(relative)
            if (!info.exists) {
                return json(404, { error: "文件不存在" })
            }
            if (info.type !== "file") {
                return json(400, { error: "不是文件" })
            }
            return json(200, {
                binary: true,
                path: relative,
                name: nameOf(relative),
                kind,
                size: info.size,
                mtimeMs: info.mtimeMs,
            })
        }
        const result = await (await serviceForRequest()).read(relative)
        return json(200, {
            binary: false,
            path: relative,
            name: nameOf(relative),
            kind,
            content: result.content,
            eol: result.eol,
            indent: detectIndent(result.content),
            size: result.stat.size,
            mtimeMs: result.stat.mtimeMs,
        })
    }

    if (method === "GET" && path === "/api/raw") {
        const target = url.searchParams.get("path") ?? ""
        const relative = normalizePath(target)
        if (relative === "") {
            return json(400, { error: "缺少文件路径" })
        }
        const result = await (await serviceForRequest()).readBytes(relative)
        const kind = kindOf(relative)
        const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline"
        return {
            status: 200,
            headers: {
                ...baseHeaders(),
                "content-type": kind.mime,
                "cache-control": "no-store",
                "content-disposition": `${disposition}; filename="${encodeURIComponent(nameOf(relative))}"`,
            },
            body: Buffer.from(result.bytes).toString("base64"),
            bodyEncoding: "base64",
        }
    }

    if (method === "GET" && path === "/api/stat") {
        const collected: string[] = []
        for (const value of url.searchParams.getAll("path")) {
            collected.push(value)
        }
        const joined = url.searchParams.get("paths")
        if (joined !== null && joined !== "") {
            if (joined.length > MAX_STAT_QUERY_CHARS) {
                return json(413, { error: "路径列表过长" })
            }
            for (const value of joined.split(",")) {
                if (value !== "") {
                    collected.push(value)
                }
            }
        }
        const unique = [...new Set(collected)].slice(0, MAX_STAT_PATHS)
        return json(200, { entries: await (await serviceForRequest()).statMany(unique) })
    }

    if (method === "POST" && path === "/api/file") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const target = readString(body["path"])
        const type = body["type"] === "directory" ? "directory" : "file"
        const entry = await (await serviceForRequest()).create(target, type)
        const createdKind = kindOf(entry.path)
        return json(201, {
            ok: true,
            entry: {
                ...entry,
                name: nameOf(entry.path),
                badge: createdKind.badge,
                tone: createdKind.tone,
                language: createdKind.language,
                label: createdKind.label,
            },
        })
    }

    if (method === "PUT" && path === "/api/file") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const target = readString(body["path"])
        const content = body["content"]
        if (typeof content !== "string") {
            return json(400, { error: "缺少文件内容" })
        }
        const result = await (
            await serviceForRequest()
        ).write(target, content, readBaseMtime(body["baseMtimeMs"]))
        return json(200, {
            ok: true,
            path: normalizePath(target),
            size: result.stat.size,
            mtimeMs: baseMtimeOf(result.stat),
        })
    }

    if (method === "DELETE" && path === "/api/file") {
        const guarded = guardWrite(request, false)
        if (guarded !== null) {
            return guarded
        }
        const target = url.searchParams.get("path") ?? ""
        await (await serviceForRequest()).remove(target)
        return json(200, { ok: true })
    }

    if (method === "POST" && path === "/api/rename") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const result = await (
            await serviceForRequest()
        ).rename(readString(body["from"]), readString(body["to"]))
        return json(200, { ok: true, from: result.from, to: result.to })
    }

    if (method === "GET" && path === "/api/search/files") {
        const query = (url.searchParams.get("q") ?? "").trim()
        if (query.length > MAX_QUICK_OPEN_QUERY) {
            return json(400, { error: "搜索词过长" })
        }
        const result = await (await serviceForRequest()).quickOpen(query)
        return json(200, {
            entries: result.entries.map((entry) => {
                const entryKind = kindOf(entry)
                return {
                    path: entry,
                    name: nameOf(entry),
                    badge: entryKind.badge,
                    tone: entryKind.tone,
                    label: entryKind.label,
                }
            }),
            total: result.total,
            truncated: result.truncated,
        })
    }

    if (method === "GET" && path === "/api/search/text") {
        const query = url.searchParams.get("q") ?? ""
        const caseSensitive = url.searchParams.get("case") === "1"
        const regex = url.searchParams.get("regex") === "1"
        const result = await (await serviceForRequest()).searchText(query, { caseSensitive, regex })
        return json(200, {
            files: result.files.map((file) => {
                const fileKind = kindOf(file.path)
                return {
                    path: file.path,
                    name: nameOf(file.path),
                    badge: fileKind.badge,
                    tone: fileKind.tone,
                    label: fileKind.label,
                    matches: file.matches,
                }
            }),
            matchCount: result.matchCount,
            scanned: result.scanned,
            totalFiles: result.totalFiles,
            truncated: result.truncated,
            elapsedMs: result.elapsedMs,
        })
    }

    if (method === "GET" && path === "/api/console/state") {
        const available = await consoleAvailable(getApi())
        return json(200, {
            available,
            backend: consoleBackend(),
            reason: available ? null : consoleUnavailableReason(),
        })
    }

    if (method === "GET" && path === "/api/console/list") {
        return json(200, { sessions: listConsoles() })
    }

    if (method === "POST" && path === "/api/console/open") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const opened = await openConsole(
            getApi(),
            terminalCwd(body["cwd"]),
            body["cols"],
            body["rows"],
        )
        return json(200, { ok: true, ...opened })
    }

    if (method === "GET" && path === "/api/console/poll") {
        const id = (url.searchParams.get("id") ?? "").trim()
        if (id === "") {
            return json(400, { error: "缺少会话 id" })
        }
        return json(200, await pollConsole(getApi(), id))
    }

    if (method === "POST" && path === "/api/console/input") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        await writeConsole(getApi(), readString(body["id"]), readString(body["data"]))
        return json(200, { ok: true })
    }

    if (method === "POST" && path === "/api/console/resize") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        await resizeConsole(getApi(), readString(body["id"]), body["cols"], body["rows"])
        return json(200, { ok: true })
    }

    if (method === "POST" && path === "/api/console/close") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        await closeConsole(getApi(), readString(body["id"]))
        return json(200, { ok: true })
    }

    if (method === "GET" && path === "/api/term/history") {
        return json(200, { history: commandHistory() })
    }

    if (method === "POST" && path === "/api/term/run") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        const started = await startCommand(
            getApi(),
            readString(body["command"]),
            terminalCwd(body["cwd"]),
        )
        return json(200, { ok: true, ...started })
    }

    if (method === "GET" && path === "/api/term/poll") {
        const id = (url.searchParams.get("id") ?? "").trim()
        if (id === "") {
            return json(400, { error: "缺少会话 id" })
        }
        return json(200, await pollCommand(getApi(), id))
    }

    if (method === "POST" && path === "/api/term/stop") {
        const guarded = guardWrite(request)
        if (guarded !== null) {
            return guarded
        }
        const body = parseJson(request)
        await stopCommand(getApi(), readString(body["id"]))
        return json(200, { ok: true })
    }

    if (path.startsWith("/api/")) {
        return json(404, { error: "Not Found" })
    }
    return text(404, "Not Found")
}

export async function onHttpRequest(request: HttpRequest): Promise<HttpResponse> {
    try {
        return await route(request)
    } catch (error) {
        if (error instanceof WorkspaceError) {
            return json(error.status, { error: error.message })
        }
        getApi().logger.error({ error: errorText(error) }, "code 请求处理失败")
        return json(500, { error: "服务器内部错误" })
    }
}

function listenConfig(): ListenConfig {
    const current = getApi()
    const config = resolveListenConfig({
        host: current.pluginConfig["host"],
        port: current.pluginConfig["port"],
        allowRemote: current.pluginConfig["allowRemote"],
        tls: current.pluginConfig["tls"],
        authConfigured: getAuth().configured,
    })
    for (const warning of config.warnings) {
        current.logger.warn({ kind: "listen-config" }, warning)
    }
    return config
}

onInit(async () => {
    const current = getApi()
    const config = listenConfig()
    const store = getAuth()
    store.setSecure(config.tls !== null)
    server = await registerHttpServer(
        eventBus,
        {
            name: "wellspring-code",
            host: config.host,
            port: config.port,
            ...(config.tls === null ? {} : { tls: config.tls }),
        },
        onHttpRequest,
    )
    hostRoot = resolveRoot(current)
    await ensureActiveWorkspace()
    const scheme = config.tls === null ? "http" : "https"
    const address = `${scheme}://${server.host}:${server.port}`
    current.output.info(`wellspring-code listening on ${address}`)
    current.output.info(`文件根目录：${hostRoot}`)
    for (const warning of config.warnings) {
        current.output.warn(warning)
    }
    current.output.info(
        store.configured
            ? `访问密码：已设置${isLoopbackHost(config.host) ? "" : "（远程访问需要登录）"}`
            : "访问密码：未设置（仅本机可访问；远程访问前先设置密码）",
    )
    // 在 wellspring-web 侧边栏底部注册「代码编辑器」入口
    const addonHost = server.host === "0.0.0.0" || server.host === "::" ? "127.0.0.1" : server.host
    eventBus.publish(
        "wellspring-web:addon:register",
        EventEntity.create({
            type: "nav-bottom",
            meta: {
                id: "wellspring-code",
                label: "代码编辑器",
                to: `${addonHost}:${server.port}`,
            },
        }),
    )
    if (activeWorkspace !== null) {
        current.output.info(`工作区：${activeWorkspace.name} · ${activeWorkspace.root}`)
    }
})

onShutdown(async () => {
    // 先结束仍在运行的终端，再关 HTTP 服务，避免命令变成孤儿进程
    if (api !== null) {
        await shutdownConsoles(api)
        await shutdownTerminals(api)
    }
    await server?.close()
    server = null
})
