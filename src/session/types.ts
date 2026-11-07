/* 会话模型：参考 DeepSeekHarness session.v4，按轮分段的 JSONL 事件流 */

export type SessionMode = "chat" | "run"

export interface SessionHeader {
    readonly type: string
    readonly metadata: Record<string, unknown>
    readonly workspace: string
}

export interface SessionMeta {
    readonly type: string
    readonly version: 1
    readonly id: string
    readonly createdAt: number
    readonly cwd: string
    readonly workspace: string
    readonly metadata: Record<string, unknown>
    readonly app: string
    readonly appVersion: string
    readonly model: string
    readonly title?: string
}

export type ContentPart =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "reasoning"; readonly text: string }
    | {
          readonly type: "tool-call"
          readonly id: string
          readonly name: string
          readonly arguments: string
      }

export interface SessionMessageRecord {
    readonly role: "user" | "assistant" | "system" | "tool"
    readonly content: readonly ContentPart[]
    readonly source?: Record<string, unknown>
    readonly id?: string
    readonly toolCallId?: string
}

/** 规范化后的流式片段 */
export interface StreamChunkRecord {
    readonly type: "chunk"
    readonly time: number
    readonly chunk: Record<string, unknown>
}

export interface SessionEvent {
    readonly type: string
    readonly seq: number
    readonly time: number
    readonly data: Record<string, unknown>
}

export interface SessionTurn {
    readonly turn: number
    readonly mode: SessionMode | null
    readonly events: SessionEvent[]
}
