import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino, { type Logger } from "pino"

import type { PluginCommandContext } from "../src/api/host/plugin.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import { loadPlugins } from "../src/plugin/loader.ts"
import { withConsoleGuard } from "../src/plugin/console-guard.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"

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
        "error:插件 demo 使用了不推荐的 console logger ！",
        "info:demo hello world",
        "error:插件 demo 使用了不推荐的 console logger ！",
        "warn:demo careful",
    ])
})

test("loader 加载插件并注册命令", async () => {
    const dataDir = join(root, "data")
    const pluginDir = join(dataDir, "plugins", "demo-plugin")
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({
            name: "demo-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: { apiVersion: 1 },
        }),
    )
    await writeFile(
        join(pluginDir, "index.ts"),
        [
            "export default function register(api) {",
            "    api.registerCommand({",
            '        name: "hello",',
            '        summary: "hello",',
            "        run: (ctx) => {",
            '            api.output.info("run:" + ctx.argv.join(","))',
            "            return 7",
            "        },",
            "    })",
            "}",
        ].join("\n"),
    )

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
    assert.deepEqual(plugins[0]?.commands, ["hello"])

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
    assert.match(plugins[0]?.error ?? "", /apiVersion/)
})

test("pino silent logger 可用于 loader", () => {
    const logger = pino({ level: "silent" })
    assert.equal(typeof logger.child, "function")
})
