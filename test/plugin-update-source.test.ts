/*
 * plugin update：宿主按清单来源更新
 * - 服务在运行 → 拒绝
 * - 未声明来源 → 报错
 * - npm 渠道：查最新版本，已最新不重装；有新版下载安装（用假 registry）
 * - file 渠道：--from 本地目录（或安装记录）重装
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { AppSetting } from "../src/config/types.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { writeJsonAtomic } from "../src/platform/file.ts"
import { removePath } from "../src/platform/file.ts"
import { serviceRecordFile } from "../src/service/control.ts"
import { installPlugin } from "../src/plugin/install.ts"
import { findInstalledPlugin, updatePlugin } from "../src/plugin/update.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-plugin-update-cmd-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function paths(name: string): ResolvedPaths {
    return {
        configDir: join(root, name, "config"),
        dataDir: join(root, name, "data"),
        cacheDir: join(root, name, "cache"),
        logDir: join(root, name, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
}

function configWith(
    type: "npm" | "github" | "file",
    registry = "https://registry.test",
): AppSetting {
    return {
        ...DEFAULT_SETTINGS,
        plugins: { update: { type, registry, githubToken: null } },
    }
}

const logger = pino({ level: "silent" })

async function makePluginDir(
    name: string,
    manifest: Record<string, unknown>,
    version: string,
    body = "export function setup() { return null }\n",
): Promise<string> {
    const dir = join(root, "sources", `${name}-${version}`)
    await mkdir(dir, { recursive: true })
    await writeJsonAtomic(join(dir, "package.json"), {
        version,
        type: "module",
        main: "index.ts",
        ...manifest,
    })
    await writeFile(join(dir, "index.ts"), body)
    return dir
}

// 假 registry：latest 返回指定版本与 tarball 地址，不执行下载
function fakeNpmFetch(version: string): typeof fetch {
    return (async () =>
        new Response(
            JSON.stringify({ version, dist: { tarball: "https://registry.test/x.tgz" } }),
            { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch
}

test("update：有正在运行的 Wellspring 服务时拒绝", async () => {
    const target = paths("running")
    const source = await makePluginDir("running", { name: "running" }, "1.0.0")
    await installPlugin(source, target, {})
    await writeJsonAtomic(serviceRecordFile(target), {
        version: 1,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        cwd: root,
    })

    const result = await updatePlugin("running", {
        paths: target,
        config: configWith("npm"),
        logger,
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /wellspring stop/)
})

test("update：没有声明 wellspring.npm 时明确报错", async () => {
    const target = paths("no-source")
    const source = await makePluginDir("no-source", { name: "no-source" }, "1.0.0")
    await installPlugin(source, target, {})

    const result = await updatePlugin("no-source", {
        paths: target,
        config: configWith("npm"),
        logger,
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /wellspring\.npm/)
})

test("update：未安装的插件报错", async () => {
    const result = await updatePlugin("missing", {
        paths: paths("missing"),
        config: configWith("npm"),
        logger,
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /未安装/)
})

test("update：npm 渠道 checkOnly 报告可更新", async () => {
    const target = paths("npm-check")
    const source = await makePluginDir(
        "npm-check",
        {
            name: "@x/npm-check",
            wellspring: { apiVersion: 1, name: "npm-check", npm: "@x/npm-check" },
        },
        "1.0.0",
    )
    await installPlugin(source, target, {})

    const result = await updatePlugin("npm-check", {
        paths: target,
        config: configWith("npm"),
        logger,
        checkOnly: true,
        sources: { fetchImpl: fakeNpmFetch("2.0.0") },
    })
    assert.equal(result.ok, true)
    assert.equal(result.latestVersion, "2.0.0")
    assert.equal(result.changed, false)
    assert.match(result.message, /可更新/)
})

test("update：npm 已是最新时不重装", async () => {
    const target = paths("npm-latest")
    const source = await makePluginDir(
        "npm-latest",
        {
            name: "@x/npm-latest",
            wellspring: { apiVersion: 1, name: "npm-latest", npm: "@x/npm-latest" },
        },
        "1.0.0",
    )
    await installPlugin(source, target, {})

    const result = await updatePlugin("npm-latest", {
        paths: target,
        config: configWith("npm"),
        logger,
        sources: { fetchImpl: fakeNpmFetch("1.0.0") },
    })
    assert.equal(result.ok, true)
    assert.equal(result.changed, false)
    assert.match(result.message, /已是最新/)
})

test("update：file 渠道按 --from 目录重装，并记录来源", async () => {
    const target = paths("file-update")
    const first = await makePluginDir("file-update", { name: "file-demo" }, "1.0.0")
    await installPlugin(first, target, {})

    const second = await makePluginDir(
        "file-update",
        { name: "file-demo" },
        "1.0.1",
        "export function setup() { return { marker: 2 } }\n",
    )
    const result = await updatePlugin("file-demo", {
        paths: target,
        config: configWith("file"),
        logger,
        from: second,
    })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.changed, true)
    assert.equal(result.latestVersion, "1.0.1")

    const installed = await findInstalledPlugin("file-demo", target)
    assert.equal(installed?.version, "1.0.1")
    const manifest = JSON.parse(
        await readFile(join(target.dataDir, "plugins", "file-demo", "package.json"), "utf8"),
    ) as { wellspring?: { source?: unknown } }
    assert.deepEqual(manifest.wellspring?.source, { type: "file", spec: second })
})

test("update：file 渠道没有记录也没有 --from 时报错", async () => {
    const target = paths("file-no-from")
    const source = await makePluginDir("file-no-from", { name: "file-plain" }, "1.0.0")
    await installPlugin(source, target, {})

    const result = await updatePlugin("file-plain", {
        paths: target,
        config: configWith("file"),
        logger,
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /--from/)
})

test("findInstalledPlugin：按本地名 / 包名都能找到", async () => {
    const target = paths("find")
    const source = await makePluginDir(
        "find",
        { name: "@x/find-me", wellspring: { apiVersion: 1, name: "find-me" } },
        "1.0.0",
    )
    await installPlugin(source, target, {})
    assert.equal((await findInstalledPlugin("find-me", target))?.dir.endsWith("find-me"), true)
    assert.equal((await findInstalledPlugin("@x/find-me", target))?.id, "find-me")
    assert.equal(await findInstalledPlugin("nope", target), null)
    // 清理安装残留，隔离后续用例
    await removePath(join(target.dataDir, "plugins", "find-me"))
})
