/*
 * 非 Linux 插件 sandbox：Node permission model 的 launch 参数
 */

import assert from "node:assert/strict"
import { sep } from "node:path"
import { test } from "node:test"

import {
    buildNodePermissionPluginLaunch,
    NodePermissionBackend,
} from "../src/sandbox/backends/node-permission.ts"

const input = {
    pluginDir: `${sep}tmp${sep}plugins${sep}core`,
    pluginEntryRel: "index.ts",
    pluginDataDir: `${sep}tmp${sep}data${sep}core`,
    hostSdkDir: `${sep}tmp${sep}data${sep}host`,
    runnerPath: `${sep}tmp${sep}data${sep}host${sep}src${sep}sandbox${sep}plugin-host.ts`,
    env: { PATH: "/usr/bin" },
    limits: { timeoutMs: 1_000, memoryMB: 128, pids: 16, outputLimitBytes: 1024 },
}

test("node permission：只允许插件、宿主 SDK 与插件数据目录", () => {
    const spec = buildNodePermissionPluginLaunch(input)
    assert.equal(spec.args[0], "--permission")
    assert.ok(spec.args.includes(`--allow-fs-read=${input.pluginDir}`))
    assert.ok(spec.args.includes(`--allow-fs-read=${input.hostSdkDir}`))
    assert.ok(spec.args.includes(`--allow-fs-read=${input.pluginDataDir}`))
    assert.ok(spec.args.includes(`--allow-fs-write=${input.pluginDataDir}`))
    assert.equal(spec.args.at(-1), input.runnerPath)
    assert.equal(spec.cwd, input.pluginDir)
})

test("node permission：network 清单项控制 --allow-net", () => {
    assert.ok(!buildNodePermissionPluginLaunch(input).args.includes("--allow-net"))
    assert.ok(
        buildNodePermissionPluginLaunch({ ...input, network: true }).args.includes("--allow-net"),
    )
})

test("node permission：probe 报告可用，但明确说明隔离边界", async () => {
    const status = await new NodePermissionBackend().probe()
    assert.equal(status.available, true)
    assert.match(status.reason ?? "", /无网络\/进程隔离/)
    assert.throws(() => new NodePermissionBackend().buildAgentLaunch(input as never))
})
