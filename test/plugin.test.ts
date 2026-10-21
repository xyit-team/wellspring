import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino, { type Logger } from "pino"

import { emitBeforeMessage } from "../src/api/host/hooks.ts"
import type { PluginCommandContext } from "../src/api/host/plugin.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import { withConsoleGuard } from "../src/plugin/console-guard.ts"
import { installPlugin } from "../src/plugin/install.ts"
import { loadPlugins } from "../src/plugin/loader.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import { scaffoldPlugin } from "../src/plugin/scaffold.ts"
import { resolve } from "node:path"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { makeZip } from "./helpers/zip.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-plugin-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

function fakeLogger(): { logger: Logger; lines: string[] } {
    const lines: string[] = []
    const push = (text: string): void => {
        lines.push(text)
    }
    const logger = {
        error: (text: string) => push(`error:${text}`),
        info: (text: string) => push(`info:${text}`),
        warn: (text: string) => push(`warn:${text}`),
        debug: (text: string) => push(`debug:${text}`),
        trace: (text: string) => push(`trace:${text}`),
        child: () => logger,
    } as unknown as Logger
    return { logger, lines }
}

function tempPaths(dataDir: string): ResolvedPaths {
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

const PLUGIN_SOURCE = [
    'import { beforeMessage } from "wellspring/api/host/index.ts"',
    "",
    'beforeMessage(({ prompt }) => { prompt.push("hook-system") })',
    "",
    "export function setup() {",
    "    return {",
    '        id: "demo-plugin",',
    '        name: "Demo Plugin",',
    '        version: "1.0.0",',
    '        deps: ["core"],',
    "        commands: [",
    "            {",
    '                name: "hello",',
    '                summary: "hello",',
    "                run: (ctx) => {",
    '                    ctx.output.info("run:" + ctx.argv.join(","))',
    "                    return 7",
    "                },",
    "            },",
    "        ],",
    "    }",
    "}",
].join("\n")

async function writePlugin(dataDir: string, dirName: string): Promise<string> {
    const pluginDir = join(dataDir, "plugins", dirName)
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({
            name: dirName,
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: { apiVersion: 1 },
        }),
    )
    await writeFile(join(pluginDir, "index.ts"), PLUGIN_SOURCE)
    return pluginDir
}

test("PluginRegistry 注册、别名与冲突", () => {
    const registry = new PluginRegistry(new Set(["chat"]))
    registry.register("demo", {
        name: "hello",
        summary: "hello",
        aliases: ["hi"],
        run: () => 0,
    })
    assert.equal(registry.resolve("hello")?.pluginName, "demo")
    assert.equal(registry.resolve("hi")?.pluginName, "demo")

    assert.throws(
        () => registry.register("demo", { name: "chat", summary: "x", run: () => 0 }),
        /不能覆盖内置命令/,
    )
    assert.throws(
        () => registry.register("demo", { name: "hello", summary: "x", run: () => 0 }),
        /重名/,
    )

    registry.removePlugin("demo")
    assert.equal(registry.resolve("hello"), undefined)
})

test("console 拦截：先 error 再按原级别输出", async () => {
    const { logger, lines } = fakeLogger()
    const originalLog = console.log
    await withConsoleGuard("demo", logger, async () => {
        console.log("hello", "world")
        console.warn("careful")
    })
    assert.equal(console.log, originalLog)
    assert.deepEqual(lines, [
        "error:插件 [demo] 使用了不推荐的 console logger ！",
        "info:demo hello world",
        "error:插件 [demo] 使用了不推荐的 console logger ！",
        "warn:demo careful",
    ])
})

test("loader 按 setup() 契约加载插件、注册命令与钩子", async () => {
    const dataDir = join(root, "data")
    await writePlugin(dataDir, "demo-plugin")

    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })

    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    const paths = tempPaths(dataDir)
    const plugins = await loadPlugins({
        paths,
        config: DEFAULT_SETTINGS,
        logger,
        registry,
    })

    assert.equal(plugins.length, 1)
    assert.equal(plugins[0]?.status, "ok")
    assert.equal(plugins[0]?.id, "demo-plugin")
    assert.equal(plugins[0]?.name, "Demo Plugin")
    assert.deepEqual(plugins[0]?.deps, ["core"])
    assert.deepEqual(plugins[0]?.commands, ["hello"])

    // 插件从 wellspring/api/host 注册的钩子应该生效
    const prompt: string[] = []
    await emitBeforeMessage({ input: "hi", context: process.cwd(), prompt })
    assert.deepEqual(prompt, ["hook-system"])

    const record = registry.resolve("hello")
    assert.ok(record !== undefined)
    const context: PluginCommandContext = {
        argv: ["a", "b"],
        env: process.env,
        paths,
        config: DEFAULT_SETTINGS,
        logger,
        output: {
            info: (text) => output.write(text),
            warn: (text) => output.write(text),
            error: (text) => output.write(text),
            print: (text = "") => output.write(text),
        },
        cwd: process.cwd(),
        json: false,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
    }
    const code = await record?.command.run(context)
    assert.equal(code, 7)
    assert.match(output.text, /run:a,b/)
})

test("loader 拒绝不支持的 apiVersion", async () => {
    const dataDir = join(root, "data2")
    const pluginDir = join(dataDir, "plugins", "old-plugin")
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: "old-plugin", version: "1.0.0", wellspring: { apiVersion: 99 } }),
    )
    await writeFile(join(pluginDir, "index.ts"), "export function setup() { return {} }")

    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    const plugins = await loadPlugins({
        paths: tempPaths(dataDir),
        config: DEFAULT_SETTINGS,
        logger,
        registry,
    })
    assert.equal(plugins[0]?.status, "failed")
    assert.match(plugins[0]?.error ?? "", /apiVersion/)
})

test("loader 拒绝缺少 setup 的入口", async () => {
    const dataDir = join(root, "data3")
    const pluginDir = join(dataDir, "plugins", "bad-plugin")
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, "package.json"), JSON.stringify({ name: "bad-plugin" }))
    await writeFile(join(pluginDir, "index.ts"), "export default function register() {}")

    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    const plugins = await loadPlugins({
        paths: tempPaths(dataDir),
        config: DEFAULT_SETTINGS,
        logger,
        registry,
    })
    assert.equal(plugins[0]?.status, "failed")
    assert.match(plugins[0]?.error ?? "", /setup/)
})

test("install 支持 zip，并自动去掉外层目录", async () => {
    const dataDir = join(root, "install-data")
    const zip = makeZip({
        "demo-plugin/package.json": JSON.stringify({
            name: "demo-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: { apiVersion: 1 },
        }),
        "demo-plugin/index.ts": PLUGIN_SOURCE,
    })
    const archive = join(root, "demo-plugin.zip")
    await writeFile(archive, zip)

    const installed = await installPlugin(archive, tempPaths(dataDir))
    assert.equal(installed.id, "demo-plugin")

    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    const plugins = await loadPlugins({
        paths: tempPaths(dataDir),
        config: DEFAULT_SETTINGS,
        logger,
        registry,
    })
    assert.equal(plugins[0]?.id, "demo-plugin")
    assert.equal(plugins[0]?.status, "ok")

    await assert.rejects(installPlugin(archive, tempPaths(dataDir)), /已存在/)
})

test("plugin new 生成的模板可安装、可加载、可触发顶层钩子", async () => {
    const parent = join(root, "scaffold")
    const created = await scaffoldPlugin({ name: "hello-demo", parentDir: parent })
    assert.equal(created.commandName, "hello-demo")

    const dataDir = join(root, "scaffold-data")
    const paths = tempPaths(dataDir)
    const installed = await installPlugin(created.dir, paths)
    assert.equal(installed.id, "hello-demo")

    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    const plugins = await loadPlugins({
        paths,
        config: DEFAULT_SETTINGS,
        logger,
        registry,
    })
    assert.equal(plugins[0]?.status, "ok")
    assert.deepEqual(plugins[0]?.commands, ["hello-demo"])

    const prompt: string[] = []
    await emitBeforeMessage({ input: "hi", context: process.cwd(), prompt })
    assert.match(prompt.join("\n"), /Wellspring 里的助手/)
})

test("仓库官方示例插件可安装并加载", async () => {
    const dataDir = join(root, "example-data")
    const example = resolve(import.meta.dirname, "../examples/hello-plugin")
    const installed = await installPlugin(example, tempPaths(dataDir))
    assert.equal(installed.id, "hello-plugin")

    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    const plugins = await loadPlugins({
        paths: tempPaths(dataDir),
        config: DEFAULT_SETTINGS,
        logger,
        registry,
    })
    assert.equal(plugins[0]?.status, "ok")
    assert.equal(plugins[0]?.id, "hello-plugin")
    assert.deepEqual(plugins[0]?.commands, ["hello"])
})

test("zip 拒绝路径穿越", async () => {
    const zip = makeZip({ "../evil.ts": "export function setup() {}" })
    const archive = join(root, "evil.zip")
    await writeFile(archive, zip)
    await assert.rejects(installPlugin(archive, tempPaths(join(root, "evil-data"))), /非法路径/)
})

test("pino silent logger 可用于 loader", () => {
    const logger = pino({ level: "silent" })
    assert.equal(typeof logger.child, "function")
})
