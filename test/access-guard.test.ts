import assert from "node:assert/strict"
import { test } from "node:test"

import { withHookOwner } from "../src/api/host/hooks.ts"
import { ensureAccessGuard } from "../src/plugin/access-guard.ts"

ensureAccessGuard()

test("插件上下文禁止动态 import node:fs", async () => {
    await assert.rejects(
        withHookOwner("guard-test", async () => {
            await import("node:fs")
        }),
        /禁止直接访问/,
    )
})

test("非插件上下文仍可正常 import node:fs", async () => {
    const module = await import("node:fs")
    assert.equal(typeof module.readFileSync, "function")
})
