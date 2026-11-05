import assert from "node:assert/strict"
import { test } from "node:test"

import { sandboxPermissions } from "../src/plugin/loader.ts"

function pkg(sandbox: unknown) {
    return { name: "demo", version: "1.0.0", wellspring: { sandbox } } as never
}

test("插件清单：sandbox.network 默认关闭", () => {
    assert.equal(sandboxPermissions(pkg(undefined)).network, false)
    assert.equal(sandboxPermissions(pkg({ fs: {} })).network, false)
    assert.equal(sandboxPermissions(pkg({ network: false })).network, false)
    // 只认布尔 true，字符串 "true" 这种写错的不算
    assert.equal(sandboxPermissions(pkg({ network: "true" })).network, false)
})

test("插件清单：sandbox.network=true 才放开出网", () => {
    assert.equal(sandboxPermissions(pkg({ network: true })).network, true)
})

test("插件清单：workspace 读写与 hostApi 解析不受 network 影响", () => {
    const parsed = sandboxPermissions(
        pkg({
            network: true,
            hostApi: ["logger", "fs"],
            fs: { read: ["${pluginDir}", "${workspace}"], write: ["${dataDir}"] },
        }),
    )
    assert.deepEqual(parsed.hostApi, ["logger", "fs"])
    assert.equal(parsed.workspaceRead, true)
    assert.equal(parsed.workspaceWrite, false)
    assert.equal(parsed.network, true)
})
