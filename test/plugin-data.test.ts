import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import type { ResolvedPaths } from "../src/platform/path.ts"
import { PluginDataService } from "../src/plugin/data-access.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-plugin-data-"))
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

test("依赖链插件互访 data，无关插件拒绝", async () => {
    const service = new PluginDataService(paths())
    service.setPlugins([
        { id: "a", deps: ["b"] },
        { id: "b", deps: [] },
        { id: "c", deps: [] },
    ])
    assert.equal(service.canAccess("a", "b"), true)
    assert.equal(service.canAccess("b", "a"), true)
    assert.equal(service.canAccess("a", "c"), false)

    const b = await service.open("a", "b")
    assert.ok(b)
    await b.writeText("from-a.txt", "hello")
    const back = await service.open("b", "a")
    assert.ok(back)
    assert.equal(await back.readText("from-a.txt"), null)
    await back.writeText("from-b.txt", "world")
    assert.equal(await b.readText("from-b.txt"), null)
    assert.equal(await service.open("a", "c"), null)
})
