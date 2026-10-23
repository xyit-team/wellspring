import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import {
    configureHost,
    getHost,
    setHostPlugins,
    setHostStatus,
    type HostPlugin,
} from "../src/api/host/host.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-host-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

function paths(): ResolvedPaths {
    return {
        configDir: join(root, "config"),
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        logDir: join(root, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
}

test("getHost 暴露状态、路径、OS 与插件列表", () => {
    const resolved = paths()
    configureHost({ paths: resolved, os: { platform: "linux" } })
    setHostStatus("running")

    const plugin: HostPlugin = {
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        deps: [],
        commands: ["hello"],
        getStatus: () => "ok",
    }
    setHostPlugins([plugin])

    const host = getHost()
    assert.equal(host.getStatus(), "running")
    assert.deepEqual(host.getPaths(), resolved)
    assert.equal(host.getOS().platform, "linux")
    assert.equal(host.getPlugins().length, 1)
    assert.equal(host.getPlugins()[0]?.getStatus(), "ok")
    assert.deepEqual(host.getPlugins()[0]?.commands, ["hello"])
})

test("getHost 插件状态可以是 disabled", () => {
    setHostPlugins([
        {
            id: "off",
            name: "Off",
            version: "0.1.0",
            deps: [],
            commands: [],
            getStatus: () => "disabled",
        },
    ])
    assert.equal(getHost().getPlugins()[0]?.getStatus(), "disabled")
})
