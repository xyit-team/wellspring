/*
 * Web 插件的模型与供应商接口：增删供应商、切换模型、按供应商发聊天、界面接线。
 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { emitInitHooks, emitShutdownHooks } from "../src/api/host/hooks.ts"
import type { HostAgentChatInput } from "../src/api/host/agent.ts"
import type { HostAgentService } from "../src/plugin/agent-service.ts"
import { createHostModelsService } from "../src/plugin/models-service.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { SETTING_FILE_NAME } from "../src/config/loader.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { PluginSandboxClient, shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"

const projectRoot = join(import.meta.dirname, "..")
let root = ""
let previousKey: string | undefined
let client: PluginSandboxClient | null = null
let base = ""
let lastChatInput: HostAgentChatInput | null = null
let cookie = ""

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

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-web-models-"))
    previousKey = process.env["OPENAI_API_KEY"]
    delete process.env["OPENAI_API_KEY"]
    const resolved = paths()
    configureHost({ paths: resolved })
    const output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    const logger = pino({ level: "silent" })
    const settings = {
        ...DEFAULT_SETTINGS,
        openai: { ...DEFAULT_SETTINGS.openai, timeoutMs: 700, maxRetries: 0 },
    }
    const fakeAgent = {
        async chat(input: HostAgentChatInput) {
            lastChatInput = input
            return {
                sessionId: "model-session",
                turn: 1,
                steps: 1,
                reply: `reply:${input.provider ?? "-"}/${input.model ?? "-"}`,
                model: input.model ?? "test",
                usage: null,
            }
        },
        async stream(
            input: HostAgentChatInput,
            onEvent: (event: { type: "delta"; text: string }) => void,
        ) {
            lastChatInput = input
            onEvent({ type: "delta", text: "ok" })
            return {
                sessionId: "model-stream",
                turn: 1,
                steps: 1,
                reply: "stream",
                model: input.model ?? "test",
                usage: null,
            }
        },
        async validateWorkspace(path: string) {
            return { ok: true, root: path, name: "ws" }
        },
        async pickDirectory() {
            return { ok: false, root: "", name: "", error: "已取消" }
        },
        async searchWorkspaceFiles(fileRoot: string) {
            return { ok: true, root: fileRoot, entries: [], truncated: false }
        },
        async interject() {
            return false
        },
        async respondApproval() {
            return false
        },
    } as unknown as HostAgentService
    client = new PluginSandboxClient({
        pluginId: "wellspring-web",
        pluginName: "Wellspring Web",
        pluginVersion: "1.0.0",
        pluginDir: join(projectRoot, "plugins", "wellspring-web"),
        pluginEntry: join(projectRoot, "plugins", "wellspring-web", "index.ts"),
        paths: resolved,
        config: settings,
        pluginConfig: { port: 0 },
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 8192 },
        logger,
        permissions: {
            hostApi: ["logger", "fs", "http", "agent", "models", "event", "getHost"],
            workspaceRead: false,
            workspaceWrite: false,
        },
        models: createHostModelsService({
            settings,
            settingsFile: join(resolved.configDir, SETTING_FILE_NAME),
            configDir: resolved.configDir,
            logger,
        }),
        agent: fakeAgent,
    })
    await client.start()
    await emitInitHooks()
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output.text)
    assert.ok(match, output.text)
    base = `http://127.0.0.1:${match[1]}`

    const setup = await fetch(`${base}/api/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "secret123" }),
    })
    assert.equal(setup.status, 200)
    cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? ""
})

after(async () => {
    await emitShutdownHooks()
    await shutdownAllSandboxPlugins()
    client = null
    if (previousKey === undefined) {
        delete process.env["OPENAI_API_KEY"]
    } else {
        process.env["OPENAI_API_KEY"] = previousKey
    }
    await rm(root, { recursive: true, force: true })
})

async function request(
    method: string,
    path: string,
    body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, data: (await response.json()) as Record<string, unknown> }
}

test("页面包含模型切换入口与供应商弹窗", async () => {
    const html = await (await fetch(`${base}/`)).text()
    assert.match(html, /id="model-btn"/)
    assert.match(html, /id="model-menu"/)
    assert.match(html, /id="providers-open"/)
    assert.match(html, /id="models-dialog"/)
    assert.match(html, /id="provider-name"/)
    assert.match(html, /id="provider-baseurl"/)
    assert.match(html, /id="provider-save"/)
    const script = await (await fetch(`${base}/assets/app.js`)).text()
    assert.match(script, /\/api\/models/)
    assert.match(script, /function loadModels\(/)
    assert.match(script, /function switchModel\(/)
    assert.match(script, /function saveProviderForm\(/)
    assert.match(script, /function renderModelMenu\(/)
    assert.match(script, /function chooseModel\(/)
})

test("模型接口：新增供应商、切模型、Key 状态、删除", async () => {
    const initial = await request("GET", "/api/models")
    assert.equal(initial.status, 200)
    const initialProviders = initial.data["providers"] as Array<Record<string, unknown>>
    assert.equal(initialProviders.length, 1)
    assert.equal(initialProviders[0]?.["id"], "openai")
    assert.equal(initialProviders[0]?.["builtin"], true)

    const saved = await request("POST", "/api/models/provider", {
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        models: ["deepseek-chat", "deepseek-reasoner"],
        defaultModel: "deepseek-chat",
        apiKey: "sk-web-deepseek-00001111",
    })
    assert.equal(saved.status, 200)
    const state = saved.data["state"] as Record<string, unknown>
    const providers = state["providers"] as Array<Record<string, unknown>>
    const deepseek = providers.find((item) => item["id"] === "deepseek")
    assert.ok(deepseek !== undefined)
    assert.equal(deepseek?.["keyConfigured"], true)
    assert.equal(deepseek?.["keyMasked"], "sk-…1111")

    assert.equal((initial.data as Record<string, unknown>)["activeReasoning"], "off")
    const active = await request("POST", "/api/models/active", {
        providerId: "deepseek",
        model: "deepseek-reasoner",
        reasoning: "high",
    })
    assert.equal(active.status, 200)
    const activeState = active.data["state"] as Record<string, unknown>
    assert.equal(activeState["activeProvider"], "deepseek")
    assert.equal(activeState["activeModel"], "deepseek-reasoner")
    assert.equal(activeState["activeReasoning"], "high")

    // 聊天带上浏览器选择的供应商/模型（这里显式传，验证透传）
    const chat = await request("POST", "/api/chat", {
        message: "hello",
        workspaceRoot: projectRoot,
        provider: "deepseek",
        model: "deepseek-reasoner",
        reasoning: "high",
    })
    assert.equal(chat.status, 200, JSON.stringify(chat.data))
    assert.equal(lastChatInput?.provider, "deepseek")
    assert.equal(lastChatInput?.model, "deepseek-reasoner")
    assert.equal(lastChatInput?.reasoning, "high")
    assert.equal(chat.data["reply"], "reply:deepseek/deepseek-reasoner")

    // Key：坏格式被拒，合法格式保存，清除后回落到未配置
    const badKey = await request("POST", "/api/models/key", { id: "deepseek", apiKey: "bad key" })
    assert.equal(badKey.status, 400)
    const keyed = await request("POST", "/api/models/key", {
        id: "deepseek",
        apiKey: "sk-web-deepseek-22223333",
    })
    assert.equal(keyed.status, 200)
    const clearedKey = await request("POST", "/api/models/key/clear", { id: "deepseek" })
    assert.equal(clearedKey.status, 200)
    const clearedState = clearedKey.data["state"] as Record<string, unknown>
    const clearedProviders = clearedState["providers"] as Array<Record<string, unknown>>
    assert.equal(
        clearedProviders.find((item) => item["id"] === "deepseek")?.["keyConfigured"],
        false,
    )

    // 拉取模型：不可用地址快速失败，错误码映射成文案
    const fetched = await request("POST", "/api/models/fetch", {
        id: "deepseek",
        apiKey: "sk-web-deepseek-22223333",
    })
    assert.equal(fetched.status, 400)
    assert.match(String(fetched.data["error"]), /连接|供应商|超时|API Key/)

    const removed = await request("POST", "/api/models/provider/remove", { id: "deepseek" })
    assert.equal(removed.status, 200)
    const removedState = removed.data["state"] as Record<string, unknown>
    assert.equal((removedState["providers"] as unknown[]).length, 1)
    assert.equal(removedState["activeProvider"], "openai")

    const builtinRemove = await request("POST", "/api/models/provider/remove", { id: "openai" })
    assert.equal(builtinRemove.status, 400)
    assert.match(String(builtinRemove.data["error"]), /内置/)

    const badActive = await request("POST", "/api/models/active", { providerId: "nope" })
    assert.equal(badActive.status, 400)
})
