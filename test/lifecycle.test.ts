import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { onInit, onShutdown, setHookGuard, shutdown, withHookOwner } from "../src/api/host/hooks.ts"
import { runStartCommand } from "../src/commands/start.ts"
import type { CommandContext } from "../src/commands/shared.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { Elog } from "../src/logger/elog4js.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { readServiceRecord } from "../src/service/control.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-lifecycle-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

function context(): CommandContext {
    const paths: ResolvedPaths = {
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
    const elog = new Elog({
        stdout: { write: () => true },
        stderr: { write: () => true },
        json: true,
    })
    return {
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
        loadPlugins: async () => [],
    }
}

test("start 按顺序触发 onInit / onShutdown，并支持 shutdown()", async () => {
    const calls: string[] = []
    const guardOwners: string[] = []
    const ctx = context()
    let servicePid: number | null = null
    setHookGuard(async (owner, task) => {
        guardOwners.push(owner)
        await task()
    })

    // 插件注册的钩子带 owner，平台会套上 console 拦截
    const offInit = await withHookOwner("demo-plugin", async () =>
        onInit(async () => {
            calls.push("init")
            servicePid = (await readServiceRecord(ctx.paths))?.pid ?? null
            shutdown()
        }),
    )
    const offShutdown = await withHookOwner("demo-plugin", async () =>
        onShutdown(() => {
            calls.push("shutdown")
        }),
    )

    try {
        const outcome = await runStartCommand(ctx)
        assert.equal(outcome.result.isSuccess(), true)
        assert.deepEqual(calls, ["init", "shutdown"])
        assert.deepEqual(guardOwners, ["demo-plugin", "demo-plugin"])
        assert.equal(servicePid, process.pid)
        assert.equal(await readServiceRecord(ctx.paths), null)
        assert.equal(process.listenerCount("SIGINT"), 0)
    } finally {
        setHookGuard(null)
        offInit()
        offShutdown()
    }
})

test("非服务进程调用 shutdown() 抛错", () => {
    assert.throws(() => shutdown(), /wellspring start/)
})
