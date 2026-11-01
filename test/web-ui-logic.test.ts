/*
 * Web 前端的纯逻辑：步骤折叠与提交文件提取
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { submittedFiles } from "../plugins/wellspring-web/frontend/src/logic/artifacts.ts"
import {
    groupSteps,
    messageBlocks,
} from "../plugins/wellspring-web/frontend/src/logic/message-blocks.ts"
import type { ProcessItem } from "../plugins/wellspring-web/frontend/src/types.ts"

const reasoning: ProcessItem = {
    kind: "reasoning",
    text: "想一下",
    at: 0,
    startedAt: 0,
    endedAt: 2000,
}
const tool: ProcessItem = {
    kind: "tool",
    id: "t1",
    name: "execute_code",
    at: 6,
    status: "ok",
    result: JSON.stringify({
        artifacts: [
            { path: "/tmp/a/report.md", size: 2048 },
            { path: "relative.txt", size: 1 },
        ],
    }),
}

test("groupSteps：完成后过程收成一块，正文顺序不变", () => {
    // reasoning 在正文开头，tool 在正文末尾：两块之间夹着正文
    const blocks = messageBlocks("第一段第二段", [reasoning, tool])
    assert.deepEqual(
        groupSteps(blocks, true).map((block) => block.type),
        ["steps", "md", "steps"],
    )
})

test("groupSteps：相邻的过程行并进同一个步骤块", () => {
    const blocks = messageBlocks("", [reasoning, tool])
    const grouped = groupSteps(blocks, true)
    assert.equal(grouped.length, 1)
    const steps = grouped[0]
    assert.equal(steps !== undefined && steps.type === "steps" ? steps.items.length : 0, 2)
})

test("groupSteps：流式中保持逐行", () => {
    const blocks = messageBlocks("第一段", [reasoning, tool])
    assert.deepEqual(
        groupSteps(blocks, false).map((block) => block.type),
        ["proc", "md", "proc"],
    )
})

test("submittedFiles：write 与 sandbox 产物都算提交，相对路径丢掉", () => {
    const write: ProcessItem = {
        kind: "tool",
        id: "w1",
        name: "write",
        at: 0,
        status: "ok",
        result: JSON.stringify({ path: "/tmp/a/report.md", bytes: 2048 }),
    }
    const files = submittedFiles([write, tool, reasoning])
    assert.deepEqual(
        files.map((file) => [file.path, file.source]),
        [["/tmp/a/report.md", "write"]],
    )
    assert.equal(files[0]?.name, "report.md")
    assert.equal(files[0]?.size, 2048)
})

test("submittedFiles：工具还在跑时不算提交", () => {
    const running: ProcessItem = { ...tool, status: "running" }
    assert.deepEqual(submittedFiles([running]), [])
})
