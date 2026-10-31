import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { getAgentToolContext } from "../src/agent/tool-context.ts"
import { configureHost } from "../src/api/host/host.ts"
import type { HostAgentApprovalRequest } from "../src/api/host/agent.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initPaths, type ResolvedPaths } from "../src/platform/path.ts"
import { createHostAgentService } from "../src/plugin/agent-service.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import { initElog } from "../src/logger/elog4js.ts"

let root = ""
let server: Server | null = null
let baseUrl = ""
let requestCount = 0

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-agent-approval-"))
    process.env["OPENAI_API_KEY"] = "test-key"
    const resolved = paths()
    initPaths(resolved)
    configureHost({ paths: resolved })
    initElog({
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        color: false,
        json: false,
    })
    server = createServer((request, response) => {
        request.resume()
        request.on("end", () => {
            requestCount += 1
            response.statusCode = 200
            response.setHeader("content-type", "text/event-stream")
            const parts = requestCount % 2 === 1 ? toolCallChunks() : finalChunks()
            for (const part of parts) {
                response.write(`data: ${JSON.stringify(part)}\n\n`)
            }
            response.end("data: [DONE]\n\n")
        })
    })
    await new Promise<void>((resolvePromise) => {
        server?.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const address = server.address()
    if (address === null || typeof address === "string") {
        throw new Error("测试服务器没有端口")
    }
    baseUrl = `http://127.0.0.1:${address.port}/v1`
})

after(async () => {
    delete process.env["OPENAI_API_KEY"]
    await new Promise<void>((resolvePromise) => server?.close(() => resolvePromise()))
    await rm(root, { recursive: true, force: true })
})

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
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
}

function toolCallChunks(): object[] {
    return [
        chunk({ role: "assistant" }),
        chunk({
            tool_calls: [
                {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "escalate", arguments: "{}" },
                },
            ],
        }),
        chunk({}, "tool_calls"),
        usageChunk(),
    ]
}

function finalChunks(): object[] {
    return [
        chunk({ role: "assistant" }),
        chunk({ content: "完成" }),
        chunk({}, "stop"),
        usageChunk(),
    ]
}

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

async function runApprovalTurn(approved: boolean): Promise<{ reply: string; requests: number }> {
    requestCount = 0
    const agentTools = new AgentToolRegistry()
    agentTools.register("test", {
        name: "escalate",
        introduction: { params: {}, content: "请求提升权限" },
        call: async () => {
            const context = getAgentToolContext()
            if (context === null || context.approveExec === undefined) {
                return { success: false, data: { content: "没有审批回调" } }
            }
            const allowed = await context.approveExec({
                command: "node",
                argv: ["-e", "console.log(1)"],
                cwd: context.workspaceDir,
                currentPermission: "read-only",
                requestedPermission: "workspace-write",
                justification: "需要写入构建产物",
                network: true,
                background: true,
                stdin: "y\n",
                timeoutMs: 4000,
            })
            return { success: allowed, data: { content: allowed ? "approved" : "denied" } }
        },
    })
    const service = createHostAgentService({
        settings: {
            ...DEFAULT_SETTINGS,
            openai: { ...DEFAULT_SETTINGS.openai, baseUrl, model: "test-model" },
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        paths: paths(),
        logger: pino({ level: "silent" }),
        registry: new PluginRegistry(),
        agentTools,
        cwd: root,
    })

    let resolveApproval: ((request: HostAgentApprovalRequest) => void) | null = null
    const approvalSeen = new Promise<HostAgentApprovalRequest>((resolvePromise) => {
        resolveApproval = resolvePromise
    })
    const events: string[] = []
    const streamPromise = service.stream({ message: "执行" }, (event) => {
        events.push(event.type)
        if (event.type === "approval") {
            resolveApproval?.(event.request)
        }
    })
    const request = await approvalSeen
    assert.equal(request.command, "node")
    assert.equal(request.requestedPermission, "workspace-write")
    assert.equal(request.justification, "需要写入构建产物")
    /* 审批界面要展示这些：argv 是真正执行的东西，其余决定这次调用还能做什么 */
    assert.deepEqual(request.argv, ["-e", "console.log(1)"])
    assert.equal(request.network, true)
    assert.equal(request.background, true)
    assert.equal(request.stdin, "y\n")
    assert.equal(request.timeoutMs, 4000)
    assert.equal(await service.respondApproval(request.approvalId, approved), true)
    const result = await streamPromise
    assert.equal(result.reply, "完成")
    assert.ok(events.includes("approval"))
    assert.equal(await service.respondApproval(request.approvalId, approved), false)
    return { reply: result.reply, requests: requestCount }
}

test("Agent 服务：提权请求批准后继续执行", { timeout: 20_000 }, async () => {
    const result = await runApprovalTurn(true)
    assert.equal(result.requests, 2)
})

test("Agent 服务：提权请求拒绝后继续执行", { timeout: 20_000 }, async () => {
    const result = await runApprovalTurn(false)
    assert.equal(result.requests, 2)
})

test("Agent 服务：本轮 permission 覆盖宿主默认权限", { timeout: 20_000 }, async () => {
    requestCount = 0
    let seenPermission: string | null = null
    const agentTools = new AgentToolRegistry()
    agentTools.register("test", {
        name: "escalate",
        introduction: { params: {}, content: "记录当前权限" },
        call: async () => {
            const context = getAgentToolContext()
            seenPermission = context === null ? null : context.permission
            return { success: true, data: { content: "ok" } }
        },
    })
    const service = createHostAgentService({
        settings: {
            ...DEFAULT_SETTINGS,
            openai: { ...DEFAULT_SETTINGS.openai, baseUrl, model: "test-model" },
            sandbox: {
                ...DEFAULT_SETTINGS.sandbox,
                mode: "best-effort",
                access: "read-only",
            },
        },
        paths: paths(),
        logger: pino({ level: "silent" }),
        registry: new PluginRegistry(),
        agentTools,
        cwd: root,
    })
    const result = await service.chat({ message: "记录权限", permission: "workspace-write" })
    assert.equal(result.reply, "完成")
    assert.equal(seenPermission, "workspace-write")
})

test("Agent 服务：拒绝非法的 permission", { timeout: 20_000 }, async () => {
    const service = createHostAgentService({
        settings: {
            ...DEFAULT_SETTINGS,
            openai: { ...DEFAULT_SETTINGS.openai, baseUrl, model: "test-model" },
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        paths: paths(),
        logger: pino({ level: "silent" }),
        registry: new PluginRegistry(),
        agentTools: new AgentToolRegistry(),
        cwd: root,
    })
    await assert.rejects(
        service.chat({ message: "不该执行", permission: "root" as never }),
        /permission 不合法/,
    )
})
