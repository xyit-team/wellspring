/*
 * 端到端：插件在 init 里注册版本探针，宿主能通过 sandbox RPC 问到它
 *
 * 单元测试只能验证注册表；真正的风险在跨进程那一层——探针跑在插件沙箱里，
 * 宿主拿到的是包装函数。这里用一个真插件把这条链路走通。
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, afterEach, before, test } from "node:test"

import pino from "pino"

import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { loadPlugins } from "../src/plugin/loader.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"
import {
    checkPluginUpdates,
    clearVersionProbes,
    hasVersionProbe,
} from "../src/plugin/version-probes.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-version-probe-"))
})

after(async () => {
    await shutdownAllSandboxPlugins()
    await rm(root, { recursive: true, force: true })
})

afterEach(async () => {
    await shutdownAllSandboxPlugins()
    clearVersionProbes()
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

/** 插件源码：在 init 里交出探针 */
function pluginSource(body: string): string {
    return [
        "export function setup() {",
        "    return {",
        '        id: "probe-plugin",',
        '        name: "Probe Plugin",',
        '        version: "1.0.0",',
        '        status: "ok",',
        "        init(api) {",
        body,
        "        },",
        "    }",
        "}",
        "",
    ].join("\n")
}

async function writePlugin(dataDir: string, source: string): Promise<void> {
    const dir = join(dataDir, "plugins", "probe-plugin")
    await mkdir(dir, { recursive: true })
    await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
            name: "probe-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.ts",
            wellspring: { apiVersion: 1 },
        }),
    )
    await writeFile(join(dir, "index.ts"), source)
}

async function load(dataDir: string): Promise<void> {
    const sandbox = { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" as const }
    const plugins = await loadPlugins({
        paths: paths(dataDir),
        config: { ...DEFAULT_SETTINGS, sandbox },
        logger: pino({ level: "silent" }),
        registry: new PluginRegistry(),
        agentTools: new AgentToolRegistry(),
        sandbox,
        sandboxBackend: new DirectBackend(),
    })
    const target = plugins.find((plugin) => plugin.id === "probe-plugin")
    assert.equal(target?.status, "ok", `插件没加载成功：${target?.error ?? "unknown"}`)
}

test("init 里注册的探针，宿主能通过 sandbox 问到（含下载地址）", { timeout: 60_000 }, async () => {
    const dataDir = join(root, "with-url")
    await writePlugin(
        dataDir,
        pluginSource(
            [
                '            api.registerVersionProbe(async () => ({ version: "2.0.0", downloadUrl: "https://example.com/probe-2.0.0.zip" }))',
            ].join("\n"),
        ),
    )
    await load(dataDir)
    // 探针按 package.json 的 name 注册
    assert.equal(hasVersionProbe("probe-plugin"), true)

    const checks = await checkPluginUpdates([{ id: "probe-plugin", version: "1.0.0" }])
    assert.equal(checks[0]?.latest, "2.0.0", JSON.stringify(checks[0]))
    assert.equal(checks[0]?.updateAvailable, true)
    assert.equal(checks[0]?.downloadUrl, "https://example.com/probe-2.0.0.zip")
    assert.equal(checks[0]?.error, null)
})

test("探针只报版本号也能用，下载地址为 null", { timeout: 60_000 }, async () => {
    const dataDir = join(root, "version-only")
    await writePlugin(
        dataDir,
        pluginSource('            api.registerVersionProbe(async () => "1.0.0")'),
    )
    await load(dataDir)
    const checks = await checkPluginUpdates([{ id: "probe-plugin", version: "1.0.0" }])
    assert.equal(checks[0]?.latest, "1.0.0")
    assert.equal(checks[0]?.updateAvailable, false)
    assert.equal(checks[0]?.downloadUrl, null)
})

test("非归档下载地址让这一项失败，但不影响版本号", { timeout: 60_000 }, async () => {
    const dataDir = join(root, "bad-url")
    await writePlugin(
        dataDir,
        pluginSource(
            '            api.registerVersionProbe(async () => ({ version: "2.0.0", downloadUrl: "https://github.com/xyit-team/wellspring-core" }))',
        ),
    )
    await load(dataDir)
    const checks = await checkPluginUpdates([{ id: "probe-plugin", version: "1.0.0" }])
    assert.equal(checks[0]?.latest, "2.0.0")
    assert.equal(checks[0]?.downloadUrl, null)
    assert.match(String(checks[0]?.error), /必须是 \.zip 或 \.tar\.gz/)
})

test("探针抛错被隔离成这一项的错误", { timeout: 60_000 }, async () => {
    const dataDir = join(root, "throws")
    await writePlugin(
        dataDir,
        pluginSource(
            '            api.registerVersionProbe(async () => { throw new Error("registry 502") })',
        ),
    )
    await load(dataDir)
    const checks = await checkPluginUpdates([{ id: "probe-plugin", version: "1.0.0" }])
    assert.equal(checks[0]?.latest, null)
    assert.equal(checks[0]?.updateAvailable, false)
    assert.match(String(checks[0]?.error), /registry 502/)
})

test("没注册探针的插件不报错，只标 hasProbe: false", { timeout: 60_000 }, async () => {
    const dataDir = join(root, "no-probe")
    await writePlugin(dataDir, pluginSource("            void api"))
    await load(dataDir)
    const checks = await checkPluginUpdates([{ id: "probe-plugin", version: "1.0.0" }])
    assert.equal(checks[0]?.hasProbe, false)
    assert.equal(checks[0]?.error, null)
})

test(
    "探针按 package.json 名注册：用目录名/对外 id 作候选也能命中",
    { timeout: 60_000 },
    async () => {
        const dataDir = join(root, "alias")
        await writePlugin(
            dataDir,
            pluginSource('            api.registerVersionProbe(async () => "3.0.0")'),
        )
        await load(dataDir)
        // 外面对这个插件用的是 setup() 的 id，探针挂在 package.json 的 name 上
        const checks = await checkPluginUpdates([
            { id: "probe-plugin", version: "1.0.0", probeIds: ["probe-plugin"] },
        ])
        assert.equal(checks[0]?.latest, "3.0.0")
    },
)
