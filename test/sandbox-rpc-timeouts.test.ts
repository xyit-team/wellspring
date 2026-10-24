import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

import { RPC_TIMEOUT_MS } from "../src/sandbox/rpc-timeouts.ts"

const projectRoot = join(import.meta.dirname, "..")

test("host RPC 超时策略：agent.stream 不设上限", () => {
    // 一轮 Agent 对话可能持续很久，handler RPC 不能把它掐断在固定秒数上
    assert.equal(RPC_TIMEOUT_MS.agentStream, null)
    assert.ok(Number.isFinite(RPC_TIMEOUT_MS.default) && RPC_TIMEOUT_MS.default > 0)
    assert.ok(Number.isFinite(RPC_TIMEOUT_MS.agentChat) && RPC_TIMEOUT_MS.agentChat > 0)
})

test("plugin-host 的 agent.stream 使用无上限策略", async () => {
    const source = await readFile(join(projectRoot, "src", "sandbox", "plugin-host.ts"), "utf8")
    assert.match(
        source,
        /"host\.agent\.stream",\s*\{ streamId, input \},\s*RPC_TIMEOUT_MS\.agentStream/,
    )
    assert.doesNotMatch(source, /"host\.agent\.stream"[^)]*180_000/)
})
