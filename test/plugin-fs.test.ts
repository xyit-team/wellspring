import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { createPluginFileApi } from "../src/plugin/fs.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-plugin-fs-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

test("HostFileApi 读写文本 / JSON / 列表", async () => {
    const fs = createPluginFileApi(root)
    await fs.writeText("notes/hello.txt", "hi")
    assert.equal(await fs.readText("notes/hello.txt"), "hi")
    assert.equal(await fs.readText("missing.txt"), null)
    assert.equal(await fs.exists("notes/hello.txt"), true)

    await fs.writeJson("data.json", { a: 1 })
    assert.deepEqual(await fs.readJson("data.json"), { a: 1 })

    await fs.mkdir("nested/dir")
    await fs.writeText("nested/dir/a.txt", "a")
    const entries = await fs.list("nested/dir")
    assert.deepEqual(
        entries.map((entry) => [entry.name, entry.type]),
        [["a.txt", "file"]],
    )

    const info = await fs.stat("notes/hello.txt")
    assert.equal(info?.type, "file")
    assert.equal(info?.size, 2)

    await fs.remove("notes")
    assert.equal(await fs.exists("notes"), false)
})

test("HostFileApi 拒绝绝对路径与路径穿越", async () => {
    const fs = createPluginFileApi(root)
    await assert.rejects(fs.readText("/etc/passwd"), /绝对路径/)
    await assert.rejects(fs.writeText("../escape.txt", "x"), /路径越界/)
    await assert.rejects(fs.readText("a/../../escape.txt"), /路径越界/)
})
