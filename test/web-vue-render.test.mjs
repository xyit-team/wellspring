/*
 * 展示层纯逻辑：工具参数换行、正文与过程行的穿插顺序。
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { messageBlocks } from "../plugins/wellspring-web/frontend/src/logic/message-blocks.ts"
import { formatPayload } from "../plugins/wellspring-web/frontend/src/logic/tool-payload.ts"

test("formatPayload：JSON 参数展开成键值并保留真实换行", () => {
    const raw = JSON.stringify({
        command: "node",
        argv: ["-e", "console.log('a')\nconsole.log('b')"],
    })
    const text = formatPayload(raw)
    assert.match(text, /^command: node/)
    assert.match(text, /console\.log\('a'\)\nconsole\.log\('b'\)/, "字符串里的换行要保留为真实换行")
    assert.ok(!/\\\\n/.test(text), "不应残留字面的 \\\\n")
})

test("formatPayload：纯文本里的字面换行符还原", () => {
    assert.equal(formatPayload("第一行\\n第二行"), "第一行\n第二行")
    // 已有真实换行时原样返回
    assert.equal(formatPayload("a\nb"), "a\nb")
    assert.equal(formatPayload(""), "")
    assert.equal(formatPayload(undefined), "")
})

test("formatPayload：非法 JSON 按纯文本兜底", () => {
    assert.equal(formatPayload("{不是 json"), "{不是 json")
})

test("messageBlocks：正文与过程行按 at 穿插，总结留在最后", () => {
    const blocks = messageBlocks("先说说，然后", [
        { kind: "reasoning", text: "想一想", at: 0 },
        { kind: "tool", id: "t1", name: "read", at: 3, status: "ok" },
    ])
    assert.deepEqual(
        blocks.map((block) => block.type),
        ["proc", "md", "proc", "md"],
    )
    assert.equal(blocks[1].type === "md" ? blocks[1].text : "", "先说说")
    assert.equal(blocks[3].type === "md" ? blocks[3].text : "", "，然后")
})

test("messageBlocks：at 超出正文长度时不再切分正文", () => {
    const blocks = messageBlocks("短", [
        { kind: "tool", id: "t1", name: "read", at: 99, status: "ok" },
        { kind: "tool", id: "t2", name: "write", at: 99, status: "ok" },
    ])
    assert.deepEqual(
        blocks.map((block) => block.type),
        ["md", "proc", "proc"],
    )
})
