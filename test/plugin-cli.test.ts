/*
 * plugin 命令：只改文件、不启动插件；remove 发现依赖时要求 --ignore
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { runPluginCommand } from "../src/commands/plugin.ts"
import type { CommandContext } from "../src/commands/shared.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { Elog } from "../src/logger/elog4js.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { pluginsRoot } from "../src/plugin/paths.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-plugin-cli-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

function context(): CommandContext & { loadCalls: number } {
    const paths = {
        configDir: join(root, "config"),
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        logDir: join(root, "logs"),
        sources: {
            configDir: "override" as const,
            dataDir: "override" as const,
            cacheDir: "override" as const,
            logDir: "override" as const,
        },
    }
    const elog = new Elog({
        stdout: { write: () => true },
        stderr: { write: () => true },
        json: true,
    })
    const ctx = {
        loadCalls: 0,
        global: { json: true, quiet: true, help: false, version: false },
        settings: DEFAULT_SETTINGS,
        settingsFile: join(paths.configDir, "app-setting.json"),
        configCode: null,
        paths,
        logger: pino({ level: "silent" }),
        elog,
        registry: new PluginRegistry(),
        agentTools: new AgentToolRegistry(),
        openai: null,
        async loadPlugins() {
            ctx.loadCalls += 1
            throw new Error("plugin 命令不应启动插件")
        },
    }
    return ctx
}

async function writePlugin(dirName: string, deps: string[]): Promise<string> {
    const dir = join(pluginsRoot(context().paths), dirName)
    await mkdir(dir, { recursive: true })
    await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: dirName, version: "1.0.0", main: "index.ts" }),
    )
    await writeFile(
        join(dir, "index.ts"),
        `export function setup() {\n    return {\n        id: "${dirName}",\n        name: "${dirName}",\n        version: "1.0.0",\n        deps: ${JSON.stringify(deps)},\n    }\n}\n`,
    )
    return dir
}

test("plugin list / enable / disable 只读文件，不启动插件", async () => {
    const ctx = context()
    await writePlugin("alpha", [])
    const listed = await runPluginCommand(ctx, ["list"])
    assert.equal(listed.result.isSuccess(), true)
    assert.equal(ctx.loadCalls, 0, "list 不应该加载插件")

    const disabled = await runPluginCommand(ctx, ["disable", "alpha"])
    assert.equal(disabled.result.isSuccess(), true)
    const enabled = await runPluginCommand(ctx, ["enable", "alpha"])
    assert.equal(enabled.result.isSuccess(), true)
    assert.equal(ctx.loadCalls, 0)
})

test("link / install 直接写文件，不加载插件", async () => {
    const ctx = context()
    const source = join(root, "source-plugin")
    await mkdir(source, { recursive: true })
    await writeFile(
        join(source, "package.json"),
        JSON.stringify({ name: "source-plugin", version: "1.0.0", main: "index.ts" }),
    )
    await writeFile(join(source, "index.ts"), "export function setup() { return null }\n")

    const linked = await runPluginCommand(ctx, ["link", source])
    assert.equal(linked.result.isSuccess(), true, JSON.stringify(linked.result.getCode()))
    const installSource = join(root, "install-plugin")
    await mkdir(installSource, { recursive: true })
    await writeFile(
        join(installSource, "package.json"),
        JSON.stringify({ name: "install-plugin", version: "1.0.0", main: "index.ts" }),
    )
    await writeFile(join(installSource, "index.ts"), "export function setup() { return null }\n")
    const installed = await runPluginCommand(ctx, ["install", installSource])
    assert.equal(installed.result.isSuccess(), true, JSON.stringify(installed.result.getCode()))
    assert.equal(ctx.loadCalls, 0)
})

test("卸载被依赖的插件会被拒绝，--ignore 可强制删除", async () => {
    const ctx = context()
    const core = await writePlugin("core", [])
    await writePlugin("consumer", ["core"])
    assert.equal((await stat(core)).isDirectory(), true)

    const refused = await runPluginCommand(ctx, ["remove", "core"])
    assert.equal(refused.result.isSuccess(), false)
    assert.match(refused.result.getCode() ?? "", /plugin\.has-dependents:consumer/)
    assert.equal((await stat(core)).isDirectory(), true, "拒绝后插件目录保留")
    assert.equal(ctx.loadCalls, 0)

    const forced = await runPluginCommand(ctx, ["remove", "core", "--ignore"])
    assert.equal(forced.result.isSuccess(), true, JSON.stringify(forced.result.getCode()))
    await assert.rejects(() => stat(core))
    assert.equal(ctx.loadCalls, 0)

    const consumer = join(pluginsRoot(context().paths), "consumer")
    const source = await readFile(join(consumer, "index.ts"), "utf8")
    assert.match(source, /deps/)
})

test("remove：悬空符号链接按目录名删除", async () => {
    const ctx = context()
    const rootDir = pluginsRoot(ctx.paths)
    await mkdir(rootDir, { recursive: true })
    const link = join(rootDir, "ghost-plugin")
    await symlink(join(root, "missing-source"), link)
    await assert.rejects(() => stat(link), "先确认链接是悬空的")

    const outcome = await runPluginCommand(ctx, ["remove", "ghost-plugin"])
    assert.equal(outcome.result.isSuccess(), true, JSON.stringify(outcome.result.getCode()))
    await assert.rejects(() => stat(link))
    assert.equal(ctx.loadCalls, 0)
})

test("install：裸包名提示补 npm: / github: 前缀", async () => {
    const ctx = context()
    const outcome = await runPluginCommand(ctx, ["install", "@xyit-team/wellspring-gateway"])
    assert.equal(outcome.result.isSuccess(), false)
    assert.match(outcome.result.getCode() ?? "", /npm:<包名> 或 github:<owner>\/<repo>/)
})
