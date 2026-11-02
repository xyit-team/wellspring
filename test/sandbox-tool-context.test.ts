/*
 * Agent 工具调用身份按请求传递（真插件进程 test-fixtures/context-probe）
 *
 * 1. 两个会话并发调同一插件的工具，各拿自己的权限
 * 2. 工具调用结束后，插件再发的宿主请求查不到身份
 * 3. 提权审批落到发起方会话
 */

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { activeAgentToolContextCount, withAgentToolContext } from "../src/agent/tool-context.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { SandboxAccess } from "../src/config/types.ts"
import { getElog, initElog, type ElogStream } from "../src/logger/elog4js.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { PluginSandboxClient } from "../src/sandbox/plugin-client.ts"
import type { AgentCodeResult } from "../src/sandbox/types.ts"
import type { HostCapabilities } from "../src/plugin/capabilities.ts"

const projectRoot = join(import.meta.dirname, "..")
const probeDir = join(projectRoot, "test-fixtures", "context-probe")

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-tool-context-"))
    const output: ElogStream = { write: () => undefined }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    configureHost({ paths: paths() })
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

interface ExecAttempt {
    readonly tag: string
    readonly sessionId: string | null
    readonly permission: string | null
}

interface ApproveAttempt {
    readonly tag: string
    readonly sessionId: string | null
    readonly turn: number | null
    readonly step: number | null
}

interface ProbeState {
    readonly attempts: ExecAttempt[]
    readonly approvals: ApproveAttempt[]
    readonly reports: string[]
    readonly gates: Map<string, () => void>
    readonly arrivals: string[]
    approve: boolean
}

function newState(): ProbeState {
    return {
        attempts: [],
        approvals: [],
        reports: [],
        gates: new Map(),
        arrivals: [],
        approve: false,
    }
}

function codeResult(): AgentCodeResult {
    return {
        sandboxId: "probe-sandbox",
        backend: "direct",
        access: "workspace-write",
        exitCode: 0,
        signal: null,
        stdout: "ok",
        stderr: "",
        truncated: false,
        timedOut: false,
        enforcement: "full",
        enforcementNotes: [],
        memoryLimit: "none",
        memoryLimitReason: null,
        oomKilled: false,
        durationMs: 1,
        artifacts: [],
    } as unknown as AgentCodeResult
}

/*
 * 宿主能力替身：记录每个宿主请求带来的 Agent 身份
 *
 * webSearch 当闸门，控制两次工具调用重叠
 * executeCode 与真实实现一致：拿不到身份即报错
 */
function stubCapabilities(state: ProbeState): HostCapabilities {
    return {
        async executeCode(input, context) {
            const tag =
                typeof (input as Record<string, unknown>)["tag"] === "string"
                    ? String((input as Record<string, unknown>)["tag"])
                    : ""
            if (context === undefined) {
                throw new Error("executeCode 只能在 Agent 工具调用中使用")
            }
            state.attempts.push({
                tag,
                sessionId: context.sessionId,
                permission: context.permission,
            })
            if (state.approve && context.approveExec !== undefined) {
                state.approvals.push({
                    tag,
                    sessionId: context.sessionId,
                    turn: context.turn,
                    step: context.step,
                })
                await context.approveExec({ command: "probe", argv: [], cwd: "/" })
            }
            return codeResult()
        },
        async startBackgroundCode(_input, context) {
            if (context === undefined) {
                throw new Error("startBackgroundCode 只能在 Agent 工具调用中使用")
            }
            return { taskId: "probe-task", sandboxId: "probe-sandbox" }
        },
        queryTask() {
            return null
        },
        stopTask() {
            return false
        },
        async webSearch(query) {
            if (query.startsWith("gate:")) {
                const tag = query.slice("gate:".length)
                state.arrivals.push(tag)
                return await new Promise((resolve) => {
                    state.gates.set(tag, () => resolve([]))
                })
            }
            if (query.startsWith("report:")) {
                state.reports.push(query.slice("report:".length))
            }
            return []
        },
        async webFetch(url) {
            return { url, title: "", content: "", truncated: false } as never
        },
    }
}

function createClient(state: ProbeState): PluginSandboxClient {
    return new PluginSandboxClient({
        pluginId: "context-probe",
        pluginName: "Context Probe Fixture",
        pluginVersion: "1.0.0",
        pluginDir: probeDir,
        pluginEntry: join(probeDir, "index.ts"),
        paths: paths(),
        config: DEFAULT_SETTINGS,
        pluginConfig: {},
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: {
            hostApi: ["logger", "fs", "capabilities", "fileRoots"],
            workspaceRead: true,
            workspaceWrite: true,
        },
        capabilities: stubCapabilities(state),
    })
}

async function startProbe(state: ProbeState): Promise<PluginSandboxClient> {
    const client = createClient(state)
    await client.start()
    await client.initialize()
    return client
}

function agentContext(
    sessionId: string,
    permission: SandboxAccess,
    seen: string[],
    workspaceDir: string = root,
): Parameters<typeof withAgentToolContext>[0] {
    return {
        sessionId,
        turn: 3,
        step: 7,
        workspaceDir,
        permission,
        allowExec: true,
        approveExec: async () => {
            seen.push(sessionId)
            return false
        },
        elog: getElog(),
    }
}

async function callProbe(
    client: PluginSandboxClient,
    context: Parameters<typeof withAgentToolContext>[0],
    args: Record<string, unknown>,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
    const probe = client.agentToolStubs().find((tool) => tool.name === "probe")
    assert.ok(probe !== undefined, "插件应注册 probe 工具")
    return await withAgentToolContext(context, async () => await probe.call(args))
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
        if (predicate()) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.fail(`等待超时：${label}`)
}

async function release(state: ProbeState, tag: string): Promise<void> {
    await waitFor(() => state.gates.has(tag), `闸门 ${tag} 出现`)
    const open = state.gates.get(tag)
    state.gates.delete(tag)
    open?.()
}

async function exists(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null)) !== null
}

test("并发工具调用：各自拿到自己的会话身份与权限", { timeout: 60_000 }, async () => {
    const state = newState()
    const seen: string[] = []
    const client = await startProbe(state)
    try {
        const first = callProbe(client, agentContext("s-full", "danger-full-access", seen), {
            mode: "gate",
            tag: "A",
        })
        await waitFor(() => state.arrivals.includes("A"), "A 进入插件")
        // A 未返回时 B 进入同一个插件进程
        const second = callProbe(client, agentContext("s-readonly", "read-only", seen), {
            mode: "gate",
            tag: "B",
        })
        await waitFor(() => state.arrivals.includes("B"), "B 进入插件")
        await release(state, "A")
        await release(state, "B")
        await Promise.all([first, second])

        const a = state.attempts.find((item) => item.tag === "A")
        const b = state.attempts.find((item) => item.tag === "B")
        assert.deepEqual(a, { tag: "A", sessionId: "s-full", permission: "danger-full-access" })
        assert.deepEqual(b, { tag: "B", sessionId: "s-readonly", permission: "read-only" })
        assert.equal(activeAgentToolContextCount(), 0, "调用结束后不应残留身份")
    } finally {
        await client.close().catch(() => undefined)
    }
})

test("调用结束后插件请求不带上次身份", { timeout: 60_000 }, async () => {
    const state = newState()
    const seen: string[] = []
    const client = await startProbe(state)
    try {
        // 两个会话交错跑一轮，结束后各自留一个脱离调用链的定时器
        const first = callProbe(client, agentContext("s-full", "danger-full-access", seen), {
            mode: "late",
            tag: "L",
            gate: true,
            delayMs: 40,
        })
        await waitFor(() => state.arrivals.includes("L"), "L 进入插件")
        const second = callProbe(client, agentContext("s-readonly", "read-only", seen), {
            mode: "late",
            tag: "M",
            gate: true,
            delayMs: 40,
        })
        await waitFor(() => state.arrivals.includes("M"), "M 进入插件")
        await release(state, "L")
        await release(state, "M")
        await Promise.all([first, second])

        await waitFor(() => state.reports.length >= 2, "插件回报迟到调用的结果")
        assert.deepEqual(state.reports.sort(), ["late-denied:L", "late-denied:M"])
        // 迟到的调用不带身份，也不该借别的身份
        assert.deepEqual(state.attempts, [])
    } finally {
        await client.close().catch(() => undefined)
    }
})

test("提权审批落到发起方会话", { timeout: 60_000 }, async () => {
    const state = newState()
    state.approve = true
    const seen: string[] = []
    const client = await startProbe(state)
    try {
        const first = callProbe(client, agentContext("s-full", "danger-full-access", seen), {
            mode: "gate",
            tag: "A",
        })
        await waitFor(() => state.arrivals.includes("A"), "A 进入插件")
        const second = callProbe(client, agentContext("s-readonly", "read-only", seen), {
            mode: "gate",
            tag: "B",
        })
        await waitFor(() => state.arrivals.includes("B"), "B 进入插件")
        await release(state, "A")
        await release(state, "B")
        await Promise.all([first, second])

        const byTag = (tag: string): ApproveAttempt | undefined =>
            state.approvals.find((item) => item.tag === tag)
        assert.deepEqual(byTag("A"), { tag: "A", sessionId: "s-full", turn: 3, step: 7 })
        assert.deepEqual(byTag("B"), { tag: "B", sessionId: "s-readonly", turn: 3, step: 7 })
        assert.deepEqual(seen.sort(), ["s-full", "s-readonly"])
    } finally {
        await client.close().catch(() => undefined)
    }
})

test("并发写工作区：只读会话拒绝，可写会话通过", { timeout: 60_000 }, async () => {
    const state = newState()
    const seen: string[] = []
    const client = await startProbe(state)
    const workspace = await mkdtemp(join(root, "ws-"))
    const previousCwd = process.cwd()
    try {
        // workspaceFs 的根是会话工作区，不是宿主 cwd：故意把 cwd 换到别处
        process.chdir(workspace)
        const first = callProbe(client, agentContext("s-readonly", "read-only", seen), {
            mode: "write",
            tag: "A",
            path: "readonly.txt",
        })
        await waitFor(() => state.arrivals.includes("A"), "A 进入插件")
        const second = callProbe(client, agentContext("s-writable", "workspace-write", seen), {
            mode: "write",
            tag: "B",
            path: "writable.txt",
        })
        await waitFor(() => state.arrivals.includes("B"), "B 进入插件")
        await release(state, "A")
        await release(state, "B")
        const [readonlyResult, writableResult] = await Promise.all([first, second])

        assert.equal(readonlyResult.success, false, "只读会话写入应被拒绝")
        assert.match(String(readonlyResult.data["error"]), /read-only/)
        assert.equal(writableResult.success, true)
        // 落在会话工作区（agentContext 的 workspaceDir = root），而不是宿主 cwd
        assert.equal(await exists(join(workspace, "writable.txt")), false, "不该写进宿主 cwd")
        assert.equal(await exists(join(root, "readonly.txt")), false)
        assert.equal(await exists(join(root, "writable.txt")), true)
    } finally {
        process.chdir(previousCwd)
        await client.close().catch(() => undefined)
    }
})

test("fileRoots 写按会话权限校验", { timeout: 60_000 }, async () => {
    const state = newState()
    const seen: string[] = []
    const client = await startProbe(state)
    const workspace = await mkdtemp(join(root, "rooted-"))
    try {
        const readonlyResult = await callProbe(
            client,
            agentContext("s-readonly", "read-only", seen),
            { mode: "rooted", tag: "R", path: "blocked.txt", root: workspace },
        )
        assert.equal(readonlyResult.success, false)
        assert.match(String(readonlyResult.data["error"]), /read-only/)
        assert.equal(await exists(join(workspace, "blocked.txt")), false)

        const writableResult = await callProbe(
            client,
            agentContext("s-writable", "workspace-write", seen),
            { mode: "rooted", tag: "W", path: "allowed.txt", root: workspace },
        )
        assert.equal(writableResult.success, true)
        assert.equal(await exists(join(workspace, "allowed.txt")), true)
    } finally {
        await client.close().catch(() => undefined)
    }
})

test("workspaceFs 按会话工作区解析：两个会话不串台", { timeout: 60_000 }, async () => {
    const state = newState()
    const seen: string[] = []
    const client = await startProbe(state)
    const first = await mkdtemp(join(root, "session-a-"))
    const second = await mkdtemp(join(root, "session-b-"))
    try {
        const a = callProbe(client, agentContext("s-a", "workspace-write", seen, first), {
            mode: "write",
            tag: "A",
            path: "same.txt",
        })
        await waitFor(() => state.arrivals.includes("A"), "A 进入插件")
        const b = callProbe(client, agentContext("s-b", "workspace-write", seen, second), {
            mode: "write",
            tag: "B",
            path: "same.txt",
        })
        await waitFor(() => state.arrivals.includes("B"), "B 进入插件")
        await release(state, "A")
        await release(state, "B")
        const [firstResult, secondResult] = await Promise.all([a, b])

        assert.equal(firstResult.success, true)
        assert.equal(secondResult.success, true)
        assert.equal(await readFile(join(first, "same.txt"), "utf8"), "A")
        assert.equal(await readFile(join(second, "same.txt"), "utf8"), "B")
        assert.equal(await exists(join(root, "same.txt")), false, "不该落到宿主 cwd")
    } finally {
        await client.close().catch(() => undefined)
    }
})

test("workspaceFs 收工作区内绝对路径，拒绝工作区外绝对路径", { timeout: 60_000 }, async () => {
    const state = newState()
    const seen: string[] = []
    const client = await startProbe(state)
    const workspace = await mkdtemp(join(root, "abs-"))
    try {
        const inside = callProbe(
            client,
            agentContext("s-abs", "workspace-write", seen, workspace),
            { mode: "write", tag: "IN", path: join(workspace, "abs.txt") },
        )
        await release(state, "IN")
        const insideResult = await inside
        assert.equal(insideResult.success, true)
        assert.equal(await exists(join(workspace, "abs.txt")), true)

        const outside = callProbe(
            client,
            agentContext("s-abs", "workspace-write", seen, workspace),
            { mode: "write", tag: "OUT", path: join(root, "escape.txt") },
        )
        await release(state, "OUT")
        const outsideResult = await outside
        assert.equal(outsideResult.success, false)
        assert.match(String(outsideResult.data["error"]), /不在工作区内/)
        assert.equal(await exists(join(root, "escape.txt")), false)
    } finally {
        await client.close().catch(() => undefined)
    }
})
