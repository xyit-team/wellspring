/*
 * 中断恢复：发现服务端跑在前面就立即增量重放，而不是等这一轮跑完。
 *
 * 前端看门狗每 10s 没有 data 事件就问一次进度（`?peek=1`），服务端的 total 比本地
 * 收到的多就按 `?since=N` 增量重放。这里验证服务端这两个参数，以及越界时退回全量。
 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { emitInitHooks } from "../src/api/host/hooks.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initElog } from "../src/logger/elog4js.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { PluginSandboxClient, shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"
import { startHttpHostPlugin, watchHttpServer } from "../test/helpers/http-host.ts"

const projectRoot = join(import.meta.dirname, "..")
let root = ""
let watcher: ReturnType<typeof watchHttpServer> | null = null
let base = ""
let cookie = ""
let workspaceRoot = ""
const CONVERSATION = "c_immediate"

/** 让这一轮停在半路：测试自己决定什么时候收尾 */
let release: (() => void) | null = null
const gate = new Promise<void>((resolve) => {
    release = resolve
})

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-resume-"))
    const paths = {
        configDir: join(root, "config"),
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        logDir: join(root, "logs"),
        sources: {
            configDir: "override" as const,
            dataDir: "override" as const,
            cacheDir: "override" as const,
            logDir: "override" as const,
        },
    }
    configureHost({ paths })
    const output: { text: string; write: (text: string) => void } = {
        text: "",
        write(text: string) {
            output.text += text
        },
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    workspaceRoot = join(root, "demo")
    await startHttpHostPlugin(paths)
    watcher = watchHttpServer("wellspring-web")

    const agent: any = {
        async validateWorkspace(path: string) {
            return { ok: true, root: path, name: "demo" }
        },
        async pickDirectory() {
            return { ok: true, root: workspaceRoot, name: "demo" }
        },
        async chat(input: { message: string }) {
            return {
                sessionId: "s",
                turn: 1,
                steps: 1,
                reply: input.message,
                model: "m",
                usage: null,
            }
        },
        async stream(
            input: { message: string },
            onEvent: (event: Record<string, unknown>) => void,
        ) {
            onEvent({ type: "session", sessionId: `sess-${input.message}` })
            onEvent({ type: "delta", text: "第一段。" })
            onEvent({ type: "delta", text: "第二段。" })
            // 工具调用卡住：这一轮先停在这里，服务端仍有 3 条事件
            await gate
            onEvent({ type: "delta", text: "第三段。" })
            onEvent({ type: "done", reply: "结束" })
            return { sessionId: "s", turn: 1, steps: 1, reply: "结束", model: "m", usage: null }
        },
        async stop() {
            return true
        },
        async searchWorkspaceFiles(path: string) {
            return { ok: true, root: path, truncated: false, entries: [] }
        },
        async interject() {
            return false
        },
        async respondApproval() {
            return true
        },
        async respondAsk() {
            return true
        },
    }

    const pluginDir = join(projectRoot, "plugins", "wellspring-web")
    const client = new PluginSandboxClient({
        pluginId: "wellspring-web",
        pluginName: "Wellspring Web",
        pluginVersion: "1.0.0",
        pluginDir,
        pluginEntry: join(pluginDir, "index.ts"),
        paths,
        config: DEFAULT_SETTINGS,
        pluginConfig: { port: 0 },
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: {
            hostApi: [
                "logger",
                "fs",
                "agent",
                "models",
                "plugins",
                "shutdown",
                "event",
                "getHost",
                "workspaces",
            ],
            workspaceRead: false,
            workspaceWrite: false,
        },
        agent,
    })
    await client.start()
    await emitInitHooks()
    const ready = await watcher.ready
    base = `http://127.0.0.1:${ready.port}`
    const setup = await fetch(`${base}/api/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "secret123" }),
    })
    cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
})

after(async () => {
    release?.()
    watcher?.dispose()
    await shutdownAllSandboxPlugins()
    await rm(root, { recursive: true, force: true })
})

interface SseEvent {
    readonly type?: string
    readonly text?: string
    readonly from?: number
    readonly total?: number
    readonly active?: boolean
}

/** 读够 count 个 SSE 事件就断开（续接流不会自己结束） */
async function readEvents(path: string, count: number): Promise<SseEvent[]> {
    const controller = new AbortController()
    const response = await fetch(`${base}${path}`, {
        headers: { cookie, accept: "text/event-stream" },
        signal: controller.signal,
    })
    assert.equal(response.status, 200)
    const reader = response.body?.getReader()
    assert.ok(reader !== undefined)
    const decoder = new TextDecoder()
    const events: SseEvent[] = []
    let buffer = ""
    try {
        while (events.length < count) {
            const chunk = await reader.read()
            if (chunk.done === true) break
            buffer += decoder.decode(chunk.value, { stream: true })
            let boundary = buffer.indexOf("\n\n")
            while (boundary !== -1 && events.length < count) {
                const block = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                for (const line of block.split("\n")) {
                    if (!line.startsWith("data:")) continue
                    events.push(JSON.parse(line.slice(5).trimStart()) as SseEvent)
                }
                boundary = buffer.indexOf("\n\n")
            }
        }
    } finally {
        controller.abort()
        await reader.cancel().catch(() => undefined)
    }
    return events
}

/** 发起一轮并读到前 3 条事件（session + 两条 delta），之后让流挂住 */
async function startHalfTurn(): Promise<void> {
    const response = await fetch(`${base}/api/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
            message: "跑个长任务",
            workspaceRoot,
            conversationId: CONVERSATION,
        }),
    })
    assert.equal(response.status, 200)
    const reader = response.body?.getReader()
    assert.ok(reader !== undefined)
    const decoder = new TextDecoder()
    let buffer = ""
    let seen = 0
    while (seen < 3) {
        const chunk = await reader.read()
        if (chunk.done === true) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let boundary = buffer.indexOf("\n\n")
        while (boundary !== -1) {
            buffer = buffer.slice(boundary + 2)
            seen += 1
            boundary = buffer.indexOf("\n\n")
        }
    }
    // 不 cancel：这一轮要留在服务端继续跑
}

test("peek 探针：不建流就能看到已有多少条事件", { timeout: 20_000 }, async () => {
    await startHalfTurn()
    const response = await fetch(`${base}/api/chat/resume?conversationId=${CONVERSATION}&peek=1`, {
        headers: { cookie },
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /application\/json/)
    const progress = (await response.json()) as {
        ok?: boolean
        active?: boolean
        total?: number
        done?: boolean
        truncated?: boolean
    }
    assert.equal(progress.ok, true)
    assert.equal(progress.active, true)
    assert.equal(progress.done, false)
    assert.equal(progress.truncated, false)
    // session + 两条 delta
    assert.equal(progress.total, 3)
})

test("since 增量重放：只补本地缺的那几条", { timeout: 20_000 }, async () => {
    const events = await readEvents(`/api/chat/resume?conversationId=${CONVERSATION}&since=2`, 2)
    const marker = events[0]
    assert.equal(marker?.type, "resume")
    assert.equal(marker?.from, 2)
    assert.equal(marker?.total, 3)
    assert.equal(marker?.active, true)
    // 只重放第 3 条：第二段
    const replayed = events[1]
    assert.equal(replayed?.type, "delta")
    assert.equal(replayed?.text, "第二段。")
})

test("since 越界（缓冲被重置过）退回全量重放", { timeout: 20_000 }, async () => {
    const events = await readEvents(`/api/chat/resume?conversationId=${CONVERSATION}&since=99`, 4)
    assert.equal(events[0]?.type, "resume")
    assert.equal(events[0]?.from, 0, "越界时从头重放")
    assert.equal(events[1]?.type, "session")
    assert.equal(events[2]?.text, "第一段。")
    assert.equal(events[3]?.text, "第二段。")
})

test("本轮收尾后 peek 报 done，resume 重放完整且立即结束", { timeout: 20_000 }, async () => {
    release?.()
    // 等这一轮把最后一段与 done 推完
    await new Promise((resolve) => setTimeout(resolve, 300))
    const progress = (await (
        await fetch(`${base}/api/chat/resume?conversationId=${CONVERSATION}&peek=1`, {
            headers: { cookie },
        })
    ).json()) as { active?: boolean; total?: number; done?: boolean }
    assert.equal(progress.done, true)
    assert.equal(progress.active, false)
    assert.ok((progress.total ?? 0) >= 5, "session + 3 delta + done")

    const events = await readEvents(`/api/chat/resume?conversationId=${CONVERSATION}&since=0`, 8)
    assert.equal(events[0]?.from, 0)
    assert.ok(
        events.some((event) => event.type === "done"),
        "重放里要包含收尾事件",
    )
})
