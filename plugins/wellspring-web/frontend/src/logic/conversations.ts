/* 会话数据归一化、序列化与展示格式化（从旧客户端 app.ts 迁移）。 */

export var MAX_MESSAGES = 400

export var MAX_MESSAGE_CHARS = 32000

export var MAX_CONVERSATION_TEXT_CHARS = 600000

export var PERMISSION_ORDER = ["read-only", "workspace-write", "danger-full-access"]

export function normalizeProcessItem(value) {
    if (value === null || typeof value !== "object") return null
    if (value.kind === "reasoning") {
        if (typeof value.text !== "string" || value.text === "") return null
        var reasoning = {
            kind: "reasoning",
            text: value.text.slice(0, 24000),
            at: typeof value.at === "number" && value.at >= 0 ? Math.floor(value.at) : 0
        }
        if (value.running === true) reasoning.running = true
        if (value.open === true) reasoning.open = true
        if (typeof value.startedAt === "number" && value.startedAt > 0) {
            reasoning.startedAt = Math.floor(value.startedAt)
        }
        if (typeof value.endedAt === "number" && value.endedAt > 0) {
            reasoning.endedAt = Math.floor(value.endedAt)
        }
        return reasoning
    }
    if (value.kind === "steer") {
        if (typeof value.text !== "string" || value.text === "") return null
        return {
            kind: "steer",
            text: value.text.slice(0, 24000),
            at: typeof value.at === "number" && value.at >= 0 ? Math.floor(value.at) : 0
        }
    }
    if (value.kind !== "tool") return null
    if (typeof value.name !== "string" || value.name === "") return null
    var tool = {
        kind: "tool",
        id: typeof value.id === "string" && value.id !== "" ? value.id.slice(0, 128) : value.name,
        name: value.name.slice(0, 64),
        at: typeof value.at === "number" && value.at >= 0 ? Math.floor(value.at) : 0,
        status: value.status === "ok" || value.status === "error" || value.status === "stopped" ? value.status : "running"
    }
    if (typeof value.arguments === "string" && value.arguments !== "") {
        tool.arguments = value.arguments.slice(0, 4000)
    }
    if (typeof value.result === "string" && value.result !== "") {
        tool.result = value.result.slice(0, 8000)
    }
    if (value.truncated === true) tool.truncated = true
    if (value.open === true) tool.open = true
    return tool
}

export function normalizeProcess(value) {
    if (!Array.isArray(value)) return []
    var items = []
    for (var i = 0; i < value.length && items.length < 48; i += 1) {
        var item = normalizeProcessItem(value[i])
        if (item !== null) items.push(item)
    }
    return items
}

/** 一条消息的 token 用量；与 logic/usage.ts 的 normalizeUsage 同口径（旧文件不做跨模块导入） */
function normalizeMessageUsage(value: unknown): Record<string, number | null> | null {
    if (value === null || typeof value !== "object") return null
    var record = value as Record<string, unknown>
    var usage: Record<string, number | null> = { inputTokens: null, outputTokens: null }
    if (typeof record.inputTokens === "number" && isFinite(record.inputTokens)) {
        usage.inputTokens = Math.floor(record.inputTokens)
    }
    if (typeof record.outputTokens === "number" && isFinite(record.outputTokens)) {
        usage.outputTokens = Math.floor(record.outputTokens)
    }
    if (usage.inputTokens === null && usage.outputTokens === null) return null
    var optional = ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "contextTokens"]
    for (var i = 0; i < optional.length; i += 1) {
        var key = optional[i]
        var count = record[key]
        if (typeof count === "number" && isFinite(count) && count >= 0) {
            usage[key] = Math.floor(count)
        }
    }
    return usage
}

export function normalizeMessage(value) {
    if (value === null || typeof value !== "object") return null
    if (value.role !== "user" && value.role !== "assistant") return null
    if (typeof value.text !== "string") return null
    var message = {
        role: value.role,
        text: value.text,
        at: typeof value.at === "number" ? value.at : Date.now()
    }
    if (typeof value.model === "string") message.model = value.model
    if (typeof value.turn === "number" && value.turn >= 0) message.turn = value.turn
    if (typeof value.steps === "number" && value.steps >= 0) message.steps = value.steps
    var usage = normalizeMessageUsage(value.usage)
    if (usage !== null) message.usage = usage
    if (value.error === true || typeof value.error === "string") message.error = value.error
    if (value.stopped === true || value.streaming === true) message.stopped = true
    // 页面刷新/断线时这一轮还没写完，重新打开后尝试续接
    if (value.interrupted === true) message.interrupted = true
    message.process = value.role === "assistant" ? normalizeProcess(value.process) : []
    if (message.stopped === true) finalizeProcess(message)
    return message
}

export function normalizeConversationReasoning(value) {
    return value === "off" || value === "low" || value === "high" || value === "max" ? value : null
}

export function normalizeConversationPermission(value) {
    return PERMISSION_ORDER.indexOf(value) === -1 ? null : value
}

export function normalizeConversation(value) {
    if (value === null || typeof value !== "object") return null
    if (typeof value.id !== "string" || value.id === "") return null
    var messages = []
    if (Array.isArray(value.messages)) {
        for (var i = 0; i < value.messages.length; i += 1) {
            var message = normalizeMessage(value.messages[i])
            if (message !== null) messages.push(message)
        }
    }
    if (messages.length > MAX_MESSAGES) {
        messages.splice(0, messages.length - MAX_MESSAGES)
    }
    return {
        id: value.id,
        serverSessionId: typeof value.serverSessionId === "string" ? value.serverSessionId : null,
        title: typeof value.title === "string" && value.title !== "" ? value.title : "新对话",
        createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
        updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
        provider: typeof value.provider === "string" && value.provider !== "" ? value.provider : null,
        model: typeof value.model === "string" && value.model !== "" ? value.model : null,
        reasoning: normalizeConversationReasoning(value.reasoning),
        permission: normalizeConversationPermission(value.permission),
        workspaceRoot:
            typeof value.workspaceRoot === "string" && value.workspaceRoot !== ""
                ? value.workspaceRoot
                : null,
        messages: messages
    }
}

/**
 * 序列化成服务端要的 payload
 * @param overrideMessages 指定要保存的消息列表；不传时用会话自己的（函数体已按此处理）
 */
export function conversationPayload(conv, overrideMessages = undefined) {
    var source = Array.isArray(overrideMessages) ? overrideMessages : conv.messages
    var messages = []
    for (var i = 0; i < source.length; i += 1) {
        var message = source[i]
        var payload = { role: message.role, text: message.text, at: message.at }
        if (typeof message.model === "string" && message.model !== "") payload.model = message.model
        if (typeof message.turn === "number") payload.turn = message.turn
        if (typeof message.steps === "number") payload.steps = message.steps
        if (message.usage !== null && typeof message.usage === "object") payload.usage = message.usage
        if (message.error) {
            payload.error = typeof message.error === "string" ? message.error : "回复失败"
        }
        if (message.stopped === true || message.streaming === true) payload.stopped = true
        if (message.interrupted === true) payload.interrupted = true
        if (message.role === "assistant" && Array.isArray(message.process) && message.process.length > 0) {
            payload.process = message.process
        }
        messages.push(payload)
    }
    return {
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        serverSessionId: conv.serverSessionId,
        provider: conv.provider === undefined ? null : conv.provider,
        model: conv.model === undefined ? null : conv.model,
        reasoning: conv.reasoning === undefined ? null : conv.reasoning,
        permission: conv.permission === undefined ? null : conv.permission,
        workspaceRoot: conv.workspaceRoot,
        messages: messages
    }
}

/** 会话地址：每个会话一个 /c/:id，刷新与前进后退都回到同一个会话 */
export function conversationPath(conversation: string | { id: string } | null): string {
    var id = typeof conversation === "string" ? conversation : conversation !== null && typeof conversation === "object" ? conversation.id : ""
    var value = String(id ?? "")
    return value === "" ? "/" : "/c/" + encodeURIComponent(value)
}

/** 与服务端一致的正文预算：超出时丢弃较早消息，避免 PUT 超过体积上限 */

export function trimPayloadMessages(messages) {
    var total = 0
    var kept = []
    var trimmed = false
    for (var i = messages.length - 1; i >= 0; i -= 1) {
        var message = messages[i]
        var size = typeof message.text === "string" ? message.text.length : 0
        if (total + size > MAX_CONVERSATION_TEXT_CHARS) {
            trimmed = true
            continue
        }
        total += size
        kept.unshift(message)
    }
    return { messages: trimmed ? kept : messages, trimmed: trimmed }
}

export function settleReasoning(message) {
    if (!Array.isArray(message.process)) return
    for (var i = 0; i < message.process.length; i += 1) {
        var item = message.process[i]
        if (item.kind === "reasoning" && item.running === true) item.running = false
    }
}

export function finalizeProcess(message) {
    settleReasoning(message)
    if (!Array.isArray(message.process)) return
    for (var i = 0; i < message.process.length; i += 1) {
        var item = message.process[i]
        if (item.kind === "tool" && item.status === "running") item.status = "stopped"
    }
}

export function conversationStats(conv) {
    if (conv === null) return null
    var turns = 0
    var steps = 0
    var found = false
    for (var i = 0; i < conv.messages.length; i += 1) {
        var message = conv.messages[i]
        if (message.role !== "assistant" || typeof message.turn !== "number") continue
        found = true
        turns += 1
        if (typeof message.steps === "number") steps += message.steps
    }
    return found ? { turns: turns, steps: steps } : null
}

export function formatUsage(usage) {
    if (usage === null || typeof usage !== "object") return null
    var input = typeof usage.inputTokens === "number" ? usage.inputTokens : null
    var output = typeof usage.outputTokens === "number" ? usage.outputTokens : null
    if (input === null && output === null) return null
    return "in " + compactNumber(input) + " · out " + compactNumber(output)
}

/* ── 提示与复制 ───────────────────────────────────────────── */

export function compactNumber(value) {
    if (value === null || value === undefined) return "?"
    if (value >= 1000) return Math.round(value / 100) / 10 + "k"
    return String(value)
}

/** 会话累计轮次与步数：只统计带指标的消息 */

export function formatClock(ts) {
    try {
        return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    } catch (error) {
        return ""
    }
}

export function formatRelativeTime(ts) {
    var date = new Date(ts)
    var now = new Date()
    var clock = formatClock(ts)
    if (date.toDateString() === now.toDateString()) return "今天 " + clock
    var yesterday = new Date(now.getTime())
    yesterday.setDate(now.getDate() - 1)
    if (date.toDateString() === yesterday.toDateString()) return "昨天 " + clock
    return date.getMonth() + 1 + "月" + date.getDate() + "日"
}

export function titleFromText(text) {
    var line = String(text).split("\n")[0].trim()
    if (line.length > 32) line = line.slice(0, 32) + "…"
    return line === "" ? "新对话" : line
}

export function lastModel(conv) {
    for (var i = conv.messages.length - 1; i >= 0; i -= 1) {
        if (conv.messages[i].model) return conv.messages[i].model
    }
    return null
}

export function newConversationId() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
