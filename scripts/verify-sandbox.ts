#!/usr/bin/env node
/*
 * 沙箱真机验证矩阵
 *
 * 逐个 access 模式跑一组探针，把后端自报的边界与实际拦截结果对成一张表
 * 这张表是 AgentCodeResult.enforcementNotes 的数据来源：`partial` 具体缺哪几位，
 * 由实测跑出，与后端自报的常量对照
 *
 * 用法：
 *   node scripts/verify-sandbox.ts                自动挑后端（Linux bwrap / macOS seatbelt）
 *   node scripts/verify-sandbox.ts --backend seatbelt
 *   node scripts/verify-sandbox.ts --json         附带机器可读输出
 *
 * 退出码：0 全部符合预期，1 有偏差，2 环境不可用
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { SandboxAccess, SandboxBackend as SandboxBackendName } from "../src/config/types.ts"
import { platform as currentPlatform } from "../src/platform/os.ts"
import { getPaths, initPaths } from "../src/platform/path.ts"
import { resolveNodeRuntime } from "../src/sandbox/backends/bwrap.ts"
import { candidateBackends, SandboxManager } from "../src/sandbox/manager.ts"
import type { AgentCodeRequest, SandboxEnforcement } from "../src/sandbox/types.ts"

import {
    ACCESS_MODES,
    PROBES,
    classifyResult,
    isMountBackend,
    probeArgs,
    probeTag,
    type Actual,
    type FixturePaths,
    type Outcome,
    type Probe,
} from "./sandbox-matrix.ts"

interface Observed {
    readonly probe: Probe
    readonly access: SandboxAccess
    readonly expected: Outcome
    readonly actual: Actual
    readonly detail: string
}

interface Fixture extends FixturePaths {}

async function createFixture(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "wellspring-verify-"))
    const workspace = join(root, "workspace")
    const outsideDir = join(root, "outside")
    await mkdir(workspace, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(workspace, "demo.txt"), "hello")
    /* 沙箱外的私有文件：read:outside 探针应当读不到它 */
    const secret = join(root, "id_ed25519")
    await writeFile(secret, "-----BEGIN PRIVATE KEY-----\n")
    return { root, workspace, secret, outsideDir }
}

/** bwrap 下 node 在挂载点，Seatbelt 下用宿主真实路径 */
function nodeCommand(backend: string): string {
    return isMountBackend(backend) ? resolveNodeRuntime().nodePath : process.execPath
}

async function runProbe(
    manager: SandboxManager,
    probe: Probe,
    backend: string,
    access: SandboxAccess,
    fixture: Fixture,
    index: number,
): Promise<Observed> {
    const expected = probe.expect({ backend, access })
    const request: AgentCodeRequest = {
        command: nodeCommand(backend),
        argv: [
            "-e",
            probe.script,
            ...probeArgs(probe.id, backend, fixture, probeTag(access, index)),
        ],
        workspaceDir: fixture.workspace,
        access,
        timeoutMs: 15_000,
    }
    try {
        const result = await manager.runAgentCode(request)
        const classified = classifyResult(result)
        return { probe, access, expected, ...classified }
    } catch (error) {
        return {
            probe,
            access,
            expected,
            actual: "error",
            detail: error instanceof Error ? error.message : String(error),
        }
    }
}

function formatOutcome(observed: Observed): string {
    if (observed.actual === "error") {
        return "error ??"
    }
    const hit = observed.actual === observed.expected
    return `${observed.actual.padEnd(5)} ${hit ? "ok" : "MISMATCH"}`
}

function printTable(name: string, rows: readonly Observed[]): void {
    console.log(`\n=== ${name} ===`)
    console.log(["探针".padEnd(30), "access".padEnd(16), "期望".padEnd(8), "实际"].join(""))
    for (const observed of rows) {
        console.log(
            [
                observed.probe.id.padEnd(30),
                observed.access.padEnd(16),
                observed.expected.padEnd(8),
                formatOutcome(observed),
                observed.detail === "" ? "" : `  (${observed.detail})`,
            ].join(""),
        )
    }
}

/** 打印 profile 与一次手工运行的完整输出，用于定位进程未启动 */
async function dumpProfile(manager: SandboxManager, backend: string): Promise<number> {
    const fixture = await createFixture()
    const limits = { timeoutMs: 15_000, memoryMB: 512, pids: 64, outputLimitBytes: 1024 * 1024 }
    const probe = PROBES[0]
    if (probe === undefined) {
        return 2
    }
    try {
        for (const access of ACCESS_MODES) {
            const backendImpl = candidateBackends(backend as SandboxBackendName, currentPlatform)[0]
            if (backendImpl === undefined) {
                return 2
            }
            const request: AgentCodeRequest = {
                command: nodeCommand(backend),
                argv: ["-e", probe.script, "/etc/passwd"],
                workspaceDir: fixture.workspace,
                access,
                timeoutMs: 15_000,
            }
            const spec = backendImpl.buildAgentLaunch({
                workspaceDir: fixture.workspace,
                scratchDir: join(getPaths().dataDir, "sandbox", "dump", "scratch"),
                cwd: fixture.workspace,
                access,
                command: request.command,
                argv: [...request.argv],
                env: { PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" },
                limits,
            })
            console.log(`\n===== ${access} =====`)
            console.log(`launcher: ${spec.command}`)
            console.log(`target: ${String(spec.args[2])}`)
            console.log(`env: ${JSON.stringify(spec.env)}`)
            console.log("--- profile ---")
            console.log(String(spec.args[1]))
            console.log("--- 手工运行 ---")
            const result = await manager.runAgentCode(request)
            console.log(`exitCode=${String(result.exitCode)} signal=${String(result.signal)}`)
            console.log(`stdout: ${result.stdout.slice(0, 1000)}`)
            console.log(`stderr: ${result.stderr.slice(0, 4000)}`)

            /*
             * 对照：同一个 launcher、同一个 target，只把 profile 换成 (allow default)
             * 能跑说明 loader 与 env 没问题，问题在 profile 规则
             * 不能跑说明问题在 launcher 或 env
             */
            const permissive = spawnSync(
                spec.command,
                ["-p", "(version 1)(allow default)", String(spec.args[2]), "-e", "console.log('ok')"],
                { encoding: "utf8", env: { ...spec.env }, timeout: 15_000 },
            )
            console.log(
                `对照(allow default): status=${String(permissive.status)} signal=${String(permissive.signal)}`,
            )
            console.log(`  对照 stdout: ${(permissive.stdout ?? "").slice(0, 500)}`)
            console.log(`  对照 stderr: ${(permissive.stderr ?? "").slice(0, 2000)}`)

            /* 对照：系统 sandbox-exec 跑严格 profile，它会打印自己的错误信息 */
            if (existsSync("/usr/bin/sandbox-exec")) {
                const viaCli = spawnSync(
                    "/usr/bin/sandbox-exec",
                    ["-p", String(spec.args[1]), String(spec.args[2]), "-e", "console.log('ok')"],
                    { encoding: "utf8", env: { ...spec.env }, timeout: 15_000 },
                )
                console.log(
                    `对照(sandbox-exec): status=${String(viaCli.status)} signal=${String(viaCli.signal)}`,
                )
                console.log(`  sandbox-exec stderr: ${(viaCli.stderr ?? "").slice(0, 2000)}`)
            }
        }
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
    return 0
}

function parseBackendArg(): SandboxBackendName | null {
    const index = process.argv.indexOf("--backend")
    if (index === -1) {
        return null
    }
    const value = process.argv[index + 1]
    const allowed: readonly string[] = ["auto", "bwrap", "seatbelt"]
    if (value === undefined || !allowed.includes(value)) {
        console.error(`--backend 只接受 ${allowed.join(" / ")}`)
        process.exit(2)
    }
    return value as SandboxBackendName
}

async function main(): Promise<number> {
    initPaths()
    const preferred = parseBackendArg() ?? "auto"
    const manager = new SandboxManager({
        settings: { ...DEFAULT_SETTINGS.sandbox, mode: "strict", backend: preferred },
        paths: getPaths(),
    })

    const status = await manager.probe()
    console.log(`后端：${status.backend}  可用：${status.available}`)
    if (status.version !== null) {
        console.log(`版本：${status.version}`)
    }
    if (!status.available) {
        console.error(`\n后端不可用：${status.reason ?? "未知原因"}`)
        console.error("  macOS 用 seatbelt；Linux 用 bwrap，需要允许非特权 user namespace：")
        console.error("    unshare -Ur true && bwrap --unshare-all --ro-bind / / /bin/true")
        console.error("  macOS 上若没有随包 loader，先跑：pnpm seatbelt:build")
        return 2
    }

    const backend = candidateBackends(status.backend as SandboxBackendName, currentPlatform)[0]
    if (backend === undefined) {
        console.error(`\n无法构造后端实例：${status.backend}`)
        return 2
    }

    if (process.argv.includes("--dump-profile")) {
        return await dumpProfile(manager, status.backend)
    }

    const fixture = await createFixture()
    const all: Observed[] = []
    try {
        for (const access of ACCESS_MODES) {
            for (const [index, probe] of PROBES.entries()) {
                all.push(await runProbe(manager, probe, status.backend, access, fixture, index))
            }
        }
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }

    printTable(`${status.backend} 探针矩阵`, all)

    /* 声明 vs 实测：claimed 是后端自报的常量，mismatch 是跑出来的偏差 */
    const claims: Array<{ access: SandboxAccess; claim: SandboxEnforcement; notes: number }> = []
    for (const access of ACCESS_MODES) {
        claims.push({
            access,
            claim: backend.enforcement(access),
            notes: backend.enforcementNotes(access).length,
        })
    }
    console.log("\n=== 后端自报 ===")
    for (const item of claims) {
        console.log(
            `  ${item.access.padEnd(16)} enforcement=${item.claim}  缺口说明 ${item.notes} 条`,
        )
    }

    const mismatched = all.filter((item) => item.actual !== item.expected)
    const errors = all.filter((item) => item.actual === "error")
    if (mismatched.length > 0) {
        console.log(`\n不一致 ${mismatched.length} 项：`)
        for (const item of mismatched) {
            console.log(
                `  ${item.probe.id} @ ${item.access}：期望 ${item.expected}，实际 ${item.actual} ${item.detail}`,
            )
        }
    }

    /* 自报 full 却测出偏差，本身就是缺陷：声明与实测必须能对上 */
    const overstated = claims.filter(
        (item) =>
            item.claim === "full" &&
            all.some((row) => row.access === item.access && row.actual !== row.expected),
    )
    for (const item of overstated) {
        console.log(
            `\n声明与实测不符：${item.access} 自报 full，但同模式的探针有偏差。` +
                "enforcement 必须由实测支撑，不能是常量。",
        )
    }

    if (process.argv.includes("--json")) {
        console.log(
            `\n${JSON.stringify(
                {
                    backend: status.backend,
                    version: status.version,
                    claims,
                    results: all.map((row) => ({
                        probe: row.probe.id,
                        access: row.access,
                        expected: row.expected,
                        actual: row.actual,
                        detail: row.detail,
                    })),
                },
                null,
                4,
            )}`,
        )
    }

    if (errors.length > 0) {
        console.log(`\n${errors.length} 项探针自身出错（不是沙箱结论），先修环境再判断。`)
        return 1
    }
    console.log(
        mismatched.length === 0
            ? `\n全部 ${all.length} 项符合预期`
            : `\n${mismatched.length} / ${all.length} 项与预期不符`,
    )
    return mismatched.length === 0 ? 0 : 1
}

process.exit(await main())
