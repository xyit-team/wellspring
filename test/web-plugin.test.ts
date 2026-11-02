import assert from "node:assert/strict"
import { startHttpHostPlugin } from "./helpers/http-host.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { emitInitHooks, emitShutdownHooks } from "../src/api/host/hooks.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { EventEntity, eventBus } from "../src/event/event.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { PluginSandboxClient, shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"

const projectRoot = join(import.meta.dirname, "..")
let root = ""
const askCalls: Array<{ askId: string; answer: string }> = []
let lastAgentPermission: unknown = "unset"

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-web-test-"))
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

test("web 插件：首次设置密码、登录、与 Agent 聊天", { timeout: 20_000 }, async () => {
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
            hostApi: ["logger", "fs", "http", "agent", "event", "workspaces"],
            workspaceRead: false,
            workspaceWrite: false,
        },
        agent: {
            async chat(input) {
                lastAgentPermission = input.permission
                return {
                    sessionId: "web-session",
                    turn: 1,
                    steps: 2,
                    reply: `reply:${input.message}`,
                    model: "test",
                    usage: null,
                }
            },
            async stream(input, onEvent) {
                lastAgentPermission = input.permission
                onEvent({ type: "session", sessionId: "stream-session" })
                onEvent({ type: "delta", text: "partial" })
                onEvent({
                    type: "ask",
                    request: {
                        askId: "ask_test",
                        question: "用哪个分支？",
                        options: ["main", "dev"],
                    },
                })
                return {
                    sessionId: "stream-session",
                    turn: 1,
                    steps: 2,
                    reply: `stream:${input.message}`,
                    model: "test",
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
                askCalls.push({ askId, answer })
                return askId !== "unknown" && answer !== ""
            },
            async validateWorkspace(path: string) {
                return {
                    ok: true,
                    root: path,
                    name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
                }
            },
            async openPath(_path: string, _mode?: "default" | "reveal") {
                return
            },
            async pickDirectory() {
                return { ok: false, root: "", name: "", error: "已取消" }
            },
            async searchWorkspaceFiles(root: string) {
                return {
                    ok: true,
                    root,
                    entries: [{ path: "src/main.ts", name: "main.ts", type: "file" as const }],
                    truncated: false,
                }
            },
        },
    })
    try {
        await client.start()
        await emitInitHooks()
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output.text)
        assert.ok(match, output.text)
        const base = `http://127.0.0.1:${match[1]}`

        const state = (await (await fetch(`${base}/api/state`)).json()) as {
            configured: boolean
            authenticated: boolean
        }
        assert.equal(state.configured, false)
        assert.equal(state.authenticated, false)

        const setup = await fetch(`${base}/api/auth/setup`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: "secret123" }),
        })
        assert.equal(setup.status, 200)
        let cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? ""
        assert.match(cookie, /wellspring_web_session=/)

        const authed = (await (
            await fetch(`${base}/api/state`, { headers: { cookie } })
        ).json()) as { authenticated: boolean }
        assert.equal(authed.authenticated, true)

        // 修改密码：当前密码错误 → 401；太短 → 400；成功后旧会话失效、新 cookie 生效
        const wrongCurrent = await fetch(`${base}/api/auth/password`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ currentPassword: "wrong", newPassword: "newsecret456" }),
        })
        assert.equal(wrongCurrent.status, 401)
        const tooShort = await fetch(`${base}/api/auth/password`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ currentPassword: "secret123", newPassword: "123" }),
        })
        assert.equal(tooShort.status, 400)
        const changed = await fetch(`${base}/api/auth/password`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ currentPassword: "secret123", newPassword: "newsecret456" }),
        })
        assert.equal(changed.status, 200)
        const newCookie = changed.headers.get("set-cookie")?.split(";")[0] ?? ""
        assert.match(newCookie, /wellspring_web_session=/)
        assert.notEqual(newCookie, cookie)
        const oldSession = (await (
            await fetch(`${base}/api/state`, { headers: { cookie } })
        ).json()) as { authenticated: boolean }
        assert.equal(oldSession.authenticated, false, "修改密码后旧会话应失效")
        const newSession = (await (
            await fetch(`${base}/api/state`, { headers: { cookie: newCookie } })
        ).json()) as { authenticated: boolean }
        assert.equal(newSession.authenticated, true)
        const oldLogin = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: "secret123" }),
        })
        assert.equal(oldLogin.status, 401)
        const newLogin = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: "newsecret456" }),
        })
        assert.equal(newLogin.status, 200)
        cookie = newCookie

        const workspaceResponse = await fetch(`${base}/api/workspaces`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ root: projectRoot }),
        })
        assert.equal(workspaceResponse.status, 201)
        const workspaceBody = (await workspaceResponse.json()) as {
            workspace: { id: string; root: string }
        }
        assert.equal(workspaceBody.workspace.root, projectRoot)
        const workspaceId = workspaceBody.workspace.id

        const chat = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ message: "hello", workspaceId }),
        })
        assert.equal(chat.status, 200)
        const data = (await chat.json()) as { sessionId: string; reply: string }
        assert.equal(data.sessionId, "web-session")
        assert.equal(data.reply, "reply:hello")

        const streamed = await fetch(`${base}/api/chat/stream`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ message: "hello", workspaceId }),
        })
        const events = await streamed.text()
        assert.equal(streamed.status, 200, events)
        assert.match(events, /"type":"delta"/)
        assert.match(events, /"text":"partial"/)
        assert.match(events, /"type":"done"/)
        assert.match(events, /"sessionId":"stream-session"/)
        assert.match(events, /"type":"session"/)
        assert.match(events, /"sessionId":"stream-session"/)
        assert.match(events, /"type":"ask"/)
        assert.match(events, /"question":"用哪个分支？"/)

        const answered = await fetch(`${base}/api/asks/ask_test`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ answer: "main" }),
        })
        assert.equal(answered.status, 200)
        assert.deepEqual(askCalls[0], { askId: "ask_test", answer: "main" })
        const badAnswer = await fetch(`${base}/api/asks/ask_test`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ answer: 42 }),
        })
        assert.equal(badAnswer.status, 400)
        const missingAsk = await fetch(`${base}/api/asks/unknown`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ answer: "x" }),
        })
        /*
         * 没接受不等于接口出错：面板很可能来自「刷新后的重放」，这一问早就答过了。
         * 以前这里回 404，用户点一下就看到一个没意义的报错。
         */
        assert.equal(missingAsk.status, 200)
        assert.deepEqual(await missingAsk.json(), { ok: false, accepted: false, stale: true })

        /*
         * 答过的提问不能靠刷新重连续接再弹一次
         *
         * resume 是照 buffer 原样重放，答完的 ask 如果不从缓冲里抹掉，
         * 刷新一次就又弹出来，再点一次还会因为宿主已消费掉而失败。
         */
        const askStream = await fetch(`${base}/api/chat/stream`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ message: "ask", workspaceId, conversationId: "conv-ask" }),
        })
        assert.equal(askStream.status, 200)
        assert.match(await askStream.text(), /"question":"用哪个分支？"/)
        const answeredOnce = await fetch(`${base}/api/asks/ask_test`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ answer: "main" }),
        })
        assert.equal(answeredOnce.status, 200)
        assert.equal(((await answeredOnce.json()) as { accepted: boolean }).accepted, true)
        const replayText = await (
            await fetch(`${base}/api/chat/resume?conversationId=conv-ask&since=0`, {
                headers: { accept: "text/event-stream", cookie },
            })
        ).text()
        assert.match(replayText, /"type":"ask","request":null/, "重放里那一问已被清空")
        assert.doesNotMatch(replayText, /用哪个分支？/, "重放不该再把答过的问题弹出来")

        // 权限切换器：permission 透传到宿主 Agent，非法值被拒绝
        const permissionChat = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({
                message: "hello",
                workspaceId,
                permission: "danger-full-access",
            }),
        })
        assert.equal(permissionChat.status, 200)
        assert.equal(lastAgentPermission, "danger-full-access")

        const permissionStream = await fetch(`${base}/api/chat/stream`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({
                message: "hello",
                workspaceId,
                permission: "workspace-write",
            }),
        })
        assert.equal(permissionStream.status, 200)
        await permissionStream.text()
        assert.equal(lastAgentPermission, "workspace-write")

        const invalidPermission = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ message: "hello", workspaceId, permission: "root" }),
        })
        assert.equal(invalidPermission.status, 400)

        const unauthorized = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "hello", workspaceId }),
        })
        assert.equal(unauthorized.status, 401)

        // 侧栏扩展：事件注册 nav-bottom 链接
        const addonsUnauthorized = await fetch(`${base}/api/addons`)
        assert.equal(addonsUnauthorized.status, 401)

        eventBus.publish(
            "wellspring-web:addon:register",
            EventEntity.create({
                type: "nav-bottom",
                meta: { label: "打开 Wellspring Code", to: "http://127.0.0.1:8788" },
            }),
        )
        await new Promise((resolve) => setTimeout(resolve, 200))
        const addonsResponse = await fetch(`${base}/api/addons`, { headers: { cookie } })
        assert.equal(addonsResponse.status, 200)
        const addonsBody = (await addonsResponse.json()) as {
            addons: Array<{ label: string; to: string; external: boolean }>
        }
        assert.deepEqual(
            addonsBody.addons.map((addon) => [addon.label, addon.to, addon.external]),
            [["打开 Wellspring Code", "http://127.0.0.1:8788/", true]],
        )

        // 省略协议的 host:port 会被补成 http
        eventBus.publish(
            "wellspring-web:addon:register",
            EventEntity.create({
                type: "nav-bottom",
                meta: { id: "wellspring-code", label: "代码编辑器", to: "127.0.0.1:8788" },
            }),
        )
        await new Promise((resolve) => setTimeout(resolve, 150))
        const withShortUrl = (await (
            await fetch(`${base}/api/addons`, { headers: { cookie } })
        ).json()) as { addons: Array<{ id: string; label: string; to: string; external: boolean }> }
        const codeAddon = withShortUrl.addons.find((addon) => addon.id === "wellspring-code")
        assert.equal(codeAddon?.label, "代码编辑器")
        assert.equal(codeAddon?.to, "http://127.0.0.1:8788/")
        assert.equal(codeAddon?.external, true)

        eventBus.publish(
            "wellspring-web:addon:register",
            EventEntity.create({
                type: "nav-bottom",
                meta: { label: "危险链接", to: "javascript:alert(1)" },
            }),
        )
        await new Promise((resolve) => setTimeout(resolve, 150))
        const afterInvalid = (await (
            await fetch(`${base}/api/addons`, { headers: { cookie } })
        ).json()) as { addons: unknown[] }
        assert.equal(afterInvalid.addons.length, 2)

        // SSE 初始快照
        const controller = new AbortController()
        const sse = await fetch(`${base}/api/addons/stream`, {
            headers: { cookie },
            signal: controller.signal,
        })
        assert.equal(sse.status, 200)
        assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/)
        assert.ok(sse.body !== null)
        const reader = sse.body.getReader()
        const first = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("addon SSE 超时")), 3000),
            ),
        ])
        const chunk = new TextDecoder().decode(first.value)
        assert.match(chunk, /event: addons/)
        assert.match(chunk, /打开 Wellspring Code/)
        assert.match(chunk, /代码编辑器/)
        controller.abort()
    } finally {
        await emitShutdownHooks()
        await shutdownAllSandboxPlugins()
    }
})
