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

test("execute_code 的 RPC 超时覆盖沙箱命令的最长时限", async () => {
    // 沙箱 timeoutMs 上限 600s：RPC 必须更长，否则长命令会先报「host RPC 超时」
    assert.ok(RPC_TIMEOUT_MS.sandboxExec > 600_000)
    const source = await readFile(join(projectRoot, "src", "sandbox", "plugin-host.ts"), "utf8")
    assert.match(source, /"host\.capabilities\.executeCode",[\s\S]*?RPC_TIMEOUT_MS\.sandboxExec/)
})
