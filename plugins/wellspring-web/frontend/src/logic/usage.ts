/*
 * Token 用量与缓存命中的前端纯逻辑。
 *
 * 服务端把供应商报告的 usage 原样带下来：`inputTokens` 是 prompt tokens 总数，
 * `cacheReadTokens` 是其中由缓存提供的部分，`contextTokens` 是这一轮最后一次
 * 请求的 prompt tokens（收尾时占用的上下文）。旧会话没有这些字段，按缺省处理。
 */

import type { TokenUsage } from "../types"

function countOf(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : undefined
}

/** 校验一条消息的 usage；没有可用的输入/输出计数时返回 null */
export function normalizeUsage(value: unknown): TokenUsage | null {
    if (value === null || typeof value !== "object") {
        return null
    }
    const record = value as Record<string, unknown>
    const input = record["inputTokens"]
    const output = record["outputTokens"]
    const inputTokens = typeof input === "number" && Number.isFinite(input) ? Math.floor(input) : null
    const outputTokens =
        typeof output === "number" && Number.isFinite(output) ? Math.floor(output) : null
    if (inputTokens === null && outputTokens === null) {
        return null
    }
    const cacheReadTokens = countOf(record["cacheReadTokens"])
    const cacheWriteTokens = countOf(record["cacheWriteTokens"])
    const reasoningTokens = countOf(record["reasoningTokens"])
    const contextTokens = countOf(record["contextTokens"])
    return {
        inputTokens,
        outputTokens,
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        ...(contextTokens === undefined ? {} : { contextTokens }),
    }
}

/** 缓存命中的 prompt tokens；没有缓存信息时为 null */
export function cachedInputTokens(usage: TokenUsage | null | undefined): number | null {
    if (usage === null || usage === undefined) return null
    return typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : null
}

/** 未缓存输入：prompt tokens 总数减去缓存读取与写入，最小为 0 */
export function uncachedInputTokens(usage: TokenUsage | null | undefined): number | null {
    if (usage === null || usage === undefined || usage.inputTokens === null) return null
    const cacheRead = cachedInputTokens(usage) ?? 0
    const cacheWrite =
        typeof usage.cacheWriteTokens === "number" && Number.isFinite(usage.cacheWriteTokens)
            ? usage.cacheWriteTokens
            : 0
    return Math.max(0, usage.inputTokens - cacheRead - cacheWrite)
}

/** 缓存命中率（0-100 整数）；供应商没报告缓存时为 null */
export function cacheHitPercent(usage: TokenUsage | null | undefined): number | null {
    const cacheRead = cachedInputTokens(usage)
    const prompt = usage?.inputTokens
    if (cacheRead === null || typeof prompt !== "number" || prompt <= 0) {
        return null
    }
    return Math.min(100, Math.max(0, Math.round((cacheRead / prompt) * 100)))
}

/** 合计 token：输入（含缓存命中）+ 输出；没有可用计数时为 null */
export function totalTokensOf(usage: TokenUsage | null | undefined): number | null {
    if (usage === null || usage === undefined) return null
    const input = usage.inputTokens
    const output = usage.outputTokens
    if (input === null && output === null) return null
    return (input ?? 0) + (output ?? 0)
}

/** 紧凑显示：950 / 1.2K / 12.3K / 1.2M */
export function formatTokenCount(tokens: number | null | undefined): string {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return ""
    const value = Math.floor(tokens)
    if (value >= 1024 * 1024) {
        return `${trimFixed(value / (1024 * 1024))}M`
    }
    if (value >= 1024) {
        return `${trimFixed(value / 1024)}K`
    }
    return String(value)
}

function trimFixed(value: number): string {
    const fixed = value.toFixed(1)
    return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed
}

/** 精确显示（带千分位）；弹窗里的明细用 */
export function formatTokenCountExact(tokens: number | null | undefined): string {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return ""
    return String(Math.floor(tokens)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** 多条消息的用量求和；没有任何 usage 时返回 null */
export function sumUsage(
    usages: Iterable<TokenUsage | null | undefined>,
): TokenUsage | null {
    let input: number | null = null
    let output: number | null = null
    let cacheRead: number | null = null
    let cacheWrite: number | null = null
    let reasoning: number | null = null
    for (const usage of usages) {
        if (usage === null || usage === undefined) continue
        if (usage.inputTokens !== null) input = (input ?? 0) + usage.inputTokens
        if (usage.outputTokens !== null) output = (output ?? 0) + usage.outputTokens
        if (typeof usage.cacheReadTokens === "number") {
            cacheRead = (cacheRead ?? 0) + usage.cacheReadTokens
        }
        if (typeof usage.cacheWriteTokens === "number") {
            cacheWrite = (cacheWrite ?? 0) + usage.cacheWriteTokens
        }
        if (typeof usage.reasoningTokens === "number") {
            reasoning = (reasoning ?? 0) + usage.reasoningTokens
        }
    }
    if (input === null && output === null) return null
    return {
        inputTokens: input,
        outputTokens: output,
        ...(cacheRead === null ? {} : { cacheReadTokens: cacheRead }),
        ...(cacheWrite === null ? {} : { cacheWriteTokens: cacheWrite }),
        ...(reasoning === null ? {} : { reasoningTokens: reasoning }),
    }
}

/** 回复下方的用量按钮文案：`用量 12.3K · 缓存 85%` */
export function formatUsageBadge(usage: TokenUsage | null | undefined): string | null {
    const total = totalTokensOf(usage)
    if (total === null) return null
    const percent = cacheHitPercent(usage)
    const head = `用量 ${formatTokenCount(total)}`
    return percent === null ? head : `${head} · 缓存 ${percent}%`
}

/** 顶栏/统计弹窗里的会话缓存命中摘要 */
export function formatCacheHit(usage: TokenUsage | null | undefined): string | null {
    const percent = cacheHitPercent(usage)
    return percent === null ? null : `缓存命中 ${percent}%`
}
