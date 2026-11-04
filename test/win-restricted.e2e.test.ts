/*
 * Windows 受限 token 沙盒端到端测试。
 *
 * 需要先构建 native/win-sandbox：node scripts/build-win-sandbox.mjs
 * 非 Windows 或缺少 launcher 时整组跳过。
 */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import {
    packagedLauncherPath,
    WinRestrictedBackend,
    workspaceStateKey,
} from "../src/sandbox/backends/win-restricted.ts"
import { SandboxManager } from "../src/sandbox/manager.ts"

const launcher = packagedLauncherPath()
const skip = process.platform !== "win32" || launcher === null
const shell = process.env["ComSpec"] ?? "cmd.exe"

let root = ""
let workspace = ""
let outside = ""
let dataDir = ""

function paths(): ResolvedPaths {
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

before(async () => {
    /* 某些受限会话的 TEMP 目录不属于当前 token 可写 DACL；允许用环境变量指定测试根目录 */
    const base =
        process.env["WELLSPRING_WIN_E2E_ROOT"] ??
        (process.platform === "win32" ? join(process.cwd(), ".tmp") : tmpdir())
    await mkdir(base, { recursive: true })
    root = await mkdtemp(join(base, "wellspring-win-sandbox-"))
    workspace = join(root, "workspace")
    outside = join(root, "outside")
    dataDir = join(root, "data")
    await mkdir(workspace, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(workspace, "demo.txt"), "hello")
    await writeFile(join(outside, "secret.txt"), "secret")
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

function manager(): SandboxManager {
    return new SandboxManager({
        settings: { ...DEFAULT_SETTINGS.sandbox, mode: "strict" },
        paths: paths(),
        backend: new WinRestrictedBackend({ dataDir, launcher: launcher ?? undefined }),
    })
}

test("win-restricted 端到端：读全局放开、写 workspace/scratch、写外部拒绝", { skip }, async () => {
    const sandbox = manager()
    const read = await sandbox.runAgentCode({
        command: shell,
        argv: ["/c", "type", join("..", "outside", "secret.txt")],
        workspaceDir: workspace,
        cwd: workspace,
        access: "read-only",
        timeoutMs: 15_000,
    })
    assert.equal(read.exitCode, 0, read.stderr)
    assert.match(read.stdout, /secret/)
    assert.equal(read.backend, "win-restricted")

    const readOnlyWrite = await sandbox.runAgentCode({
        command: shell,
        argv: ["/c", "echo nope> ro-write.txt"],
        workspaceDir: workspace,
        cwd: workspace,
        access: "read-only",
        timeoutMs: 15_000,
    })
    assert.notEqual(readOnlyWrite.exitCode, 0)
    await assert.rejects(readFile(join(workspace, "ro-write.txt")))

    const write = await sandbox.runAgentCode({
        command: shell,
        argv: ["/c", "echo yes> ww-write.txt"],
        workspaceDir: workspace,
        cwd: workspace,
        access: "workspace-write",
        timeoutMs: 15_000,
    })
    assert.equal(write.exitCode, 0, write.stderr)
    assert.equal((await readFile(join(workspace, "ww-write.txt"), "utf8")).trim(), "yes")

    const outsideWrite = await sandbox.runAgentCode({
        command: shell,
        argv: ["/c", `echo bad> "${join(outside, "bad.txt")}"`],
        workspaceDir: workspace,
        cwd: workspace,
        access: "workspace-write",
        timeoutMs: 15_000,
    })
    assert.notEqual(outsideWrite.exitCode, 0)
    await assert.rejects(readFile(join(outside, "bad.txt")))

    const scratchWrite = await sandbox.runAgentCode({
        command: shell,
        argv: ["/c", "echo scratch> %TEMP%\\scratch.txt && type %TEMP%\\scratch.txt"],
        workspaceDir: workspace,
        cwd: workspace,
        access: "read-only",
        timeoutMs: 15_000,
    })
    assert.equal(scratchWrite.exitCode, 0, scratchWrite.stderr)
    assert.match(scratchWrite.stdout, /scratch/)
})

test("manager.probe：Windows auto 选择 win-restricted", { skip }, async () => {
    const sandbox = new SandboxManager({
        settings: { ...DEFAULT_SETTINGS.sandbox, mode: "strict" },
        paths: paths(),
    })
    const status = await sandbox.probe()
    assert.equal(status.available, true, status.reason ?? "")
    assert.equal(status.backend, "win-restricted")
})

test("win-restricted：cleanup 删除 ACE 后写 token 不能再写 workspace", { skip }, async () => {
    if (launcher === null) {
        return
    }
    const cleanupWorkspace = join(root, "cleanup-workspace")
    const cleanupScratch = join(root, "cleanup-scratch")
    await mkdir(cleanupWorkspace, { recursive: true })
    await mkdir(cleanupScratch, { recursive: true })
    const backend = new WinRestrictedBackend({ dataDir, launcher })
    await backend.prepare({ workspaceDir: cleanupWorkspace, scratchDir: cleanupScratch })
    const state = JSON.parse(
        await readFile(
            join(dataDir, "sandbox", "win", `${workspaceStateKey(cleanupWorkspace)}.json`),
            "utf8",
        ),
    ) as { sidR: string; sidW: string }

    const run = (name: string): number =>
        spawnSync(
            launcher,
            [
                "--exec",
                "--access",
                "workspace-write",
                "--workspace",
                cleanupWorkspace,
                "--scratch",
                cleanupScratch,
                "--cwd",
                cleanupWorkspace,
                "--sid-r",
                state.sidR,
                "--sid-w",
                state.sidW,
                "--memory-mb",
                "256",
                "--pids",
                "64",
                "--",
                shell,
                "/c",
                `echo x> ${name}`,
            ],
            { encoding: "utf8", windowsHide: true },
        ).status ?? -1

    assert.equal(run("before.txt"), 0)
    await backend.cleanup({ workspaceDir: cleanupWorkspace, scratchDir: cleanupScratch })
    assert.notEqual(run("after.txt"), 0)
    assert.equal(existsSync(join(cleanupWorkspace, "after.txt")), false)
})

test("win-restricted：prepare 拒绝网络盘 / reparse point / 盘根", { skip }, async () => {
    if (launcher === null) {
        return
    }
    const base = join(root, "path-check")
    const real = join(base, "real")
    const junction = join(base, "junction")
    await mkdir(real, { recursive: true })
    spawnSync(process.env["ComSpec"] ?? "cmd.exe", ["/c", "mklink", "/J", junction, real], {
        windowsHide: true,
    })
    const sidR = "S-1-5-21-111111111-222222222-333333333-41001"
    const sidW = "S-1-5-21-111111111-222222222-333333333-41002"
    const prepare = (workspace: string): number =>
        spawnSync(
            launcher,
            [
                "--prepare",
                "--workspace",
                workspace,
                "--scratch",
                real,
                "--sid-r",
                sidR,
                "--sid-w",
                sidW,
            ],
            { encoding: "utf8", windowsHide: true },
        ).status ?? -1
    assert.equal(prepare("\\\\localhost\\C$\\Windows"), 2)
    assert.equal(prepare(`${process.cwd().slice(0, 2)}\\`), 3)
    assert.equal(prepare(junction), 3)
})

test("win-restricted：超时会杀掉 Job Object 里的目标进程", { skip }, async () => {
    const sandbox = manager()
    const started = Date.now()
    const result = await sandbox.runAgentCode({
        command: shell,
        argv: ["/c", "ping -n 10 127.0.0.1 >nul"],
        workspaceDir: workspace,
        cwd: workspace,
        access: "read-only",
        timeoutMs: 500,
    })
    assert.equal(result.timedOut, true)
    assert.ok(Date.now() - started < 5_000, "超时后应在数秒内返回")
})
