/*
 * 目录规则：本地名（wellspring.name）决定 plugins/<本地名> 与 plugin-data/<本地名>，
 * 与 npm scope 无关；旧布局 plugins/@scope/name 仍可读，update 时迁到单层
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import type { ResolvedPaths } from "../src/platform/path.ts"
import {
    hasDeclaredLocalName,
    manifestLocalName,
    packageLocalName,
    readPluginManifest,
    writePluginSource,
} from "../src/plugin/manifest.ts"
import { installPlugin } from "../src/plugin/install.ts"
import { listPluginDirs } from "../src/plugin/paths.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-plugin-layout-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function paths(name = "case"): ResolvedPaths {
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

async function writePluginSourceDir(
    dirName: string,
    manifest: Record<string, unknown>,
    version = "1.0.0",
): Promise<string> {
    const dir = join(root, "src", dirName)
    await mkdir(dir, { recursive: true })
    await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
            version,
            type: "module",
            main: "index.ts",
            ...manifest,
        }),
    )
    await writeFile(join(dir, "index.ts"), "export function setup() { return null }\n")
    return dir
}

test("packageLocalName：取包名最后一段并清洗非法字符", () => {
    assert.equal(packageLocalName("@xyit/test"), "test")
    assert.equal(packageLocalName("@etheros/wellspring-core"), "wellspring-core")
    assert.equal(packageLocalName("demo"), "demo")
    assert.equal(packageLocalName("@x/a b"), "a-b")
    assert.equal(packageLocalName(""), null)
    assert.equal(packageLocalName("@x/"), null)
})

test("manifestLocalName：wellspring.name 优先，没有时回退包名", () => {
    assert.equal(manifestLocalName({ name: "@xyit/test" }), "test")
    assert.equal(manifestLocalName({ name: "@xyit/test", wellspring: { name: "demo" } }), "demo")
    assert.equal(manifestLocalName({ name: "@xyit/test", wellspring: { name: "../x" } }), null)
    assert.equal(manifestLocalName(null), null)
    assert.equal(hasDeclaredLocalName({ name: "x" }), false)
    assert.equal(hasDeclaredLocalName({ name: "x", wellspring: { name: "demo" } }), true)
})

test("installPlugin：带 scope 的包名落到 plugins/<本地名>（单层）", async () => {
    const source = await writePluginSourceDir("scoped-src", { name: "@xyit/installed" })
    const result = await installPlugin(source, paths("scoped"))
    assert.equal(result.id, "installed")
    assert.equal(result.packageName, "@xyit/installed")
    assert.equal(result.target, join(root, "scoped", "data", "plugins", "installed"))
})

test("installPlugin：wellspring.name 决定目录，与包名无关", async () => {
    const source = await writePluginSourceDir("declared-src", {
        name: "@xyit/test",
        wellspring: { apiVersion: 1, name: "demo" },
    })
    const result = await installPlugin(source, paths("declared"))
    assert.equal(result.id, "demo")
    assert.equal(result.target, join(root, "declared", "data", "plugins", "demo"))
    const manifest = await readPluginManifest(result.target)
    assert.deepEqual(manifest?.wellspring?.name, "demo")
})

test("installPlugin：安装来源写进已装 package.json", async () => {
    const source = await writePluginSourceDir("source-src", { name: "with-source" })
    const result = await installPlugin(source, paths("source"), {
        source: { type: "npm", spec: "@x/with-source" },
    })
    const manifest = await readPluginManifest(result.target)
    assert.deepEqual(manifest?.wellspring?.source, { type: "npm", spec: "@x/with-source" })
})

test("writePluginSource：只增字段，不动其它内容", async () => {
    const source = await writePluginSourceDir("merge-src", {
        name: "merge",
        wellspring: { apiVersion: 1, name: "merge" },
    })
    await writePluginSource(source, { type: "file", spec: "/tmp/merge" })
    const raw = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as {
        name?: string
        wellspring?: { apiVersion?: number; name?: string; source?: unknown }
    }
    assert.equal(raw.name, "merge")
    assert.equal(raw.wellspring?.apiVersion, 1)
    assert.deepEqual(raw.wellspring?.source, { type: "file", spec: "/tmp/merge" })
})

test("installPlugin update：把旧布局 plugins/@scope/<本地名> 迁到单层", async () => {
    const target = paths("legacy")
    const legacyDir = join(target.dataDir, "plugins", "@xyit", "legacy-plugin")
    await mkdir(legacyDir, { recursive: true })
    await writeFile(
        join(legacyDir, "package.json"),
        JSON.stringify({ name: "@xyit/legacy-plugin", version: "1.0.0", main: "index.ts" }),
    )
    await writeFile(join(legacyDir, "index.ts"), "export function setup() { return null }\n")

    const source = await writePluginSourceDir("legacy-src", {
        name: "@xyit/legacy-plugin",
        wellspring: { apiVersion: 1, name: "legacy-plugin" },
    })
    const result = await installPlugin(source, target, { mode: "update" })
    assert.equal(result.target, join(target.dataDir, "plugins", "legacy-plugin"))
    const legacyStillThere = await stat(legacyDir).catch(() => null)
    assert.equal(legacyStillThere, null, "旧布局目录应该被移除")
})

test("listPluginDirs：单层是新布局，@scope 目录标 legacy", async () => {
    const target = paths("list")
    const rootDir = join(target.dataDir, "plugins")
    await mkdir(join(rootDir, "demo"), { recursive: true })
    await mkdir(join(rootDir, "@xyit", "old"), { recursive: true })
    const entries = await listPluginDirs(rootDir)
    const demo = entries.find((entry) => entry.id === "demo")
    const old = entries.find((entry) => entry.id === "@xyit/old")
    assert.equal(demo?.legacy, false)
    assert.equal(old?.legacy, true)
    assert.equal(old?.dirName, "old")
})
