import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

import { RPC_TIMEOUT_MS } from "../src/sandbox/rpc-timeouts.ts"

const projectRoot = join(import.meta.dirname, "..")

test("host RPC 超时策略：时长由用户/模型/工具决定的调用不设上限", () => {
    // 给固定秒数必然误杀：宿主还在干活，插件这边先报超时，界面看着像「点了没反应」
    assert.equal(RPC_TIMEOUT_MS.agentStream, null)
    assert.equal(RPC_TIMEOUT_MS.agentChat, null)
    assert.equal(RPC_TIMEOUT_MS.picker, null)
    // 探针逐个跑、每个 10s，总量由插件数量决定，不能用固定上限
    assert.equal(RPC_TIMEOUT_MS.pluginsCheckUpdates, null)
    // 联网客户端自己有 openai.timeoutMs（默认 60s、用户可调），默认的 30s 会把它砍掉
    assert.equal(RPC_TIMEOUT_MS.webTools, null)
})

test("host RPC 超时策略：宿主内的快操作保留超时，作为卡死探针", () => {
    // 不整体改成无超时：宿主挂了要能报错、要能解开互相等待
    assert.ok(Number.isFinite(RPC_TIMEOUT_MS.default) && RPC_TIMEOUT_MS.default > 0)
    assert.ok(Number.isFinite(RPC_TIMEOUT_MS.modelsFetch) && RPC_TIMEOUT_MS.modelsFetch > 0)
    assert.ok(Number.isFinite(RPC_TIMEOUT_MS.pluginsRemove) && RPC_TIMEOUT_MS.pluginsRemove > 0)
})

test("无上限的 RPC 必须自己有时间界", async () => {
    const agentService = await readFile(
        join(projectRoot, "src", "plugin", "agent-service.ts"),
        "utf8",
    )
    // 选择框：脚本自己 300s 放弃，并把这个上限交给 runNativeCommand
    assert.match(agentService, /const PICKER_TIMEOUT_MS = 300_000/)
    assert.match(agentService, /PICKER_TIMEOUT_MS,\s*\)/)

    const probes = await readFile(join(projectRoot, "src", "plugin", "version-probes.ts"), "utf8")
    assert.match(probes, /VERSION_PROBE_TIMEOUT_MS = 10_000/)

    // 联网工具：客户端按 openai.timeoutMs 超时
    const capabilities = await readFile(
        join(projectRoot, "src", "plugin", "capabilities.ts"),
        "utf8",
    )
    assert.match(
        capabilities,
        /createDeepSeekWebClient\(\{[\s\S]*?timeoutMs: config\.openai\.timeoutMs/,
    )
})

test("plugin-host 的 agent.stream 使用无上限策略", async () => {
    const source = await readFile(join(projectRoot, "src", "sandbox", "plugin-host.ts"), "utf8")
    assert.match(
        source,
        /"host\.agent\.stream",\s*\{ streamId, input \},\s*RPC_TIMEOUT_MS\.agentStream/,
    )
    assert.doesNotMatch(source, /"host\.agent\.stream"[^)]*180_000/)
})

test("plugin-host 的选择框与单轮对话同样不设上限", async () => {
    const source = await readFile(join(projectRoot, "src", "sandbox", "plugin-host.ts"), "utf8")
    assert.match(source, /"host\.agent\.pickDirectory",\s*\{\},\s*RPC_TIMEOUT_MS\.picker/)
    assert.match(source, /RPC_TIMEOUT_MS\.agentChat/)
})

test("execute_code 的 RPC 超时覆盖沙箱命令的最长时限", async () => {
    // 沙箱 timeoutMs 上限 600s：RPC 必须更长，否则长命令会先报「host RPC 超时」
    assert.ok(RPC_TIMEOUT_MS.sandboxExec > 600_000)
    const source = await readFile(join(projectRoot, "src", "sandbox", "plugin-host.ts"), "utf8")
    assert.match(source, /"host\.capabilities\.executeCode",[\s\S]*?RPC_TIMEOUT_MS\.sandboxExec/)
})
