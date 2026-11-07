/*
 * 宿主级工作区注册表：CRUD、去重、上限、损坏恢复与旧 wellspring-web 索引迁移
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import type { ResolvedPaths } from "../src/platform/path.ts"
import {
    MAX_WORKSPACES,
    addWorkspace,
    legacyWorkspaceRegistryFile,
    listWorkspaces,
    parseWorkspaceEntries,
    removeWorkspace,
    renameWorkspace,
    resetWorkspaceRegistry,
    touchWorkspace,
    workspaceIdFor,
    workspaceRegistryFile,
} from "../src/workspace/registry.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-workspace-registry-"))
})

after(async () => {
    resetWorkspaceRegistry()
    await rm(root, { recursive: true, force: true })
})

function pathsAt(name: string): ResolvedPaths {
    const base = join(root, name)
    return {
        configDir: join(base, "config"),
        dataDir: join(base, "data"),
        cacheDir: join(base, "cache"),
        logDir: join(base, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
}

async function makeDir(name: string): Promise<string> {
    const path = join(root, "dirs", name)
    await mkdir(path, { recursive: true })
    return path
}

test("工作区 id 由路径派生且稳定", () => {
    const first = workspaceIdFor("/home/me/projects/Wellspring")
    assert.equal(first, workspaceIdFor("/home/me/projects/Wellspring"))
    assert.match(first, /^wellspring-[0-9a-f]{10}$/)
    assert.match(workspaceIdFor("/home/me/中文目录"), /^workspace-[0-9a-f]{10}$/)
    assert.notEqual(first, workspaceIdFor("/home/me/projects/Wellspring2"))
})

test("工作区注册表：添加、去重、重命名、touch 与移除", async () => {
    const paths = pathsAt("crud")
    resetWorkspaceRegistry(paths)
    const alpha = await makeDir("alpha")
    const beta = await makeDir("beta")

    const added = await addWorkspace({ root: alpha }, paths)
    assert.equal(added.duplicate, false)
    assert.equal(added.workspace.root, alpha)
    assert.equal(added.workspace.name, "alpha")
    assert.match(added.workspace.id, /^alpha-[0-9a-f]{10}$/)

    const duplicate = await addWorkspace({ root: alpha, name: "Alpha 项目" }, paths)
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.workspace.id, added.workspace.id)
    // 重复添加不覆盖名称，只刷新 lastSeenAt
    assert.equal(duplicate.workspace.name, "alpha")

    await addWorkspace({ root: beta, name: "Beta" }, paths)
    let list = await listWorkspaces(paths)
    assert.equal(list.workspaces.length, 2)
    assert.equal(list.workspaces[0]?.root, beta, "新添加的排在最前")

    const renamed = await renameWorkspace(added.workspace.id, "Alpha 改名", paths)
    assert.equal(renamed?.name, "Alpha 改名")
    assert.equal(await renameWorkspace("not-exist", "x", paths), null)
    await assert.rejects(() => renameWorkspace(added.workspace.id, " ", paths))

    const touched = await touchWorkspace(added.workspace.id, paths)
    assert.ok(touched !== null && touched.lastSeenAt >= added.workspace.lastSeenAt)
    assert.equal(await touchWorkspace("not-exist", paths), null)

    const removed = await removeWorkspace(added.workspace.id, paths)
    assert.equal(removed.removed, true)
    assert.equal((await removeWorkspace(added.workspace.id, paths)).removed, false)
    list = await listWorkspaces(paths)
    assert.deepEqual(
        list.workspaces.map((entry) => entry.name),
        ["Beta"],
    )

    // 落盘格式：<dataDir>/workspaces.json，v1
    const persisted = JSON.parse(await readFile(workspaceRegistryFile(paths), "utf8")) as {
        v: number
        workspaces: Array<{ id: string; root: string }>
    }
    assert.equal(persisted.v, 1)
    assert.equal(persisted.workspaces.length, 1)
    assert.equal(persisted.workspaces[0]?.root, beta)

    // 目录本身不被删除
    assert.equal((await stat(beta)).isDirectory(), true)
    resetWorkspaceRegistry(paths)
})

test("工作区注册表：路径校验、名称校验与数量上限", async () => {
    const paths = pathsAt("limits")
    resetWorkspaceRegistry(paths)
    await assert.rejects(() => addWorkspace({ root: "" }, paths), /不能为空/)
    await assert.rejects(
        () => addWorkspace({ root: join(root, "dirs", "missing-dir") }, paths),
        /目录不存在/,
    )
    const notDir = join(root, "dirs", "a-file")
    await mkdir(join(root, "dirs"), { recursive: true })
    await writeFile(notDir, "x")
    await assert.rejects(() => addWorkspace({ root: notDir }, paths), /目录不存在/)

    for (let index = 0; index < MAX_WORKSPACES; index += 1) {
        const dir = await makeDir(`many-${index}`)
        await addWorkspace({ root: dir }, paths)
    }
    const overflow = await makeDir("overflow")
    await assert.rejects(() => addWorkspace({ root: overflow }, paths), /上限/)
    resetWorkspaceRegistry(paths)
})

test("工作区注册表：损坏文件移到 .broken 后按空表启动", async () => {
    const paths = pathsAt("broken")
    resetWorkspaceRegistry(paths)
    const file = workspaceRegistryFile(paths)
    await mkdir(join(paths.dataDir), { recursive: true })
    await writeFile(file, "{ broken json", "utf8")
    const list = await listWorkspaces(paths)
    assert.deepEqual(list.workspaces, [])
    const broken = await readFile(`${file}.broken`, "utf8")
    assert.equal(broken, "{ broken json")
    resetWorkspaceRegistry(paths)
})

test("工作区注册表：首次加载导入旧版 wellspring-web 索引", async () => {
    const paths = pathsAt("legacy")
    resetWorkspaceRegistry(paths)
    const dir = await makeDir("legacy-project")
    const legacyFile = legacyWorkspaceRegistryFile(paths)
    await mkdir(join(legacyFile, ".."), { recursive: true })
    await writeFile(
        legacyFile,
        JSON.stringify({
            v: 2,
            workspaces: [
                {
                    id: workspaceIdFor(dir),
                    name: "旧项目",
                    root: dir,
                    conversationCount: 3,
                    createdAt: 111,
                    lastSeenAt: 222,
                },
                { id: "bad", root: "", name: "非法" },
            ],
        }),
        "utf8",
    )
    const list = await listWorkspaces(paths)
    assert.equal(list.workspaces.length, 1)
    assert.equal(list.workspaces[0]?.id, workspaceIdFor(dir))
    assert.equal(list.workspaces[0]?.name, "旧项目")
    assert.equal(list.workspaces[0]?.lastSeenAt, 222)
    // 迁移结果写进宿主注册表；旧文件保持原样便于回滚
    const stored = JSON.parse(await readFile(workspaceRegistryFile(paths), "utf8")) as {
        workspaces: Array<{ root: string }>
    }
    assert.equal(stored.workspaces[0]?.root, dir)
    assert.equal((await stat(legacyFile)).isFile(), true)
    resetWorkspaceRegistry(paths)
})

test("工作区注册表：解析旧格式与非法条目", () => {
    const entries = parseWorkspaceEntries({
        workspaces: [
            { id: "keep-1", name: "A", root: "/tmp/a", createdAt: 1, lastSeenAt: 2 },
            { id: "keep-1", name: "重复 id", root: "/tmp/b" },
            { id: "x", root: "/tmp/a" },
            { name: "没有路径" },
            "junk",
        ],
    })
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.id, "keep-1")
    assert.equal(entries[0]?.root, "/tmp/a")
    assert.deepEqual(parseWorkspaceEntries(null), [])
    const fromArray = parseWorkspaceEntries([{ root: "/tmp/c" }])
    assert.equal(fromArray.length, 1)
    assert.equal(fromArray[0]?.id, workspaceIdFor("/tmp/c"))
    assert.equal(fromArray[0]?.name, "c")
    assert.equal(typeof fromArray[0]?.createdAt, "number")
})

test("工作区注册表：按路径重新加载（新进程模拟）", async () => {
    const paths = pathsAt("reload")
    resetWorkspaceRegistry(paths)
    const dir = await makeDir("reload-project")
    const added = await addWorkspace({ root: dir, name: "重载" }, paths)
    resetWorkspaceRegistry(paths)
    const list = await listWorkspaces(paths)
    assert.equal(list.workspaces.length, 1)
    assert.equal(list.workspaces[0]?.id, added.workspace.id)
    assert.equal(list.workspaces[0]?.name, "重载")
    resetWorkspaceRegistry(paths)
})
