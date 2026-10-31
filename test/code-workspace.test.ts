import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { kindOf } from "../plugins/wellspring-code/src/kinds.ts"
import {
    WorkspaceService,
    createScopedFs,
    detectIndent,
    fuzzyScore,
    normalizePath,
    rankFiles,
    relativeInside,
} from "../plugins/wellspring-code/src/workspace.ts"
import { createPluginFileApi } from "../src/plugin/fs.ts"

let root = ""
let service: WorkspaceService

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-code-ws-"))
    const fs = createPluginFileApi(root)
    service = new WorkspaceService(fs)
    await fs.mkdir("src")
    await fs.writeText("src/main.ts", 'export const hello = "world"\nconsole.log(hello)\n')
    await fs.writeText("README.md", "# Wellspring\n\nhello **world**\n")
    await fs.writeText("package.json", '{\n    "name": "demo"\n}\n')
    await fs.writeText("nested/deep/file.txt", "hello from nested\n")
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

test("normalizePath 只接受工作区内的相对路径", () => {
    assert.equal(normalizePath(""), "")
    assert.equal(normalizePath("."), "")
    assert.equal(normalizePath("/"), "")
    assert.equal(normalizePath("src/main.ts"), "src/main.ts")
    assert.equal(normalizePath("src//main.ts"), "src/main.ts")
    assert.equal(normalizePath("src/./main.ts"), "src/main.ts")
    assert.equal(normalizePath("src\\main.ts"), "src/main.ts")
    assert.throws(() => normalizePath(".."), /越过工作区/)
    assert.throws(() => normalizePath("src/../secret"), /越过工作区/)
    assert.throws(() => normalizePath("/etc/passwd"), /绝对路径/)
    assert.throws(() => normalizePath("C:/windows"), /绝对路径/)
    assert.throws(() => normalizePath("bad\0name"), /非法字符/)
})

test("fuzzyScore 按顺序匹配，词首连续命中得分更高", () => {
    const exact = fuzzyScore("src/main.ts", "main")
    const scattered = fuzzyScore("src/main.ts", "smt")
    assert.ok(exact !== null && scattered !== null)
    assert.ok((exact ?? 0) > (scattered ?? 0))
    assert.equal(fuzzyScore("src/main.ts", "zzz"), null)
    assert.deepEqual(rankFiles(["b/zeta.ts", "a/main.ts"], "main", 10), ["a/main.ts"])
})

test("detectIndent 识别空格与制表符", () => {
    assert.equal(detectIndent("function a() {\n  return 1\n}"), "2")
    assert.equal(detectIndent("function a() {\n    return 1\n}"), "4")
    assert.equal(detectIndent("function a() {\n\treturn 1\n}"), "tab")
    assert.equal(detectIndent("no indent"), "")
})

test("kindOf 覆盖常见语言与二进制文件", () => {
    assert.equal(kindOf("src/main.ts").language, "typescript")
    assert.equal(kindOf("a/b/c.jsx").language, "javascript")
    assert.equal(kindOf("package.json").language, "json")
    assert.equal(kindOf("README.md").language, "markdown")
    assert.equal(kindOf("style.css").language, "css")
    assert.equal(kindOf("index.html").language, "html")
    assert.equal(kindOf("main.py").language, "python")
    assert.equal(kindOf("Dockerfile").language, "dockerfile")
    assert.equal(kindOf("logo.png").media, "image")
    assert.equal(kindOf("archive.zip").media, "binary")
    assert.equal(kindOf("unknown.zzz").media, "text")
    assert.equal(kindOf("unknown.zzz").badge, "ZZZ")
})

test("relativeInside 只接受 base 内的路径", () => {
    assert.equal(relativeInside(root, root), "")
    assert.equal(relativeInside(root, join(root, "src/main.ts")), "src/main.ts")
    assert.equal(relativeInside(root, join(root, "..", "outside")), null)
    assert.equal(relativeInside(root, "/etc"), null)
})

test("createScopedFs 把子目录映射为独立工作区", async () => {
    const base = createPluginFileApi(root)
    const scoped = createScopedFs(base, "nested")
    assert.equal(await scoped.readText("deep/file.txt"), "hello from nested\n")
    assert.equal(await scoped.readText("missing.txt"), null)
    const entries = await scoped.list("")
    assert.deepEqual(
        entries.map((entry) => entry.name),
        ["deep"],
    )
    const stat = await scoped.stat("")
    assert.equal(stat?.type, "directory")
    await scoped.writeText("created.txt", "scoped")
    assert.equal(await base.readText("nested/created.txt"), "scoped")
    assert.equal(relativeInside(root, join(root, "nested")), "nested")
})

test("WorkspaceService 列举目录：目录在前，带完整相对路径", async () => {
    const entries = await service.list("")
    const names = entries.map((entry) => entry.name)
    assert.deepEqual(names, ["nested", "src", "package.json", "README.md"])
    assert.equal(entries[0]?.type, "directory")
    assert.equal(entries[0]?.path, "nested")
    const src = await service.list("src")
    assert.deepEqual(
        src.map((entry) => entry.path),
        ["src/main.ts"],
    )
})

test("WorkspaceService 读写与 mtime 冲突检测", async () => {
    const read = await service.read("src/main.ts")
    assert.match(read.content, /hello/)
    assert.equal(read.eol, "lf")

    const first = await service.write("src/new.ts", "const a = 1\n", 0)
    assert.ok(first.stat.mtimeMs > 0)
    const second = await service.read("src/new.ts")
    assert.equal(second.content, "const a = 1\n")

    await assert.rejects(
        () => service.write("src/new.ts", "const a = 2\n", second.stat.mtimeMs - 5000),
        /磁盘上被修改/,
    )

    const updated = await service.write("src/new.ts", "const a = 2\n", second.stat.mtimeMs)
    assert.ok(updated.stat.mtimeMs >= second.stat.mtimeMs)
    assert.equal((await service.read("src/new.ts")).content, "const a = 2\n")
})

test("WorkspaceService 新建、重命名与删除", async () => {
    await assert.rejects(() => service.create("missing/child.txt", "file"), /父目录不存在/)
    const dir = await service.create("scratch", "directory")
    assert.equal(dir.type, "directory")
    await assert.rejects(() => service.create("scratch", "directory"), /已存在/)

    const file = await service.create("scratch/one.txt", "file")
    assert.ok(file.exists)
    await service.write("scratch/one.txt", "hello")
    await service.rename("scratch/one.txt", "scratch/two.txt")
    assert.equal(await service.readTextAtRoot("scratch/one.txt"), null)
    assert.equal(await service.readTextAtRoot("scratch/two.txt"), "hello")

    await assert.rejects(() => service.rename("scratch", "scratch/inner"), /子目录/)
    await assert.rejects(() => service.rename("nope.txt", "other.txt"), /不存在/)

    await service.rename("scratch", "renamed")
    const entries = await service.list("")
    assert.ok(entries.some((entry) => entry.name === "renamed"))
    assert.equal(await service.readTextAtRoot("renamed/two.txt"), "hello")

    await service.remove("renamed")
    assert.equal(
        (await service.list("")).some((entry) => entry.name === "renamed"),
        false,
    )
    await assert.rejects(() => service.remove("renamed"), /不存在/)
    await assert.rejects(() => service.remove(""), /根目录/)
})

test("WorkspaceService 全文搜索与正则", async () => {
    const result = await service.searchText("hello")
    assert.ok(result.matchCount >= 2)
    const main = result.files.find((file) => file.path === "src/main.ts")
    assert.ok(main !== undefined)
    assert.equal(main?.matches[0]?.line, 1)
    assert.equal(main?.matches[0]?.column, 14)

    const nested = await service.searchText("nested")
    assert.ok(nested.files.some((file) => file.path === "nested/deep/file.txt"))

    const caseSensitive = await service.searchText("Hello", { caseSensitive: true })
    assert.equal(caseSensitive.matchCount, 0)

    const regex = await service.searchText("hel+o", { regex: true })
    assert.ok(regex.matchCount >= 1)
    await assert.rejects(() => service.searchText("(", { regex: true }), /不合法/)
    await assert.rejects(() => service.searchText("   "), /不能为空/)
})

test("WorkspaceService 快速打开文件索引", async () => {
    const result = await service.quickOpen("main")
    assert.ok(result.entries.includes("src/main.ts"))
    const empty = await service.quickOpen("")
    assert.ok(empty.entries.length >= 4)
    assert.ok(empty.total >= 4)
})

test("WorkspaceService statMany 返回存在状态", async () => {
    const stats = await service.statMany(["src/main.ts", "missing.txt"])
    assert.equal(stats[0]?.exists, true)
    assert.equal(stats[0]?.type, "file")
    assert.equal(stats[1]?.exists, false)
    assert.equal(stats[1]?.type, "missing")
})

test("搜索跳过 node_modules 等生成目录", async () => {
    await mkdir(join(root, "node_modules", "lib"), { recursive: true })
    await writeFile(join(root, "node_modules", "lib", "index.js"), "hello from dependency\n")
    const result = await service.searchText("dependency")
    assert.equal(
        result.files.some((file) => file.path.startsWith("node_modules")),
        false,
    )
})
