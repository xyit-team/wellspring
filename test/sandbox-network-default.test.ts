/*
 * 默认网络策略：工作区可写与完全访问默认通网，只读默认断网
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { resolveNetwork } from "../src/sandbox/manager.ts"

test("resolveNetwork：工作区可写与完全访问默认通网", () => {
    assert.equal(resolveNetwork(undefined, "workspace-write"), true)
    assert.equal(resolveNetwork(undefined, "danger-full-access"), true)
})

test("resolveNetwork：只读默认断网", () => {
    assert.equal(resolveNetwork(undefined, "read-only"), false)
})

test("resolveNetwork：显式传值优先", () => {
    assert.equal(resolveNetwork(false, "workspace-write"), false)
    assert.equal(resolveNetwork(true, "read-only"), true)
})
