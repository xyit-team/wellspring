import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import {
    afterStep,
    afterTurn,
    beforeStep,
    beforeTurn,
    onAgentAsyncTaskComplete,
    onAgentCallTool,
    onAgentRunAsync,
    onAgentRunSync,
    onMessage,
} from "../src/api/host/hooks.ts"
import { Result } from "../src/api/result/result.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { CommandContext } from "../src/commands/shared.ts"
import { executeTurn } from "../src/commands/conversation.ts"
import { Elog } from "../src/logger/elog4js.ts"
import { createProxyFetch } from "../src/network/proxy.ts"
import { OpenAIClient, type CreateOpenAIClientOptions } from "../src/network/openai.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import { registerSession } from "../src/session/registry.ts"
import { Session } from "../src/session/session.ts"
import { SessionStore } from "../src/session/store.ts"

let root = ""
let cwd = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-conversation-"))
    cwd = await mkdtemp(join(tmpdir(), "wellspring-conversation-cwd-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
})

const SETTINGS = {
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    timeoutMs: 1000,
    maxRetries: 0,
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): object {
    return {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
    }
}

function usageChunk(): object {
    return {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    }
}

function sse(parts: readonly object[]): Response {
    const body = `${parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("")}data: [DONE]\n\n`
    return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    })
}

function successFetch(requests: unknown[]): NonNullable<CreateOpenAIClientOptions["fetch"]> {
    return async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return sse([
            chunk({ role: "assistant" }),
            chunk({ content: "hel" }),
            chunk({ content: "lo" }),
            chunk({}, "stop"),
            usageChunk(),
        ])
    }
}

function context(client: OpenAIClient, settings = DEFAULT_SETTINGS): CommandContext {
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
        settings,
        settingsFile: join(paths.configDir, "app-setting.json"),
        configCode: null,
        paths,
        logger: pino({ level: "silent" }),
        elog,
        registry: new PluginRegistry(),
        agentTools: new AgentToolRegistry(),
        openai: client,
        loadPlugins: async () => [],
    }
}

function createClient(fetchImpl: NonNullable<CreateOpenAIClientOptions["fetch"]>): OpenAIClient {
    const created = OpenAIClient.create({
        apiKey: "test-key",
        settings: SETTINGS,
        fetch: fetchImpl,
    })
    assert.equal(created.isSuccess(), true)
    const client = created.getData()
    assert.ok(client !== null)
    return client
}

test("executeTurn 写入会话与流式 chunk", async () => {
    const requests: unknown[] = []
    const client = createClient(successFetch(requests))
    const ctx = context(client)
    const store = new SessionStore(join(root, "sessions"))
    const session = await store.create({ cwd, model: "test-model", id: "conv-1" })

    const result = await executeTurn({
        ctx,
        client,
        store,
        session,
        mode: "chat",
        input: "hi",
        model: "test-model",
        stream: false,
        display: false,
    })

    assert.equal(result.isSuccess(), true)
    assert.equal(result.getData()?.reply, "hello")
    assert.equal(result.getData()?.turn, 1)
    assert.equal(result.getData()?.steps, 1)
    assert.deepEqual(result.getData()?.usage, { inputTokens: 2, outputTokens: 2 })

    const reopened = await store.open("conv-1", cwd)
    assert.deepEqual(
        reopened.events.map((event) => event.type),
        ["turn/start", "user/message", "assistant/message", "turn/end"],
    )
    const assistant = reopened.events[2]
    const stream = assistant?.data["stream"]
    assert.ok(Array.isArray(stream))
    const deltas = (stream as Array<{ chunk?: { type?: string; text?: string } }>).filter(
        (item) => item.chunk?.type === "text-delta",
    )
    assert.deepEqual(
        deltas.map((item) => item.chunk?.text),
        ["hel", "lo"],
    )
    assert.deepEqual(
        (reopened.events[3]?.data["reason"] as { kind?: string } | undefined)?.kind,
        "completed",
    )

    const second = await executeTurn({
        ctx,
        client,
        store,
        session,
        mode: "chat",
        input: "again",
        model: "test-model",
        stream: false,
        display: false,
    })
    assert.equal(second.isSuccess(), true)
    const secondRequest = requests[1] as { messages?: Array<{ role: string }> }
    assert.deepEqual(
        secondRequest.messages?.map((message) => message.role),
        ["user", "assistant", "user"],
    )
})

test("对话生命周期触发 before/after 钩子", async () => {
    const requests: unknown[] = []
    const client = createClient(successFetch(requests))
    const ctx = context(client)
    const store = new SessionStore(join(root, "sessions"))
    const session = await store.create({ cwd, model: "test-model", id: "conv-hooks" })

    const calls: string[] = []
    const unregisters = [
        beforeTurn(() => {
            calls.push("beforeTurn")
        }),
        onMessage(({ phase, prompt }) => {
            if (phase === "before") {
                calls.push("onMessage:before")
                prompt.push("hook-rule")
            } else {
                calls.push("onMessage:after")
            }
        }),
        beforeStep(() => {
            calls.push("beforeStep")
        }),
        afterStep(() => {
            calls.push("afterStep")
        }),
        afterTurn((payload) => {
            calls.push(`afterTurn:${payload.reason}`)
        }),
    ]

    try {
        const result = await executeTurn({
            ctx,
            client,
            store,
            session,
            mode: "chat",
            input: "hi",
            model: "test-model",
            stream: false,
            display: false,
        })
        assert.equal(result.isSuccess(), true)

        const request = requests[0] as {
            messages?: Array<{ role: string; content: string }>
        }
        assert.deepEqual(request.messages?.[0], { role: "system", content: "hook-rule" })
        assert.deepEqual(calls, [
            "beforeTurn",
            "onMessage:before",
            "beforeStep",
            "onMessage:after",
            "afterStep",
            "afterTurn:completed",
        ])
    } finally {
        for (const unregister of unregisters) {
            unregister()
        }
    }
})

test("run 模式触发 onAgentRunSync；onAgentRunAsync 等异步任务钩子暂不触发", async () => {
    const requests: unknown[] = []
    const client = createClient(successFetch(requests))
    const ctx = context(client)
    const store = new SessionStore(join(root, "sessions"))
    const session = await store.create({ cwd, model: "test-model", id: "conv-agent-run" })

    const syncCalls: Array<{ sessionId: string; turn: number; input: string; cwd: string }> = []
    const asyncCalls: unknown[] = []
    const completeCalls: unknown[] = []
    const offSync = onAgentRunSync((payload) => {
        syncCalls.push({ ...payload })
    })
    const offAsync = onAgentRunAsync((payload) => {
        asyncCalls.push(payload)
    })
    const offComplete = onAgentAsyncTaskComplete((payload) => {
        completeCalls.push(payload)
    })

    try {
        const result = await executeTurn({
            ctx,
            client,
            store,
            session,
            mode: "run",
            input: "do it",
            model: "test-model",
            stream: false,
            display: false,
        })
        assert.equal(result.isSuccess(), true)
        const expected = [{ sessionId: "conv-agent-run", turn: 1, input: "do it", cwd }]
        assert.deepEqual(syncCalls, expected)
        assert.deepEqual(asyncCalls, [])
        assert.deepEqual(completeCalls, [])
    } finally {
        offSync()
        offAsync()
        offComplete()
    }
})

test("Agent 循环执行 execute_code 并回填 tool result", { timeout: 20_000 }, async () => {
    const requests: unknown[] = []
    let callCount = 0
    const toolCallArgs = JSON.stringify({
        command: process.execPath,
        argv: ["-e", "console.log('sandboxed-output')"],
    })
    const fetchImpl: NonNullable<CreateOpenAIClientOptions["fetch"]> = async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)))
        callCount += 1
        if (callCount === 1) {
            return sse([
                chunk({ role: "assistant" }),
                {
                    id: "chatcmpl_1",
                    object: "chat.completion.chunk",
                    created: 0,
                    model: "test-model",
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: "call_1",
                                        type: "function",
                                        function: {
                                            name: "execute_code",
                                            arguments: toolCallArgs,
                                        },
                                    },
                                ],
                            },
                            finish_reason: null,
                        },
                    ],
                },
                chunk({}, "tool_calls"),
                usageChunk(),
            ])
        }
        return sse([
            chunk({ role: "assistant" }),
            chunk({ content: "最终回答" }),
            chunk({}, "stop"),
            usageChunk(),
        ])
    }

    const client = createClient(fetchImpl)
    const settings = {
        ...DEFAULT_SETTINGS,
        sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" as const },
    }
    const ctx = context(client, settings)
    const store = new SessionStore(join(root, "sessions"))
    const session = await store.create({ cwd, model: "test-model", id: "conv-agent-code" })
    ctx.agentTools.register("test", {
        name: "execute_code",
        introduction: { params: { command: "命令" }, content: "执行" },
        call: async () => ({
            success: true,
            data: { content: "exitCode: 0\nstdout:\nsandboxed-output" },
        }),
    })

    const toolCalls: string[] = []
    const stepsSeen: Array<{ turn: number; step: number }> = []
    let approvals = 0
    const off = onAgentCallTool((payload) => {
        toolCalls.push(`${payload.name}:${payload.arguments}`)
    })

    try {
        const result = await executeTurn({
            ctx,
            client,
            store,
            session,
            mode: "run",
            input: "执行代码",
            model: "test-model",
            stream: false,
            display: false,
            approveExec: async () => {
                approvals += 1
                return false
            },
            onStep: (event) => {
                stepsSeen.push(event)
            },
        })
        assert.equal(result.isSuccess(), true)
        assert.equal(result.getData()?.reply, "最终回答")
        assert.equal(result.getData()?.turn, 1)
        assert.equal(result.getData()?.steps, 2)
        assert.deepEqual(stepsSeen, [
            { turn: 1, step: 1 },
            { turn: 1, step: 2 },
        ])
        assert.equal(approvals, 0)
        assert.equal(requests.length, 2)

        const first = requests[0] as { tools?: unknown[] }
        assert.ok(Array.isArray(first.tools))
        const second = requests[1] as {
            messages?: Array<{ role: string; tool_call_id?: string }>
        }
        assert.equal(
            second.messages?.some((message) => message.role === "tool"),
            true,
        )
        assert.equal(
            second.messages?.some((message) => message.role === "assistant"),
            true,
        )
        assert.equal(toolCalls.length, 1)
        assert.match(toolCalls[0] ?? "", /execute_code/)

        const reopened = await store.open("conv-agent-code", cwd)
        const types = reopened.events.map((event) => event.type)
        assert.ok(types.includes("tool/call"))
        assert.ok(types.includes("tool/result"))
        const toolResult = reopened.events.find((event) => event.type === "tool/result")
        assert.match(String(toolResult?.data["content"] ?? ""), /sandboxed-output/)
    } finally {
        off()
    }
})

test("Agent 循环调用 web_search 并回填结果", { timeout: 20_000 }, async () => {
    const requests: unknown[] = []
    let callCount = 0
    const fetchImpl: NonNullable<CreateOpenAIClientOptions["fetch"]> = async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)))
        callCount += 1
        if (callCount === 1) {
            return sse([
                chunk({ role: "assistant" }),
                {
                    id: "chatcmpl_1",
                    object: "chat.completion.chunk",
                    created: 0,
                    model: "test-model",
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: "call_web",
                                        type: "function",
                                        function: {
                                            name: "web_search",
                                            arguments: JSON.stringify({ query: "DeepSeek V4" }),
                                        },
                                    },
                                ],
                            },
                            finish_reason: null,
                        },
                    ],
                },
                chunk({}, "tool_calls"),
                usageChunk(),
            ])
        }
        return sse([
            chunk({ role: "assistant" }),
            chunk({ content: "搜索结果已找到" }),
            chunk({}, "stop"),
        ])
    }

    const client = createClient(fetchImpl)
    const ctx = context(client)
    ctx.agentTools.register("test", {
        name: "web_search",
        introduction: { params: { query: "查询" }, content: "搜索" },
        call: async () => ({
            success: true,
            data: { content: "1. DeepSeek V4 发布\n   https://example.com/v4\n   长摘要" },
        }),
    })
    const store = new SessionStore(join(root, "sessions"))
    const session = await store.create({ cwd, model: "test-model", id: "conv-agent-web" })

    const result = await executeTurn({
        ctx,
        client,
        store,
        session,
        mode: "run",
        input: "搜一下",
        model: "test-model",
        stream: false,
        display: false,
    })
    assert.equal(result.isSuccess(), true)
    assert.equal(result.getData()?.reply, "搜索结果已找到")
    assert.equal(requests.length, 2)
    const second = requests[1] as { messages?: Array<{ role: string; content?: unknown }> }
    assert.equal(
        second.messages?.some((message) => message.role === "tool"),
        true,
    )

    const reopened = await store.open("conv-agent-web", cwd)
    const toolResult = reopened.events.find((event) => event.type === "tool/result")
    assert.match(String(toolResult?.data["content"] ?? ""), /DeepSeek V4 发布/)
    assert.match(String(toolResult?.data["content"] ?? ""), /https:\/\/example\.com\/v4/)
})

test("Agent 循环调用插件工具", { timeout: 20_000 }, async () => {
    const requests: unknown[] = []
    let callCount = 0
    const fetchImpl: NonNullable<CreateOpenAIClientOptions["fetch"]> = async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)))
        callCount += 1
        if (callCount === 1) {
            return sse([
                chunk({ role: "assistant" }),
                {
                    id: "chatcmpl_1",
                    object: "chat.completion.chunk",
                    created: 0,
                    model: "test-model",
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: "call_plugin",
                                        type: "function",
                                        function: {
                                            name: "hello_tool",
                                            arguments: JSON.stringify({ name: "wellspring" }),
                                        },
                                    },
                                ],
                            },
                            finish_reason: null,
                        },
                    ],
                },
                chunk({}, "tool_calls"),
            ])
        }
        return sse([
            chunk({ role: "assistant" }),
            chunk({ content: "插件工具完成" }),
            chunk({}, "stop"),
        ])
    }
    const client = createClient(fetchImpl)
    const ctx = context(client)
    ctx.agentTools.register("demo", {
        name: "hello_tool",
        introduction: { params: { name: "名称" }, content: "示例插件工具" },
        call: async (args) => ({ success: true, data: { echoed: args } }),
    })
    const store = new SessionStore(join(root, "sessions"))
    const session = await store.create({ cwd, model: "test-model", id: "conv-agent-plugin" })

    const result = await executeTurn({
        ctx,
        client,
        store,
        session,
        mode: "run",
        input: "调用插件工具",
        model: "test-model",
        stream: false,
        display: false,
    })
    assert.equal(result.isSuccess(), true)
    assert.equal(result.getData()?.reply, "插件工具完成")
    const first = requests[0] as { tools?: Array<{ function?: { name?: string } }> }
    assert.equal(
        first.tools?.some((tool) => tool.function?.name === "hello_tool"),
        true,
    )
    const reopened = await store.open("conv-agent-plugin", cwd)
    const toolResult = reopened.events.find((event) => event.type === "tool/result")
    assert.match(String(toolResult?.data["content"] ?? ""), /wellspring/)
})

test("Agent 循环调用 read 并回填行号内容", { timeout: 20_000 }, async () => {
    await writeFile(join(cwd, "read-target.txt"), "alpha\nbeta\n")
    let callCount = 0
    const fetchImpl: NonNullable<CreateOpenAIClientOptions["fetch"]> = async () => {
        callCount += 1
        if (callCount === 1) {
            return sse([
                chunk({ role: "assistant" }),
                {
                    id: "chatcmpl_1",
                    object: "chat.completion.chunk",
                    created: 0,
                    model: "test-model",
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: "call_read",
                                        type: "function",
                                        function: {
                                            name: "read",
                                            arguments: JSON.stringify({
                                                file_path: "read-target.txt",
                                            }),
                                        },
                                    },
                                ],
                            },
                            finish_reason: null,
                        },
                    ],
                },
                chunk({}, "tool_calls"),
            ])
        }
        return sse([chunk({ role: "assistant" }), chunk({ content: "读到了" }), chunk({}, "stop")])
    }
    const client = createClient(fetchImpl)
    const ctx = context(client)
    const store = new SessionStore(join(root, "sessions"))
    const session = await store.create({ cwd, model: "test-model", id: "conv-agent-read" })
    ctx.agentTools.register("test", {
        name: "read",
        introduction: { params: { file_path: "路径" }, content: "读取" },
        call: async () => ({
            success: true,
            data: { content: "1│ alpha\n2│ beta\n\n[lines 1-2 of 2]" },
        }),
    })

    const result = await executeTurn({
        ctx,
        client,
        store,
        session,
        mode: "run",
        input: "读文件",
        model: "test-model",
        stream: false,
        display: false,
    })
    assert.equal(result.isSuccess(), true)
    assert.equal(result.getData()?.reply, "读到了")
    const reopened = await store.open("conv-agent-read", cwd)
    const toolResult = reopened.events.find((event) => event.type === "tool/result")
    assert.match(String(toolResult?.data["content"] ?? ""), /1│ alpha/)
    assert.match(String(toolResult?.data["content"] ?? ""), /2│ beta/)
})

test("Session.message 注入当前 Agent step", { timeout: 20_000 }, async () => {
    const requests: unknown[] = []
    let callCount = 0
    const fetchImpl: NonNullable<CreateOpenAIClientOptions["fetch"]> = async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)))
        callCount += 1
        if (callCount === 1) {
            return sse([
                chunk({ role: "assistant" }),
                {
                    id: "chatcmpl_1",
                    object: "chat.completion.chunk",
                    created: 0,
                    model: "test-model",
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: "call_plugin_inject",
                                        type: "function",
                                        function: {
                                            name: "hello_tool",
                                            arguments: "{}",
                                        },
                                    },
                                ],
                            },
                            finish_reason: null,
                        },
                    ],
                },
                chunk({}, "tool_calls"),
            ])
        }
        return sse([chunk({ role: "assistant" }), chunk({ content: "完成" }), chunk({}, "stop")])
    }
    const client = createClient(fetchImpl)
    const ctx = context(client)
    ctx.agentTools.register("demo", {
        name: "hello_tool",
        introduction: { params: {}, content: "示例" },
        call: () => ({ success: true, data: {} }),
    })
    const store = new SessionStore(join(root, "sessions"))
    const data = await store.create({ cwd, model: "test-model", id: "conv-agent-inject" })
    const session = new Session(data, store)
    registerSession(session)
    const off = beforeStep(async () => {
        if (
            session.take.length === 0 &&
            !session.data.events.some((event) => event.type === "assistant/message")
        ) {
            await session.message("injected")
        }
    })
    try {
        const result = await executeTurn({
            ctx,
            client,
            store,
            session: data,
            mode: "run",
            input: "开始",
            model: "test-model",
            stream: false,
            display: false,
        })
        assert.equal(result.isSuccess(), true)
        const first = requests[0] as { messages?: Array<{ role: string; content: unknown }> }
        assert.equal(
            first.messages?.some(
                (message) => message.role === "user" && message.content === "injected",
            ),
            true,
        )
    } finally {
        off()
    }
})

test("executeTurn 失败时记录 failed 轮次", async () => {
    const fetchImpl: NonNullable<CreateOpenAIClientOptions["fetch"]> = async () =>
        new Response(
            JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }),
            {
                status: 429,
                headers: { "content-type": "application/json" },
            },
        )
    const client = createClient(fetchImpl)
    const ctx = context(client)
    const store = new SessionStore(join(root, "sessions"))
    const session = await store.create({ cwd, model: "test-model", id: "conv-2" })

    const result = await executeTurn({
        ctx,
        client,
        store,
        session,
        mode: "run",
        input: "hello",
        model: "test-model",
        stream: false,
        display: false,
    })

    assert.equal(result.isSuccess(), false)
    assert.equal(result.getCode(), "openai.rate-limited")

    const reopened = await store.open("conv-2", cwd)
    const last = reopened.events[reopened.events.length - 1]
    assert.equal(last?.type, "turn/end")
    const reason = last?.data["reason"] as { kind?: string; code?: string } | undefined
    assert.equal(reason?.kind, "failed")
    assert.equal(reason?.code, "openai.rate-limited")
})

test("代理为 null 时不注入 fetch", () => {
    assert.equal(createProxyFetch(null), undefined)
})

test("run 非流式输出：每步消息与工具调用交替，且换行分隔", async () => {
    let output = ""
    const agentTools = new AgentToolRegistry()
    agentTools.register("test", {
        name: "read",
        introduction: { params: { file_path: "路径" }, content: "读取文件" },
        call: async () => ({ success: true, data: { content: "file body" } }),
    })
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
        stdout: { write: (text: string) => ((output += text), true) },
        stderr: { write: () => true },
        color: false,
        json: false,
    })
    const responses = [
        sse([
            chunk({ role: "assistant" }),
            chunk({ content: "我先读一下。" }),
            chunk({
                tool_calls: [
                    {
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: { name: "read", arguments: '{"file_path":"a.txt"}' },
                    },
                ],
            }),
            chunk({}, "tool_calls"),
            usageChunk(),
        ]),
        sse([
            chunk({ role: "assistant" }),
            chunk({ content: "读完了。" }),
            chunk({}, "stop"),
            usageChunk(),
        ]),
    ]
    let index = 0
    const client = createClient(
        async () => responses[Math.min(index++, responses.length - 1)] ?? responses[1]!,
    )
    const ctx: CommandContext = {
        global: { json: false, quiet: false, help: false, version: false },
        settings: DEFAULT_SETTINGS,
        settingsFile: join(paths.configDir, "app-setting.json"),
        configCode: null,
        paths,
        logger: pino({ level: "silent" }),
        elog,
        registry: new PluginRegistry(),
        agentTools,
        openai: client,
        loadPlugins: async () => [],
    }
    const store = new SessionStore(join(root, "sessions"))
    const session = await store.create({ cwd, model: "test-model" })
    registerSession(new Session(session, store))

    const result = await executeTurn({
        ctx,
        client,
        store,
        session,
        mode: "run",
        input: "看看仓库",
        model: "test-model",
        stream: false,
        display: true,
        permission: "read-only",
    })
    assert.equal(result.isSuccess(), true)
    assert.equal(result.getData()?.reply, "读完了。")

    assert.match(output, /我先读一下。\n\n读取文件  a\.txt\n\n\[Agent\]\n读完了。/, output)
    assert.equal(output.split("读完了。").length - 1, 1, "最终消息不应重复打印")
    assert.ok(!output.includes("Agent调用工具"), `工具调用不再用旧的多行块：\n${output}`)
    assert.ok(!output.includes("[操作]"), `不再打印 [操作] 状态行：\n${output}`)
})
