import assert from "node:assert/strict"
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { withAgentToolContext } from "../src/agent/tool-context.ts"
import { createHostCapabilities } from "../src/plugin/capabilities.ts"
import { loadPlugins } from "../src/plugin/loader.ts"
import { shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import { Elog } from "../src/logger/elog4js.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-core-plugin-"))
})

after(async () => {
    await shutdownAllSandboxPlugins()
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

test("wellspring-core 注册全部 Agent 工具", { timeout: 20_000 }, async () => {
    const dataDir = join(root, "data")
    const destination = join(dataDir, "plugins", "wellspring-core")
    await cp(resolve(import.meta.dirname, "../plugins/wellspring-core"), destination, {
        recursive: true,
    })
    const agentTools = new AgentToolRegistry()
    const plugins = await loadPlugins({
        paths: paths(),
        config: {
            ...DEFAULT_SETTINGS,
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        logger: pino({ level: "silent" }),
        registry: new PluginRegistry(),
        agentTools,
        sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        sandboxBackend: new DirectBackend(),
    })
    assert.equal(plugins.find((plugin) => plugin.id === "wellspring-core")?.status, "ok")
    assert.deepEqual(
        agentTools
            .list()
            .map((record) => record.tool.name)
            .sort(),
        ["execute_code", "query_task", "read", "stop_task", "web_fetch", "web_search"],
    )

    const relative = ".tmp/core-read.txt"
    await writeFile(join(process.cwd(), relative), "alpha\nbeta\n")
    const read = agentTools.get("read")
    assert.ok(read)
    const result = await read.tool.call({ file_path: relative })
    assert.equal(result.success, true)
    assert.match(String(result.data["content"] ?? ""), /1│ alpha/)

    const missing = await agentTools.get("query_task")?.tool.call({ task_id: "nope" })
    assert.equal(missing?.success, false)
    const stopped = await agentTools.get("stop_task")?.tool.call({ type: "kill", task_id: "nope" })
    assert.equal(stopped?.success, false)

    const elog = new Elog({
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        color: false,
    })
    const execute = agentTools.get("execute_code")
    assert.ok(execute)
    const executeResult = await withAgentToolContext(
        {
            sessionId: "s",
            turn: 1,
            step: 1,
            workspaceDir: process.cwd(),
            permission: "read-only",
            allowExec: true,
            elog,
        },
        async () =>
            await execute.tool.call({
                command: process.execPath,
                argv: ["-e", "console.log('core')"],
                sandbox_permissions: "workspace-write",
                network: false,
                background: false,
            }),
    )
    assert.equal(executeResult.success, true)
    assert.equal(executeResult.data["access"], "workspace-write")

    const background = await withAgentToolContext(
        {
            sessionId: "s",
            turn: 1,
            step: 1,
            workspaceDir: process.cwd(),
            permission: "read-only",
            allowExec: true,
            elog,
        },
        async () =>
            await execute.tool.call({
                command: process.execPath,
                argv: ["-e", "setTimeout(() => {}, 60_000)"],
                background: true,
            }),
    )
    assert.equal(background.success, true)
    assert.equal(typeof background.data["taskId"], "string")
    const stop = await agentTools.get("stop_task")?.tool.call({
        type: "kill",
        task_id: background.data["taskId"],
    })
    assert.equal(stop?.success, true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const cancelled = await agentTools.get("query_task")?.tool.call({
        task_id: background.data["taskId"],
    })
    assert.equal(cancelled?.data["status"], "cancelled")
    const taskResult = cancelled?.data["result"]
    if (taskResult !== null && typeof taskResult === "object") {
        assert.equal("hostArtifactDir" in taskResult, false)
        assert.equal("hostSandboxDir" in taskResult, false)
    }
})

test("宿主 capabilities 在 Agent 上下文中执行代码", { timeout: 20_000 }, async () => {
    const elog = new Elog({
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        color: false,
    })
    const capabilities = createHostCapabilities({
        config: {
            ...DEFAULT_SETTINGS,
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        paths: paths(),
        logger: pino({ level: "silent" }),
    })
    const executeResult = await withAgentToolContext(
        {
            sessionId: "s",
            turn: 1,
            step: 1,
            workspaceDir: process.cwd(),
            permission: "read-only",
            allowExec: true,
            elog,
        },
        async () =>
            await capabilities.executeCode({
                command: process.execPath,
                argv: ["-e", "console.log('cap')"],
            }),
    )
    assert.equal(executeResult.exitCode, 0)
    assert.match(executeResult.stdout, /cap/)
})

test("后台任务查询与停止", { timeout: 20_000 }, async () => {
    const elog = new Elog({
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        color: false,
    })
    const capabilities = createHostCapabilities({
        config: {
            ...DEFAULT_SETTINGS,
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        paths: paths(),
        logger: pino({ level: "silent" }),
    })
    const task = await withAgentToolContext(
        {
            sessionId: "s",
            turn: 1,
            step: 1,
            workspaceDir: process.cwd(),
            permission: "read-only",
            allowExec: true,
            elog,
        },
        async () =>
            await capabilities.startBackgroundCode({
                command: process.execPath,
                argv: ["-e", "setTimeout(() => {}, 60_000)"],
            }),
    )
    const running = capabilities.queryTask(task.taskId)
    assert.equal(running?.status, "running")
    assert.equal(capabilities.stopTask(task.taskId, "kill"), true)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const stopped = capabilities.queryTask(task.taskId)
    assert.notEqual(stopped?.status, "running")
})

test("capabilities 接受更宽 access", { timeout: 20_000 }, async () => {
    const elog = new Elog({
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        color: false,
    })
    const capabilities = createHostCapabilities({
        config: {
            ...DEFAULT_SETTINGS,
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        paths: paths(),
        logger: pino({ level: "silent" }),
    })
    let approvals = 0
    const executeResult = await withAgentToolContext(
        {
            sessionId: "s",
            turn: 1,
            step: 1,
            workspaceDir: process.cwd(),
            permission: "read-only",
            allowExec: false,
            approveExec: async () => {
                approvals += 1
                return true
            },
            elog,
        },
        async () =>
            await capabilities.executeCode({
                command: process.execPath,
                argv: ["-e", "console.log('write')"],
                access: "workspace-write",
            }),
    )
    assert.equal(executeResult.access, "workspace-write")
    assert.equal(approvals, 1)
})
