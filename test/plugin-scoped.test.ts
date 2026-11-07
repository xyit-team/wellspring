/*
 * 作用域插件：@scope/name 作为 id，plugin-data 与配置文件按 id 嵌套
 * 安装落盘用本地名（包名最后一段），目录单层
 * 覆盖发现、路径构造、安装、启用状态与无 scope 的兼容
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, afterEach, before, test } from "node:test"

import pino from "pino"

import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { installPlugin } from "../src/plugin/install.ts"
import { loadPlugins } from "../src/plugin/loader.ts"
import { PLUGIN_ID, listPluginDirs, pluginDirOf, pluginIdSegments } from "../src/plugin/paths.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import { pluginConfigFile, pluginDataDir } from "../src/plugin/runtime.ts"
import { readPluginState, setPluginEnabled } from "../src/plugin/state.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"
import { makeZip } from "./helpers/zip.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-scoped-"))
})

after(async () => {
    await shutdownAllSandboxPlugins()
    await rm(root, { recursive: true, force: true })
})

afterEach(async () => {
    await shutdownAllSandboxPlugins()
})

function paths(dataDir: string): ResolvedPaths {
    return {
        configDir: join(dataDir, "config"),
        dataDir,
        cacheDir: join(dataDir, "cache"),
        logDir: join(dataDir, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
}

function source(id: string, version = "1.0.0"): string {
    return [
        "export function setup() {",
        "    return {",
        `        id: ${JSON.stringify(id)},`,
        '        name: "Scoped",',
        `        version: ${JSON.stringify(version)},`,
        '        status: "ok",',
        "    }",
        "}",
        "",
    ].join("\n")
}

// 直接在 plugins/<id> 下写入插件
async function writePlugin(dataDir: string, id: string): Promise<string> {
    const dir = pluginDirOf(join(dataDir, "plugins"), id)
    assert.ok(dir !== null)
    await mkdir(dir, { recursive: true })
    await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: id, version: "1.0.0", type: "module", main: "index.ts" }),
    )
    await writeFile(join(dir, "index.ts"), source(id))
    return dir
}

async function load(dataDir: string) {
    const sandbox = { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" as const }
    return await loadPlugins({
        paths: paths(dataDir),
        config: { ...DEFAULT_SETTINGS, sandbox },
        logger: pino({ level: "silent" }),
        registry: new PluginRegistry(),
        agentTools: new AgentToolRegistry(),
        sandbox,
        sandboxBackend: new DirectBackend(),
    })
}

test("PLUGIN_ID：接受 scope，拒绝路径穿越与非法字符", () => {
    assert.equal(PLUGIN_ID.test("wellspring-core"), true)
    assert.equal(PLUGIN_ID.test("@xyit/wellspring-core"), true)
    assert.equal(PLUGIN_ID.test("@xyit/wellspring.core-v2"), true)
    for (const bad of [
        "@xyit/",
        "@/name",
        "/name",
        "@xyit/../evil",
        "a/b/c",
        "../evil",
        ".",
        "@xyit",
        "",
    ]) {
        assert.equal(PLUGIN_ID.test(bad), false, `应拒绝：${bad}`)
    }
})

test("pluginIdSegments：scope 拆两段，无 scope 一段", () => {
    assert.deepEqual(pluginIdSegments("@xyit/x"), ["@xyit", "x"])
    assert.deepEqual(pluginIdSegments("x"), ["x"])
    assert.equal(pluginIdSegments("../x"), null)
})

test("pluginDataDir / pluginConfigFile：scope 走嵌套，无 scope 保持旧路径", () => {
    const p = paths("/data")
    assert.equal(pluginDataDir("x", p), join("/data", "plugin-data", "x"))
    assert.equal(pluginDataDir("@xyit/x", p), join("/data", "plugin-data", "@xyit", "x"))
    assert.equal(pluginConfigFile("x", p), join("/data", "config", "plugins", "x.json"))
    assert.equal(
        pluginConfigFile("@xyit/x", p),
        join("/data", "config", "plugins", "@xyit", "x.json"),
    )
    assert.throws(() => pluginDataDir("../x", p), /插件 id 不合法/)
})

test("listPluginDirs：发现 @scope 下的插件，跳过非插件条目", async () => {
    const dir = join(root, "list")
    await writePlugin(dir, "@xyit/scoped-a")
    await writePlugin(dir, "@xyit/scoped-b")
    await writePlugin(dir, "plain")
    await mkdir(join(dir, "plugins", ".hidden"), { recursive: true })
    await writeFile(join(dir, "plugins", "stray.txt"), "x")

    const found = await listPluginDirs(join(dir, "plugins"))
    assert.deepEqual(
        found.map((item) => item.id),
        ["@xyit/scoped-a", "@xyit/scoped-b", "plain"],
    )
    assert.equal(found[0]?.dirName, "scoped-a")
})

test("loadPlugins：作用域插件被加载，id 为完整 scope", async () => {
    const dir = join(root, "load")
    await writePlugin(dir, "@xyit/loaded")
    const plugins = await load(dir)
    const target = plugins.find((plugin) => plugin.id === "@xyit/loaded")
    assert.equal(target?.status, "ok", target?.error ?? "未加载")
    assert.equal(target?.name, "Scoped")
})

test("loadPlugins：作用域与普通插件并存", async () => {
    const dir = join(root, "both")
    await writePlugin(dir, "@xyit/mixed")
    await writePlugin(dir, "plain-mixed")
    const ids = (await load(dir)).map((plugin) => plugin.id).sort()
    assert.deepEqual(ids, ["@xyit/mixed", "plain-mixed"])
})

test("启用状态：作用域 id 作 key，互不影响", async () => {
    const dir = join(root, "state")
    await writePlugin(dir, "@xyit/off")
    await writePlugin(dir, "on-plugin")
    await setPluginEnabled("@xyit/off", false, paths(dir))
    const disabled = await readPluginState(paths(dir))
    assert.equal(disabled.has("@xyit/off"), true)
    assert.equal(disabled.has("on-plugin"), false)

    const plugins = await load(dir)
    assert.equal(plugins.find((plugin) => plugin.id === "@xyit/off")?.status, "disabled")
    assert.equal(plugins.find((plugin) => plugin.id === "on-plugin")?.status, "ok")
})

test("installPlugin：带 scope 的包名落到单层 plugins/<本地名>", async () => {
    const dir = join(root, "install")
    await mkdir(dir, { recursive: true })
    const zip = join(dir, "scoped.zip")
    await writeFile(
        zip,
        makeZip({
            "package.json": JSON.stringify({
                name: "@xyit/installed",
                version: "2.0.0",
                type: "module",
                main: "index.ts",
            }),
            "index.ts": source("@xyit/installed", "2.0.0"),
        }),
    )
    const result = await installPlugin(zip, paths(dir), {})
    // 1.7 起目录用本地名（包名最后一段），与 scope 无关
    assert.equal(result.id, "installed")
    assert.equal(result.packageName, "@xyit/installed")
    assert.equal(result.target, join(dir, "plugins", "installed"))
    const pkg = JSON.parse(await readFile(join(result.target, "package.json"), "utf8")) as {
        name: string
    }
    assert.equal(pkg.name, "@xyit/installed")
})
