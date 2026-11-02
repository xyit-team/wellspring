import assert from "node:assert/strict"
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { platform as currentPlatform } from "../src/platform/os.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import {
    BwrapBackend,
    bwrapMissingReason,
    bwrapProbeFailureReason,
    buildBwrapLaunch,
    buildBwrapPluginLaunch,
    resolveNodeRuntime,
} from "../src/sandbox/backends/bwrap.ts"
import { NodePermissionBackend } from "../src/sandbox/backends/node-permission.ts"
import { SeatbeltBackend } from "../src/sandbox/backends/seatbelt.ts"
import { flushSandboxAudit } from "../src/sandbox/audit.ts"
import { candidateBackends, SandboxManager, unavailableReason } from "../src/sandbox/manager.ts"

let root = ""
let workspace = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-sandbox-"))
    workspace = join(root, "workspace")
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace, { recursive: true }))
    await writeFile(join(workspace, "demo.txt"), "hello")
})

after(async () => {
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

function manager(
    mode: "strict" | "best-effort" = "best-effort",
    overrides: Record<string, number> = {},
): SandboxManager {
    return new SandboxManager({
        settings: { ...DEFAULT_SETTINGS.sandbox, mode, ...overrides },
        paths: paths(),
        backend: new DirectBackend(),
    })
}

test("bwrap launch spec：namespace、只读 workspace、可写 scratch、无网络", () => {
    const input = {
        workspaceDir: workspace,
        scratchDir: join(root, "scratch"),
        cwd: join(workspace, "sub"),
        command: "node",
        argv: ["-e", "console.log(1)"],
        env: { PATH: "/usr/bin:/bin", HOME: "/scratch" },
        limits: { timeoutMs: 5_000, memoryMB: 128, pids: 16, outputLimitBytes: 1024 },
    }
    const spec = buildBwrapLaunch(input)
    assert.equal(spec.command, "bwrap")
    assert.ok(spec.args.includes("--unshare-all"))
    assert.ok(!spec.args.includes("--share-net"))
    assert.ok(spec.args.includes("--clearenv"))
    assert.ok(
        spec.args.some((arg, index) => arg === "--ro-bind-try" && spec.args[index + 1] === "/etc"),
    )
    const workspaceBind = spec.args.findIndex(
        (arg, index) => arg === "--ro-bind" && spec.args[index + 2] === "/workspace",
    )
    assert.ok(workspaceBind > 0)
    assert.equal(spec.args[workspaceBind + 1], workspace)
    assert.deepEqual(
        spec.args.slice(spec.args.indexOf("--bind"), spec.args.indexOf("--bind") + 3),
        ["--bind", join(root, "scratch"), "/scratch"],
    )
    assert.ok(spec.args.includes("--chdir"))
    assert.equal(spec.args[spec.args.indexOf("--chdir") + 1], "/workspace/sub")
    const prlimitIndex = spec.args.indexOf("/usr/bin/prlimit")
    assert.ok(prlimitIndex > 0)
    assert.ok(spec.args.includes("--nproc=16"))
    // 不再用 RLIMIT_CPU / RLIMIT_AS：超时交给 supervisor，物理内存交给 cgroup
    assert.ok(!spec.args.some((arg) => arg.startsWith("--cpu=")))
    assert.ok(!spec.args.some((arg) => arg.startsWith("--as=")))
    assert.ok(spec.args.includes("NODE_OPTIONS"))
    assert.ok(spec.args.includes("--max-old-space-size=128"))
    const runtime = resolveNodeRuntime()
    const pathIndex = spec.args.indexOf("PATH")
    assert.ok(pathIndex > 0)
    assert.ok(
        (spec.args[pathIndex + 1] ?? "").startsWith(`${runtime.pathEntry}:`),
        "PATH 指向挂载进来的 node/bin",
    )
    if (runtime.prefix !== null) {
        assert.ok(spec.args.includes(runtime.prefix), "完整 node 前缀整体挂载")
    }
})

test("bwrap launch spec：非 node 命令也不再使用 --as", () => {
    const spec = buildBwrapLaunch({
        workspaceDir: workspace,
        scratchDir: join(root, "scratch2"),
        cwd: workspace,
        command: "echo",
        argv: ["hi"],
        env: { PATH: "/usr/bin:/bin" },
        limits: { timeoutMs: 2_000, memoryMB: 64, pids: 8, outputLimitBytes: 1024 },
    })
    assert.ok(!spec.args.some((arg) => arg.startsWith("--as=")))
    assert.ok(!spec.args.some((arg) => arg.startsWith("--cpu=")))
    assert.ok(spec.args.includes("--chdir"))
    assert.equal(spec.args[spec.args.indexOf("--chdir") + 1], "/workspace")
})

test("bwrap launch spec：network 开启 share-net", () => {
    const spec = buildBwrapLaunch({
        workspaceDir: workspace,
        scratchDir: join(root, "scratch-net"),
        cwd: workspace,
        network: true,
        command: "node",
        argv: ["-e", "console.log(1)"],
        env: { PATH: "/usr/bin:/bin" },
        limits: { timeoutMs: 5_000, memoryMB: 128, pids: 16, outputLimitBytes: 1024 },
    })
    assert.ok(spec.args.includes("--share-net"))
})

test("bwrap launch spec：workspace-write 可写 workspace", () => {
    const spec = buildBwrapLaunch({
        workspaceDir: workspace,
        scratchDir: join(root, "scratch-write"),
        cwd: workspace,
        access: "workspace-write",
        command: "node",
        argv: ["-e", "console.log(1)"],
        env: { PATH: "/usr/bin:/bin" },
        limits: { timeoutMs: 5_000, memoryMB: 128, pids: 16, outputLimitBytes: 1024 },
    })
    const bind = spec.args.findIndex(
        (arg, index) => arg === "--bind" && spec.args[index + 2] === "/workspace",
    )
    assert.ok(bind > 0)
    assert.equal(spec.args[bind + 1], workspace)
})

test("bwrap plugin launch：插件只读、host SDK 只读、Node permission 开启", () => {
    const spec = buildBwrapPluginLaunch({
        pluginDir: join(root, "plugin"),
        pluginEntryRel: "index.ts",
        pluginDataDir: join(root, "plugin-data"),
        hostSdkDir: join(root, "host-sdk"),
        runnerPath: join(root, "runner.ts"),
        env: { PATH: "/usr/bin:/bin" },
        limits: { timeoutMs: 10_000, memoryMB: 128, pids: 16, outputLimitBytes: 4096 },
    })
    assert.equal(spec.command, "bwrap")
    assert.ok(spec.args.includes("--unshare-all"))
    assert.ok(!spec.args.includes("--share-net"))
    const pluginBind = spec.args.findIndex(
        (arg, index) => arg === "--ro-bind" && spec.args[index + 2] === "/plugin",
    )
    assert.ok(pluginBind > 0)
    const hostBind = spec.args.findIndex(
        (arg, index) => arg === "--ro-bind" && spec.args[index + 2] === "/host",
    )
    assert.ok(hostBind > 0)
    assert.ok(spec.args.includes("--permission"))
    assert.ok(spec.args.includes("--allow-fs-read=/plugin"))
    assert.ok(spec.args.includes("--allow-fs-read=/host"))
    assert.ok(!spec.args.includes("--allow-fs-write=/plugin"))
    assert.ok(spec.args.includes("--nproc=16"))
    assert.ok(spec.args.includes(resolveNodeRuntime().nodePath), "插件用挂载后的 node 路径")
})

test("resolveNodeRuntime：完整发行版挂前缀，裸二进制退回单文件", () => {
    const full = resolveNodeRuntime(
        "/opt/node-v24/bin/node",
        (path) => path === "/opt/node-v24/lib/node_modules/npm",
    )
    assert.deepEqual(full, {
        prefix: "/opt/node-v24",
        nodePath: "/opt/wellspring/bin/node",
        pathEntry: "/opt/wellspring/bin",
    })
    const bare = resolveNodeRuntime("/usr/local/bin/node", () => false)
    assert.deepEqual(bare, {
        prefix: null,
        nodePath: "/opt/wellspring/node",
        pathEntry: "/opt/wellspring",
    })
})

test("manager 全权限执行绕过 sandbox", async () => {
    const result = await manager().runAgentCode({
        command: process.execPath,
        argv: ["-e", "console.log(process.cwd())"],
        workspaceDir: workspace,
        access: "danger-full-access",
    })
    assert.equal(result.access, "danger-full-access")
    assert.equal(result.backend, "direct")
    assert.equal(result.memoryLimit, "none", "direct 后端不挂 cgroup")
    assert.equal(result.oomKilled, false)
})

test("manager 执行命令并收集 stdout/stderr/退出码", async () => {
    const result = await manager().runAgentCode({
        command: process.execPath,
        argv: ["-e", "console.log('out'); console.error('err')"],
        workspaceDir: workspace,
    })
    assert.equal(result.backend, "direct")
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.trim(), "out")
    assert.equal(result.stderr.trim(), "err")
    assert.equal(result.timedOut, false)
})

test("manager 转发 stdin、截断超限输出、超时终止", async () => {
    const stdinResult = await manager().runAgentCode({
        command: process.execPath,
        argv: ["-e", "process.stdin.on('data', (d) => process.stdout.write('in:' + d))"],
        workspaceDir: workspace,
        stdin: "hello",
    })
    assert.match(stdinResult.stdout, /in:hello/)

    const truncated = await manager().runAgentCode({
        command: process.execPath,
        argv: ["-e", "process.stdout.write('x'.repeat(5000))"],
        workspaceDir: workspace,
        outputLimitBytes: 1024,
    })
    assert.equal(truncated.truncated, true)
    assert.equal(truncated.stdout.length, 1024)

    const timedOut = await manager().runAgentCode({
        command: process.execPath,
        argv: ["-e", "setTimeout(() => {}, 5000)"],
        workspaceDir: workspace,
        timeoutMs: 300,
    })
    assert.equal(timedOut.timedOut, true)
})

test("manager 收集 scratch/artifacts 并拒绝越界 cwd", async () => {
    const result = await manager().runAgentCode({
        command: process.execPath,
        argv: [
            "-e",
            "const fs = require('node:fs'); fs.mkdirSync(process.env.SCRATCH + '/artifacts', { recursive: true }); fs.writeFileSync(process.env.SCRATCH + '/artifacts/a.txt', 'artifact')",
        ],
        workspaceDir: workspace,
    })
    assert.equal(result.artifacts.length, 1)
    assert.equal(result.artifacts[0]?.path, "a.txt")
    assert.equal(result.artifacts[0]?.size, 8)
    assert.ok(result.hostArtifactDir !== null)
    assert.equal(await readFile(join(result.hostArtifactDir, "a.txt"), "utf8"), "artifact")

    await assert.rejects(
        manager().runAgentCode({
            command: process.execPath,
            argv: ["-e", "0"],
            workspaceDir: workspace,
            cwd: "/tmp",
        }),
        /cwd 不在 workspace/,
    )
})

test("strict 模式下没有 OS backend 时拒绝执行", async () => {
    const strict = new SandboxManager({
        settings: { ...DEFAULT_SETTINGS.sandbox, mode: "strict", backend: "auto" },
        paths: paths(),
    })
    const status = await strict.probe()
    if (!status.available) {
        await assert.rejects(
            strict.runAgentCode({
                command: process.execPath,
                argv: ["-e", "0"],
                workspaceDir: workspace,
            }),
            /sandbox 不可用|没有可用/,
        )
    }
})

test("agent-code 执行写 sandbox audit", async () => {
    const result = await manager().runAgentCode({
        command: process.execPath,
        argv: ["-e", "0"],
        workspaceDir: workspace,
    })
    await flushSandboxAudit()
    const audits = await readFile(join(paths().logDir, "sandbox-audit.log"), "utf8")
    assert.match(audits, /"type":"sandbox\.agent-code"/)
    assert.match(audits, new RegExp(result.sandboxId))
})

test("maxConcurrent 限制并发执行数量", { timeout: 20_000 }, async () => {
    const log = join(root, "order.log")
    await writeFile(log, "")
    const script = [
        "const fs = require('node:fs')",
        "const id = process.argv[1]",
        `const log = ${JSON.stringify(log)}`,
        "fs.appendFileSync(log, `start:${id}\\n`)",
        "setTimeout(() => { fs.appendFileSync(log, `end:${id}\\n`) }, 150)",
    ].join(";")
    const concurrent = manager("best-effort", { maxConcurrent: 1 })
    await Promise.all([
        concurrent.runAgentCode({
            command: process.execPath,
            argv: ["-e", script, "0"],
            workspaceDir: workspace,
        }),
        concurrent.runAgentCode({
            command: process.execPath,
            argv: ["-e", script, "1"],
            workspaceDir: workspace,
        }),
    ])
    const lines = (await readFile(log, "utf8")).trim().split("\n")
    assert.deepEqual(lines, ["start:0", "end:0", "start:1", "end:1"])
})

test("后端能力位与真实机制一致", () => {
    const bwrap = new BwrapBackend()
    assert.equal(bwrap.pathStyle, "mount", "bwrap 有独立挂载视图")
    assert.equal(bwrap.memoryLimit, true, "bwrap 走 cgroup v2")
    assert.equal(bwrap.enforcement("workspace-write"), "full")
    assert.deepEqual(bwrap.enforcementNotes("workspace-write"), [])

    /* 没有 cgroup 的后端不能顶替 memoryLimit，否则结果里的 memoryLimit 会撒谎 */
    assert.equal(new SeatbeltBackend().memoryLimit, false)
    assert.equal(new DirectBackend().memoryLimit, false)

    assert.equal(new SeatbeltBackend().pathStyle, "host", "Seatbelt 没有挂载命名空间")
    assert.equal(new DirectBackend().enforcement("read-only"), "none")
    assert.ok(new DirectBackend().enforcementNotes("read-only").length > 0)
    assert.equal(new NodePermissionBackend().enforcement("workspace-write"), "partial")
})

test("candidateBackends：auto 按平台挑，显式指定不跨后端回退", () => {
    assert.deepEqual(
        candidateBackends("auto", "macos").map((item) => item.name),
        ["seatbelt"],
    )
    assert.deepEqual(
        candidateBackends("auto", "linux").map((item) => item.name),
        ["bwrap"],
    )
    assert.deepEqual(
        candidateBackends("bwrap", "macos").map((item) => item.name),
        ["bwrap"],
    )
    assert.deepEqual(
        candidateBackends("seatbelt", "linux").map((item) => item.name),
        ["seatbelt"],
    )
    assert.deepEqual(candidateBackends("nsjail", "linux"), [])
})

test("candidateBackends：android 上没有 macOS 式回退，仍然只试 bwrap", () => {
    assert.deepEqual(
        candidateBackends("auto", "android").map((item) => item.name),
        ["bwrap"],
    )
})

test("bwrap 缺失说明：Android 指向死路，其他平台给出安装方式", () => {
    const android = bwrapMissingReason("android")
    assert.match(android, /Termux/)
    assert.match(android, /user namespace/)
    /* 提示别人 apt install bubblewrap 在 Termux 上是错的 */
    assert.doesNotMatch(android, /apt install/)

    assert.match(bwrapMissingReason("linux"), /apt install bubblewrap/)
})

test("bwrap 探测失败说明：带上真实 stderr，Android 点明 user namespace", () => {
    assert.equal(
        bwrapProbeFailureReason(
            "bwrap: Creating new namespace failed: Operation not permitted\n",
            "linux",
        ),
        "bwrap: Creating new namespace failed: Operation not permitted",
    )
    assert.match(
        bwrapProbeFailureReason("bwrap: Creating new namespace failed", "android"),
        /Android 禁止非特权 user namespace/,
    )
    assert.equal(bwrapProbeFailureReason("", "linux"), "bwrap 无法创建 namespace")
})

test("unavailableReason：把最后一个候选的后端与原因带出来", () => {
    assert.equal(unavailableReason(null), "没有可用的 OS 级 sandbox 后端")
    assert.equal(
        unavailableReason({ available: false, backend: "bwrap", reason: null, version: null }),
        "没有可用的 OS 级 sandbox 后端",
    )
    const reason = unavailableReason({
        available: false,
        backend: "bwrap",
        reason: "找不到 bwrap",
        version: null,
    })
    assert.match(reason, /bwrap/)
    assert.match(reason, /找不到 bwrap/)
})

test("执行结果透出 enforcement 与缺口说明", async () => {
    const result = await manager().runAgentCode({
        command: process.execPath,
        argv: ["-e", "0"],
        workspaceDir: workspace,
    })
    assert.equal(result.enforcement, "none", "direct 后端必须自报无隔离")
    assert.ok(result.enforcementNotes.length > 0)
    assert.match(result.enforcementNotes.join("\n"), /无隔离/)
})

test("seatbelt 在非 macOS 上 fail-closed，strict 不静默降级", async (t) => {
    if (currentPlatform === "macos") {
        t.skip("仅在非 macOS 上验证拒绝路径")
        return
    }
    const status = await new SeatbeltBackend({
        deps: { platform: "linux", exists: () => false, selfTest: () => false },
    }).probe()
    assert.equal(status.available, false)
    assert.match(status.reason ?? "", /仅 macOS/)

    const strict = new SandboxManager({
        settings: { ...DEFAULT_SETTINGS.sandbox, mode: "strict", backend: "seatbelt" },
        paths: paths(),
    })
    await assert.rejects(
        strict.runAgentCode({
            command: process.execPath,
            argv: ["-e", "0"],
            workspaceDir: workspace,
        }),
        /sandbox 不可用|没有可用/,
    )
})
