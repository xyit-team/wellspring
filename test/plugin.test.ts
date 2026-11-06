import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, afterEach, before, test } from "node:test"

import pino, { type Logger } from "pino"

import { getHost } from "../src/api/host/host.ts"
import { eventBus } from "../src/event/event.ts"
import { shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"
import { emitOnMessage } from "../src/api/host/hooks.ts"
import type { PluginCommandContext } from "../src/api/host/plugin.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import { withConsoleGuard } from "../src/plugin/console-guard.ts"
import { installPlugin } from "../src/plugin/install.ts"
import {
    getPluginRuntime,
    loadPlugins as loadPluginsCore,
    type LoadPluginsOptions,
} from "../src/plugin/loader.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { createPluginFileApi } from "../src/plugin/fs.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import { readPluginState, setPluginEnabled } from "../src/plugin/state.ts"
import { scaffoldPlugin } from "../src/plugin/scaffold.ts"
import { resolve } from "node:path"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { makeZip } from "./helpers/zip.ts"

function loadPlugins(options: LoadPluginsOptions) {
    return loadPluginsCore({
        ...options,
        sandboxBackend: options.sandboxBackend ?? new DirectBackend(),
    })
}

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-plugin-"))
})

after(async () => {
    await shutdownAllSandboxPlugins()
    await rm(root, { recursive: true, force: true })
})

afterEach(async () => {
    await shutdownAllSandboxPlugins()
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
    'import { onMessage } from "wellspring/api/host/index.ts"',
    "",
    'onMessage(({ phase, prompt }) => { if (phase === "before") prompt.push("hook-system") })',
    "",
    "export function setup() {",
    "    return {",
    '        id: "demo-plugin",',
    '        name: "Demo Plugin",',
    '        version: "1.0.0",',
    '        status: "ok",',
    "        deps: [],",
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
    assert.deepEqual(plugins[0]?.deps, [])
    assert.deepEqual(plugins[0]?.commands, ["hello"])
    assert.equal(
        getHost()
            .getPlugins()
            .some((plugin) => plugin.id === "demo-plugin"),
        true,
    )

    // 插件从 wellspring/api/host 注册的钩子应该生效
    const prompt: string[] = []
    await emitOnMessage({
        sessionId: "demo-plugin",
        mode: "chat",
        turn: 1,
        role: "user",
        phase: "before",
        content: "hi",
        prompt,
    })
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
        pluginDataDir: join(dataDir, "plugin-data", "demo-plugin"),
        pluginConfig: {},
        fs: createPluginFileApi(join(dataDir, "plugin-data", "demo-plugin")),
        workspaceFs: createPluginFileApi(process.cwd()),
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

test("setup() 缺少 status 或自报 failed 时加载失败", async () => {
    const dataDir = join(root, "status-data")
    await writeCustomPlugin(
        dataDir,
        "missing-status",
        [
            "export function setup() {",
            "    return {",
            '        id: "missing-status",',
            '        name: "Missing Status",',
            '        version: "1.0.0",',
            "    }",
            "}",
        ].join("\n"),
    )
    await writeCustomPlugin(
        dataDir,
        "failed-status",
        [
            "export function setup() {",
            "    return {",
            '        id: "failed-status",',
            '        name: "Failed Status",',
            '        version: "1.0.0",',
            '        status: "failed",',
            "        commands: [{",
            '            name: "should-not-exist",',
            '            summary: "x",',
            "            run: () => 0,",
            "        }],",
            "    }",
            "}",
        ].join("\n"),
    )

    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    const plugins = await loadPlugins({
        paths: tempPaths(dataDir),
        config: DEFAULT_SETTINGS,
        logger,
        registry,
    })
    const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]))
    assert.equal(byId.get("missing-status")?.status, "failed")
    assert.match(byId.get("missing-status")?.error ?? "", /status/)
    assert.equal(byId.get("failed-status")?.status, "failed")
    assert.match(byId.get("failed-status")?.error ?? "", /failed/)
    assert.equal(registry.resolve("should-not-exist"), undefined)
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
    assert.match(
        await readFile(join(created.dir, "tsconfig.json"), "utf8"),
        /allowImportingTsExtensions/,
    )
    assert.match(await readFile(join(created.dir, "README.md"), "utf8"), /pnpm link/)

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
    await emitOnMessage({
        sessionId: "demo-plugin",
        mode: "chat",
        turn: 1,
        role: "user",
        phase: "before",
        content: "hi",
        prompt,
    })
    assert.match(prompt.join("\n"), /Wellspring 里的助手/)
})

test("示例插件可安装并加载", async () => {
    const dataDir = join(root, "example-data")
    const example = join(root, "example-source", "hello-plugin")
    await mkdir(example, { recursive: true })
    await writeFile(
        join(example, "package.json"),
        JSON.stringify({
            name: "hello-plugin",
            version: "0.1.0",
            type: "module",
            main: "index.ts",
            wellspring: { apiVersion: 1 },
        }),
    )
    await writeFile(
        join(example, "index.ts"),
        [
            "export function setup() {",
            "    return {",
            '        id: "hello-plugin",',
            '        name: "Hello Plugin",',
            '        version: "0.1.0",',
            '        status: "ok",',
            "        commands: [",
            "            {",
            '                name: "hello",',
            '                summary: "示例命令",',
            "                run: (ctx) => {",
            '                    ctx.output.info("hello")',
            "                    return 0",
            "                },",
            "            },",
            "        ],",
            "    }",
            "}",
        ].join("\n"),
    )
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

async function writeCustomPlugin(
    dataDir: string,
    dirName: string,
    source: string,
): Promise<string> {
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
    await writeFile(join(pluginDir, "index.ts"), source)
    return pluginDir
}

test("插件可以从 host API 使用 event 总线", async () => {
    const dataDir = join(root, "event-data")
    const received: unknown[] = []
    const off = eventBus.subscribe("demo/ping", (payload) => {
        received.push(payload.getData())
    })

    await writeCustomPlugin(
        dataDir,
        "event-plugin",
        [
            'import { EventEntity, eventBus } from "wellspring/api/host/index.ts"',
            "",
            "export function setup() {",
            '    eventBus.subscribe("demo/ping", (payload) => {',
            "        console.log(payload.getData())",
            "    })",
            "    return {",
            '        id: "event-plugin",',
            '        name: "Event Plugin",',
            '        version: "1.0.0",',
            '        status: "ok",',
            "        commands: [",
            "            {",
            '                name: "event-emit",',
            '                summary: "emit event",',
            "                run: (ctx) => {",
            '                    eventBus.publish("demo/ping", EventEntity.create({ msg: "hi" }))',
            '                    ctx.output.info("published")',
            "                    return 0",
            "                },",
            "            },",
            "        ],",
            "    }",
            "}",
        ].join("\n"),
    )

    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    const paths = tempPaths(dataDir)
    const plugins = await loadPlugins({ paths, config: DEFAULT_SETTINGS, logger, registry })
    assert.equal(plugins[0]?.status, "ok")

    const record = registry.resolve("event-emit")
    assert.ok(record !== undefined)
    const code = await record.command.run({
        argv: [],
        env: process.env,
        paths,
        config: DEFAULT_SETTINGS,
        logger,
        output: { info: () => {}, warn: () => {}, error: () => {}, print: () => {} },
        pluginDataDir: join(paths.dataDir, "plugin-data", "event-plugin"),
        pluginConfig: {},
        fs: createPluginFileApi(join(paths.dataDir, "plugin-data", "event-plugin")),
        workspaceFs: createPluginFileApi(process.cwd()),
        cwd: process.cwd(),
        json: false,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
    })
    assert.equal(code, 0)
    assert.deepEqual(received, [{ msg: "hi" }])
    off()
})

test("插件拿到专属 config 与 data 目录", async () => {
    const dataDir = join(root, "runtime-data")
    const paths = tempPaths(dataDir)
    const marker = join(dataDir, "plugin-data", "runtime-plugin", "init.json")
    await mkdir(join(paths.configDir, "plugins"), { recursive: true })
    await writeFile(
        join(paths.configDir, "plugins", "runtime-plugin.json"),
        JSON.stringify({ token: "abc", nested: { enabled: true } }),
    )
    await writeCustomPlugin(
        dataDir,
        "runtime-plugin",
        [
            "export function setup() {",
            "    return {",
            '        id: "runtime-plugin",',
            '        name: "Runtime Plugin",',
            '        version: "1.0.0",',
            '        status: "ok",',
            "        init: async (api) => {",
            '            await api.fs.writeJson("init.json", { dataDir: api.pluginDataDir, config: api.pluginConfig })',
            "        },",
            "    }",
            "}",
        ].join("\n"),
    )

    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    const plugins = await loadPlugins({ paths, config: DEFAULT_SETTINGS, logger, registry })
    assert.equal(plugins[0]?.status, "ok")

    const written = JSON.parse(await readFile(marker, "utf8")) as {
        dataDir: string
        config: Record<string, unknown>
    }
    assert.equal(written.dataDir, join(paths.dataDir, "plugin-data", "runtime-plugin"))
    assert.deepEqual(written.config, { token: "abc", nested: { enabled: true } })
})

test("依赖按拓扑排序初始化：目录名靠前的依赖后执行", async () => {
    const dataDir = join(root, "dep-data")
    const order: string[] = []
    const off = eventBus.subscribe("plugin/init", (payload) => {
        order.push(String(payload.getData()))
    })
    const source = (id: string, deps: string[]): string =>
        [
            'import { EventEntity, eventBus } from "wellspring/api/host/index.ts"',
            "export function setup() {",
            "    return {",
            `        id: ${JSON.stringify(id)},`,
            `        name: ${JSON.stringify(id)},`,
            '        version: "1.0.0",',
            '        status: "ok",',
            `        deps: ${JSON.stringify(deps)},`,
            "        init: () => {",
            `            eventBus.publish("plugin/init", EventEntity.create(${JSON.stringify(id)}))`,
            "        },",
            "    }",
            "}",
        ].join("\n")
    /* 1.7 起 id 与依赖名都是本地名（目录名）：依赖写在 z-base 上、目录顺序却在后面 */
    await writeCustomPlugin(dataDir, "z-base", source("z-base", []))
    await writeCustomPlugin(dataDir, "a-child", source("a-child", ["z-base"]))

    try {
        const registry = new PluginRegistry()
        const { logger } = fakeLogger()
        const plugins = await loadPlugins({
            paths: tempPaths(dataDir),
            config: DEFAULT_SETTINGS,
            logger,
            registry,
        })
        assert.deepEqual(
            plugins.map((plugin) => plugin.status),
            ["ok", "ok"],
        )
        assert.deepEqual(order, ["z-base", "a-child"])
    } finally {
        off()
    }
})

test("缺失依赖与循环依赖会标记失败", async () => {
    const dataDir = join(root, "dep-bad")
    const source = (id: string, deps: string[]): string =>
        [
            "export function setup() {",
            "    return {",
            `        id: ${JSON.stringify(id)},`,
            `        name: ${JSON.stringify(id)},`,
            '        version: "1.0.0",',
            '        status: "ok",',
            `        deps: ${JSON.stringify(deps)},`,
            "    }",
            "}",
        ].join("\n")
    await writeCustomPlugin(dataDir, "needs-missing", source("needs-missing", ["nope"]))
    await writeCustomPlugin(dataDir, "cycle-a", source("cycle-a", ["cycle-b"]))
    await writeCustomPlugin(dataDir, "cycle-b", source("cycle-b", ["cycle-a"]))

    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    const plugins = await loadPlugins({
        paths: tempPaths(dataDir),
        config: DEFAULT_SETTINGS,
        logger,
        registry,
    })
    const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]))
    assert.match(byId.get("needs-missing")?.error ?? "", /依赖不存在/)
    assert.match(byId.get("cycle-a")?.error ?? "", /循环依赖|依赖/)
    assert.match(byId.get("cycle-b")?.error ?? "", /循环依赖|依赖/)
})

test("禁用插件不加载，重新启用后恢复", async () => {
    const dataDir = join(root, "toggle-data")
    await writePlugin(dataDir, "toggle-plugin")
    const paths = tempPaths(dataDir)

    await setPluginEnabled("toggle-plugin", false, paths)
    const disabledRegistry = new PluginRegistry()
    const { logger } = fakeLogger()
    const disabled = await loadPlugins({
        paths,
        config: DEFAULT_SETTINGS,
        logger,
        registry: disabledRegistry,
    })
    assert.equal(disabled[0]?.status, "disabled")
    assert.deepEqual(disabled[0]?.commands, [])
    assert.equal(disabledRegistry.resolve("hello"), undefined)

    await setPluginEnabled("toggle-plugin", true, paths)
    const enabledRegistry = new PluginRegistry()
    const enabled = await loadPlugins({
        paths,
        config: DEFAULT_SETTINGS,
        logger,
        registry: enabledRegistry,
    })
    assert.equal(enabled[0]?.status, "ok")
    assert.deepEqual(enabled[0]?.commands, ["hello"])
})

test("插件可以 import wellspring/api/host 目录入口", async () => {
    const dataDir = join(root, "host-entry-data")
    await writeCustomPlugin(
        dataDir,
        "host-entry-plugin",
        [
            'import { onMessage } from "wellspring/api/host"',
            "",
            "export function setup() {",
            "    onMessage(() => {}",
            "    )",
            "    return {",
            '        id: "host-entry-plugin",',
            '        name: "Host Entry Plugin",',
            '        version: "1.0.0",',
            '        status: "ok",',
            "    }",
            "}",
        ].join("\n"),
    )
    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    const plugins = await loadPlugins({
        paths: tempPaths(dataDir),
        config: DEFAULT_SETTINGS,
        logger,
        registry,
    })
    assert.equal(plugins[0]?.status, "ok")
})

test("禁止插件直接 import node:fs", async () => {
    const dataDir = join(root, "guard-data")
    await writeCustomPlugin(
        dataDir,
        "guard-plugin",
        [
            'import { readFileSync } from "node:fs"',
            "",
            "export function setup() {",
            "    return {",
            '        id: "guard-plugin",',
            '        name: "Guard Plugin",',
            '        version: "1.0.0",',
            '        status: "ok",',
            "        commands: [],",
            "    }",
            "}",
        ].join("\n"),
    )

    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    const plugins = await loadPlugins({
        paths: tempPaths(dataDir),
        config: DEFAULT_SETTINGS,
        logger,
        registry,
    })
    assert.equal(plugins[0]?.status, "failed")
    assert.match(plugins[0]?.error ?? "", /禁止直接访问|api\.fs/)
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

test("插件 Agent 工具重名时后加载插件失败", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "wellspring-agent-tools-"))
    const source = (id: string): string =>
        [
            "export function setup() {",
            "    return {",
            `        id: "${id}",`,
            `        name: "${id}",`,
            '        version: "1.0.0",',
            '        status: "ok",',
            "        agentTools: [{",
            '            name: "same_tool",',
            '            introduction: { params: {}, content: "same" },',
            "            call: () => ({ success: true, data: {} }),",
            "        }],",
            "    }",
            "}",
        ].join("\n")
    for (const id of ["tool-a", "tool-b"]) {
        const dir = join(dataDir, "plugins", id)
        await mkdir(dir, { recursive: true })
        await writeFile(
            join(dir, "package.json"),
            JSON.stringify({
                name: id,
                version: "1.0.0",
                type: "module",
                main: "index.ts",
                wellspring: { apiVersion: 1 },
            }),
        )
        await writeFile(join(dir, "index.ts"), source(id))
    }
    const { logger } = fakeLogger()
    const registry = new PluginRegistry()
    const agentTools = new AgentToolRegistry()
    const plugins = await loadPlugins({
        paths: tempPaths(dataDir),
        config: DEFAULT_SETTINGS,
        logger,
        registry,
        agentTools,
    })
    assert.equal(plugins.filter((plugin) => plugin.status === "ok").length, 1)
    assert.equal(plugins.filter((plugin) => plugin.status === "failed").length, 1)
    assert.equal(agentTools.list().length, 1)
    await rm(dataDir, { recursive: true, force: true })
})

/* ── 热启用 / 热禁用 ─────────────────────────────────────── */

async function writeSourcePlugin(dataDir: string, dirName: string, source: string): Promise<void> {
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
    await writeFile(join(pluginDir, "index.ts"), source)
}

test("热禁用/热启用：命令注册与宿主状态即时更新", async () => {
    const dataDir = join(root, "hot-data-basic")
    await writePlugin(dataDir, "demo-plugin")
    const paths = tempPaths(dataDir)
    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    await loadPlugins({ paths, config: DEFAULT_SETTINGS, logger, registry })

    const runtime = getPluginRuntime(paths)
    assert.notEqual(runtime, null)
    assert.ok(registry.resolve("hello") !== undefined)

    const disabled = await runtime!.hotDisable("demo-plugin")
    assert.equal(disabled.ok, true)
    assert.equal(disabled.changed, true)
    assert.equal(registry.resolve("hello"), undefined)
    assert.equal(
        getHost()
            .getPlugins()
            .find((plugin) => plugin.id === "demo-plugin")
            ?.getStatus(),
        "disabled",
    )
    assert.ok((await readPluginState(paths)).has("demo-plugin"))

    const enabled = await runtime!.hotEnable("demo-plugin")
    assert.equal(enabled.ok, true)
    assert.equal(enabled.changed, true)
    assert.ok(registry.resolve("hello") !== undefined)
    assert.equal(
        getHost()
            .getPlugins()
            .find((plugin) => plugin.id === "demo-plugin")
            ?.getStatus(),
        "ok",
    )
    assert.equal((await readPluginState(paths)).has("demo-plugin"), false)
})

test("热禁用：被依赖时拒绝，并返回依赖方", async () => {
    const dataDir = join(root, "hot-data-deps")
    await writePlugin(dataDir, "demo-plugin")
    await writeSourcePlugin(
        dataDir,
        "dep-plugin",
        [
            "export function setup() {",
            "    return {",
            '        id: "dep-plugin",',
            '        name: "Dep Plugin",',
            '        version: "1.0.0",',
            '        status: "ok",',
            '        deps: ["demo-plugin"],',
            '        commands: [{ name: "dep-cmd", summary: "dep", run: () => 0 }],',
            "    }",
            "}",
        ].join("\n"),
    )
    const paths = tempPaths(dataDir)
    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    await loadPlugins({ paths, config: DEFAULT_SETTINGS, logger, registry })

    const runtime = getPluginRuntime(paths)
    const blocked = await runtime!.hotDisable("demo-plugin")
    assert.equal(blocked.ok, false)
    assert.deepEqual(blocked.dependents, ["dep-plugin"])
    assert.match(blocked.error ?? "", /被依赖/)

    const depDisabled = await runtime!.hotDisable("dep-plugin")
    assert.equal(depDisabled.ok, true)
    const demoDisabled = await runtime!.hotDisable("demo-plugin")
    assert.equal(demoDisabled.ok, true)
})

test("热禁用：wellspring-web 被拒绝，只能走重启流程", async () => {
    const dataDir = join(root, "hot-data-web")
    await writeSourcePlugin(
        dataDir,
        "wellspring-web",
        [
            "export function setup() {",
            "    return {",
            '        id: "wellspring-web",',
            '        name: "Wellspring Web",',
            '        version: "1.0.0",',
            '        status: "ok",',
            "        deps: [],",
            '        commands: [{ name: "web-cmd", summary: "web", run: () => 0 }],',
            "    }",
            "}",
        ].join("\n"),
    )
    const paths = tempPaths(dataDir)
    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    await loadPlugins({ paths, config: DEFAULT_SETTINGS, logger, registry })

    const runtime = getPluginRuntime(paths)
    const result = await runtime!.hotDisable("wellspring-web")
    assert.equal(result.ok, false)
    assert.match(result.error ?? "", /不支持热禁用/)
})

test("热启用：触发该插件的 init 钩子", async () => {
    const dataDir = join(root, "hot-data-hook")
    await writeSourcePlugin(
        dataDir,
        "hook-plugin",
        [
            'import { onInit } from "wellspring/api/host/index.ts"',
            "let api",
            "export function setup() {",
            "    return {",
            '        id: "hook-plugin",',
            '        name: "Hook Plugin",',
            '        version: "1.0.0",',
            '        status: "ok",',
            "        deps: [],",
            '        commands: [{ name: "hook-cmd", summary: "hook", run: () => 0 }],',
            "        init(value) { api = value },",
            "    }",
            "}",
            'onInit(async () => { await api.fs.writeText("init-hook.txt", "ok") })',
        ].join("\n"),
    )
    const paths = tempPaths(dataDir)
    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    await loadPlugins({ paths, config: DEFAULT_SETTINGS, logger, registry })

    // 冷加载由 start 命令统一触发 init 钩子；测试里没触发
    const hookFile = join(dataDir, "plugin-data", "hook-plugin", "init-hook.txt")
    await assert.rejects(async () => await readFile(hookFile, "utf8"))

    const runtime = getPluginRuntime(paths)
    assert.equal((await runtime!.hotDisable("hook-plugin")).ok, true)
    const enabled = await runtime!.hotEnable("hook-plugin")
    assert.equal(enabled.ok, true)
    assert.equal(await readFile(hookFile, "utf8"), "ok")
})

test("热启用：init 阶段就能读取依赖插件的数据", async () => {
    const dataDir = join(root, "hot-data-depdata")
    const depData = join(dataDir, "plugin-data", "dep-plugin")
    await mkdir(depData, { recursive: true })
    await writeFile(join(depData, "data.txt"), "hello-dep", "utf8")
    await writeSourcePlugin(
        dataDir,
        "dep-plugin",
        [
            "export function setup() {",
            "    return {",
            '        id: "dep-plugin",',
            '        name: "Dep Plugin",',
            '        version: "1.0.0",',
            '        status: "ok",',
            "        deps: [],",
            '        commands: [{ name: "dep-cmd", summary: "dep", run: () => 0 }],',
            "    }",
            "}",
        ].join("\n"),
    )
    await writeSourcePlugin(
        dataDir,
        "dep-reader",
        [
            "let api",
            "export function setup() {",
            "    return {",
            '        id: "dep-reader",',
            '        name: "Dep Reader",',
            '        version: "1.0.0",',
            '        status: "ok",',
            '        deps: ["dep-plugin"],',
            "        init: async (value) => {",
            "            api = value",
            '            const fs = await api.pluginData("dep-plugin")',
            '            const text = fs === null ? "null" : await fs.readText("data.txt")',
            '            await api.fs.writeText("seen.txt", text)',
            "        },",
            "    }",
            "}",
        ].join("\n"),
    )
    const paths = tempPaths(dataDir)
    const registry = new PluginRegistry()
    const { logger } = fakeLogger()
    await loadPlugins({ paths, config: DEFAULT_SETTINGS, logger, registry })

    const seenFile = join(dataDir, "plugin-data", "dep-reader", "seen.txt")
    assert.equal(await readFile(seenFile, "utf8"), "hello-dep")

    await rm(seenFile)
    const runtime = getPluginRuntime(paths)
    assert.equal((await runtime!.hotDisable("dep-reader")).ok, true)
    const enabled = await runtime!.hotEnable("dep-reader")
    assert.equal(enabled.ok, true)
    assert.equal(await readFile(seenFile, "utf8"), "hello-dep")
})
