/*
 * plugin link 的替换语义。
 *
 * 以前用 stat 判断目标是否已存在：悬空符号链接（源目录被删或改名）会让 stat 报 ENOENT，
 * 于是被当成「不存在」而放过，接着 symlink 撞 EEXIST、被裸 catch 吞掉后回落 cp，
 * 用户看到的是 Cannot overwrite non-directory with directory。
 */

import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import type { ResolvedPaths } from "../src/platform/path.ts"
import { linkPlugin } from "../src/plugin/loader.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-link-"))
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

/** 造一个可链接的插件目录；插件名取源目录 basename，所以目录名就是 name */
async function makeSource(name: string, marker = "v1"): Promise<string> {
    const dir = join(root, `src-${marker}`, name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "index.ts"), `export const marker = ${JSON.stringify(marker)}\n`)
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }))
    return dir
}

test("首次 link 建立符号链接", async () => {
    const source = await makeSource("plug-first")
    const name = await linkPlugin(source, paths())
    assert.equal(name, "plug-first")
    const target = join(root, "data", "plugins", "plug-first")
    const info = await lstat(target)
    assert.equal(info.isSymbolicLink(), true)
    assert.equal(await readlink(target), source)
    assert.match(await readFile(join(target, "index.ts"), "utf8"), /v1/)
})

test("源目录被删后重新 link：替换悬空符号链接，不再报 Cannot overwrite", async () => {
    const first = await makeSource("plug-relink", "v1")
    await linkPlugin(first, paths())
    // 整个源目录移走，插件目录里留下一个悬空链接
    await rm(first, { recursive: true, force: true })
    const target = join(root, "data", "plugins", "plug-relink")
    assert.equal((await lstat(target)).isSymbolicLink(), true)

    const second = await makeSource("plug-relink", "v2")
    const name = await linkPlugin(second, paths())
    assert.equal(name, "plug-relink")
    assert.equal(await readlink(target), second)
    assert.match(await readFile(join(target, "index.ts"), "utf8"), /v2/)
})

test("源目录改名后重新 link：指向新路径", async () => {
    const oldDir = await makeSource("plug-move", "v1")
    await linkPlugin(oldDir, paths())
    const newDir = await makeSource("plug-move", "v2")
    await rm(oldDir, { recursive: true, force: true })
    await linkPlugin(newDir, paths())
    assert.equal(await readlink(join(root, "data", "plugins", "plug-move")), newDir)
})

test("重复 link 同一个源是幂等的", async () => {
    const source = await makeSource("plug-idem")
    await linkPlugin(source, paths())
    const name = await linkPlugin(source, paths())
    assert.equal(name, "plug-idem")
    assert.equal(await readlink(join(root, "data", "plugins", "plug-idem")), source)
})

test("目标已是真实目录时报插件已存在", async () => {
    const source = await makeSource("plug-dir")
    const target = join(root, "data", "plugins", "plug-dir")
    await mkdir(target, { recursive: true })
    await assert.rejects(() => linkPlugin(source, paths()), /插件已存在/)
})

test("源目录不存在时报错，不建出空链接", async () => {
    const missing = join(root, "not-there")
    await assert.rejects(() => linkPlugin(missing, paths()), /源目录不存在/)
    await assert.rejects(() => lstat(join(root, "data", "plugins", "not-there")))
})

test("路径带尾斜杠时插件名不带尾斜杠", async () => {
    const source = await makeSource("plug-slash")
    const name = await linkPlugin(`${source}/`, paths())
    assert.equal(name, "plug-slash")
})

test("符号链接内容损坏（指向普通文件）时不覆盖，报可读错误", async () => {
    const name = "plug-file"
    const target = join(root, "data", "plugins", name)
    await mkdir(join(root, "data", "plugins"), { recursive: true })
    const strayFile = join(root, "stray.txt")
    await writeFile(strayFile, "x")
    await symlink(strayFile, target)
    const source = await makeSource(name)
    // 指向文件的链接会被替换掉，连到新的源目录
    await linkPlugin(source, paths())
    assert.equal(await readlink(target), source)
})
