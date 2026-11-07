/*
 * Token 用量：模型报告的输出、缓存命中与上下文占用
 *
 * `inputTokens` 统一成 prompt tokens 总数，缓存命中的部分也计算在内
 * `cacheReadTokens` / `cacheWriteTokens` 是其中的缓存读取与写入
 * 不同供应商口径由 parseProviderUsage 抹平：
 * - DeepSeek / OpenAI：prompt_tokens（或 Responses 的 input_tokens）本身含缓存命中，
 *   命中数在 prompt_cache_hit_tokens 或 prompt_tokens_details.cached_tokens；
 * - 部分网关沿用 Anthropic 的 cache_read_input_tokens / cache_creation_input_tokens，
 *   这时 input_tokens 只是未缓存部分，parse 会把两段缓存加进总数
 */

/** 一次模型调用报告的用量；供应商没返回的项为 null */
export interface ProviderUsage {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly cacheReadTokens: number | null
    readonly cacheWriteTokens: number | null
    readonly reasoningTokens: number | null
}

// 界面共用的可选字段；空值不入会话，旧格式兼容
export interface TokenUsage {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly cacheReadTokens?: number | null
    readonly cacheWriteTokens?: number | null
    readonly reasoningTokens?: number | null
    /** 这一轮最后一次请求的 prompt tokens，即收尾时占用的上下文 */
    readonly contextTokens?: number | null
}

function countOf(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return null
    }
    return Math.floor(value)
}

function recordOf(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

// 供应商 usage 归一化为计数；无可用字段返回 null
export function parseProviderUsage(value: unknown): ProviderUsage | null {
    const record = recordOf(value)
    if (record === null) {
        return null
    }
    const promptDetails = recordOf(record["prompt_tokens_details"])
    const inputDetails = recordOf(record["input_tokens_details"])
    const completionDetails = recordOf(record["completion_tokens_details"])
    const outputDetails = recordOf(record["output_tokens_details"])
    let input = countOf(record["prompt_tokens"]) ?? countOf(record["input_tokens"])
    const output = countOf(record["completion_tokens"]) ?? countOf(record["output_tokens"])
    const cacheRead =
        countOf(record["prompt_cache_hit_tokens"]) ??
        countOf(promptDetails?.["cached_tokens"]) ??
        countOf(inputDetails?.["cached_tokens"]) ??
        countOf(record["cache_read_input_tokens"])
    const cacheWrite =
        countOf(record["cache_creation_input_tokens"]) ??
        countOf(promptDetails?.["cache_creation_tokens"]) ??
        countOf(inputDetails?.["cache_creation_tokens"])
    /*
     * Anthropic 口径的 input_tokens 不含缓存读取/写入，补成 prompt 总数
     * OpenAI 口径的 prompt_tokens 与 *_tokens_details 已含缓存，再加会重复计数
     */
    const anthropicStyle =
        record["prompt_tokens"] === undefined &&
        promptDetails === null &&
        inputDetails === null &&
        (cacheRead !== null || cacheWrite !== null) &&
        (record["cache_read_input_tokens"] !== undefined ||
            record["cache_creation_input_tokens"] !== undefined)
    if (anthropicStyle && input !== null) {
        input += (cacheRead ?? 0) + (cacheWrite ?? 0)
    }
    const reasoning =
        countOf(completionDetails?.["reasoning_tokens"]) ??
        countOf(outputDetails?.["reasoning_tokens"])
    if (input === null && output === null && cacheRead === null && cacheWrite === null) {
        return null
    }
    return {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: reasoning,
    }
}

/*
 * 缓存命中率（0-100 整数）
 *
 * 分母是 prompt tokens 总数，`cacheRead` 是其中的子集
 * 供应商没报告缓存或没有输入时返回 null
 */
export function cacheHitPercent(
    cacheReadTokens: number | null | undefined,
    promptTokens: number | null | undefined,
): number | null {
    if (typeof cacheReadTokens !== "number" || typeof promptTokens !== "number") {
        return null
    }
    if (!Number.isFinite(cacheReadTokens) || !Number.isFinite(promptTokens) || promptTokens <= 0) {
        return null
    }
    const percent = Math.round((cacheReadTokens / promptTokens) * 100)
    return Math.min(100, Math.max(0, percent))
}

/** 未缓存输入：prompt tokens 减去缓存读取/写入，最小为 0 */
export function uncachedInputTokens(
    inputTokens: number | null | undefined,
    cacheReadTokens: number | null | undefined,
    cacheWriteTokens?: number | null,
): number | null {
    if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens < 0) {
        return null
    }
    const cacheRead =
        typeof cacheReadTokens === "number" && Number.isFinite(cacheReadTokens)
            ? cacheReadTokens
            : 0
    const cacheWrite =
        typeof cacheWriteTokens === "number" && Number.isFinite(cacheWriteTokens)
            ? cacheWriteTokens
            : 0
    return Math.max(0, Math.floor(inputTokens - cacheRead - cacheWrite))
}

// 去掉空的可选字段；会话 JSON 只留供应商报告过的项
export function compactUsage(usage: TokenUsage): TokenUsage {
    return {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(typeof usage.cacheReadTokens === "number"
            ? { cacheReadTokens: usage.cacheReadTokens }
            : {}),
        ...(typeof usage.cacheWriteTokens === "number"
            ? { cacheWriteTokens: usage.cacheWriteTokens }
            : {}),
        ...(typeof usage.reasoningTokens === "number"
            ? { reasoningTokens: usage.reasoningTokens }
            : {}),
        ...(typeof usage.contextTokens === "number" ? { contextTokens: usage.contextTokens } : {}),
    }
}

/** 一次模型回复的结构化用量；inputTokens 默认就是这次请求占用的上下文 */
export interface UsageSource {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly cacheReadTokens?: number | null
    readonly cacheWriteTokens?: number | null
    readonly reasoningTokens?: number | null
}

export function usageOf(source: UsageSource, contextTokens?: number | null): TokenUsage {
    return compactUsage({
        inputTokens: source.inputTokens,
        outputTokens: source.outputTokens,
        cacheReadTokens: source.cacheReadTokens ?? null,
        cacheWriteTokens: source.cacheWriteTokens ?? null,
        reasoningTokens: source.reasoningTokens ?? null,
        contextTokens: contextTokens === undefined ? source.inputTokens : contextTokens,
    })
}
