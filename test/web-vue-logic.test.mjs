/*
 * Vue 前端纯逻辑单测：@ 引用解析与会话数据归一化（从旧客户端逻辑迁移后行为不变）。
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
    conversationPath,
    conversationPayload,
    conversationStats,
    formatUsage,
    normalizeConversation,
    titleFromText,
} from "../plugins/wellspring-web/frontend/src/logic/conversations.ts"
import {
    collectReferences,
    dropCoveredReferences,
    extractReferences,
    formatMention,
    mentionRanges,
} from "../plugins/wellspring-web/frontend/src/logic/mentions.ts"
import { contextInputEntries } from "../plugins/wellspring-web/frontend/src/logic/model-context.ts"
import {
    formatNoProxy,
    parseNoProxy,
} from "../plugins/wellspring-web/frontend/src/logic/network.ts"
import {
    cacheHitPercent,
    formatCacheHit,
    formatTokenCount,
    formatTokenCountExact,
    formatUsageBadge,
    normalizeUsage,
    sumUsage,
    totalTokensOf,
    uncachedInputTokens,
} from "../plugins/wellspring-web/frontend/src/logic/usage.ts"

test("mentionRanges：基本 @ 引用、引号路径与中文边界", () => {
    assert.deepEqual(mentionRanges("@src/app.ts 你好"), [{ start: 0, end: 11 }])
    assert.deepEqual(mentionRanges("看代码@src/app.ts。"), [{ start: 3, end: 14 }])
    assert.deepEqual(mentionRanges('@"my file.txt" 和 @a'), [
        { start: 0, end: 14 },
        { start: 17, end: 19 },
    ])
    assert.deepEqual(mentionRanges("邮箱 a@b.com"), [])
    assert.deepEqual(mentionRanges(""), [])
})

test("extractReferences：去重、去尾随标点并限制数量", () => {
    assert.deepEqual(extractReferences("读 @src/a.ts 和 @src/a.ts。"), ["src/a.ts"])
    const many = Array.from({ length: 30 }, (_, index) => `@f${index}.ts`).join(" ")
    assert.equal(extractReferences(many).length, 20)
})

test("formatMention / dropCoveredReferences / collectReferences", () => {
    assert.equal(formatMention({ path: "a.ts", type: "file" }), "@a.ts")
    assert.equal(formatMention({ path: "my file.txt", type: "file" }), '@"my file.txt"')
    assert.equal(formatMention({ path: "dir", type: "directory" }), "@dir/")
    assert.equal(formatMention({ path: 'a"b', type: "file" }), null)
    assert.deepEqual(dropCoveredReferences(["my", "my file.txt"]), ["my file.txt"])
    assert.deepEqual(collectReferences("看 @my file.txt", ["my file.txt"]), ["my file.txt"])
    assert.deepEqual(collectReferences("@a.ts", ["missing.ts"]), ["a.ts"])
})

test("normalizeConversation：非法条目、消息裁剪与过程项归一化", () => {
    assert.equal(normalizeConversation(null), null)
    assert.equal(normalizeConversation({ id: "" }), null)
    const conv = normalizeConversation({
        id: "c1",
        messages: [
            { role: "user", text: "hi", at: 1 },
            {
                role: "assistant",
                text: "ok",
                at: 2,
                model: "m",
                turn: 1,
                steps: 2,
                process: [
                    { kind: "reasoning", text: "想一想", at: 0, running: true },
                    { kind: "tool", id: "t1", name: "read", at: 3, status: "ok", arguments: "{}" },
                    { kind: "unknown" },
                ],
            },
        ],
    })
    assert.equal(conv.title, "新对话")
    assert.equal(conv.messages.length, 2)
    assert.equal(conv.messages[1].process.length, 2)
    assert.equal(conv.messages[1].process[1].name, "read")
})

test("conversationPayload / stats / usage / title", () => {
    const conv = normalizeConversation({
        id: "c2",
        title: "标题",
        messages: [
            { role: "user", text: "hi", at: 1 },
            {
                role: "assistant",
                text: "ok",
                at: 2,
                turn: 2,
                steps: 3,
                usage: {
                    inputTokens: 100,
                    outputTokens: 5,
                    cacheReadTokens: 80,
                    contextTokens: 100,
                },
            },
        ],
    })
    const payload = conversationPayload(conv)
    assert.equal(payload.id, "c2")
    assert.equal(payload.messages.length, 2)
    assert.deepEqual(payload.messages[1].usage, {
        inputTokens: 100,
        outputTokens: 5,
        cacheReadTokens: 80,
        contextTokens: 100,
    })
    assert.deepEqual(conversationStats(conv), { turns: 1, steps: 3 })
    assert.equal(formatUsage({ inputTokens: 1500, outputTokens: 2300 }), "in 1.5k · out 2.3k")
    assert.equal(titleFromText("  第一行标题\n第二行"), "第一行标题")
    assert.equal(titleFromText("x".repeat(40)).length, 33)
})

test("normalizeUsage：缓存/上下文用量归一化，旧会话无缓存字段", () => {
    assert.deepEqual(normalizeUsage({ inputTokens: 12, outputTokens: 34 }), {
        inputTokens: 12,
        outputTokens: 34,
    })
    assert.deepEqual(
        normalizeUsage({
            inputTokens: 100,
            outputTokens: 5,
            cacheReadTokens: 80,
            cacheWriteTokens: 0,
            reasoningTokens: 3,
            contextTokens: 100,
        }),
        {
            inputTokens: 100,
            outputTokens: 5,
            cacheReadTokens: 80,
            cacheWriteTokens: 0,
            reasoningTokens: 3,
            contextTokens: 100,
        },
    )
    assert.deepEqual(normalizeUsage({ inputTokens: 100.9, outputTokens: null }), {
        inputTokens: 100,
        outputTokens: null,
    })
    assert.equal(normalizeUsage(null), null)
    assert.equal(normalizeUsage({ cacheReadTokens: 80 }), null, "没有输入/输出计数时不算用量")
})

test("缓存命中与 token 显示", () => {
    const usage = { inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, contextTokens: 100 }
    assert.equal(cacheHitPercent(usage), 80)
    assert.equal(uncachedInputTokens(usage), 20)
    assert.equal(
        uncachedInputTokens({
            inputTokens: 100,
            outputTokens: 1,
            cacheReadTokens: 80,
            cacheWriteTokens: 10,
        }),
        10,
    )
    assert.equal(totalTokensOf(usage), 105)
    assert.equal(formatTokenCount(950), "950")
    assert.equal(formatTokenCount(1500), "1.5K")
    assert.equal(formatTokenCount(128000), "125K")
    assert.equal(formatTokenCount(1048576), "1M")
    assert.equal(formatTokenCountExact(123456), "123,456")
    assert.equal(formatUsageBadge(usage), "用量 105 · 缓存 80%")
    assert.equal(formatUsageBadge({ inputTokens: 12, outputTokens: 34 }), "用量 46")
    assert.equal(formatUsageBadge(null), null)
    assert.equal(formatCacheHit(usage), "缓存命中 80%")
    assert.equal(formatCacheHit({ inputTokens: 12, outputTokens: 34 }), null)
})

test("sumUsage：会话累计，缺省字段保持缺省", () => {
    assert.equal(sumUsage([]), null)
    assert.deepEqual(
        sumUsage([
            { inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, contextTokens: 100 },
            { inputTokens: 120, outputTokens: 8, cacheReadTokens: 100, contextTokens: 120 },
        ]),
        { inputTokens: 220, outputTokens: 13, cacheReadTokens: 180 },
    )
    assert.deepEqual(sumUsage([{ inputTokens: 10, outputTokens: 2 }]), {
        inputTokens: 10,
        outputTokens: 2,
    })
})

test("conversationPath：每个会话一个 /c/:id 地址", () => {
    assert.equal(conversationPath("conv-a-1"), "/c/conv-a-1")
    assert.equal(conversationPath({ id: "c/weird id" }), "/c/c%2Fweird%20id")
    assert.equal(conversationPath(null), "/")
})

test("contextInputEntries：模型名里的 / 不会被截断", () => {
    const providers = [
        {
            id: "xyit-newapi",
            models: ["deepseek-v4.1-flash:1017", "deepseek/deepseek-v4.1-flash"],
        },
    ]
    const inputs = {
        "xyit-newapi/deepseek-v4.1-flash:1017": "1M",
        "xyit-newapi/deepseek/deepseek-v4.1-flash": "1M",
        "unrelated/model": "128K",
    }
    assert.deepEqual(contextInputEntries(providers, inputs), [
        { provider: "xyit-newapi", model: "deepseek-v4.1-flash:1017", raw: "1M" },
        { provider: "xyit-newapi", model: "deepseek/deepseek-v4.1-flash", raw: "1M" },
    ])
    assert.deepEqual(contextInputEntries([], inputs), [])
})

test("parseNoProxy / formatNoProxy：逗号、空格、换行分隔并去空去重", () => {
    assert.deepEqual(parseNoProxy("localhost, 127.0.0.1"), ["localhost", "127.0.0.1"])
    assert.deepEqual(parseNoProxy("localhost，.internal\n example.com  localhost"), [
        "localhost",
        ".internal",
        "example.com",
    ])
    assert.deepEqual(parseNoProxy(""), [])
    assert.equal(formatNoProxy(["localhost", "127.0.0.1"]), "localhost, 127.0.0.1")
    assert.equal(formatNoProxy(null), "")
})
