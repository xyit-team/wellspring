// 会话门面：插件与宿主使用的 Session / SessionMessage

import { randomUUID } from "node:crypto"

import { emitOnMessage } from "../api/host/hooks.ts"
import type { SessionStore, SessionData } from "./store.ts"
import type { SessionMessageRecord } from "./types.ts"
import { lastSeq, lastTurnNumber } from "./replay.ts"
import { Workspace } from "../workspace/index.ts"

export interface SessionMessageInput {
    readonly sessionId: string
    readonly content: string | readonly string[]
    readonly type?: string
}

export class SessionMessage {
    readonly sessionId: string
    readonly content: string[]
    readonly type: string

    constructor(input: SessionMessageInput) {
        this.sessionId = input.sessionId
        this.content = typeof input.content === "string" ? [input.content] : [...input.content]
        this.type = input.type ?? "message"
    }
}

export class Session {
    readonly id: string
    readonly type: string
    readonly metadata: Record<string, unknown>
    readonly workspace: Workspace
    readonly data: SessionData
    readonly #store: SessionStore | null
    readonly #queue: SessionMessage[] = []
    #active = false

    constructor(data: SessionData, store: SessionStore | null = null) {
        this.data = data
        this.#store = store
        this.id = data.meta.id
        this.type = data.meta.type
        this.metadata = data.meta.metadata
        this.workspace = new Workspace(data.meta.workspace)
    }

    /** Agent 循环开始后，消息进入队列而不是直接落盘 */
    begin(): void {
        this.#active = true
    }

    end(): void {
        this.#active = false
    }

    /** 取走运行期排队的消息 */
    take(): SessionMessage[] {
        return this.#queue.splice(0)
    }

    get events() {
        return this.data.events
    }

    get turns() {
        return this.data.turns
    }

    /** 发送消息并触发 onMessage */
    async message(content: string | readonly string[], type = "message"): Promise<SessionMessage> {
        const message = new SessionMessage({ sessionId: this.id, content, type })
        await emitOnMessage({
            sessionId: this.id,
            mode: "chat",
            turn: lastTurnNumber(this.data.events) + 1,
            role: "user",
            phase: "before",
            content: message.content.join(""),
            prompt: [],
        })
        if (this.#active || this.#store === null) {
            this.#queue.push(message)
            return message
        }

        const turn = lastTurnNumber(this.data.events) + 1
        await this.#store.appendTurn(this.data, [
            {
                type: "user/message",
                seq: lastSeq(this.data.events) + 1,
                time: Date.now(),
                data: {
                    turn,
                    message: {
                        role: "user",
                        content: [{ type: "text", text: message.content.join("") }],
                        source: { kind: "plugin", type: message.type },
                        id: randomUUID(),
                    },
                },
            },
        ])
        return message
    }

    toJSON(): Record<string, unknown> {
        return {
            id: this.id,
            type: this.type,
            metadata: this.metadata,
            workspace: this.workspace.root,
        }
    }
}

export type { SessionStore, SessionData, SessionMessageRecord }
