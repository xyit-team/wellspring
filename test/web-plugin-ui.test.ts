import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { emitInitHooks, emitShutdownHooks } from "../src/api/host/hooks.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { PluginSandboxClient, shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"
import { CLIENT_SCRIPT, STATIC_ASSETS } from "../plugins/wellspring-web/src/assets/index.ts"

const projectRoot = join(import.meta.dirname, "..")
let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-web-ui-test-"))
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

interface Running {
    readonly base: string
    readonly output: string
}

const approvalCalls: Array<{ approvalId: string; approved: boolean }> = []
const askCalls: Array<{ askId: string; answer: string }> = []
const interjectCalls: Array<{ sessionId: string; message: string }> = []
/** 模拟宿主会话：只有 stream 进行中才允许插话 */
const activeSessions = new Set<string>()

async function startWebPlugin(
    options: { readonly slowStream?: boolean; readonly streamDelayMs?: number } = {},
): Promise<Running> {
    const resolved = paths()
    configureHost({ paths: resolved })
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
            hostApi: ["logger", "fs", "http", "agent", "event", "getHost"],
            workspaceRead: false,
            workspaceWrite: false,
        },
        agent: {
            async chat(input) {
                return {
                    sessionId: "ui-session",
                    turn: 1,
                    steps: 2,
                    reply: `reply:${input.message}`,
                    model: "test-model",
                    usage: null,
                }
            },
            async stream(input, onEvent) {
                activeSessions.add("ui-stream-session")
                onEvent({ type: "session", sessionId: "ui-stream-session" })
                onEvent({ type: "step", turn: 1, step: 1 })
                onEvent({
                    type: "approval",
                    request: {
                        approvalId: "apv_test",
                        command: "node",
                        argv: ["-e", "console.log(1)"],
                        cwd: process.cwd(),
                        currentPermission: "read-only",
                        requestedPermission: "workspace-write",
                        justification: "需要写入文件",
                    },
                })
                onEvent({
                    type: "ask",
                    request: {
                        askId: "ask_test",
                        question: "用哪个分支？",
                        options: ["main", "dev"],
                    },
                })
                onEvent({ type: "reasoning", text: "先想一下。" })
                onEvent({
                    type: "tool",
                    id: "call_1",
                    name: "read",
                    phase: "start",
                    arguments: '{"file_path":"a.txt"}',
                })
                onEvent({
                    type: "tool",
                    id: "call_1",
                    name: "read",
                    phase: "end",
                    ok: true,
                    result: "文件内容",
                })
                onEvent({ type: "delta", text: "# 标题\n\n" })
                onEvent({ type: "delta", text: "流式 `code` 与 **粗体**" })
                if (options.slowStream === true) {
                    await new Promise((resolve) => setTimeout(resolve, 150))
                    onEvent({ type: "delta", text: "尾部内容" })
                }
                if (options.streamDelayMs !== undefined) {
                    await new Promise((resolve) => setTimeout(resolve, options.streamDelayMs))
                    onEvent({ type: "delta", text: "尾部内容" })
                }
                activeSessions.delete("ui-stream-session")
                return {
                    sessionId: "ui-stream-session",
                    turn: 1,
                    steps: 2,
                    reply: `stream:${input.message}`,
                    model: "test-model",
                    usage: { inputTokens: 12, outputTokens: 34 },
                }
            },
            async interject(sessionId: string, message: string) {
                interjectCalls.push({ sessionId, message })
                return activeSessions.has(sessionId)
            },
            async respondApproval(approvalId: string, approved: boolean) {
                approvalCalls.push({ approvalId, approved })
                return approvalId !== "unknown"
            },
            async respondAsk(askId: string, answer: string) {
                askCalls.push({ askId, answer })
                return askId !== "unknown"
            },
            async validateWorkspace(path: string) {
                return {
                    ok: true,
                    root: path,
                    name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
                }
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
    await client.start()
    await emitInitHooks()
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output.text)
    assert.ok(match, output.text)
    return { base: `http://127.0.0.1:${match[1]}`, output: output.text }
}

async function stopWebPlugin(): Promise<void> {
    await emitShutdownHooks()
    await shutdownAllSandboxPlugins()
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 同一临时 data 目录已经设过密码时改走登录 */
async function authenticate(base: string): Promise<string> {
    const setup = await fetch(`${base}/api/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "secret123" }),
    })
    let cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? ""
    if (setup.status !== 200) {
        const login = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: "secret123" }),
        })
        assert.equal(login.status, 200)
        cookie = login.headers.get("set-cookie")?.split(";")[0] ?? ""
    }
    assert.match(cookie, /wellspring_web_session=/)
    return cookie
}

async function ensureWorkspace(base: string, cookie: string): Promise<string> {
    const response = await fetch(`${base}/api/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ root: projectRoot }),
    })
    assert.ok(response.status === 201 || response.status === 409)
    return ((await response.json()) as { workspace: { id: string } }).workspace.id
}

test("web 插件：页面外壳、静态资源与主题 cookie", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin()
    try {
        const page = await fetch(`${server.base}/`)
        assert.equal(page.status, 200)
        const html = await page.text()
        assert.match(page.headers.get("content-type") ?? "", /text\/html/)
        const csp = page.headers.get("content-security-policy") ?? ""
        assert.match(csp, /default-src 'none'/)
        assert.match(csp, /script-src 'self'/)
        assert.equal(page.headers.get("x-content-type-options"), "nosniff")
        assert.equal(page.headers.get("x-frame-options"), "DENY")
        assert.equal(page.headers.get("cache-control"), "no-store")

        assert.match(html, /<link rel="stylesheet" href="\/assets\/app\.css">/)
        assert.match(html, /<script src="\/assets\/app\.js" defer><\/script>/)
        assert.ok(!html.includes("<style"), "页面不应有内联 <style>")
        assert.ok(!/\son[a-z]+=/.test(html), "页面不应有内联事件处理器")
        assert.match(html, /<h1 id="setup-title">/)
        assert.match(html, /<h1 id="login-title">/)
        assert.match(html, /id="setup-panel"/)
        assert.match(html, /id="login-panel"/)
        assert.match(html, /id="app"/)
        // 侧栏：中段单独滚动，工作区列表可折叠
        assert.match(html, /id="sidebar-scroll"/)
        assert.match(html, /id="workspace-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="workspace-body"/)
        assert.match(html, /id="workspace-body"/)
        assert.match(html, /id="workspace-active" hidden/)
        // 输入框 @ 引用高亮层（镜像层在 textarea 之下）
        assert.match(html, /class="composer-field"/)
        assert.match(html, /id="composer-highlight"/)
        assert.match(html, /id="composer-highlight-inner"/)
        assert.ok(!html.includes('data-theme="'), "默认主题不写 data-theme")
        // Agent 权限切换器：三个权限选项 + 完全访问的警告条
        assert.match(html, /id="perm-btn"/)
        assert.match(html, /id="perm-menu"/)
        assert.match(html, /id="perm-warning"/)
        assert.match(html, /data-permission="read-only"/)
        assert.match(html, /data-permission="workspace-write"/)
        assert.match(html, /data-permission="danger-full-access"/)
        assert.match(html, /role="menuitemradio"/)
        // 首次默认「工作区可写」（工作区内修改），完全访问仍需二次确认
        assert.match(html, /aria-checked="true" data-permission="workspace-write"/)
        assert.match(html, /aria-checked="false" data-permission="read-only"/)
        // 修改密码：侧栏入口与弹窗
        assert.match(html, /id="password-open"/)
        assert.match(html, /id="password-dialog"/)
        assert.match(html, /id="password-current"/)
        assert.match(html, /id="password-new"/)
        assert.match(html, /id="password-confirm"/)
        assert.match(html, /id="password-save"/)
        assert.match(html, /id="password-cancel"/)
        assert.match(html, /id="i-lock"/)
        // 输入框：Enter 换行，Shift+Enter 发送
        assert.match(html, /<kbd>Enter<\/kbd> 换行/)
        assert.match(html, /<kbd>Shift<\/kbd>\+<kbd>Enter<\/kbd> 发送/)
        assert.match(html, /placeholder="输入消息，Shift\+Enter 发送"/)
        assert.match(html, /id="hint-busy" hidden>回复中…/)
        assert.match(html, /<kbd>Shift<\/kbd>\+<kbd>Enter<\/kbd> 插话/)
        // Agent 提问卡片（输入框上方，参考 Harness）
        assert.match(html, /id="ask-card"/)
        assert.match(html, /id="ask-question"/)
        assert.match(html, /id="ask-options"/)
        assert.match(html, /id="ask-custom"/)
        assert.match(html, /id="ask-input"/)
        assert.match(html, /id="ask-feedback"/)
        assert.match(html, /id="ask-submit"/)
        assert.match(html, /id="ask-skip"/)
        assert.match(html, /id="ask-x"/)
        assert.match(html, /id="ask-min"/)
        assert.match(html, /id="i-edit"/)
        // 模型切换与自定义供应商
        assert.match(html, /id="model-btn"/)
        assert.match(html, /id="model-menu"/)
        assert.match(html, /id="model-manage"/)
        assert.match(html, /id="providers-open"/)
        assert.match(html, /id="models-dialog"/)
        assert.match(html, /id="provider-name"/)
        assert.match(html, /id="provider-baseurl"/)
        assert.match(html, /id="provider-save"/)
        // 思考链与工具调用：图标、客户端渲染与样式
        assert.match(html, /id="i-think"/)
        assert.match(html, /id="i-tool"/)
        assert.match(html, /id="i-chevron"/)
        assert.match(CLIENT_SCRIPT, /function enqueueAsk/)
        assert.match(CLIENT_SCRIPT, /function showNextAsk/)
        assert.match(CLIENT_SCRIPT, /function submitAsk/)
        assert.match(CLIENT_SCRIPT, /function finishAsks/)
        assert.match(CLIENT_SCRIPT, /function dismissAsks/)
        assert.match(CLIENT_SCRIPT, /function chooseAskOption/)
        assert.match(CLIENT_SCRIPT, /function toggleAskMinimized/)
        assert.match(CLIENT_SCRIPT, /function updateAskSubmit/)
        assert.match(CLIENT_SCRIPT, /ASK_RECOMMENDED/)
        // 推荐选项标签只影响展示，答案仍取原始标签
        assert.match(CLIENT_SCRIPT, /askDisplayLabel/)
        assert.match(CLIENT_SCRIPT, /ask: "询问用户"/)
        assert.match(CLIENT_SCRIPT, /\/api\/asks\//)
        assert.match(CLIENT_SCRIPT, /ask: "询问用户"/)
        assert.match(CLIENT_SCRIPT, /function syncMessageContent/)
        assert.match(CLIENT_SCRIPT, /function processTextAt/)
        assert.match(CLIENT_SCRIPT, /function appendReasoning/)
        assert.match(CLIENT_SCRIPT, /function applyToolEvent/)
        assert.match(CLIENT_SCRIPT, /function reasoningSummary/)
        assert.match(CLIENT_SCRIPT, /TOOL_LABELS/)
        assert.match(CLIENT_SCRIPT, /permission: "workspace-write"/)
        assert.match(CLIENT_SCRIPT, /function choosePermission/)
        assert.match(CLIENT_SCRIPT, /permission: conversation\.permission/)
        // 会话级模型 / 推理 / 权限
        assert.match(CLIENT_SCRIPT, /function conversationSettings/)
        assert.match(CLIENT_SCRIPT, /function pinConversationSettings/)
        assert.match(CLIENT_SCRIPT, /function setDefaultModel/)
        assert.match(CLIENT_SCRIPT, /event\.type === "session"/)
        assert.match(CLIENT_SCRIPT, /function conversationPermission/)
        assert.match(CLIENT_SCRIPT, /function applyConversationSettings/)
        assert.match(CLIENT_SCRIPT, /provider: conv\.provider/)
        assert.match(CLIENT_SCRIPT, /conv\.permission = next/)
        assert.match(CLIENT_SCRIPT, /conv\.reasoning = level/)
        assert.match(CLIENT_SCRIPT, /切换到「完全访问」/)

        const ids = [...html.matchAll(/id="([^" ]+)"/g)].map((matchRun) => matchRun[1] ?? "")
        assert.equal(new Set(ids).size, ids.length, "页面 id 必须唯一")

        const referenced = new Set(
            [...CLIENT_SCRIPT.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map(
                (matchRun) => matchRun[1] ?? "",
            ),
        )
        const missing = [...referenced].filter((id) => !ids.includes(id))
        assert.deepEqual(missing, [], `脚本引用的 id 在页面里缺失：${missing.join(", ")}`)

        const light = await fetch(`${server.base}/`, {
            headers: { cookie: "wellspring_theme=light" },
        })
        assert.match(await light.text(), /<html lang="zh-CN" data-theme="light">/)
        const weird = await fetch(`${server.base}/`, {
            headers: { cookie: "wellspring_theme=evil" },
        })
        assert.ok(!(await weird.text()).includes('data-theme="'), "非法主题值应被忽略")

        const css = await fetch(`${server.base}/assets/app.css`)
        assert.equal(css.status, 200)
        assert.match(css.headers.get("content-type") ?? "", /text\/css/)
        const etag = css.headers.get("etag")
        assert.ok(etag)
        const cssBody = await css.text()
        assert.match(cssBody, /prefers-reduced-motion/)
        assert.match(cssBody, /:focus-visible/)
        assert.match(cssBody, /\.perm-btn/)
        assert.match(cssBody, /\.perm-menu/)
        assert.match(cssBody, /\.perm-warning/)
        // 字体与字号阶梯和 wellspring-code 一致
        assert.match(cssBody, /--font-size-xs: 1rem/)
        assert.match(cssBody, /--font-size-base: 1\.2rem/)
        assert.match(cssBody, /--font-size-8xl: 3\.7rem/)
        assert.match(cssBody, /\.form-message/)
        assert.match(cssBody, /\.form-note/)
        assert.match(cssBody, /\.models-provider/)
        assert.match(cssBody, /\.models-model-btn/)
        assert.match(cssBody, /\.model-menu-item/)
        assert.match(cssBody, /\.model-menu-reasoning/)
        assert.match(cssBody, /\.msg-content/)
        assert.match(cssBody, /\.proc-row/)
        assert.match(cssBody, /\.proc-pre/)
        assert.match(cssBody, /\.ask-card/)
        assert.match(cssBody, /\.ask-question/)
        assert.match(cssBody, /\.ask-option/)
        assert.match(cssBody, /\.ask-number/)
        assert.match(cssBody, /\.ask-badge/)
        assert.match(cssBody, /\.ask-feedback/)
        assert.match(cssBody, /proc-shimmer/)
        assert.match(cssBody, /\.trigger-mark/)
        assert.match(cssBody, /\.composer-field/)
        assert.match(cssBody, /\.composer-highlight/)
        assert.match(cssBody, /\.composer-ref/)
        assert.match(cssBody, /\.sidebar-scroll/)
        assert.match(cssBody, /\.sidebar-fold \{/)
        assert.match(cssBody, /\.sidebar-fold-value/)
        assert.match(cssBody, /\.workspace-body\[hidden\]/)
        // 窄屏：composer-bar 不换行时发送按钮会溢出 composer，被 .app 的 overflow 裁掉
        const narrowCss = cssBody.slice(cssBody.indexOf("@media (max-width: 860px)"))
        assert.ok(narrowCss.includes(".composer-bar"), "窄屏断点里必须有输入条布局")
        assert.match(narrowCss, /\.composer-bar \{[^}]*flex-wrap: wrap/)
        assert.match(narrowCss, /\.btn-send \{[^}]*flex: none/)
        assert.match(cssBody, /font-size: var\(--ui-font-size, 1rem\)/)
        assert.ok(!cssBody.includes("IBM Plex Sans"), "字体栈应与 code 插件一致")

        const cached = await fetch(`${server.base}/assets/app.css`, {
            headers: { "if-none-match": etag },
        })
        assert.equal(cached.status, 304)

        const script = await fetch(`${server.base}/assets/app.js`)
        assert.equal(script.status, 200)
        assert.match(script.headers.get("content-type") ?? "", /javascript/)
        const scriptBody = await script.text()
        assert.equal(scriptBody, CLIENT_SCRIPT)
        assert.ok(!scriptBody.includes("innerHTML"), "客户端不应拼接 HTML 字符串")
        assert.match(scriptBody, /\/api\/auth\/password/)
        assert.match(scriptBody, /function openPasswordDialog\(/)
        assert.match(scriptBody, /function savePassword\(/)
        assert.match(scriptBody, /function closePasswordDialog\(/)
        assert.match(scriptBody, /event\.key === "Enter" && event\.shiftKey/)
        assert.match(scriptBody, /function requestEscapeStop\(/)
        assert.match(scriptBody, /STOP_ESCAPE_WINDOW_MS = 600/)
        assert.doesNotMatch(scriptBody, /event\.key === "Enter" && !event\.shiftKey/)
        assert.match(scriptBody, /\/api\/models/)
        assert.match(scriptBody, /function loadModels\(/)
        assert.match(scriptBody, /function switchModel\(/)
        assert.match(scriptBody, /function saveProviderForm\(/)
        assert.match(scriptBody, /function renderModelMenu\(/)
        assert.match(scriptBody, /function toggleModelMenu\(/)
        assert.match(scriptBody, /function chooseModel\(/)
        assert.match(scriptBody, /function switchReasoning\(/)
        assert.match(scriptBody, /function mentionDescription\(/)
        assert.match(scriptBody, /function appendHighlightedText\(/)
        assert.match(scriptBody, /function isMentionBoundary\(/)
        assert.match(scriptBody, /function appendHighlightedSegments\(/)
        assert.match(scriptBody, /function collectReferences\(/)
        assert.match(scriptBody, /function mentionRanges\(/)
        assert.match(scriptBody, /function formatMention\(/)
        assert.match(scriptBody, /function renderComposerHighlight\(/)
        assert.match(scriptBody, /function renderWorkspaceFold\(/)
        assert.match(scriptBody, /function toggleWorkspaceFold\(/)
        assert.match(scriptBody, /WORKSPACE_FOLD_KEY/)
        assert.match(scriptBody, /compositionend[\s\S]{0,240}refreshTrigger\(\)/)
        assert.match(scriptBody, /function maybeResumeTurn\(/)
        assert.match(scriptBody, /function resumeTurn\(/)
        assert.match(scriptBody, /\/api\/chat\/resume/)
        assert.match(scriptBody, /interrupted: true/)
        assert.match(scriptBody, /conversationId: conv\.id/)
        assert.match(scriptBody, /\/api\/chat\/interject/)
        assert.match(scriptBody, /function appendInterjection\(/)
        assert.match(scriptBody, /function interjectMessage\(/)
        assert.match(scriptBody, /send\.textContent = busy \? "插话" : "发送"/)
        assert.doesNotThrow(() => new Function(scriptBody), "客户端脚本必须语法合法")

        const icon = await fetch(`${server.base}/favicon.svg`)
        assert.equal(icon.status, 200)
        assert.match(icon.headers.get("content-type") ?? "", /svg/)

        const missingAsset = await fetch(`${server.base}/assets/nope.js`)
        assert.equal(missingAsset.status, 404)

        const wrongMethod = await fetch(`${server.base}/api/state`, { method: "PUT" })
        assert.equal(wrongMethod.status, 405)
        assert.equal(wrongMethod.headers.get("allow"), "GET")

        assert.ok(STATIC_ASSETS.get("/assets/app.js"))
    } finally {
        await stopWebPlugin()
    }
})

test("web 插件：写接口校验、登录限流与宿主状态", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin()
    try {
        const wrongType = await fetch(`${server.base}/api/auth/setup`, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "password=secret123",
        })
        assert.equal(wrongType.status, 415)

        const crossSite = await fetch(`${server.base}/api/auth/setup`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: "http://evil.example" },
            body: JSON.stringify({ password: "secret123" }),
        })
        assert.equal(crossSite.status, 403)

        const setup = await fetch(`${server.base}/api/auth/setup`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: server.base,
            },
            body: JSON.stringify({ password: "secret123" }),
        })
        assert.equal(setup.status, 200)
        const cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? ""
        assert.match(cookie, /wellspring_web_session=/)

        const anonymousHost = await fetch(`${server.base}/api/host`)
        assert.equal(anonymousHost.status, 401)
        const anonymousChat = await fetch(`${server.base}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "hi", workspaceId: "any" }),
        })
        assert.equal(anonymousChat.status, 401)
        const anonymousStream = await fetch(`${server.base}/api/chat/stream`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "hi", workspaceId: "any" }),
        })
        assert.equal(anonymousStream.status, 401)

        const workspaceResponse = await fetch(`${server.base}/api/workspaces`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ root: projectRoot }),
        })
        // 同一临时 data 目录里前一个测试可能已经添加过
        assert.ok(workspaceResponse.status === 201 || workspaceResponse.status === 409)
        const workspaceId = ((await workspaceResponse.json()) as { workspace: { id: string } })
            .workspace.id

        const host = await fetch(`${server.base}/api/host`, { headers: { cookie } })
        assert.equal(host.status, 200)
        const hostData = (await host.json()) as {
            status: string
            os: { platform: string; node: string }
            plugins: Array<{ id: string; status: string }>
        }
        assert.ok(["starting", "running", "stopping", "stopped"].includes(hostData.status))
        assert.ok(hostData.os.platform.length > 0)
        assert.ok(hostData.os.node.length > 0)
        assert.ok(Array.isArray(hostData.plugins))

        const tooLong = await fetch(`${server.base}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ message: "x".repeat(33_000), workspaceId }),
        })
        assert.equal(tooLong.status, 413)
        const tooLongStream = await fetch(`${server.base}/api/chat/stream`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ message: "x".repeat(33_000), workspaceId }),
        })
        assert.equal(tooLongStream.status, 413)

        const stream = await fetch(`${server.base}/api/chat/stream`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ message: "hi", workspaceId }),
        })
        assert.equal(stream.status, 200)
        assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/)
        const events = await stream.text()
        assert.match(events, /"type":"delta"/)
        assert.match(events, /"type":"done"/)
        assert.match(events, /"model":"test-model"/)
        assert.match(events, /"inputTokens":12/)
        assert.match(events, /"turn":1/)
        assert.match(events, /"steps":2/)
        assert.match(events, /"type":"step"/)
        assert.match(events, /"type":"approval"/)
        assert.match(events, /"approvalId":"apv_test"/)
        // 思考链与工具调用事件原样转发给浏览器
        assert.match(events, /"type":"ask"/)
        assert.match(events, /"question":"用哪个分支？"/)
        assert.match(events, /"type":"reasoning"/)
        assert.match(events, /"text":"先想一下。"/)
        assert.match(events, /"type":"tool"/)
        assert.match(events, /"phase":"start"/)
        assert.match(events, /"result":"文件内容"/)

        const anonymousApproval = await fetch(`${server.base}/api/approvals/apv_test`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ approved: true }),
        })
        assert.equal(anonymousApproval.status, 401)

        const approved = await fetch(`${server.base}/api/approvals/apv_test`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ approved: true }),
        })
        assert.equal(approved.status, 200)
        assert.equal(
            approvalCalls.some((call) => call.approvalId === "apv_test" && call.approved === true),
            true,
        )

        const unknownApproval = await fetch(`${server.base}/api/approvals/unknown`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ approved: false }),
        })
        assert.equal(unknownApproval.status, 404)

        const badApproval = await fetch(`${server.base}/api/approvals/apv_test`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ approved: "yes" }),
        })
        assert.equal(badApproval.status, 400)

        // 连续 5 次错误密码后锁定
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const failure = await fetch(`${server.base}/api/auth/login`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ password: "wrong-password" }),
            })
            assert.equal(failure.status, 401, `第 ${attempt + 1} 次失败应返回 401`)
        }
        const locked = await fetch(`${server.base}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: "secret123" }),
        })
        assert.equal(locked.status, 429)
        assert.ok(Number(locked.headers.get("retry-after")) > 0)
        const lockedBody = (await locked.json()) as { retryAfter: number }
        assert.ok(lockedBody.retryAfter > 0)
    } finally {
        await stopWebPlugin()
    }
})

test("web 插件：中断流式请求不会影响服务", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin({ slowStream: true })
    try {
        // 同一临时 data 目录前面可能已经设过密码
        const setup = await fetch(`${server.base}/api/auth/setup`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: "secret123" }),
        })
        let cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? ""
        if (setup.status !== 200) {
            const login = await fetch(`${server.base}/api/auth/login`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ password: "secret123" }),
            })
            assert.equal(login.status, 200)
            cookie = login.headers.get("set-cookie")?.split(";")[0] ?? ""
        }
        assert.match(cookie, /wellspring_web_session=/)

        const workspaceResponse = await fetch(`${server.base}/api/workspaces`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ root: projectRoot }),
        })
        // 同一临时 data 目录里前一个测试可能已经添加过
        assert.ok(workspaceResponse.status === 201 || workspaceResponse.status === 409)
        const workspaceId = ((await workspaceResponse.json()) as { workspace: { id: string } })
            .workspace.id

        const controller = new AbortController()
        const stream = await fetch(`${server.base}/api/chat/stream`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ message: "slow", workspaceId }),
            signal: controller.signal,
        })
        assert.equal(stream.status, 200)
        const reader = stream.body?.getReader()
        assert.ok(reader)
        const first = await reader.read()
        assert.equal(first.done, false)
        controller.abort()
        await reader.cancel().catch(() => undefined)

        // 等 Agent 在断开的连接上继续写完
        await new Promise((resolve) => setTimeout(resolve, 300))
        const health = await fetch(`${server.base}/api/state`)
        assert.equal(health.status, 200)
        const state = (await health.json()) as { configured: boolean }
        assert.equal(state.configured, true)
    } finally {
        await stopWebPlugin()
    }
})

test("web 插件：刷新/断线后续接正在进行的回复", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin({ streamDelayMs: 400 })
    try {
        const cookie = await authenticate(server.base)
        const workspaceId = await ensureWorkspace(server.base, cookie)
        const startChat = async (message: string, conversationId: string) => {
            return await fetch(`${server.base}/api/chat/stream`, {
                method: "POST",
                headers: { "content-type": "application/json", cookie },
                body: JSON.stringify({ message, workspaceId, conversationId }),
            })
        }

        // 第一次刷新：连接在收到首批事件后断开，服务端那一轮继续跑完
        const controller = new AbortController()
        const stream = await fetch(`${server.base}/api/chat/stream`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ message: "刷新", workspaceId, conversationId: "c_resume_done" }),
            signal: controller.signal,
        })
        assert.equal(stream.status, 200)
        const reader = stream.body?.getReader()
        assert.ok(reader)
        const first = await reader.read()
        assert.equal(first.done, false)
        const firstText = new TextDecoder().decode(first.value)
        assert.match(firstText, /"type":"session"/)
        controller.abort()
        await reader.cancel().catch(() => undefined)

        // 等宿主把这一轮跑完，再模拟刷新后的续接请求
        await sleep(700)
        const resumed = await fetch(`${server.base}/api/chat/resume?conversationId=c_resume_done`, {
            headers: { cookie },
        })
        assert.equal(resumed.status, 200)
        assert.match(resumed.headers.get("content-type") ?? "", /text\/event-stream/)
        const replay = await resumed.text()
        assert.match(replay, /"type":"resume"/, "续接先发恢复标记")
        assert.match(replay, /"type":"session"/, "重放会话 id")
        assert.match(replay, /"type":"delta"/, "重放增量内容")
        assert.match(replay, /尾部内容/, "断线后的增量也在重放里")
        assert.match(replay, /"type":"done"/, "重放本轮结束事件")
        assert.match(replay, /"reply":"stream:刷新"/)

        // 第二次：回合还在进行时直接接上，实时收到剩余事件
        const stream2 = await startChat("进行中", "c_resume_live")
        const reader2 = stream2.body?.getReader()
        assert.ok(reader2)
        const first2 = await reader2.read()
        assert.equal(first2.done, false)
        await reader2.cancel().catch(() => undefined)
        const live = await fetch(`${server.base}/api/chat/resume?conversationId=c_resume_live`, {
            headers: { cookie },
        })
        assert.equal(live.status, 200)
        const liveBody = await live.text()
        assert.match(liveBody, /"type":"resume"/)
        assert.match(liveBody, /尾部内容/)
        assert.match(liveBody, /"type":"done"/)

        // 没有可续接的回合：返回 JSON 提示
        const missing = await fetch(
            `${server.base}/api/chat/resume?conversationId=c_resume_missing`,
            { headers: { cookie } },
        )
        assert.equal(missing.status, 200)
        assert.match(missing.headers.get("content-type") ?? "", /application\/json/)
        const missingBody = (await missing.json()) as { ok: boolean }
        assert.equal(missingBody.ok, false)

        // 非法会话 id / 未登录
        const invalid = await fetch(`${server.base}/api/chat/resume?conversationId=bad%20id`, {
            headers: { cookie },
        })
        assert.equal(invalid.status, 400)
        const anonymous = await fetch(`${server.base}/api/chat/resume?conversationId=c_resume_done`)
        assert.equal(anonymous.status, 401)
    } finally {
        await stopWebPlugin()
    }
})

test("web 插件：回复中可以插话", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin({ streamDelayMs: 600 })
    try {
        const cookie = await authenticate(server.base)
        const workspaceId = await ensureWorkspace(server.base, cookie)
        interjectCalls.length = 0

        const stream = await fetch(`${server.base}/api/chat/stream`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({
                message: "写一段长的",
                workspaceId,
                conversationId: "c_interject",
            }),
        })
        assert.equal(stream.status, 200)
        const reader = stream.body?.getReader()
        assert.ok(reader)
        const first = await reader.read()
        assert.equal(first.done, false)
        assert.match(new TextDecoder().decode(first.value), /"type":"session"/)

        const response = await fetch(`${server.base}/api/chat/interject`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ conversationId: "c_interject", message: "顺便看下 README" }),
        })
        assert.equal(response.status, 200)
        assert.equal(((await response.json()) as { ok: boolean }).ok, true)
        assert.deepEqual(interjectCalls, [
            { sessionId: "ui-stream-session", message: "顺便看下 README" },
        ])

        // 原连接要收到插话事件（其它窗口/刷新续接也从同一份事件重放）
        let rest = ""
        const decoder = new TextDecoder()
        while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            rest += decoder.decode(chunk.value)
        }
        assert.match(rest, /"type":"steer"/)
        assert.match(rest, /顺便看下 README/)
        assert.match(rest, /"type":"done"/)

        // 轮次结束后插话被拒绝，界面据此按下一轮发送
        const late = await fetch(`${server.base}/api/chat/interject`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ conversationId: "c_interject", message: "太晚了" }),
        })
        assert.equal(late.status, 409)
        assert.equal(((await late.json()) as { ok: boolean }).ok, false)

        // 非法参数与未登录
        const invalid = await fetch(`${server.base}/api/chat/interject`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ conversationId: "bad id", message: "x" }),
        })
        assert.equal(invalid.status, 400)
        const empty = await fetch(`${server.base}/api/chat/interject`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ conversationId: "c_interject", message: "  " }),
        })
        assert.equal(empty.status, 400)
        const anonymous = await fetch(`${server.base}/api/chat/interject`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "c_interject", message: "x" }),
        })
        assert.equal(anonymous.status, 401)
    } finally {
        await stopWebPlugin()
    }
})
