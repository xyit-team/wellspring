/*
 * Token 用量归一化：不同供应商的缓存字段与上下文占用计算
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
    cacheHitPercent,
    compactUsage,
    parseProviderUsage,
    uncachedInputTokens,
    usageOf,
} from "../src/agent/usage.ts"

test("parseProviderUsage：OpenAI Chat Completions 的 cached_tokens", () => {
    assert.deepEqual(
        parseProviderUsage({
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
            prompt_tokens_details: { cached_tokens: 96 },
            completion_tokens_details: { reasoning_tokens: 12 },
        }),
        {
            inputTokens: 120,
            outputTokens: 30,
            cacheReadTokens: 96,
            cacheWriteTokens: null,
            reasoningTokens: 12,
        },
    )
})

test("parseProviderUsage：DeepSeek 的 prompt_cache_hit_tokens", () => {
    assert.deepEqual(
        parseProviderUsage({
            prompt_tokens: 100,
            completion_tokens: 5,
            total_tokens: 105,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
        }),
        {
            inputTokens: 100,
            outputTokens: 5,
            cacheReadTokens: 80,
            cacheWriteTokens: null,
            reasoningTokens: null,
        },
    )
})

test("parseProviderUsage：Responses API 的 input_tokens_details", () => {
    assert.deepEqual(
        parseProviderUsage({
            input_tokens: 50,
            output_tokens: 8,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens_details: { reasoning_tokens: 3 },
        }),
        {
            inputTokens: 50,
            outputTokens: 8,
            cacheReadTokens: 40,
            cacheWriteTokens: null,
            reasoningTokens: 3,
        },
    )
})

test("parseProviderUsage：Anthropic 口径的缓存读取/写入", () => {
    assert.deepEqual(
        parseProviderUsage({
            input_tokens: 20,
            output_tokens: 4,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 6,
        }),
        {
            // Anthropic 的 input_tokens 仅未缓存部分，归一化后为 prompt 总数
            inputTokens: 56,
            outputTokens: 4,
            cacheReadTokens: 30,
            cacheWriteTokens: 6,
            reasoningTokens: null,
        },
    )
})

test("parseProviderUsage：没有可用字段时返回 null", () => {
    assert.equal(parseProviderUsage(undefined), null)
    assert.equal(parseProviderUsage(null), null)
    assert.equal(parseProviderUsage({}), null)
    assert.equal(parseProviderUsage({ total_tokens: 10 }), null)
    // 负数与浮点按非法值丢弃
    assert.deepEqual(parseProviderUsage({ prompt_tokens: -1, completion_tokens: 2.9 }), {
        inputTokens: null,
        outputTokens: 2,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
    })
})

test("cacheHitPercent / uncachedInputTokens", () => {
    assert.equal(cacheHitPercent(80, 100), 80)
    assert.equal(cacheHitPercent(0, 100), 0)
    assert.equal(cacheHitPercent(120, 100), 100, "命中数异常时不超过 100%")
    assert.equal(cacheHitPercent(10, 0), null)
    assert.equal(cacheHitPercent(null, 100), null)
    assert.equal(cacheHitPercent(10, null), null)

    assert.equal(uncachedInputTokens(100, 80), 20)
    assert.equal(uncachedInputTokens(100, 0), 100)
    assert.equal(uncachedInputTokens(100, null), 100)
    assert.equal(uncachedInputTokens(100, 120), 0, "缓存读数异常时不出现负输入")
    assert.equal(uncachedInputTokens(100, 80, 10), 10)
    assert.equal(uncachedInputTokens(null, 80), null)
})

test("usageOf / compactUsage：空值不写进会话记录", () => {
    assert.deepEqual(
        usageOf({
            inputTokens: 100,
            outputTokens: 5,
            cacheReadTokens: 80,
        }),
        {
            inputTokens: 100,
            outputTokens: 5,
            cacheReadTokens: 80,
            contextTokens: 100,
        },
    )
    assert.deepEqual(usageOf({ inputTokens: 2, outputTokens: 2 }), {
        inputTokens: 2,
        outputTokens: 2,
        contextTokens: 2,
    })
    // 聚合轮次时上下文单独传入（最后一步的 prompt tokens）
    assert.deepEqual(usageOf({ inputTokens: 300, outputTokens: 40, reasoningTokens: 9 }, 120), {
        inputTokens: 300,
        outputTokens: 40,
        reasoningTokens: 9,
        contextTokens: 120,
    })
    assert.deepEqual(compactUsage({ inputTokens: null, outputTokens: null }), {
        inputTokens: null,
        outputTokens: null,
    })
})
