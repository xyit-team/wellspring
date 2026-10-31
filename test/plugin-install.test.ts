/*
 * 插件包管理：packageManager 解析，以及安装时按声明自动安装依赖。
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import type { ResolvedPaths } from "../src/platform/path.ts"
import { makeZip } from "./helpers/zip.ts"
import { installPlugin } from "../src/plugin/install.ts"
import {
    lockfilePackageManager,
    parsePackageManager,
    pluginInstallCommand,
} from "../src/plugin/package-manager.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-plugin-install-test-"))
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

test("packageManager 解析：支持 npm/pnpm/yarn/bun 与版本号", () => {
    assert.deepEqual(parsePackageManager("npm@11.20.0"), {
        name: "npm",
        version: "11.20.0",
    })
    assert.deepEqual(parsePackageManager("pnpm"), { name: "pnpm", version: null })
    assert.deepEqual(parsePackageManager("pnpm@10.0.0+sha512.abc"), {
        name: "pnpm",
        version: "10.0.0+sha512.abc",
    })
    assert.deepEqual(parsePackageManager(" Yarn@1.22.22 "), {
        name: "yarn",
        version: "1.22.22",
    })
    assert.deepEqual(parsePackageManager("bun@1"), { name: "bun", version: "1" })
    assert.equal(parsePackageManager("npm@; rm -rf /"), null)
    assert.equal(parsePackageManager("unknown@1"), null)
    assert.equal(parsePackageManager(""), null)
})

test("lockfile 推断与安装命令", () => {
    assert.equal(lockfilePackageManager(["pnpm-lock.yaml"])?.name, "pnpm")
    assert.equal(lockfilePackageManager(["package-lock.json"])?.name, "npm")
    assert.equal(lockfilePackageManager(["yarn.lock"])?.name, "yarn")
    assert.equal(lockfilePackageManager(["bun.lock"])?.name, "bun")
    assert.equal(lockfilePackageManager(["index.ts"]), null)

    const npm = parsePackageManager("npm@11")
    assert.ok(npm !== null)
    assert.deepEqual(pluginInstallCommand(npm).args, [
        "install",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
    ])
})

test("zip 安装：按 packageManager 自动安装依赖", async () => {
    const zip = makeZip({
        "package.json": JSON.stringify({
            name: "dep-plugin",
            version: "1.0.0",
            packageManager: "npm@11.20.0",
            dependencies: { "fake-package": "1.0.0" },
        }),
        "index.ts": "export function setup() { return null }\n",
    })
    const zipPath = join(root, "dep-plugin.zip")
    await writeFile(zipPath, zip)
    const calls: Array<{ dir: string; manager: string }> = []
    const installed = await installPlugin(zipPath, paths(), {
        runInstall: async (dir, manager) => {
            calls.push({ dir, manager: manager.name })
            await mkdir(join(dir, "node_modules", "fake-package"), { recursive: true })
            await writeFile(join(dir, "node_modules", "fake-package", "index.js"), "")
        },
    })
    assert.equal(installed.packageManager, "npm@11.20.0")
    assert.equal(installed.dependenciesInstalled, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.manager, "npm")
    const files = await readdir(join(installed.target, "node_modules"))
    assert.deepEqual(files, ["fake-package"])
    // 临时目录都已清理
    const leftovers = (await readdir(join(paths().dataDir, "plugins"))).filter((name) =>
        name.startsWith(".install-"),
    )
    assert.deepEqual(leftovers, [])
})

test("目录安装：在暂存区安装依赖，不污染源目录", async () => {
    const source = join(root, "source-plugin")
    await mkdir(join(source, "node_modules", "old"), { recursive: true })
    await writeFile(join(source, "node_modules", "old", "index.js"), "")
    await writeFile(
        join(source, "package.json"),
        JSON.stringify({
            name: "source-plugin",
            version: "1.0.0",
            packageManager: "pnpm@10.0.0",
            dependencies: { "fake-package": "1.0.0" },
        }),
    )
    await writeFile(join(source, "index.ts"), "export function setup() { return null }\n")

    let installDir = ""
    const installed = await installPlugin(source, paths(), {
        runInstall: async (dir) => {
            installDir = dir
            assert.notEqual(dir, source)
            await mkdir(join(dir, "node_modules", "fresh"), { recursive: true })
        },
    })
    assert.notEqual(installDir, source)
    assert.equal(installed.packageManager, "pnpm@10.0.0")
    assert.deepEqual(await readdir(join(installed.target, "node_modules")), ["fresh"])
    // 源目录的旧 node_modules 没有被复制，也没有被改动
    assert.deepEqual(await readdir(join(source, "node_modules")), ["old"])
})

test("有依赖但没声明 packageManager 时拒绝安装", async () => {
    const zip = makeZip({
        "package.json": JSON.stringify({
            name: "no-manager",
            version: "1.0.0",
            dependencies: { "fake-package": "1.0.0" },
        }),
        "index.ts": "export function setup() { return null }\n",
    })
    const zipPath = join(root, "no-manager.zip")
    await writeFile(zipPath, zip)
    await assert.rejects(
        installPlugin(zipPath, paths(), { runInstall: async () => undefined }),
        /packageManager/,
    )
    assert.equal((await readdir(join(paths().dataDir, "plugins"))).includes("no-manager"), false)
})

test("声明非法 packageManager 时拒绝安装", async () => {
    const zip = makeZip({
        "package.json": JSON.stringify({
            name: "bad-manager",
            version: "1.0.0",
            packageManager: "sh@1",
            dependencies: { x: "1" },
        }),
        "index.ts": "export function setup() { return null }\n",
    })
    const zipPath = join(root, "bad-manager.zip")
    await writeFile(zipPath, zip)
    await assert.rejects(installPlugin(zipPath, paths()), /packageManager 不合法/)
})

test("没有 dependencies 时不运行包管理器", async () => {
    const zip = makeZip({
        "package.json": JSON.stringify({
            name: "plain",
            version: "1.0.0",
            packageManager: "npm@11",
        }),
        "index.ts": "export function setup() { return null }\n",
    })
    const zipPath = join(root, "plain.zip")
    await writeFile(zipPath, zip)
    let called = false
    const installed = await installPlugin(zipPath, paths(), {
        runInstall: async () => {
            called = true
        },
    })
    assert.equal(called, false)
    assert.equal(installed.dependenciesInstalled, false)
    assert.equal(installed.packageManager, null)
})
