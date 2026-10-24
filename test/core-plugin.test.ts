import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
        [
            "delete_file",
            "execute_code",
            "query_task",
            "read",
            "skill_install",
            "skill_list",
            "skill_modify",
            "skill_read",
            "stop_task",
            "web_fetch",
            "web_search",
        ],
    )

    const relative = ".tmp/core-read.txt"
    await mkdir(join(process.cwd(), ".tmp"), { recursive: true })
    await writeFile(join(process.cwd(), relative), "alpha\nbeta\n")
    const read = agentTools.get("read")
    assert.ok(read)
    const result = await read.tool.call({ file_path: relative })
    assert.equal(result.success, true)
    assert.match(String(result.data["content"] ?? ""), /1│ alpha/)

    // delete_file：文件、目录（需 recursive）、不存在路径、工作区根目录
    const deleteTool = agentTools.get("delete_file")
    assert.ok(deleteTool)
    const deleteFile = join(process.cwd(), ".tmp", "core-delete.txt")
    await writeFile(deleteFile, "删除我\n")
    const deleted = await deleteTool.tool.call({ path: ".tmp/core-delete.txt" })
    assert.equal(deleted.success, true)
    assert.match(String(deleted.data["content"]), /已删除文件/)
    assert.equal(
        await readFile(deleteFile, "utf8").then(
            () => true,
            () => false,
        ),
        false,
    )

    const nestedDir = join(process.cwd(), ".tmp", "core-delete-dir")
    await mkdir(nestedDir, { recursive: true })
    await writeFile(join(nestedDir, "nested.txt"), "x")
    const noRecursive = await deleteTool.tool.call({ path: ".tmp/core-delete-dir" })
    assert.equal(noRecursive.success, false)
    assert.match(String(noRecursive.data["error"]), /recursive/)
    const removedDir = await deleteTool.tool.call({
        path: ".tmp/core-delete-dir",
        recursive: true,
    })
    assert.equal(removedDir.success, true)
    assert.equal(
        await readFile(nestedDir, "utf8").then(
            () => true,
            () => false,
        ),
        false,
    )

    const missingDelete = await deleteTool.tool.call({ path: ".tmp/no-such-file" })
    assert.equal(missingDelete.success, false)
    assert.match(String(missingDelete.data["error"]), /不存在/)
    await assert.rejects(async () => await deleteTool.tool.call({ path: "." }), /工作区根目录/)
    await assert.rejects(async () => await deleteTool.tool.call({ path: "a/.." }), /工作区根目录/)

    // delete_file 受本轮权限约束：read-only 下拒绝写工作区
    const elog = new Elog({
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        color: false,
    })
    const guardFile = join(process.cwd(), ".tmp", "core-delete-guard.txt")
    await writeFile(guardFile, "keep")
    await assert.rejects(
        () =>
            withAgentToolContext(
                {
                    sessionId: "s",
                    turn: 1,
                    step: 1,
                    workspaceDir: process.cwd(),
                    permission: "read-only",
                    allowExec: true,
                    elog,
                },
                async () => await deleteTool.tool.call({ path: ".tmp/core-delete-guard.txt" }),
            ),
        /read-only/,
    )
    assert.equal(
        await readFile(guardFile, "utf8").then(
            () => true,
            () => false,
        ),
        true,
    )

    const missing = await agentTools.get("query_task")?.tool.call({ task_id: "nope" })
    assert.equal(missing?.success, false)
    const stopped = await agentTools.get("stop_task")?.tool.call({ type: "kill", task_id: "nope" })
    assert.equal(stopped?.success, false)

    // ── SKILL 工具 ──
    const skillListTool = agentTools.get("skill_list")
    const skillInstallTool = agentTools.get("skill_install")
    const skillReadTool = agentTools.get("skill_read")
    const skillModifyTool = agentTools.get("skill_modify")
    assert.ok(skillListTool)
    assert.ok(skillInstallTool)
    assert.ok(skillReadTool)
    assert.ok(skillModifyTool)

    const emptyList = await skillListTool.tool.call({})
    assert.equal(emptyList.success, true)
    assert.deepEqual((emptyList.data as { skills: unknown[] }).skills, [])

    const skillText = [
        "---",
        "name: demo-skill",
        "description: 演示技能",
        "whenToUse: 当需要演示时",
        "metadata:",
        "  owner: core",
        "---",
        "# 步骤",
        "1. 打招呼",
        "",
    ].join("\n")
    const installed = await skillInstallTool.tool.call({ content: skillText })
    assert.equal(installed.success, true)
    assert.equal((installed.data as { skill: { name: string } }).skill.name, "demo-skill")

    const duplicate = await skillInstallTool.tool.call({ content: skillText })
    assert.equal(duplicate.success, false)
    assert.match(String(duplicate.data["error"]), /已存在/)
    const overwritten = await skillInstallTool.tool.call({ content: skillText, overwrite: true })
    assert.equal(overwritten.success, true)

    const listed = await skillListTool.tool.call({})
    const listedSkills = (listed.data as { skills: Array<Record<string, unknown>> }).skills
    const demo = listedSkills.find((item) => item["name"] === "demo-skill")
    assert.ok(demo)
    assert.equal(demo?.["description"], "演示技能")
    assert.equal(demo?.["whenToUse"], "当需要演示时")
    assert.deepEqual(demo?.["metadata"], { owner: "core" })

    const readSkillResult = await skillReadTool.tool.call({ name: "demo-skill" })
    assert.equal(readSkillResult.success, true)
    assert.match(String(readSkillResult.data["content"]), /# 步骤/)
    assert.equal((readSkillResult.data["skill"] as { description: string }).description, "演示技能")

    const modified = await skillModifyTool.tool.call({
        name: "demo-skill",
        description: "更新后的演示技能",
        body: "# 新步骤\n继续",
    })
    assert.equal(modified.success, true)
    const reread = await skillReadTool.tool.call({ name: "demo-skill" })
    const rereadSkill = reread.data["skill"] as {
        description: string
        metadata?: Record<string, unknown>
    }
    assert.equal(rereadSkill.description, "更新后的演示技能")
    assert.deepEqual(rereadSkill.metadata, { owner: "core" })
    assert.match(String(reread.data["content"]), /新步骤/)

    const invalid = await skillInstallTool.tool.call({ content: "---\nname: bad skill\n---\nx" })
    assert.equal(invalid.success, false)

    const sourceDir = join(process.cwd(), ".tmp", "core-skill-source")
    await mkdir(join(sourceDir, "scripts"), { recursive: true })
    await writeFile(
        join(sourceDir, "SKILL.md"),
        "---\nname: workspace-skill\ndescription: 从工作区安装\n---\n# 工作区技能\n",
        "utf8",
    )
    await writeFile(join(sourceDir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n", "utf8")
    const fromWorkspace = await skillInstallTool.tool.call({ path: ".tmp/core-skill-source" })
    assert.equal(fromWorkspace.success, true)
    const resource = await skillReadTool.tool.call({
        name: "workspace-skill",
        file: "scripts/run.sh",
    })
    assert.equal(resource.success, true)
    assert.match(String(resource.data["content"]), /echo hi/)

    const traversal = await skillReadTool.tool.call({ name: "demo-skill", file: "../evil" })
    assert.equal(traversal.success, false)

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
    let approvalRequest: Record<string, unknown> | null = null
    const executeResult = await withAgentToolContext(
        {
            sessionId: "s",
            turn: 1,
            step: 1,
            workspaceDir: process.cwd(),
            permission: "read-only",
            allowExec: false,
            approveExec: async (request) => {
                approvals += 1
                approvalRequest = request as unknown as Record<string, unknown>
                return true
            },
            elog,
        },
        async () =>
            await capabilities.executeCode({
                command: process.execPath,
                argv: ["-e", "console.log('write')"],
                access: "workspace-write",
                justification: "构建产物需要写入工作区",
            }),
    )
    assert.equal(executeResult.access, "workspace-write")
    assert.equal(approvals, 1)
    assert.equal(approvalRequest?.["justification"], "构建产物需要写入工作区")
    assert.equal(approvalRequest?.["currentPermission"], "read-only")
    assert.equal(approvalRequest?.["requestedPermission"], "workspace-write")
})
