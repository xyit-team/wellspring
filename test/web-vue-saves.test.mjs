/*
 * 会话落盘追踪：还没 PUT 落地的会话要算「本地更新」，
 * 否则切工作区再切回来会少最后一条回复。
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { createSaveTracker } from "../plugins/wellspring-web/frontend/src/logic/saves.ts"

const conv = (id, text = "") => ({ id, text })

test("createSaveTracker：保存成功前一直算未落地", () => {
    const tracker = createSaveTracker()
    const value = conv("c1", "答完了")
    const token = tracker.begin(value)
    assert.equal(tracker.pending().get("c1"), value)
    tracker.settle("c1", token)
    assert.equal(tracker.pending().has("c1"), false)
})

test("createSaveTracker：期间又发起保存时，旧的成功不能清掉新的", () => {
    const tracker = createSaveTracker()
    const first = conv("c1", "第一版")
    const second = conv("c1", "第二版")
    const firstToken = tracker.begin(first)
    const secondToken = tracker.begin(second)
    // 第一个请求先回来：更新的那份还在路上，不能当成已落地
    tracker.settle("c1", firstToken)
    assert.equal(tracker.pending().get("c1"), second)
    tracker.settle("c1", secondToken)
    assert.equal(tracker.pending().has("c1"), false)
})

test("createSaveTracker：保存失败的条目留着（内容只有本地有）", () => {
    const tracker = createSaveTracker()
    const value = conv("c1", "只在本地")
    tracker.begin(value)
    // 失败路径不调 settle：切走再切回来内容还在
    assert.equal(tracker.pending().get("c1"), value)
})

test("createSaveTracker：不同会话互不影响", () => {
    const tracker = createSaveTracker()
    const a = conv("c1")
    const b = conv("c2")
    const tokenA = tracker.begin(a)
    tracker.begin(b)
    tracker.settle("c1", tokenA)
    const pending = tracker.pending()
    assert.equal(pending.has("c1"), false)
    assert.equal(pending.get("c2"), b)
})

test("createSaveTracker：pending 返回副本，改动不污染内部状态", () => {
    const tracker = createSaveTracker()
    tracker.begin(conv("c1"))
    tracker.pending().delete("c1")
    assert.equal(tracker.pending().has("c1"), true)
})
