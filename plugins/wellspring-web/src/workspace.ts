/*
 * 会话存储：工作区本身由宿主注册表管理（见 `api.workspaces`），
 * 这里只按工作区 id 保存会话与当前选中项：
 *
 *   <pluginDataDir>/workspaces/<id>/conversations.json      该工作区的会话与当前选中项
 *   <pluginDataDir>/ungrouped/conversations.json            未分组会话
 *
 * 工作区存在性由服务器注入的回调查询宿主注册表；工作区被移除时把会话转入「未分组」。
 */

import type { HostFileApi } from "wellspring/api/host/index.ts"

const WORKSPACES_DIR = "workspaces"
const UNGROUPED_DIR = "ungrouped"
const CONVERSATIONS_FILE = "conversations.json"
const REGISTRY_VERSION = 2
const STORE_VERSION = 1

export const MAX_CONVERSATIONS = 40
export const MAX_MESSAGES = 400
export const MAX_MESSAGE_CHARS = 32_000
export const MAX_WORKSPACE_NAME_CHARS = 60
/** 单个会话的正文总量上限（字符），超出时丢弃较早消息；保证 PUT 体积可控 */
export const MAX_CONVERSATION_TEXT_CHARS = 600_000
/** 单条消息最多保留的过程条目（思考 + 工具调用） */
export const MAX_PROCESS_ITEMS = 48
/** 单段思考文本上限 */
export const MAX_REASONING_CHARS = 24_000
/** 工具参数与结果在存储里的上限 */
export const MAX_TOOL_ARGUMENT_CHARS = 4_000
export const MAX_TOOL_RESULT_CHARS = 8_000
// 正文分页：单页条数上限
export const MESSAGE_PAGE_LIMIT = 40
// 单页正文字符预算
export const MESSAGE_PAGE_CHARS = 120_000
export const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/
export const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const REASONING_LEVELS = ["off", "low", "high", "max"] as const
const PERMISSION_VALUES = ["read-only", "workspace-write", "danger-full-access"] as const

/** 会话级设置：只接受白名单值，非法值按“跟随默认”处理 */
function normalizeProviderId(value: unknown): string | null {
    return typeof value === "string" && PROVIDER_ID.test(value) ? value : null
}

function normalizeReasoning(value: unknown): string | null {
    return typeof value === "string" && REASONING_LEVELS.includes(value as never) ? value : null
}

function normalizePermissionValue(value: unknown): string | null {
    return typeof value === "string" && PERMISSION_VALUES.includes(value as never) ? value : null
}

/** Agent 过程条目：思考链与工具调用，按发生顺序排列 */
export type StoredProcessItem =
    | {
          readonly kind: "reasoning"
          readonly text: string
          /** 出现时的正文偏移，用于和正文按顺序穿插 */
          readonly at?: number
          /** 仍在流式输出 */
          readonly running?: boolean
          /** 用户展开了这一行 */
          readonly open?: boolean
          /** 思考开始/结束的毫秒时间戳，前端据此显示「思考了 N 秒」 */
          readonly startedAt?: number
          readonly endedAt?: number
      }
    | {
          readonly kind: "tool"
          readonly id: string
          readonly name: string
          /** 出现时的正文偏移，用于和正文按顺序穿插 */
          readonly at?: number
          readonly arguments?: string
          readonly status: "running" | "ok" | "error" | "stopped"
          readonly result?: string
          readonly truncated?: boolean
          readonly open?: boolean
      }
    | {
          /** 用户在回复中途插入的消息 */
          readonly kind: "steer"
          readonly text: string
          readonly at?: number
      }

/** 一条消息的 token 用量；可选字段只在供应商报告时出现 */
export interface StoredUsage {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly cacheReadTokens?: number | null
    readonly cacheWriteTokens?: number | null
    readonly reasoningTokens?: number | null
    /** 这一轮最后一次请求的 prompt tokens：收尾时占用的上下文 */
    readonly contextTokens?: number | null
}

export interface StoredMessage {
    readonly role: "user" | "assistant"
    readonly text: string
    readonly at: number
    readonly model?: string
    readonly turn?: number
    readonly steps?: number
    readonly usage?: StoredUsage
    readonly error?: string
    readonly stopped?: boolean
    /** 页面刷新/崩溃时这一轮还没写完；重新打开后尝试续接 */
    readonly interrupted?: boolean
    readonly process?: readonly StoredProcessItem[]
}

export interface StoredConversation {
    readonly id: string
    readonly title: string
    readonly createdAt: number
    readonly updatedAt: number
    readonly serverSessionId: string | null
    /** 本会话选定的供应商；null 表示跟随宿主默认 */
    readonly provider: string | null
    /** 本会话选定的模型；null 表示跟随宿主/供应商默认 */
    readonly model: string | null
    /** 本会话的推理等级：off / low / high / max */
    readonly reasoning: string | null
    /** 本会话的 sandbox 权限 */
    readonly permission: string | null
    /** 会话所属目录；工作区被移除后仍用它继续对话 */
    readonly workspaceRoot: string | null
    readonly messages: readonly StoredMessage[]
}

interface StoredState {
    readonly v: number
    readonly activeId: string | null
    readonly conversations: readonly StoredConversation[]
}

export interface WorkspaceConversations {
    readonly activeId: string | null
    readonly conversations: readonly StoredConversation[]
}

/*
 * 列表用会话摘要：不带正文，只带总条数
 *
 * 正文整包回传会超过 wellspring-http 的转发上限 2.5MB，接口返回 502
 * 正文走 /messages 分页接口
 */
export interface ConversationSummary {
    readonly id: string
    readonly title: string
    readonly createdAt: number
    readonly updatedAt: number
    readonly serverSessionId: string | null
    readonly provider: string | null
    readonly model: string | null
    readonly reasoning: string | null
    readonly permission: string | null
    readonly workspaceRoot: string | null
    readonly messageCount: number
}

export interface WorkspaceIndex {
    readonly activeId: string | null
    readonly conversations: readonly ConversationSummary[]
}

/** 会话正文的一页：messages[0] 在正文里的下标是 from */
export interface ConversationPage {
    readonly id: string
    readonly from: number
    readonly total: number
    readonly messages: readonly StoredMessage[]
}

function dirnameOfPath(path: string): string {
    const index = path.lastIndexOf("/")
    return index === -1 ? "" : path.slice(0, index)
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value)
}

function normalizeTimestamp(value: unknown, fallback: number): number {
    if (!isFiniteNumber(value) || value < 0) {
        return fallback
    }
    return Math.floor(value)
}

export function normalizeWorkspaceName(value: unknown): string | null {
    if (typeof value !== "string") {
        return null
    }
    const name = value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    if (name === "" || name.length > MAX_WORKSPACE_NAME_CHARS) {
        return null
    }
    return name
}

/** 只保留非负整数；缺省/非法的可选字段直接丢掉，旧数据格式不变 */
function countOf(value: unknown): number | undefined {
    return isFiniteNumber(value) && value >= 0 ? Math.floor(value) : undefined
}

function normalizeUsage(value: unknown): StoredUsage | undefined {
    if (value === null || typeof value !== "object") {
        return undefined
    }
    const record = value as Record<string, unknown>
    const input = record["inputTokens"]
    const output = record["outputTokens"]
    if (!isFiniteNumber(input) && !isFiniteNumber(output)) {
        return undefined
    }
    const cacheReadTokens = countOf(record["cacheReadTokens"])
    const cacheWriteTokens = countOf(record["cacheWriteTokens"])
    const reasoningTokens = countOf(record["reasoningTokens"])
    const contextTokens = countOf(record["contextTokens"])
    return {
        inputTokens: isFiniteNumber(input) ? Math.floor(input) : null,
        outputTokens: isFiniteNumber(output) ? Math.floor(output) : null,
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        ...(contextTokens === undefined ? {} : { contextTokens }),
    }
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

function normalizeProcessItem(value: unknown): StoredProcessItem | null {
    if (value === null || typeof value !== "object") {
        return null
    }
    const record = value as Record<string, unknown>
    if (record["kind"] === "reasoning") {
        const text = record["text"]
        if (typeof text !== "string" || text === "") {
            return null
        }
        const item: {
            kind: "reasoning"
            text: string
            at?: number
            running?: boolean
            open?: boolean
            startedAt?: number
            endedAt?: number
        } = { kind: "reasoning", text: text.slice(0, MAX_REASONING_CHARS) }
        const at = normalizeProcessAt(record["at"])
        if (at !== undefined) item.at = at
        if (record["running"] === true) item.running = true
        if (record["open"] === true) item.open = true
        // 时间戳不能用「正文偏移」那套上限（1e6）校验，Date.now() 会超
        const startedAt = record["startedAt"]
        if (typeof startedAt === "number" && Number.isInteger(startedAt) && startedAt > 1_000_000) {
            item.startedAt = startedAt
        }
        const endedAt = record["endedAt"]
        if (typeof endedAt === "number" && Number.isInteger(endedAt) && endedAt > 1_000_000) {
            item.endedAt = endedAt
        }
        return item
    }
    if (record["kind"] === "steer") {
        const text = record["text"]
        if (typeof text !== "string" || text === "") {
            return null
        }
        const item: { kind: "steer"; text: string; at?: number } = {
            kind: "steer",
            text: text.slice(0, MAX_REASONING_CHARS),
        }
        const at = normalizeProcessAt(record["at"])
        if (at !== undefined) item.at = at
        return item
    }
    if (record["kind"] !== "tool") {
        return null
    }
    const name = record["name"]
    if (typeof name !== "string" || !TOOL_NAME.test(name)) {
        return null
    }
    const id = record["id"]
    const status = record["status"]
    const item: {
        kind: "tool"
        id: string
        name: string
        at?: number
        arguments?: string
        status: "running" | "ok" | "error" | "stopped"
        result?: string
        truncated?: boolean
        open?: boolean
    } = {
        kind: "tool",
        id: typeof id === "string" && id !== "" ? id.slice(0, 128) : name,
        name,
        status: status === "ok" || status === "error" || status === "stopped" ? status : "running",
    }
    const at = normalizeProcessAt(record["at"])
    if (at !== undefined) item.at = at
    if (typeof record["arguments"] === "string" && record["arguments"] !== "") {
        item.arguments = record["arguments"].slice(0, MAX_TOOL_ARGUMENT_CHARS)
    }
    if (typeof record["result"] === "string" && record["result"] !== "") {
        item.result = record["result"].slice(0, MAX_TOOL_RESULT_CHARS)
    }
    if (record["truncated"] === true) item.truncated = true
    if (record["open"] === true) item.open = true
    return item
}

function settleProcess(process: readonly StoredProcessItem[]): StoredProcessItem[] {
    return process.map((item): StoredProcessItem => {
        if (item.kind === "reasoning" && item.running === true) {
            const { running, ...rest } = item
            return rest.endedAt === undefined ? { ...rest, endedAt: Date.now() } : rest
        }
        if (item.kind === "tool" && item.status === "running") {
            return { ...item, status: "stopped" }
        }
        return item
    })
}

function normalizeProcess(value: unknown): StoredProcessItem[] {
    if (!Array.isArray(value)) {
        return []
    }
    const items: StoredProcessItem[] = []
    for (const entry of value) {
        const item = normalizeProcessItem(entry)
        if (item !== null) {
            items.push(item)
        }
        if (items.length >= MAX_PROCESS_ITEMS) break
    }
    return items
}

function normalizeProcessAt(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000
        ? value
        : undefined
}

export function normalizeMessage(value: unknown): StoredMessage | null {
    if (value === null || typeof value !== "object") {
        return null
    }
    const record = value as Record<string, unknown>
    const role = record["role"]
    const text = record["text"]
    if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
        return null
    }
    const message: {
        role: "user" | "assistant"
        text: string
        at: number
        model?: string
        turn?: number
        steps?: number
        usage?: StoredUsage
        error?: string
        stopped?: boolean
        interrupted?: boolean
        process?: readonly StoredProcessItem[]
    } = {
        role,
        text: text.slice(0, MAX_MESSAGE_CHARS),
        at: normalizeTimestamp(record["at"], Date.now()),
    }
    const model = record["model"]
    if (typeof model === "string" && model !== "" && model.length <= 64) {
        message.model = model
    }
    const turn = record["turn"]
    if (typeof turn === "number" && Number.isInteger(turn) && turn >= 0 && turn <= 1_000_000) {
        message.turn = turn
    }
    const steps = record["steps"]
    if (typeof steps === "number" && Number.isInteger(steps) && steps >= 0 && steps <= 1_000_000) {
        message.steps = steps
    }
    const usage = normalizeUsage(record["usage"])
    if (usage !== undefined) {
        message.usage = usage
    }
    if (typeof record["error"] === "string" && record["error"] !== "") {
        message.error = record["error"].slice(0, 2000)
    }
    if (record["stopped"] === true || record["streaming"] === true) {
        message.stopped = true
    }
    if (role === "assistant" && record["interrupted"] === true) {
        message.interrupted = true
    }
    if (role === "assistant") {
        const process = normalizeProcess(record["process"])
        if (process.length > 0) {
            // 已结束的消息不该保留“运行中”：浏览器中途关闭时写入的现场在这里收尾
            message.process = message.stopped === true ? settleProcess(process) : process
        }
    }
    return message
}

/** 服务端校验入口：非法字段拒绝；过长消息截断、超量消息保留最后一段 */
export function normalizeConversation(value: unknown): StoredConversation | null {
    if (value === null || typeof value !== "object") {
        return null
    }
    const record = value as Record<string, unknown>
    const id = record["id"]
    if (typeof id !== "string" || !CONVERSATION_ID.test(id)) {
        return null
    }
    const rawMessages = Array.isArray(record["messages"]) ? record["messages"] : []
    const messages: StoredMessage[] = []
    for (const item of rawMessages) {
        const message = normalizeMessage(item)
        if (message !== null) {
            messages.push(message)
        }
    }
    if (messages.length > MAX_MESSAGES) {
        messages.splice(0, messages.length - MAX_MESSAGES)
    }
    const now = Date.now()
    const titleValue = typeof record["title"] === "string" ? record["title"].trim() : ""
    const title = (titleValue === "" ? "新对话" : titleValue).slice(0, 80)
    const sessionValue = record["serverSessionId"]
    const modelValue = record["model"]
    const rootValue = record["workspaceRoot"]
    const createdAt = normalizeTimestamp(record["createdAt"], now)
    const updatedAt = Math.max(createdAt, normalizeTimestamp(record["updatedAt"], createdAt))
    return {
        id,
        title,
        createdAt,
        updatedAt,
        serverSessionId:
            typeof sessionValue === "string" && sessionValue !== "" && sessionValue.length <= 128
                ? sessionValue
                : null,
        provider: normalizeProviderId(record["provider"]),
        model:
            typeof modelValue === "string" &&
            modelValue.trim() !== "" &&
            modelValue.trim().length <= 64
                ? modelValue.trim()
                : null,
        reasoning: normalizeReasoning(record["reasoning"]),
        permission: normalizePermissionValue(record["permission"]),
        workspaceRoot:
            typeof rootValue === "string" && rootValue !== "" && rootValue.length <= 1024
                ? rootValue
                : null,
        messages,
    }
}

function normalizeConversations(value: unknown): StoredConversation[] {
    if (!Array.isArray(value)) {
        return []
    }
    const conversations: StoredConversation[] = []
    const seen = new Set<string>()
    for (const item of value) {
        const conversation = normalizeConversation(item)
        if (conversation !== null && !seen.has(conversation.id)) {
            seen.add(conversation.id)
            conversations.push(conversation)
        }
    }
    conversations.sort((left, right) => right.updatedAt - left.updatedAt)
    return conversations.slice(0, MAX_CONVERSATIONS)
}

// 会话转列表摘要
export function summarizeConversation(conversation: StoredConversation): ConversationSummary {
    return {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        serverSessionId: conversation.serverSessionId,
        provider: conversation.provider,
        model: conversation.model,
        reasoning: conversation.reasoning,
        permission: conversation.permission,
        workspaceRoot: conversation.workspaceRoot,
        messageCount: conversation.messages.length,
    }
}

function toIndex(state: WorkspaceConversations): WorkspaceIndex {
    return {
        activeId: state.activeId,
        conversations: state.conversations.map(summarizeConversation),
    }
}

/*
 * 从 end 往前切一页：条数与字符预算双限，至少 1 条
 *
 * 条数对齐前端的按轮窗口，字符预算应对超长消息
 * 单页体积保持在 wellspring-http 转发上限以内
 */
function pageStart(messages: readonly StoredMessage[], end: number, limit: number): number {
    const floor = Math.max(0, end - Math.max(1, limit))
    let from = end
    let chars = 0
    while (from > floor) {
        const message = messages[from - 1]
        if (message === undefined) {
            break
        }
        const size = messageSize(message)
        if (from < end && chars + size > MESSAGE_PAGE_CHARS) {
            break
        }
        chars += size
        from -= 1
    }
    return from
}

// 取 [from, end) 这一段正文；end 缺省到末尾
export function conversationPage(
    conversation: StoredConversation,
    before: number,
    limit: number,
): ConversationPage {
    const total = conversation.messages.length
    const rawEnd = Number.isFinite(before) ? Math.floor(before) : total
    const end = Math.min(Math.max(0, rawEnd), total)
    const cap = Math.min(Math.max(1, Math.floor(limit) || MESSAGE_PAGE_LIMIT), MAX_MESSAGES)
    const from = pageStart(conversation.messages, end, cap)
    return { id: conversation.id, from, total, messages: conversation.messages.slice(from, end) }
}

// 消息身份：role 与 at 相同即同一条
function messageKey(message: StoredMessage): string {
    return `${message.role}:${message.at}`
}

/*
 * 合并只带回一段正文的保存
 *
 * 分片加载时前端只有最近一页，from 落在服务端正文范围内就保留前缀
 * 服务端被裁剪导致对不上时按消息身份补齐
 */
function mergePartialMessages(
    existing: StoredConversation,
    incoming: StoredConversation,
    from: number,
): StoredConversation {
    if (from <= existing.messages.length) {
        return {
            ...incoming,
            messages: [...existing.messages.slice(0, from), ...incoming.messages],
        }
    }
    const seen = new Set(existing.messages.map(messageKey))
    const extra = incoming.messages.filter((message) => !seen.has(messageKey(message)))
    return { ...incoming, messages: [...existing.messages, ...extra] }
}

export interface ConflictResult {
    /** 服务端已有更新的版本 */
    readonly conflict: StoredConversation
}

function messageSize(message: StoredMessage): number {
    let size = message.text.length
    for (const item of message.process ?? []) {
        if (item.kind === "reasoning" || item.kind === "steer") {
            size += item.text.length
        } else {
            size += (item.arguments?.length ?? 0) + (item.result?.length ?? 0)
        }
    }
    return size
}

/** 按字符总量裁剪较早消息，避免单会话 PUT 体积失控 */
function trimConversation(conversation: StoredConversation): {
    readonly conversation: StoredConversation
    readonly trimmed: boolean
} {
    let total = 0
    let trimmed = false
    const messages: StoredMessage[] = []
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
        const message = conversation.messages[index]
        if (message === undefined) {
            continue
        }
        const size = messageSize(message)
        if (total + size > MAX_CONVERSATION_TEXT_CHARS) {
            trimmed = true
            continue
        }
        total += size
        messages.unshift(message)
    }
    if (!trimmed && messages.length === conversation.messages.length) {
        return { conversation, trimmed: false }
    }
    return { conversation: { ...conversation, messages }, trimmed: true }
}

export interface UpsertResult {
    readonly conversation: StoredConversation
    readonly trimmed: boolean
    /** 该工作区当前会话总数（供响应里装饰 conversationCount） */
    readonly count: number
}

/**
 * 工作区内的会话读写。工作区本身由宿主注册表管理：
 * 服务器注入 exists / rootOf 两个回调，这里只按 id 存 `workspaces/<id>/conversations.json`。
 * 所有写操作串行执行，避免读改写竞争。
 */
export class ConversationStore {
    readonly #fs: HostFileApi
    readonly #exists: (id: string) => boolean
    readonly #rootOf: (id: string) => string | null
    readonly #now: () => number
    #queue: Promise<unknown> = Promise.resolve()

    constructor(
        fs: HostFileApi,
        exists: (id: string) => boolean,
        rootOf: (id: string) => string | null,
        now: () => number = Date.now,
    ) {
        this.#fs = fs
        this.#exists = exists
        this.#rootOf = rootOf
        this.#now = now
    }

    /** 兼容旧的初始化调用；会话文件按需读取 */
    async load(): Promise<void> {}

    async countFor(id: string): Promise<number> {
        if (!this.#exists(id)) {
            return 0
        }
        return (await this.#readState(id)).conversations.length
    }

    // 列表：只回摘要，正文走 readMessagePage
    async readConversations(id: string): Promise<WorkspaceIndex | null> {
        if (!this.#exists(id)) {
            return null
        }
        return toIndex(await this.#readState(id))
    }

    // 读一页正文；before 缺省到末尾
    async readMessagePage(
        id: string,
        conversationId: string,
        before: number,
        limit: number,
    ): Promise<ConversationPage | null> {
        const conversation = await this.findConversation(id, conversationId)
        if (conversation === null) {
            return null
        }
        return conversationPage(conversation, before, limit)
    }

    async findConversation(id: string, conversationId: string): Promise<StoredConversation | null> {
        if (!this.#exists(id)) {
            return null
        }
        const state = await this.#readState(id)
        for (const conversation of state.conversations) {
            if (conversation.id === conversationId) {
                return conversation
            }
        }
        return null
    }

    async upsertConversation(
        id: string,
        value: unknown,
    ): Promise<UpsertResult | ConflictResult | null> {
        const root = this.#rootOf(id)
        if (root === null) {
            return null
        }
        return await this.#upsertState(this.#statePath(id), value, root)
    }

    async deleteConversation(id: string, conversationId: string): Promise<boolean> {
        if (!this.#exists(id)) {
            return false
        }
        return await this.#enqueue(async () => {
            const state = await this.#readState(id)
            const conversations = state.conversations.filter((item) => item.id !== conversationId)
            const removed = conversations.length !== state.conversations.length
            if (!removed) {
                return false
            }
            const activeId =
                state.activeId === conversationId ? (conversations[0]?.id ?? null) : state.activeId
            await this.#writeState(id, conversations, activeId)
            return true
        })
    }

    async setActive(id: string, conversationId: string | null): Promise<string | null> {
        if (!this.#exists(id)) {
            return null
        }
        return await this.#enqueue(async () => {
            const state = await this.#readState(id)
            const activeId =
                conversationId !== null &&
                state.conversations.some((item) => item.id === conversationId)
                    ? conversationId
                    : null
            await this.#writeState(id, state.conversations, activeId)
            return activeId
        })
    }

    /** 工作区被移除：会话转入「未分组」，目录本身不删除；返回移动条数 */
    async moveToUngrouped(id: string, workspaceRoot: string | null): Promise<number> {
        return await this.#enqueue(async () => {
            const state = await this.#readState(id)
            const ungrouped = await this.#readStateFile(this.#ungroupedPath())
            const existing = new Set(ungrouped.conversations.map((item) => item.id))
            const moved = state.conversations
                .filter((item) => !existing.has(item.id))
                .map((item) => ({ ...item, workspaceRoot: item.workspaceRoot ?? workspaceRoot }))
            if (moved.length > 0) {
                const merged = [...ungrouped.conversations, ...moved]
                    .sort((left, right) => right.updatedAt - left.updatedAt)
                    .slice(0, MAX_CONVERSATIONS)
                await this.#writeStateFile(this.#ungroupedPath(), merged, ungrouped.activeId)
            }
            return moved.length
        })
    }

    /** 工作区移除后清掉它的会话目录（会话已经转进未分组） */
    async dropWorkspaceDir(id: string): Promise<void> {
        try {
            await this.#fs.remove(this.#workspaceDir(id))
        } catch {
            /* 目录可能不存在 */
        }
    }

    async readUngrouped(): Promise<WorkspaceIndex> {
        return toIndex(await this.#readStateFile(this.#ungroupedPath()))
    }

    async readUngroupedMessagePage(
        conversationId: string,
        before: number,
        limit: number,
    ): Promise<ConversationPage | null> {
        const state = await this.#readStateFile(this.#ungroupedPath())
        const conversation = state.conversations.find((item) => item.id === conversationId)
        if (conversation === undefined) {
            return null
        }
        return conversationPage(conversation, before, limit)
    }

    async ungroupedCount(): Promise<number> {
        return (await this.#readStateFile(this.#ungroupedPath())).conversations.length
    }

    async upsertUngroupedConversation(
        value: unknown,
    ): Promise<UpsertResult | ConflictResult | null> {
        return await this.#upsertState(this.#ungroupedPath(), value, null)
    }

    async deleteUngroupedConversation(conversationId: string): Promise<boolean> {
        return await this.#enqueue(async () => {
            const state = await this.#readStateFile(this.#ungroupedPath())
            const conversations = state.conversations.filter((item) => item.id !== conversationId)
            if (conversations.length === state.conversations.length) {
                return false
            }
            const activeId =
                state.activeId === conversationId ? (conversations[0]?.id ?? null) : state.activeId
            await this.#writeStateFile(this.#ungroupedPath(), conversations, activeId)
            return true
        })
    }

    async setUngroupedActive(conversationId: string | null): Promise<string | null> {
        return await this.#enqueue(async () => {
            const state = await this.#readStateFile(this.#ungroupedPath())
            const activeId =
                conversationId !== null &&
                state.conversations.some((item) => item.id === conversationId)
                    ? conversationId
                    : null
            await this.#writeStateFile(this.#ungroupedPath(), state.conversations, activeId)
            return activeId
        })
    }

    /** 通用 upsert：归一化、版本冲突、体积裁剪、数量上限 */
    async #upsertState(
        path: string,
        value: unknown,
        workspaceRoot: string | null,
    ): Promise<(UpsertResult & { readonly count: number }) | ConflictResult | null> {
        const normalized = normalizeConversation(value)
        if (normalized === null) {
            return null
        }
        const rawCount = Array.isArray((value as Record<string, unknown>)["messages"])
            ? ((value as Record<string, unknown>)["messages"] as unknown[]).length
            : 0
        return await this.#enqueue(async () => {
            const state = await this.#readStateFile(path)
            const existing = state.conversations.find((item) => item.id === normalized.id)
            if (existing !== undefined && existing.updatedAt > normalized.updatedAt) {
                return { conflict: existing }
            }
            const withRoot: StoredConversation = {
                ...normalized,
                workspaceRoot: workspaceRoot ?? normalized.workspaceRoot,
            }
            // 分片保存：messagesFrom 之前的部分沿用服务端正文
            const partialFrom = countOf((value as Record<string, unknown>)["messagesFrom"])
            const merged =
                partialFrom !== undefined && partialFrom > 0 && existing !== undefined
                    ? mergePartialMessages(existing, withRoot, partialFrom)
                    : withRoot
            const trimmedConversation = trimConversation(merged)
            const conversations = state.conversations.filter(
                (item) => item.id !== trimmedConversation.conversation.id,
            )
            conversations.push(trimmedConversation.conversation)
            conversations.sort((left, right) => right.updatedAt - left.updatedAt)
            const capped = conversations.slice(0, MAX_CONVERSATIONS)
            let activeId = state.activeId
            if (activeId !== null && capped.every((item) => item.id !== activeId)) {
                activeId = capped.length > 0 ? (capped[0]?.id ?? null) : null
            }
            await this.#writeStateFile(path, capped, activeId)
            return {
                conversation: trimmedConversation.conversation,
                trimmed: trimmedConversation.trimmed || rawCount > MAX_MESSAGES,
                count: capped.length,
            }
        })
    }

    #ungroupedPath(): string {
        return `${UNGROUPED_DIR}/${CONVERSATIONS_FILE}`
    }

    #workspaceDir(id: string): string {
        return `${WORKSPACES_DIR}/${id}`
    }

    #statePath(id: string): string {
        return `${this.#workspaceDir(id)}/${CONVERSATIONS_FILE}`
    }

    /** 读取 JSON；文件损坏时挪到 .broken 并当作空数据，避免插件启动失败 */
    async #readJsonSafe(path: string): Promise<unknown> {
        try {
            return await this.#fs.readJson<unknown>(path)
        } catch (error) {
            try {
                const broken = await this.#fs.readText(path)
                if (broken !== null) {
                    await this.#fs.writeText(`${path}.broken`, broken)
                }
            } catch {
                /* 备份失败时忽略 */
            }
            return null
        }
    }

    async #readState(id: string): Promise<WorkspaceConversations> {
        return await this.#readStateFile(this.#statePath(id))
    }

    async #readStateFile(path: string): Promise<WorkspaceConversations> {
        const value = await this.#readJsonSafe(path)
        if (value === null || typeof value !== "object") {
            return { activeId: null, conversations: [] }
        }
        const record = value as Record<string, unknown>
        const conversations = normalizeConversations(record["conversations"])
        const rawActive = record["activeId"]
        const activeId =
            typeof rawActive === "string" && conversations.some((item) => item.id === rawActive)
                ? rawActive
                : null
        return { activeId, conversations }
    }

    async #writeStateFile(
        path: string,
        conversations: readonly StoredConversation[],
        activeId: string | null,
    ): Promise<void> {
        const state: StoredState = {
            v: STORE_VERSION,
            activeId,
            conversations: conversations.slice(0, MAX_CONVERSATIONS),
        }
        await this.#fs.mkdir(dirnameOfPath(path))
        await this.#fs.writeJson(path, state)
    }

    async #writeState(
        id: string,
        conversations: readonly StoredConversation[],
        activeId: string | null,
    ): Promise<void> {
        await this.#writeStateFile(this.#statePath(id), conversations, activeId)
    }

    #enqueue<T>(task: () => Promise<T>): Promise<T> {
        const run = this.#queue.then(task, task)
        this.#queue = run.then(
            () => undefined,
            () => undefined,
        )
        return run
    }
}
