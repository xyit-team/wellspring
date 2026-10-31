/*
 * 长会话显示窗口：按轮折叠、切点吸附到轮起点、「加载更早」逐步展开。
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
    alignToRound,
    defaultVisibleFrom,
    earlierVisibleFrom,
    hiddenRounds,
    resolveVisibleFrom,
    rounds,
} from "../plugins/wellspring-web/frontend/src/logic/windowing.ts"

/** 造 n 轮：每轮一条 user + 一条 assistant */
function conversation(roundCount) {
    const messages = []
    for (let index = 0; index < roundCount; index += 1) {
        messages.push({ role: "user", text: `问 ${index}` })
        messages.push({ role: "assistant", text: `答 ${index}` })
    }
    return messages
}

test("rounds：每条 user 开启一轮，回复归到它那一轮", () => {
    const spans = rounds([
        { role: "user" },
        { role: "assistant" },
        { role: "assistant" },
        { role: "user" },
        { role: "assistant" },
    ])
    assert.deepEqual(spans, [
        { start: 0, end: 3 },
        { start: 3, end: 5 },
    ])
})

test("rounds：空会话没有轮；历史数据以回复开头时也成一轮", () => {
    assert.deepEqual(rounds([]), [])
    assert.deepEqual(rounds([{ role: "assistant" }, { role: "assistant" }]), [{ start: 0, end: 2 }])
})

test("rounds：连续多条 user（重试/插话）不会被并成一轮", () => {
    const spans = rounds([{ role: "user" }, { role: "user" }, { role: "assistant" }])
    assert.deepEqual(spans, [
        { start: 0, end: 1 },
        { start: 1, end: 3 },
    ])
})

test("alignToRound：任意下标吸附到所属轮的起点", () => {
    const messages = conversation(3)
    assert.equal(alignToRound(messages, 0), 0)
    assert.equal(alignToRound(messages, 1), 0) // 第 1 轮里的回复
    assert.equal(alignToRound(messages, 2), 2) // 第 2 轮的提问
    assert.equal(alignToRound(messages, 3), 2)
    assert.equal(alignToRound(messages, 5), 4)
    // 越界与负数都夹回合法范围
    assert.equal(alignToRound(messages, 999), 4)
    assert.equal(alignToRound(messages, -5), 0)
    assert.equal(alignToRound([], 3), 0)
})

test("defaultVisibleFrom：50 轮只露出最近 10 轮，隐藏 40 轮", () => {
    const messages = conversation(50)
    const from = defaultVisibleFrom(messages, 10)
    // 50 轮 = 100 条；第 41 轮从下标 (50-10)*2 = 80 开始
    assert.equal(from, 80)
    assert.equal(messages.length - from, 20)
    assert.equal(hiddenRounds(messages, from), 40)
})

test("defaultVisibleFrom：不超过阈值就一条都不藏", () => {
    assert.equal(defaultVisibleFrom(conversation(10), 10), 0)
    assert.equal(defaultVisibleFrom(conversation(3), 10), 0)
    assert.equal(defaultVisibleFrom([], 10), 0)
    assert.equal(hiddenRounds(conversation(10), 0), 0)
})

test("defaultVisibleFrom：切点永远落在一轮的 user 上", () => {
    for (const count of [11, 12, 23, 50, 99]) {
        const messages = conversation(count)
        const from = defaultVisibleFrom(messages, 10)
        assert.equal(messages[from].role, "user", `${count} 轮的切点落在了回复上`)
    }
})

test("defaultVisibleFrom：一轮里有很多条消息时也按轮算", () => {
    // 第 1 轮：1 条提问 + 9 条过程行；第 2、3 轮各 1 问 1 答
    const messages = [
        { role: "user" },
        ...Array.from({ length: 9 }, () => ({ role: "assistant" })),
        { role: "user" },
        { role: "assistant" },
        { role: "user" },
        { role: "assistant" },
    ]
    // 只保留最近 2 轮：应该从第 2 轮的 user（下标 10）开始
    assert.equal(defaultVisibleFrom(messages, 2), 10)
    assert.equal(hiddenRounds(messages, 10), 1)
})

test("earlierVisibleFrom：一次退一页，走到顶返回 0", () => {
    const messages = conversation(50)
    const first = defaultVisibleFrom(messages, 10) // 80
    const second = earlierVisibleFrom(messages, first, 10)
    assert.equal(second, 60)
    assert.equal(hiddenRounds(messages, second), 30)
    const third = earlierVisibleFrom(messages, second, 10)
    assert.equal(third, 40)
    // 已经到顶：返回 0，调用方据此不再写状态
    assert.equal(earlierVisibleFrom(messages, 0, 10), 0)
    assert.equal(earlierVisibleFrom(messages, 4, 10), 0)
})

test("earlierVisibleFrom：从轮中间开始也能对齐后再退", () => {
    const messages = conversation(5)
    // 8 是第 5 轮的回复；退一页应从第 1 轮（0）开始
    assert.equal(earlierVisibleFrom(messages, 8, 2), 4)
    assert.equal(earlierVisibleFrom(messages, 8, 10), 0)
})

/**
 * 读窗口的路径不许写状态
 *
 * 这条曾经是真 bug：hiddenCount 在 computed 里给 store.hiddenMessages 赋值，
 * 渲染期写响应式状态会把渲染打回自激。store.ts 用无扩展名导入（Vite 才能解析），
 * Node 起不来，所以这里直接对源码做不变量检查。
 */
function functionBody(source, name) {
    const start = source.indexOf(`export function ${name}(`)
    assert.ok(start >= 0, `源码里找不到 ${name}`)
    const next = source.indexOf("\nexport function ", start + 1)
    return source.slice(start, next === -1 ? source.length : next)
}

test("读窗口的函数里不写 store.windowStarts", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(
        new URL("../plugins/wellspring-web/frontend/src/store.ts", import.meta.url),
        "utf8",
    )
    for (const name of ["visibleFrom", "hiddenCount", "hiddenRoundCount"]) {
        const body = functionBody(source, name)
        assert.ok(
            !body.includes("windowStarts[") || !/windowStarts\[[^\]]+\]\s*=/.test(body),
            `${name} 不该在读取时写 windowStarts`,
        )
    }
    // 只有 loadEarlier 会写，删除会话时清账
    assert.match(functionBody(source, "loadEarlier"), /store\.windowStarts\[[^\]]+\] = next/)
    assert.match(source, /delete store\.windowStarts\[id\]/)
})

test("resolveVisibleFrom：钉住的起点不受后续新增轮次影响", () => {
    // 打开 50 轮会话：默认露出最近 10 轮，起点 80
    const before = conversation(50)
    const pinned = defaultVisibleFrom(before, 10)
    assert.equal(pinned, 80)
    assert.equal(resolveVisibleFrom(before, pinned, 10), 80)

    // 又聊了 3 轮（流式回复正在往末尾追加）：窗口起点必须钉在 80
    // 否则默认窗口会跟着变成 86，用户正在读的 3 轮被当场折叠掉
    const after = conversation(53)
    assert.equal(defaultVisibleFrom(after, 10), 86, "默认窗口确实会漂")
    assert.equal(resolveVisibleFrom(after, pinned, 10), 80, "钉住的窗口不该漂")
    // 也仍然从头开始显示，不会切在轮中间
    assert.equal(after[resolveVisibleFrom(after, pinned, 10)].role, "user")
})

test("resolveVisibleFrom：没钉过就按默认窗口算", () => {
    assert.equal(resolveVisibleFrom(conversation(50), undefined, 10), 80)
    assert.equal(resolveVisibleFrom(conversation(3), undefined, 10), 0)
    assert.equal(resolveVisibleFrom([], undefined, 10), 0)
})

test("resolveVisibleFrom：存下的起点失效时夹回合法范围并对齐到轮", () => {
    const messages = conversation(3) // 6 条
    // 会话被裁剪后，旧起点可能超出长度
    assert.equal(resolveVisibleFrom(messages, 999, 10), 4)
    assert.equal(resolveVisibleFrom(messages, -3, 10), 0)
    // 起点落在回复上时吸附到该轮提问
    assert.equal(resolveVisibleFrom(messages, 3, 10), 2)
    assert.equal(resolveVisibleFrom(conversation(50), 81, 10), 80)
})
