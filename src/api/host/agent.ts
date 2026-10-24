/*
 * 宿主 Agent 能力：让 sandbox 插件与 Agent 会话交互。
 */

export interface HostAgentChatInput {
    /** 用户消息 */
    readonly message: string
    /** 已有会话 id；不传则创建新会话 */
    readonly sessionId?: string
    /** 覆盖本次使用的模型 */
    readonly model?: string
    /** 覆盖本次 system prompt */
    readonly system?: string
}

export interface HostAgentChatResult {
    readonly sessionId: string
    readonly reply: string
    readonly model: string
    readonly usage: {
        readonly inputTokens: number | null
        readonly outputTokens: number | null
    } | null
}

export type HostAgentStreamEvent = {
    readonly type: "delta"
    readonly text: string
}

export interface HostAgentApi {
    chat(input: HostAgentChatInput): Promise<HostAgentChatResult>
    /** 流式执行；delta 通过回调推送，Promise 在完成时返回最终结果 */
    stream(
        input: HostAgentChatInput,
        onEvent: (event: HostAgentStreamEvent) => void,
    ): Promise<HostAgentChatResult>
}
