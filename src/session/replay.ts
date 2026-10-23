/*
 * 会话回放：把事件流还原成对话轮次与 Chat Completions 消息。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"

import type {
    ContentPart,
    SessionEvent,
    SessionMessageRecord,
    SessionMode,
    SessionTurn,
} from "./types.ts"

export function contentText(parts: readonly ContentPart[] | undefined): string {
    if (parts === undefined) {
        return ""
    }
    let text = ""
    for (const part of parts) {
        if (part.type === "text") {
            text += part.text
        }
    }
    return text
}

function messageOf(event: SessionEvent): SessionMessageRecord | null {
    const message = event.data["message"]
    if (typeof message !== "object" || message === null) {
        return null
    }
    return message as SessionMessageRecord
}

/** 按 turn/start 分组；没有 turn 边界的事件归到当前组 */
export function groupTurns(events: readonly SessionEvent[]): SessionTurn[] {
    const turns: SessionTurn[] = []
    let current: SessionTurn | null = null

    for (const event of events) {
        if (event.type === "turn/start") {
            const turn =
                typeof event.data["turn"] === "number" ? event.data["turn"] : turns.length + 1
            const mode =
                event.data["mode"] === "run" ? "run" : event.data["mode"] === "chat" ? "chat" : null
            current = { turn, mode, events: [] }
            turns.push(current)
        }
        if (current === null) {
            const turn = typeof event.data["turn"] === "number" ? event.data["turn"] : 1
            const mode =
                event.data["mode"] === "run" ? "run" : event.data["mode"] === "chat" ? "chat" : null
            current = { turn, mode, events: [] }
            turns.push(current)
        }
        current.events.push(event)
    }
    return turns
}

export function lastTurnNumber(events: readonly SessionEvent[]): number {
    let max = 0
    for (const event of events) {
        const turn = event.data["turn"]
        if (typeof turn === "number" && turn > max) {
            max = turn
        }
    }
    return max
}

export function lastSeq(events: readonly SessionEvent[]): number {
    let max = -1
    for (const event of events) {
        if (event.seq > max) {
            max = event.seq
        }
    }
    return max
}

/** 历史事件 → 模型消息；保留 assistant tool_calls 与 tool 结果 */
export function toChatMessages(events: readonly SessionEvent[]): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = []
    for (const event of events) {
        if (event.type === "tool/result") {
            const callId = event.data["callId"]
            const content = event.data["content"]
            if (typeof callId === "string" && typeof content === "string") {
                messages.push({ role: "tool", tool_call_id: callId, content })
            }
            continue
        }

        const message = messageOf(event)
        if (message === null) {
            continue
        }
        const text = contentText(message.content)
        if (event.type === "user/message" && message.role === "user") {
            if (text !== "") {
                messages.push({ role: "user", content: text })
            }
            continue
        }
        if (event.type === "assistant/message" && message.role === "assistant") {
            const toolCalls = message.content.filter(
                (part): part is Extract<ContentPart, { type: "tool-call" }> =>
                    part.type === "tool-call",
            )
            if (toolCalls.length > 0) {
                messages.push({
                    role: "assistant",
                    content: text === "" ? null : text,
                    tool_calls: toolCalls.map((call) => ({
                        id: call.id,
                        type: "function" as const,
                        function: { name: call.name, arguments: call.arguments },
                    })),
                })
            } else if (text !== "") {
                messages.push({ role: "assistant", content: text })
            }
        }
    }
    return messages
}

export function turnModeLabel(mode: SessionMode | null): string {
    return mode === "run" ? "run" : "chat"
}
