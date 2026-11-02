import assert from "node:assert/strict"
import { startHttpHostPlugin } from "./helpers/http-host.ts"
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { emitInitHooks, emitShutdownHooks } from "../src/api/host/hooks.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { searchWorkspaceFiles } from "../src/plugin/agent-service.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { PluginSandboxClient, shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"
import { resetWorkspaceRegistry } from "../src/workspace/registry.ts"

const projectRoot = join(import.meta.dirname, "..")
let root = ""
const agentCalls: Array<{
    message: string
    cwd?: string
    sessionId?: string
    references?: readonly string[]
}> = []

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-web-workspace-test-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

let pickerResult: { ok: boolean; root: string; name: string; error?: string } = {
    ok: false,
    root: "",
    name: "",
    error: "已取消",
}

function setPickerResult(result: typeof pickerResult): void {
    pickerResult = result
}

const fileSearchCalls: Array<{ root: string; query: string }> = []

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

async function startWebPlugin(): Promise<string> {
    const resolved = paths()
    configureHost({ paths: resolved })
    await startHttpHostPlugin(resolved)
    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const client = new PluginSandboxClient({
        pluginId: "wellspring-web",
        pluginName: "Wellspring Web",
        pluginVersion: "1.0.0",
        pluginDir: join(projectRoot, "plugins", "wellspring-web"),
        pluginEntry: join(projectRoot, "plugins", "wellspring-web", "index.ts"),
        paths: resolved,
        config: DEFAULT_SETTINGS,
        pluginConfig: { port: 0 },
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: {
            hostApi: ["logger", "fs", "http", "agent", "event", "getHost", "workspaces"],
            workspaceRead: false,
            workspaceWrite: false,
        },
        agent: {
            async chat(input) {
                agentCalls.push({
                    message: input.message,
                    cwd: input.cwd,
                    sessionId: input.sessionId,
                    references: input.references,
                })
                return {
                    sessionId: "ws-session",
                    turn: 1,
                    steps: 2,
                    reply: `reply:${input.message}`,
                    model: "test-model",
                    usage: null,
                }
            },
            async stream(input, onEvent) {
                agentCalls.push({
                    message: input.message,
                    cwd: input.cwd,
                    sessionId: input.sessionId,
                    references: input.references,
                })
                onEvent({ type: "delta", text: "ok" })
                return {
                    sessionId: "ws-stream-session",
                    turn: 1,
                    steps: 2,
                    reply: "ok",
                    model: "test-model",
                    usage: null,
                }
            },
            async interject() {
                return false
            },
            async stop() {
                return false
            },
            async respondApproval(approvalId: string, approved: boolean) {
                return approvalId !== "unknown" && approved
            },
            async respondAsk(askId: string, answer: string) {
                return askId !== "unknown" && answer !== ""
            },
            async validateWorkspace(path: string) {
                const { basename, resolve } = await import("node:path")
                const resolvedPath = resolve(path)
                const name = basename(resolvedPath)
                try {
                    const info = await stat(resolvedPath)
                    if (!info.isDirectory()) {
                        return { ok: false, root: resolvedPath, name, error: "不是目录" }
                    }
                } catch {
                    return { ok: false, root: resolvedPath, name, error: "目录不存在" }
                }
                return { ok: true, root: resolvedPath, name }
            },
            async openPath(_path: string, _mode?: "default" | "reveal") {
                return
            },
            async pickDirectory() {
                return pickerResult
            },
            async searchWorkspaceFiles(root: string, query: string) {
                fileSearchCalls.push({ root, query })
                return await searchWorkspaceFiles(root, query)
            },
        },
    })
    await client.start()
    await emitInitHooks()
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output.text)
    assert.ok(match, output.text)
    return `http://127.0.0.1:${match[1]}`
}

async function stopWebPlugin(): Promise<void> {
    await emitShutdownHooks()
    await shutdownAllSandboxPlugins()
}

async function authenticate(base: string): Promise<string> {
    const setup = await fetch(`${base}/api/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "secret123" }),
    })
    if (setup.status === 200) {
        return setup.headers.get("set-cookie")?.split(";")[0] ?? ""
    }
    const login = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "secret123" }),
    })
    assert.equal(login.status, 200)
    return login.headers.get("set-cookie")?.split(";")[0] ?? ""
}

function request(
    base: string,
    cookie: string,
    path: string,
    method = "GET",
    body?: unknown,
): Promise<Response> {
    return fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
}

interface WorkspaceView {
    workspace: {
        id: string
        name: string
        root: string
        conversationCount: number
    }
    workspaces: Array<{ id: string; name: string; root: string }>
}

interface ProcessView {
    kind: string
    at?: number
    text?: string
    id?: string
    name?: string
    arguments?: string
    status?: string
    result?: string
    open?: boolean
}

/** 列表接口只回摘要：正文不在里面 */
type ConversationSummaryView = Omit<ConversationView, "messages"> & { messageCount: number }

/** /messages 分页：from 是这一页在整段正文里的起点 */
interface ConversationPageView {
    from: number
    total: number
    messages: ConversationView["messages"]
}

interface ConversationView {
    id: string
    title: string
    serverSessionId: string | null
    provider?: string | null
    model?: string | null
    reasoning?: string | null
    permission?: string | null
    updatedAt: number
    messages: Array<{
        role: string
        text: string
        turn?: number
        steps?: number
        usage?: {
            inputTokens: number | null
            outputTokens: number | null
            cacheReadTokens?: number
            contextTokens?: number
        }
        stopped?: boolean
        interrupted?: boolean
        process?: ProcessView[]
    }>
}

async function addWorkspace(
    base: string,
    cookie: string,
    workspaceRoot: string,
    name?: string,
): Promise<WorkspaceView["workspace"]> {
    const response = await request(base, cookie, "/api/workspaces", "POST", {
        root: workspaceRoot,
        name,
    })
    const text = await response.text()
    assert.ok(response.status === 201 || response.status === 409, text)
    const data = JSON.parse(text) as { workspace: WorkspaceView["workspace"] }
    return data.workspace
}

test("工作区：手动添加、会话落盘、跨重启保留", { timeout: 30_000 }, async () => {
    const workspaceA = join(root, "demo-a")
    const workspaceB = join(root, "demo-b")
    await mkdir(workspaceA, { recursive: true })
    await mkdir(workspaceB, { recursive: true })

    let base = await startWebPlugin()
    let cookie = ""
    let idA = ""
    const now = Date.now()
    try {
        cookie = await authenticate(base)
        const initial = (await (
            await request(base, cookie, "/api/workspaces")
        ).json()) as WorkspaceView
        assert.deepEqual(initial.workspaces, [], "启动时不预置任何工作区")

        const created = await request(base, cookie, "/api/workspaces", "POST", {
            root: workspaceA,
            name: "演示 A",
        })
        assert.equal(created.status, 201)
        const workspaceAView = (await created.json()) as WorkspaceView
        idA = workspaceAView.workspace.id
        assert.equal(workspaceAView.workspace.root, workspaceA)
        assert.equal(workspaceAView.workspace.name, "演示 A")

        const duplicated = await request(base, cookie, "/api/workspaces", "POST", {
            root: workspaceA,
        })
        assert.equal(duplicated.status, 409)
        assert.equal(
            ((await duplicated.json()) as WorkspaceView).workspace.id,
            idA,
            "重复添加返回已有工作区",
        )

        const missing = await request(base, cookie, "/api/workspaces", "POST", {
            root: join(root, "no-such-directory"),
        })
        assert.equal(missing.status, 400)
        assert.match(((await missing.json()) as { error: string }).error, /工作区不可用/)

        const conversation = {
            id: "conv-a-1",
            title: "工作区 A 的会话",
            createdAt: now,
            updatedAt: now,
            serverSessionId: "sess-a",
            provider: "openai",
            model: "deepseek-chat",
            reasoning: "high",
            permission: "read-only",
            messages: [
                { role: "user", text: "你好", at: now },
                {
                    role: "assistant",
                    text: "**回复**",
                    at: now + 1,
                    model: "deepseek-chat",
                    turn: 3,
                    steps: 5,
                    usage: {
                        inputTokens: 100,
                        outputTokens: 5,
                        cacheReadTokens: 80,
                        contextTokens: 100,
                    },
                    process: [
                        { kind: "reasoning", text: "先读文件再回答。", at: 0, open: true },
                        {
                            kind: "tool",
                            id: "call_1",
                            name: "read",
                            at: 9,
                            arguments: '{"file_path":"a.txt"}',
                            status: "ok",
                            result: "文件内容",
                        },
                        { kind: "tool", name: "非法 名称" },
                        { kind: "unknown" },
                    ],
                },
            ],
        }
        const put = await request(
            base,
            cookie,
            `/api/workspaces/${idA}/conversations/${conversation.id}`,
            "PUT",
            conversation,
        )
        assert.equal(put.status, 200)
        assert.equal(((await put.json()) as { trimmed: boolean }).trimmed, false)

        const active = await request(
            base,
            cookie,
            `/api/workspaces/${idA}/conversations/active`,
            "POST",
            { id: conversation.id },
        )
        assert.equal(((await active.json()) as { activeId: string }).activeId, conversation.id)

        const stream = await request(base, cookie, "/api/chat/stream", "POST", {
            message: "hi @src/app.ts",
            workspaceId: idA,
            references: ["src/app.ts"],
        })
        assert.equal(stream.status, 200)
        const events = await stream.text()
        assert.match(events, /"type":"delta"/)
        assert.match(events, /"type":"done"/)
        assert.match(events, /"turn":1/)
        assert.match(events, /"steps":2/)
        const call = agentCalls[agentCalls.length - 1]
        assert.equal(call?.cwd, workspaceA, "Agent 以工作区目录运行")
        assert.deepEqual(call?.references, ["src/app.ts"], "@ 引用路径传给 Agent")

        const second = await request(base, cookie, "/api/workspaces", "POST", {
            root: workspaceB,
        })
        assert.equal(second.status, 201)
        const idB = ((await second.json()) as WorkspaceView).workspace.id
        const isolation = (await (
            await request(base, cookie, `/api/workspaces/${idB}/conversations`)
        ).json()) as { conversations: ConversationView[] }
        assert.deepEqual(isolation.conversations, [], "不同工作区的会话互相隔离")

        const renamed = await request(base, cookie, `/api/workspaces/${idA}`, "PATCH", {
            name: "正式 A",
        })
        assert.equal(renamed.status, 200)
        assert.equal(((await renamed.json()) as WorkspaceView).workspace.name, "正式 A")

        const stateFile = join(
            root,
            "data",
            "plugin-data",
            "wellspring-web",
            "workspaces",
            idA,
            "conversations.json",
        )
        const stored = JSON.parse(await readFile(stateFile, "utf8")) as {
            conversations: ConversationView[]
            activeId: string | null
        }
        assert.equal(stored.conversations.length, 1)
        assert.equal(stored.activeId, conversation.id)
    } finally {
        await stopWebPlugin()
    }

    // 重启后工作区、会话、重命名都还在
    base = await startWebPlugin()
    try {
        cookie = await authenticate(base)
        const list = (await (
            await request(base, cookie, "/api/workspaces")
        ).json()) as WorkspaceView
        assert.equal(list.workspaces.length, 2)
        const workspaceA = list.workspaces.find((workspace) => workspace.id === idA)
        assert.equal(workspaceA?.name, "正式 A")
        const conversations = (await (
            await request(base, cookie, `/api/workspaces/${idA}/conversations`)
        ).json()) as { activeId: string | null; conversations: ConversationSummaryView[] }
        assert.equal(conversations.activeId, "conv-a-1")
        assert.equal(conversations.conversations[0]?.serverSessionId, "sess-a")
        /*
         * 列表只回摘要：正文整包回传会让响应体超过 wellspring-http 的转发上限
         * （2.5MB），会话一多前端直接拿到 502。这里锁住「列表不带正文」。
         */
        assert.equal(
            (conversations.conversations[0] as { messages?: unknown }).messages,
            undefined,
            "列表不再回传正文",
        )
        const page = (await (
            await request(base, cookie, `/api/workspaces/${idA}/conversations/conv-a-1/messages`)
        ).json()) as ConversationPageView
        assert.equal(page.total, 2, "摘要里的条数与分页一致")
        assert.equal(conversations.conversations[0]?.messageCount, page.total)
        assert.equal(page.from, 0)
        assert.equal(page.messages[1]?.turn, 3, "轮次持久化")
        assert.equal(page.messages[1]?.steps, 5, "步数持久化")
        // token 用量（含缓存命中与上下文占用）随会话保存，刷新后统计不丢
        assert.deepEqual(page.messages[1]?.usage, {
            inputTokens: 100,
            outputTokens: 5,
            cacheReadTokens: 80,
            contextTokens: 100,
        })
        // 会话级模型 / 推理 / 权限随会话保存，跨重启不丢
        assert.equal(conversations.conversations[0]?.provider, "openai")
        assert.equal(conversations.conversations[0]?.model, "deepseek-chat")
        assert.equal(conversations.conversations[0]?.reasoning, "high")
        assert.equal(conversations.conversations[0]?.permission, "read-only")
        const process = page.messages[1]?.process ?? []
        assert.equal(process.length, 2, "思考链与工具调用随会话持久化")
        assert.equal(process[0]?.kind, "reasoning")
        assert.equal(process[0]?.text, "先读文件再回答。")
        assert.equal(process[0]?.open, true, "展开状态持久化")
        assert.equal(process[0]?.at, 0, "过程条目记录正文偏移")
        assert.equal(process[1]?.at, 9, "工具行按正文偏移穿插")
        assert.equal(process[1]?.kind, "tool")
        assert.equal(process[1]?.name, "read")
        assert.equal(process[1]?.status, "ok")
        assert.equal(process[1]?.result, "文件内容")

        // 删除工作区会连它的会话文件一起删掉
        const idB = list.workspaces.find((workspace) => workspace.id !== idA)?.id ?? ""
        const removed = await request(base, cookie, `/api/workspaces/${idB}`, "DELETE", {})
        assert.equal(removed.status, 200)
        const removedBody = (await removed.json()) as { moved: number }
        assert.equal(removedBody.moved, 0, "空工作区没有会话可移动")
        const after = (await (
            await request(base, cookie, "/api/workspaces")
        ).json()) as WorkspaceView
        assert.equal(after.workspaces.length, 1)
        const missingConversations = await request(
            base,
            cookie,
            `/api/workspaces/${idB}/conversations`,
        )
        assert.equal(missingConversations.status, 404)
        await assert.rejects(
            access(join(root, "data", "plugin-data", "wellspring-web", "workspaces", idB)),
        )
    } finally {
        await stopWebPlugin()
    }
})

test("工作区：鉴权、校验、版本冲突与体积裁剪", { timeout: 30_000 }, async () => {
    const workspaceRoot = join(root, "demo-c")
    await mkdir(workspaceRoot, { recursive: true })
    const base = await startWebPlugin()
    try {
        const anonymous = await Promise.all([
            fetch(`${base}/api/workspaces`),
            fetch(`${base}/api/workspaces`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ root: workspaceRoot }),
            }),
        ])
        for (const response of anonymous) assert.equal(response.status, 401)

        const cookie = await authenticate(base)
        const list = (await (
            await request(base, cookie, "/api/workspaces")
        ).json()) as WorkspaceView
        const existing = list.workspaces[0]
        assert.ok(existing, "上一个测试的工作区仍然存在")

        const crossSite = await fetch(`${base}/api/workspaces`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: "http://evil.example",
                cookie,
            },
            body: JSON.stringify({ root: workspaceRoot }),
        })
        assert.equal(crossSite.status, 403)

        const workspace = await addWorkspace(base, cookie, workspaceRoot)
        const workspaceId = workspace.id

        const noWorkspace = await request(base, cookie, "/api/chat/stream", "POST", {
            message: "hi",
        })
        assert.equal(noWorkspace.status, 400)
        const missingWorkspace = await request(base, cookie, "/api/chat/stream", "POST", {
            message: "hi",
            workspaceId: "ghost-workspace",
        })
        assert.equal(missingWorkspace.status, 404)

        const traversal = await request(
            base,
            cookie,
            `/api/workspaces/${workspaceId}/conversations/..%2Fevil`,
            "PUT",
            { id: "../evil" },
        )
        assert.equal(traversal.status, 400)

        // 版本冲突：旧 updatedAt 的写入被拒绝
        const newer = {
            id: "conv-conflict",
            title: "新版本",
            createdAt: 1000,
            updatedAt: 2000,
            messages: [{ role: "user", text: "new", at: 2000 }],
        }
        assert.equal(
            (
                await request(
                    base,
                    cookie,
                    `/api/workspaces/${workspaceId}/conversations/conv-conflict`,
                    "PUT",
                    newer,
                )
            ).status,
            200,
        )
        const stale = await request(
            base,
            cookie,
            `/api/workspaces/${workspaceId}/conversations/conv-conflict`,
            "PUT",
            {
                ...newer,
                title: "旧版本",
                updatedAt: 1000,
            },
        )
        assert.equal(stale.status, 409)
        assert.equal(
            ((await stale.json()) as { conversation: ConversationView }).conversation.title,
            "新版本",
        )

        // 过程条目校验：非法条目丢弃；已结束消息里的“运行中”在这里收尾
        const processPut = await request(
            base,
            cookie,
            `/api/workspaces/${workspaceId}/conversations/conv-process`,
            "PUT",
            {
                id: "conv-process",
                title: "过程",
                createdAt: 2500,
                updatedAt: 2600,
                messages: [
                    { role: "user", text: "hi", at: 2500 },
                    {
                        role: "assistant",
                        text: "答复",
                        at: 2501,
                        stopped: true,
                        interrupted: true,
                        process: [
                            { kind: "steer", text: "顺便看下 README", at: 0 },
                            { kind: "reasoning", text: "先想", running: true },
                            {
                                kind: "tool",
                                id: "call_1",
                                name: "read",
                                arguments: "{}",
                                status: "running",
                            },
                            { kind: "tool", name: "非法 名称" },
                            { kind: "unknown" },
                        ],
                    },
                ],
            },
        )
        assert.equal(processPut.status, 200)
        const processStored = (await (
            await request(base, cookie, `/api/workspaces/${workspaceId}/conversations/conv-process`)
        ).json()) as { conversation: ConversationView }
        const storedProcess = processStored.conversation.messages[1]?.process ?? []
        assert.equal(storedProcess.length, 3, "非法过程条目被丢弃")
        assert.equal(storedProcess[0]?.kind, "steer", "插话条目要保留")
        assert.equal(storedProcess[0]?.text, "顺便看下 README")
        assert.equal(storedProcess[1]?.kind, "reasoning")
        assert.equal("running" in (storedProcess[1] ?? {}), false, "已结束消息不再带运行中")
        assert.equal(storedProcess[2]?.status, "stopped", "仍在跑的工具标记为已中断")
        assert.equal(
            processStored.conversation.messages[1]?.interrupted,
            true,
            "刷新中断标记随会话保存",
        )

        // 非法会话设置按“跟随默认”处理（null）
        const badSettings = await request(
            base,
            cookie,
            `/api/workspaces/${workspaceId}/conversations/conv-settings`,
            "PUT",
            {
                id: "conv-settings",
                title: "设置校验",
                createdAt: 2700,
                updatedAt: 2700,
                provider: "非法 provider!",
                model: "  ",
                reasoning: "ultra",
                permission: "root",
                messages: [{ role: "user", text: "hi", at: 2700 }],
            },
        )
        assert.equal(badSettings.status, 200)
        const settingsStored = (await (
            await request(
                base,
                cookie,
                `/api/workspaces/${workspaceId}/conversations/conv-settings`,
            )
        ).json()) as { conversation: ConversationView }
        assert.equal(settingsStored.conversation.provider, null)
        assert.equal(settingsStored.conversation.model, null)
        assert.equal(settingsStored.conversation.reasoning, null)
        assert.equal(settingsStored.conversation.permission, null)

        // 体积裁剪：正文总量超过上限时保留较新的消息
        const messages = Array.from({ length: 25 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            text: `${index}:`.padEnd(30_000, "x"),
            at: 3000 + index,
        }))
        const big = await request(
            base,
            cookie,
            `/api/workspaces/${workspaceId}/conversations/conv-big`,
            "PUT",
            {
                id: "conv-big",
                title: "长会话",
                createdAt: 3000,
                updatedAt: 4000,
                messages,
            },
        )
        assert.equal(big.status, 200)
        assert.equal(((await big.json()) as { trimmed: boolean }).trimmed, true)
        const bigStored = (await (
            await request(base, cookie, `/api/workspaces/${workspaceId}/conversations/conv-big`)
        ).json()) as { conversation: ConversationView }
        assert.ok(bigStored.conversation.messages.length < 25, "较早的消息被裁剪")
        assert.match(
            bigStored.conversation.messages[bigStored.conversation.messages.length - 1]?.text ?? "",
            /^24:/,
        )

        // 会话数量上限
        for (let index = 0; index < 45; index += 1) {
            const response = await request(
                base,
                cookie,
                `/api/workspaces/${workspaceId}/conversations/cap-${index}`,
                "PUT",
                {
                    id: `cap-${index}`,
                    title: `会话 ${index}`,
                    createdAt: 5000 + index,
                    updatedAt: 5000 + index,
                    messages: [{ role: "user", text: `第 ${index} 条`, at: 5000 + index }],
                },
            )
            assert.equal(response.status, 200)
        }
        const capped = (await (
            await request(base, cookie, `/api/workspaces/${workspaceId}/conversations`)
        ).json()) as { conversations: ConversationView[] }
        assert.equal(capped.conversations.length, 40)
        assert.equal(capped.conversations[0]?.id, "cap-44")
    } finally {
        await stopWebPlugin()
    }
})

test("文件夹对话框：/api/picker 透传宿主结果", { timeout: 20_000 }, async () => {
    const base = await startWebPlugin()
    try {
        const anonymous = await fetch(`${base}/api/picker`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        })
        assert.equal(anonymous.status, 401)

        const cookie = await authenticate(base)
        setPickerResult({ ok: false, root: "", name: "", error: "已取消" })
        const cancelled = await request(base, cookie, "/api/picker", "POST", {})
        assert.equal(cancelled.status, 200)
        assert.equal(((await cancelled.json()) as { ok: boolean }).ok, false)

        const picked = join(root, "picked-dir")
        await mkdir(picked, { recursive: true })
        setPickerResult({ ok: true, root: picked, name: "picked-dir" })
        const accepted = await request(base, cookie, "/api/picker", "POST", {})
        assert.equal(accepted.status, 200)
        const acceptedBody = (await accepted.json()) as { ok: boolean; root: string; name: string }
        assert.equal(acceptedBody.ok, true)
        assert.equal(acceptedBody.root, picked)
        assert.equal(acceptedBody.name, "picked-dir")
    } finally {
        await stopWebPlugin()
    }
})

test("文件搜索：@ 引用的宿主搜索与 /api/files", { timeout: 20_000 }, async () => {
    const workspaceRoot = join(root, "file-search")
    await mkdir(join(workspaceRoot, "src", "components"), { recursive: true })
    await mkdir(join(workspaceRoot, "node_modules", "pkg"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "app.ts"), "export {}\n", "utf8")
    await writeFile(join(workspaceRoot, "src", "my-app.ts"), "export {}\n", "utf8")
    await writeFile(join(workspaceRoot, "src", "components", "button.ts"), "button\n", "utf8")
    await writeFile(join(workspaceRoot, "src", "components", "app-shell.tsx"), "shell\n", "utf8")
    await writeFile(join(workspaceRoot, "README.md"), "# readme\n", "utf8")
    await writeFile(join(workspaceRoot, "node_modules", "pkg", "app.js"), "ignored\n", "utf8")

    const empty = await searchWorkspaceFiles(workspaceRoot, "")
    assert.equal(empty.ok, true)
    assert.deepEqual(
        empty.entries.map((entry) => entry.path),
        ["src", "README.md"],
        "根目录只列一层且跳过依赖目录",
    )

    const matched = await searchWorkspaceFiles(workspaceRoot, "button")
    assert.deepEqual(
        matched.entries.map((entry) => entry.path),
        ["src/components/button.ts"],
    )

    const directory = await searchWorkspaceFiles(workspaceRoot, "src/")
    assert.deepEqual(
        directory.entries.map((entry) => entry.path),
        ["src/components", "src/app.ts", "src/my-app.ts"],
        "输入目录前缀时列出该目录",
    )

    // 文件名前缀优先于路径包含；大小写不敏感
    const appMatches = await searchWorkspaceFiles(workspaceRoot, "APP")
    assert.equal(appMatches.entries[0]?.path, "src/app.ts", "文件名前缀匹配排最前")
    assert.ok(appMatches.entries.some((entry) => entry.path === "src/my-app.ts"))
    assert.ok(appMatches.entries.some((entry) => entry.path === "src/components/app-shell.tsx"))

    // 不带斜杠也能按路径匹配
    const pathQuery = await searchWorkspaceFiles(workspaceRoot, "src")
    assert.ok(pathQuery.entries.some((entry) => entry.path === "src/app.ts"))
    assert.ok(pathQuery.entries.some((entry) => entry.path === "src/components/button.ts"))

    // 带斜杠的查询按路径段匹配：中间目录不必真实存在，也不用从根目录写起
    const partialPath = await searchWorkspaceFiles(workspaceRoot, "components/button")
    assert.deepEqual(
        partialPath.entries.map((entry) => entry.path),
        ["src/components/button.ts"],
        "部分目录路径直接命中深层文件",
    )
    const suffixPath = await searchWorkspaceFiles(workspaceRoot, "components/app")
    assert.deepEqual(
        suffixPath.entries.map((entry) => entry.path),
        ["src/components/app-shell.tsx"],
    )
    const unknownPrefix = await searchWorkspaceFiles(workspaceRoot, "nope/app")
    assert.deepEqual(unknownPrefix.entries, [], "不存在的目录前缀不会越出工作区")

    // 中文文件名
    await writeFile(join(workspaceRoot, "src", "中文说明.md"), "# 说明\n", "utf8")
    const chineseName = await searchWorkspaceFiles(workspaceRoot, "说明")
    assert.deepEqual(
        chineseName.entries.map((entry) => entry.path),
        ["src/中文说明.md"],
    )
    const chinesePath = await searchWorkspaceFiles(workspaceRoot, "src/中文")
    assert.deepEqual(
        chinesePath.entries.map((entry) => entry.path),
        ["src/中文说明.md"],
    )

    // 深路径（旧实现最多 6 层）
    const deep = join(workspaceRoot, "a", "b", "c", "d", "e", "f", "g")
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, "deep-file.ts"), "deep\n", "utf8")
    const deepName = await searchWorkspaceFiles(workspaceRoot, "deep-file")
    assert.deepEqual(
        deepName.entries.map((entry) => entry.path),
        ["a/b/c/d/e/f/g/deep-file.ts"],
    )
    const deepPath = await searchWorkspaceFiles(workspaceRoot, "a/b/c/d/e/f/g/deep")
    assert.deepEqual(
        deepPath.entries.map((entry) => entry.path),
        ["a/b/c/d/e/f/g/deep-file.ts"],
    )

    // 浏览：完整目录路径以 / 结尾时只列一层；显式进入依赖目录也可以浏览
    const nestedBrowse = await searchWorkspaceFiles(workspaceRoot, "src/components/")
    assert.deepEqual(
        nestedBrowse.entries.map((entry) => entry.path),
        ["src/components/app-shell.tsx", "src/components/button.ts"],
        "目录浏览按名称排序",
    )
    const dependencyBrowse = await searchWorkspaceFiles(workspaceRoot, "node_modules/")
    assert.deepEqual(
        dependencyBrowse.entries.map((entry) => entry.path),
        ["node_modules/pkg"],
    )

    // 子序列模糊匹配
    const fuzzy = await searchWorkspaceFiles(workspaceRoot, "bttn")
    assert.deepEqual(
        fuzzy.entries.map((entry) => entry.path),
        ["src/components/button.ts"],
    )

    // 结果超过上限时截断并标记
    for (let index = 0; index < 35; index += 1) {
        await writeFile(join(workspaceRoot, "src", "many", `f${index}.txt`), "x", "utf8").catch(
            async () => {
                await mkdir(join(workspaceRoot, "src", "many"), { recursive: true })
                await writeFile(join(workspaceRoot, "src", "many", `f${index}.txt`), "x", "utf8")
            },
        )
    }
    const limited = await searchWorkspaceFiles(workspaceRoot, "f")
    assert.equal(limited.entries.length, 30)
    assert.equal(limited.truncated, true)

    // 扫描预算按广度优先：前面有 2000+ 个文件的目录时不遮挡后面的结果（旧实现是深度优先 + 2000 条上限）
    const bulk = join(workspaceRoot, "aaa-bulk")
    await mkdir(bulk, { recursive: true })
    for (let batch = 0; batch < 21; batch += 1) {
        await Promise.all(
            Array.from({ length: 100 }, (_, index) =>
                writeFile(join(bulk, `entry-${batch * 100 + index}.log`), "x", "utf8"),
            ),
        )
    }
    await mkdir(join(workspaceRoot, "zzz-target"), { recursive: true })
    await writeFile(join(workspaceRoot, "zzz-target", "needle.ts"), "needle\n", "utf8")
    const afterBulk = await searchWorkspaceFiles(workspaceRoot, "needle")
    assert.deepEqual(
        afterBulk.entries.map((entry) => entry.path),
        ["zzz-target/needle.ts"],
        "大目录不遮挡扫描预算",
    )

    const traversal = await searchWorkspaceFiles(workspaceRoot, "../")
    assert.deepEqual(traversal.entries, [], "不越出工作区根目录")

    const missingRoot = await searchWorkspaceFiles(join(root, "no-such-root"), "")
    assert.equal(missingRoot.ok, false)

    const base = await startWebPlugin()
    try {
        const anonymous = await fetch(`${base}/api/files?workspaceId=whatever`)
        assert.equal(anonymous.status, 401)

        const cookie = await authenticate(base)
        const workspace = await addWorkspace(base, cookie, workspaceRoot)
        const searched = await request(
            base,
            cookie,
            `/api/files?workspaceId=${workspace.id}&q=${encodeURIComponent("app")}`,
        )
        assert.equal(searched.status, 200)
        const searchedBody = (await searched.json()) as {
            ok: boolean
            entries: Array<{ path: string; type: string }>
        }
        assert.equal(searchedBody.ok, true)
        assert.ok(searchedBody.entries.some((entry) => entry.path === "src/app.ts"))

        const direct = await request(
            base,
            cookie,
            `/api/files?workspaceRoot=${encodeURIComponent(workspaceRoot)}&q=README`,
        )
        assert.equal(direct.status, 200)
        const directBody = (await direct.json()) as { entries: Array<{ path: string }> }
        assert.equal(directBody.entries[0]?.path, "README.md")
        assert.equal(fileSearchCalls[fileSearchCalls.length - 1]?.root, workspaceRoot)

        const missingWorkspace = await request(base, cookie, "/api/files?workspaceId=ghost")
        assert.equal(missingWorkspace.status, 404)
        const noGroup = await request(base, cookie, "/api/files?q=hi")
        assert.equal(noGroup.status, 400)
    } finally {
        await stopWebPlugin()
    }
})

test("未分组：移除工作区后会话保留并可继续", { timeout: 20_000 }, async () => {
    const workspaceRoot = join(root, "ungrouped-source")
    await mkdir(workspaceRoot, { recursive: true })
    const base = await startWebPlugin()
    try {
        const cookie = await authenticate(base)
        const workspace = await addWorkspace(base, cookie, workspaceRoot)
        const now = Date.now()
        const conversation = {
            id: "conv-ungrouped-1",
            title: "会被移出分组的会话",
            createdAt: now,
            updatedAt: now,
            serverSessionId: "sess-ungrouped",
            messages: [{ role: "user", text: "hello", at: now }],
        }
        assert.equal(
            (
                await request(
                    base,
                    cookie,
                    `/api/workspaces/${workspace.id}/conversations/${conversation.id}`,
                    "PUT",
                    conversation,
                )
            ).status,
            200,
        )

        const removed = await request(base, cookie, `/api/workspaces/${workspace.id}`, "DELETE", {})
        assert.equal(removed.status, 200)
        const removedBody = (await removed.json()) as {
            moved: number
            workspaces: Array<{ id: string }>
            ungroupedCount: number
        }
        assert.equal(removedBody.moved, 1)
        assert.equal(removedBody.ungroupedCount, 1)
        assert.ok(!removedBody.workspaces.some((item) => item.id === workspace.id))

        const ungrouped = (await (
            await request(base, cookie, "/api/ungrouped/conversations")
        ).json()) as {
            conversations: Array<{
                id: string
                workspaceRoot: string | null
                messageCount: number
            }>
        }
        const moved = ungrouped.conversations.find((item) => item.id === conversation.id)
        assert.ok(moved, "会话保留在未分组")
        assert.equal(moved?.workspaceRoot, workspaceRoot, "保留原工作区目录以便继续对话")
        assert.equal(moved?.messageCount, 1, "未分组的列表同样只给条数")
        const movedPage = (await (
            await request(base, cookie, `/api/ungrouped/conversations/${conversation.id}/messages`)
        ).json()) as ConversationPageView
        assert.equal(movedPage.messages[0]?.text, "hello")

        const stream = await request(base, cookie, "/api/chat/stream", "POST", {
            message: "继续",
            workspaceId: undefined,
            workspaceRoot: workspaceRoot,
        })
        assert.equal(stream.status, 200)
        await stream.text()
        assert.equal(
            agentCalls[agentCalls.length - 1]?.cwd,
            workspaceRoot,
            "未分组会话用原目录继续",
        )

        const unsupported = await request(base, cookie, "/api/chat/stream", "POST", {
            message: "继续",
        })
        assert.equal(unsupported.status, 400)

        const deleted = await request(
            base,
            cookie,
            `/api/ungrouped/conversations/${conversation.id}`,
            "DELETE",
            {},
        )
        assert.equal(deleted.status, 200)
        const after = (await (
            await request(base, cookie, "/api/ungrouped/conversations")
        ).json()) as { conversations: Array<{ id: string }> }
        assert.equal(after.conversations.length, 0)
    } finally {
        await stopWebPlugin()
    }
})

test("工作区：宿主索引 JSON 损坏时不影响插件启动", { timeout: 20_000 }, async () => {
    const registryFile = join(root, "data", "workspaces.json")
    await mkdir(join(root, "data"), { recursive: true })
    await writeFile(registryFile, "{ broken json", "utf8")
    // 模拟新进程：清掉测试进程里缓存的注册表，强制重新读盘
    resetWorkspaceRegistry()
    const base = await startWebPlugin()
    try {
        const cookie = await authenticate(base)
        const list = (await (
            await request(base, cookie, "/api/workspaces")
        ).json()) as WorkspaceView
        assert.deepEqual(list.workspaces, [], "损坏的宿主索引按空列表处理")
        const backup = await readFile(`${registryFile}.broken`, "utf8")
        assert.match(backup, /broken json/, "损坏文件已备份")
    } finally {
        await stopWebPlugin()
    }
})

test("工作区：旧 wellspring-web 索引迁移到宿主注册表", { timeout: 20_000 }, async () => {
    // 清掉宿主注册表，模拟升级前只有插件数据目录里的旧索引
    await rm(join(root, "data", "workspaces.json"), { force: true })
    const legacyDir = join(root, "data", "plugin-data", "wellspring-web")
    const migratedRoot = join(root, "legacy-migrated")
    await mkdir(migratedRoot, { recursive: true })
    await mkdir(legacyDir, { recursive: true })
    await writeFile(
        join(legacyDir, "workspaces.json"),
        JSON.stringify({
            v: 2,
            workspaces: [
                {
                    id: "legacy-migrated-0123456789",
                    name: "迁移项目",
                    root: migratedRoot,
                    conversationCount: 2,
                    createdAt: 1,
                    lastSeenAt: 2,
                },
            ],
        }),
        "utf8",
    )
    resetWorkspaceRegistry()
    const base = await startWebPlugin()
    try {
        const cookie = await authenticate(base)
        const list = (await (
            await request(base, cookie, "/api/workspaces")
        ).json()) as WorkspaceView
        assert.equal(list.workspaces.length, 1)
        assert.equal(list.workspaces[0]?.name, "迁移项目")
        assert.equal(list.workspaces[0]?.root, migratedRoot)
        const hostRegistry = JSON.parse(
            await readFile(join(root, "data", "workspaces.json"), "utf8"),
        ) as { workspaces: Array<{ root: string }> }
        assert.equal(hostRegistry.workspaces[0]?.root, migratedRoot, "迁移结果写进宿主注册表")
    } finally {
        await stopWebPlugin()
    }
})

/**
 * 正文分页：列表只给摘要，正文按页取，保存时不能把没加载的部分写丢
 *
 * 这条守的是「会话大到顶不住事件转发上限」之后的正确性：
 * 前端手里只有最近一页，PUT 时带 messagesFrom 告诉服务端从哪开始，
 * 服务端必须把更早的正文接回去，而不是整段覆盖。
 */
test("工作区：正文分页读取与分片保存", { timeout: 30_000 }, async () => {
    const workspaceRoot = join(root, "demo-paged")
    await mkdir(workspaceRoot, { recursive: true })
    const base = await startWebPlugin()
    try {
        const cookie = await authenticate(base)
        const workspace = await addWorkspace(base, cookie, workspaceRoot, "分页")
        const endpoint = `/api/workspaces/${workspace.id}/conversations`
        const now = Date.now()
        const all = Array.from({ length: 120 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            text: `消息 ${index}`,
            at: now + index,
        }))
        const conversation = {
            id: "conv-paged",
            title: "分页会话",
            createdAt: now,
            updatedAt: now,
            serverSessionId: null,
            messages: all,
        }
        const created = await request(base, cookie, `${endpoint}/conv-paged`, "PUT", conversation)
        assert.equal(created.status, 200)

        // 列表只给条数，不带正文
        const list = (await (await request(base, cookie, endpoint)).json()) as {
            conversations: ConversationSummaryView[]
        }
        assert.equal(list.conversations[0]?.messageCount, 120)
        assert.equal(
            (list.conversations[0] as { messages?: unknown }).messages,
            undefined,
            "列表不带正文",
        )

        // 不传 before 就是「从末尾往前一页」
        const latest = (await (
            await request(base, cookie, `${endpoint}/conv-paged/messages`)
        ).json()) as ConversationPageView
        assert.equal(latest.total, 120)
        assert.equal(latest.from, 80)
        assert.equal(latest.messages.length, 40)
        assert.equal(latest.messages[39]?.text, "消息 119")

        // 往前翻：before 是这一页的结束下标（不含）
        const middle = (await (
            await request(base, cookie, `${endpoint}/conv-paged/messages?before=80&limit=40`)
        ).json()) as ConversationPageView
        assert.equal(middle.from, 40)
        assert.equal(middle.messages[0]?.text, "消息 40")

        const head = (await (
            await request(base, cookie, `${endpoint}/conv-paged/messages?before=40&limit=40`)
        ).json()) as ConversationPageView
        assert.equal(head.from, 0)
        assert.equal(head.messages[0]?.text, "消息 0")

        // 只带回最近一页保存：更早的 80 条必须还在
        const tail = all.slice(80)
        const partial = await request(base, cookie, `${endpoint}/conv-paged`, "PUT", {
            ...conversation,
            updatedAt: now + 1000,
            messages: [...tail, { role: "user", text: "新消息", at: now + 500 }],
            messagesFrom: 80,
        })
        assert.equal(partial.status, 200)
        const merged = (await (
            await request(base, cookie, `${endpoint}/conv-paged/messages?before=80&limit=40`)
        ).json()) as ConversationPageView
        assert.equal(merged.total, 121, "更早的正文没有被覆盖掉")
        assert.equal(merged.from, 40)
        assert.equal(merged.messages[0]?.text, "消息 40", "前缀保留")
        assert.equal(merged.messages[39]?.text, "消息 79")

        // 分片参数非法时按「整段正文」处理，不能把会话写坏
        const whole = await request(base, cookie, `${endpoint}/conv-paged`, "PUT", {
            ...conversation,
            updatedAt: now + 2000,
            messages: [{ role: "user", text: "只剩一条", at: now + 3 }],
        })
        assert.equal(whole.status, 200)
        const reset = (await (
            await request(base, cookie, `${endpoint}/conv-paged/messages`)
        ).json()) as ConversationPageView
        assert.equal(reset.total, 1)
        assert.equal(reset.messages[0]?.text, "只剩一条")
    } finally {
        await stopWebPlugin()
    }
})
