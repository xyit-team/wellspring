/*
 * plugin update：覆盖已安装的同名插件
 *
 * 必须是已安装的插件；link 进来的符号链接不覆盖
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import type { ResolvedPaths } from "../src/platform/path.ts"
import { installPlugin } from "../src/plugin/install.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-plugin-update-"))
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

async function makePlugin(name: string, marker: string): Promise<string> {
    const dir = join(root, `src-${marker}`, name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "index.ts"), `export const marker = ${JSON.stringify(marker)}\n`)
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: marker }))
    return dir
}

test("update 覆盖已安装的插件", async () => {
    const first = await makePlugin("plug-update", "1.0.0")
    await installPlugin(first, paths())
    const second = await makePlugin("plug-update", "1.1.0")
    const result = await installPlugin(second, paths(), { mode: "update" })
    assert.equal(result.id, "plug-update")
    const target = join(root, "data", "plugins", "plug-update")
    assert.match(await readFile(join(target, "index.ts"), "utf8"), /1\.1\.0/)
    assert.equal(JSON.parse(await readFile(join(target, "package.json"), "utf8")).version, "1.1.0")
})

test("update 未安装时拒绝，不会顺手装一份新的", async () => {
    const source = await makePlugin("plug-absent", "1.0.0")
    await assert.rejects(
        () => installPlugin(source, paths(), { mode: "update" }),
        /插件未安装：plug-absent/,
    )
})

test("update 不覆盖 link 进来的符号链接", async () => {
    const linked = await makePlugin("plug-linked", "1.0.0")
    const target = join(root, "data", "plugins", "plug-linked")
    await mkdir(join(root, "data", "plugins"), { recursive: true })
    await symlink(linked, target, "dir")
    const source = await makePlugin("plug-linked", "2.0.0")
    await assert.rejects(() => installPlugin(source, paths(), { mode: "update" }), /符号链接/)
})
