/* 前端共享类型（宽松定义，逐步收紧）。 */

/** 一条消息的 token 用量；可选字段只在供应商报告时出现 */
export interface TokenUsage {
    inputTokens: number | null
    outputTokens: number | null
    /** 缓存命中的 prompt tokens */
    cacheReadTokens?: number | null
    cacheWriteTokens?: number | null
    reasoningTokens?: number | null
    /** 这一轮最后一次请求的 prompt tokens：收尾时占用的上下文 */
    contextTokens?: number | null
}

export interface ProcessItem {
    kind: "reasoning" | "tool" | "steer" | "prepare"
    text?: string
    id?: string
    name?: string
    at?: number
    running?: boolean
    open?: boolean
    /** 思考开始/结束的毫秒时间戳，用于显示耗时（随会话一起保存） */
    startedAt?: number
    endedAt?: number
    arguments?: string
    result?: string
    status?: "running" | "ok" | "error" | "stopped"
    truncated?: boolean
}

export interface MarkdownMessage {
    role: "user" | "assistant"
    text: string
    at: number
    model?: string
    turn?: number
    steps?: number
    usage?: TokenUsage
    error?: string | boolean
    stopped?: boolean
    interrupted?: boolean
    streaming?: boolean
    process?: ProcessItem[]
    [key: string]: unknown
}
