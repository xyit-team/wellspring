import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { emitInitHooks, emitShutdownHooks } from "../src/api/host/hooks.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { createHostPluginManager } from "../src/plugin/manage.ts"
import { createHostNetworkService } from "../src/plugin/network-service.ts"
import { PluginSandboxClient, shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"
import { STATIC_ASSETS } from "../plugins/wellspring-web/src/assets/index.ts"
import { startHttpHostPlugin } from "./helpers/http-host.ts"
import { makeZip } from "./helpers/zip.ts"

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
const stopCalls: string[] = []
/** 模拟宿主会话：只有 stream 进行中才允许插话 */
const activeSessions = new Set<string>()

async function startWebPlugin(
    options: { readonly slowStream?: boolean; readonly streamDelayMs?: number } = {},
): Promise<Running> {
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
            hostApi: [
                "logger",
                "fs",
                "http",
                "agent",
                "plugins",
                "event",
                "getHost",
                "workspaces",
                "network",
            ],
            workspaceRead: false,
            workspaceWrite: false,
        },
        plugins: createHostPluginManager({
            paths: resolved,
            logger: pino({ level: "silent" }),
        }),
        network: createHostNetworkService({
            settings: DEFAULT_SETTINGS,
            settingsFile: join(resolved.configDir, "app-setting.json"),
        }),
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
                    usage: {
                        inputTokens: 12,
                        outputTokens: 34,
                        cacheReadTokens: 8,
                        contextTokens: 12,
                    },
                }
            },
            async interject(sessionId: string, message: string) {
                interjectCalls.push({ sessionId, message })
                return activeSessions.has(sessionId)
            },
            async stop(sessionId: string) {
                stopCalls.push(sessionId)
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

        // Vue 外壳：只保留挂载点、SPRITE 与同源资源引用，界面由客户端渲染
        assert.match(html, /<link rel="stylesheet" href="\/assets\/app\.css">/)
        assert.match(html, /<script type="module" src="\/assets\/app-vue\.js"><\/script>/)
        assert.match(html, /<div id="vue-app"><\/div>/)
        assert.ok(!html.includes("<style"), "页面不应有内联 <style>")
        assert.ok(!/\son[a-z]+=/.test(html), "页面不应有内联事件处理器")
        assert.ok(!html.includes('data-theme="'), "默认主题不写 data-theme")

        // Vue 客户端资源：严格 CSP 下可运行（无 unsafe-eval / new Function）
        const script = await fetch(`${server.base}/assets/app-vue.js`)
        assert.equal(script.status, 200)
        assert.match(script.headers.get("content-type") ?? "", /javascript/)
        const scriptBody = await script.text()
        const scriptEtag = script.headers.get("etag")
        assert.ok(scriptEtag)
        const moduleFile = join(root, "app-vue-check.mjs")
        await writeFile(moduleFile, scriptBody)
        const syntax = spawnSync(process.execPath, ["--check", moduleFile], { encoding: "utf8" })
        assert.equal(syntax.status, 0, syntax.stderr)
        await rm(moduleFile, { force: true })
        // 长会话按轮折叠：窗口起点与按钮文案都在打包产物里
        assert.ok(scriptBody.includes("windowStarts"), "产物里应有按会话记录的显示窗口")
        assert.ok(scriptBody.includes("加载更早（还有"), "产物里应有按轮计数的加载更早按钮")
        assert.ok(!scriptBody.includes("MESSAGE_PAGE"), "按条切页的旧常量应已移除")
        const pageHtml = html
        assert.match(pageHtml, /\/assets\/app-vue\.css/)
        assert.match(scriptBody, /composer-input/)
        assert.match(scriptBody, /trigger-menu/)
        assert.match(scriptBody, /ask-card/)
        assert.match(scriptBody, /conversation-list|conv-list/)
        assert.match(scriptBody, /workspace-list/)
        assert.match(scriptBody, /\/api\/chat\/stream/)
        assert.match(scriptBody, /\/api\/chat\/resume/)
        assert.match(scriptBody, /\/api\/chat\/interject/)
        assert.match(scriptBody, /\/api\/asks\//)
        assert.match(scriptBody, /\/api\/models/)
        assert.match(scriptBody, /\/api\/plugins\/install/)
        assert.match(scriptBody, /\/api\/shutdown/)
        assert.match(scriptBody, /模型与供应商/)
        assert.match(scriptBody, /插件管理/)
        assert.match(scriptBody, /系统状态/)
        assert.match(scriptBody, /设置访问密码/)
        assert.match(scriptBody, /欢迎回来/)
        assert.match(scriptBody, /加载更早/)
        assert.match(scriptBody, /Wellspring 已关闭/)
        assert.ok(!scriptBody.includes("unsafe-eval"), "严格 CSP 下不能用 unsafe-eval")
        assert.ok(!scriptBody.includes("new Function"), "严格 CSP 下不能用 new Function")

        const cachedScript = await fetch(`${server.base}/assets/app-vue.js`, {
            headers: { "if-none-match": scriptEtag },
        })
        assert.equal(cachedScript.status, 304)

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
        assert.match(cssBody, /\.load-earlier-btn \{/)
        assert.match(cssBody, /:focus-visible/)
        assert.match(cssBody, /\.perm-btn/)
        assert.match(cssBody, /\.perm-menu/)
        assert.match(cssBody, /\.perm-warning/)
        // 字号阶梯：相邻两级差不到 2px 的旧阶梯已拆成 12/13/14/15/16/19/22/26/32
        assert.match(cssBody, /--font-size-2xs: 0\.75rem/)
        assert.match(cssBody, /--font-size-xs: 0\.8125rem/)
        assert.match(cssBody, /--font-size-base: 0\.9375rem/)
        assert.match(cssBody, /--font-size-md: 1rem/)
        assert.match(cssBody, /--font-size-3xl: 2rem/)
        assert.ok(!cssBody.includes("--font-size-8xl"), "旧阶梯的超大档已删除")
        assert.match(cssBody, /\.form-message/)
        assert.match(cssBody, /\.form-note/)
        assert.match(cssBody, /\.models-provider/)
        assert.match(cssBody, /\.models-context-row \{/)
        assert.match(cssBody, /\.model-menu-context \{/)
        assert.match(cssBody, /\.plugin-row \{/)
        assert.match(cssBody, /\.plugin-status\.is-disabled \{/)
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
        assert.match(cssBody, /proc-breathe/)
        // 渐变文字是装饰不是信息，已换成透明度起伏
        assert.ok(!cssBody.includes("proc-shimmer"), "不再用 background-clip: text 扫光")
        assert.match(cssBody, /\.trigger-mark/)
        assert.match(cssBody, /\.composer-field/)
        assert.match(cssBody, /\.composer-highlight/)
        assert.match(cssBody, /\.composer-ref/)
        assert.match(cssBody, /\.sidebar-scroll/)
        assert.match(cssBody, /\.sidebar-fold \{/)
        assert.match(cssBody, /\.sidebar-fold-value/)
        // 折叠用 Grid 轨道插值，高度由浏览器算，不再靠 JS 或 display: none
        assert.match(cssBody, /\.fold,\n\.proc-fold \{/)
        assert.match(
            cssBody,
            /\.fold\[data-open="true"\],\n\.proc-fold\[data-open="true"\] \{[^}]*grid-template-rows: 1fr/,
        )
        // 手机输入区：胶囊抬到第一行、输入框与发送键同一行，提示行在手机上隐藏
        const phoneCss = cssBody.slice(cssBody.lastIndexOf("@media (max-width: 560px)"))
        assert.match(phoneCss, /\.composer \{[^}]*grid-template-areas/)
        assert.match(phoneCss, /\.composer-bar \{[^}]*display: contents/)
        assert.match(phoneCss, /\.composer-hint \{[^}]*display: none/)
        assert.match(phoneCss, /\.composer-hint\[data-kind="blocked"\] \{[^}]*display: flex/)
        assert.match(phoneCss, /\.perm-btn \{[^}]*height: 44px/)
        // 触摸目标下限：抽屉的行与设置页顶栏动作
        const coarseCss = cssBody.slice(cssBody.lastIndexOf("@media (pointer: coarse)"))
        assert.match(coarseCss, /\.ws-select,[\s\S]*?min-height: 44px/)
        assert.match(coarseCss, /\.proc-head \{[^}]*min-height: 36px/)
        assert.match(coarseCss, /\.topbar-actions \.btn \{[^}]*min-height: 44px/)
        // 触摸反馈：去掉 300ms 点按延迟与 iOS 灰块
        assert.match(cssBody, /touch-action: manipulation/)
        assert.match(cssBody, /-webkit-tap-highlight-color: transparent/)
        assert.match(cssBody, /\.sidebar-foot-body \{/)
        assert.match(cssBody, /\.foot-fold/)
        // 窄屏：composer-bar 不换行时发送按钮会溢出 composer，被 .app 的 overflow 裁掉
        const narrowCss = cssBody.slice(cssBody.indexOf("@media (max-width: 860px)"))
        assert.ok(narrowCss.includes(".composer-bar"), "窄屏断点里必须有输入条布局")
        assert.match(narrowCss, /\.composer-bar \{[^}]*flex-wrap: wrap/)
        assert.match(narrowCss, /\.composer-send \{[^}]*order: 4/)
        // Token 统计：输入框下方的统计行、回复用量与统计弹窗
        assert.match(cssBody, /\.composer-stats/)
        // 输入框下方的统计行居中，并留 0.2rem 的上边距
        assert.match(cssBody, /\.composer-stats \{[^}]*justify-content: center/)
        assert.match(cssBody, /\.composer-stats \{[^}]*margin: 0\.2rem auto 0/)
        assert.match(cssBody, /\.composer-stats \{[^}]*font-family: var\(--font-mono\)/)
        assert.match(cssBody, /\.meter-bar \{/)
        assert.match(cssBody, /\.meter-bar-fill \{/)
        assert.ok(!cssBody.includes("meter-ring"), "14px 进度环已换成细横条")
        assert.match(cssBody, /\.msg-usage/)
        assert.match(cssBody, /\.stats-grid/)
        assert.match(cssBody, /\.stats-dialog/)
        assert.match(cssBody, /font-size: var\(--ui-font-size, 1rem\)/)
        assert.ok(!cssBody.includes("IBM Plex Sans"), "字体栈里不再保留 UI 无衬线字体")

        // ── 设计硬规则（改样式时守住的底线） ──
        // 1 去边框靠明度分层：卡片不画描边，最暗的一层也不是纯黑
        // 注释里提到 #000 不算；这里查的是声明值
        assert.ok(!/:\s*#000\b/i.test(cssBody), "不许出现纯黑")
        assert.ok(!/rgba?\(0,\s*0,\s*0\)/.test(cssBody), "不许出现 rgb(0,0,0)")
        assert.match(cssBody, /--bg: light-dark\(#f5f5f3, #0b0b0a\)/)
        assert.match(cssBody, /--surface-2: light-dark\(#f0f0ed, #1a1a19\)/)
        assert.match(cssBody, /\.plugin-row \{[^}]*border: 0/)
        assert.match(cssBody, /\.models-provider \{[^}]*border: 0/)
        // 2 输入框聚焦不加 outline，用双环咬合
        assert.match(
            cssBody,
            /\.input:focus,[\s\S]*?outline: none;[\s\S]*?0 0 0 1px var\(--accent\)[\s\S]*?0 0 0 4px var\(--accent-ring\)/,
        )
        // 3 深色字重整体降 40
        assert.match(cssBody, /--fw-regular: 400/)
        assert.match(cssBody, /:root\[data-theme="dark"\] \{[^}]*--fw-regular: 360/)
        // 4 流式逐字：90ms、模糊到清晰、相邻错开 30ms
        assert.match(
            cssBody,
            /\.tchar \{[^}]*animation: tchar-in 90ms cubic-bezier\(0\.215, 0\.61, 0\.355, 1\)/,
        )
        assert.match(cssBody, /@keyframes tchar-in \{[^}]*filter: blur\(6px\)/)
        // 5 行内图标按 -0.125em 对齐
        assert.match(cssBody, /\.icon \{[^}]*display: inline-block[^}]*vertical-align: -0\.125em/)
        // 6 数字锁等宽
        assert.match(cssBody, /body \{[^}]*font-variant-numeric: tabular-nums/)
        // 7 折叠：Grid 0fr→1fr，不用 JS 算高
        assert.match(cssBody, /\.fold,\n\.proc-fold \{[^}]*grid-template-rows: 0fr/)
        // 8 防孤字
        assert.match(cssBody, /body \{[^}]*text-wrap: pretty/)
        assert.match(cssBody, /\.md \{[^}]*text-wrap: pretty/)
        // 9 弹簧：过阻尼零回弹 / 欠阻尼微弹
        assert.match(cssBody, /--spring-snap: linear\(/)
        assert.match(cssBody, /--spring-pop: linear\([^)]*1\.192/)
        assert.match(cssBody, /\.proc-fold \{[^}]*transition:[^;]*--spring-snap/)
        // 10 复制反馈自熄
        assert.match(cssBody, /\[data-copied="true"\]/)
        // 深色字重补偿在「跟随系统」时同样生效
        assert.match(
            cssBody,
            /@media \(prefers-color-scheme: dark\) \{[\s\S]*?:root:not\(\[data-theme="light"\]\) \{[^}]*--fw-regular: 360/,
        )
        // 触摸目标：一份 (pointer: coarse) 块、行高 44px
        assert.equal(
            cssBody.split("@media (pointer: coarse)").length - 1,
            1,
            "(pointer: coarse) 只能有一块",
        )

        // ── 审批对话框：必须展示参数，不能只给可执行文件名 ──
        assert.match(cssBody, /\.approval-command-line \{/)
        assert.match(cssBody, /\.approval-args \{/)
        assert.match(cssBody, /\.approval-arg-index \{/)
        assert.match(cssBody, /\.approval-risk \{/)
        assert.match(cssBody, /\.approval-stdin \{/)
        assert.ok(!cssBody.includes(".approval-command {"), "旧的单行命令样式已移除")
        // 全部界面统一用系统等宽字体：UI 直接复用 mono 栈
        assert.match(cssBody, /--font-ui: var\(--font-mono\)/)
        assert.match(cssBody, /--font-mono: "Consolas", "Cascadia Mono", "Menlo", "Monaco"/)
        assert.match(cssBody, /"Sarasa Mono SC", "Noto Sans Mono CJK SC"/)

        const cached = await fetch(`${server.base}/assets/app.css`, {
            headers: { "if-none-match": etag },
        })
        assert.equal(cached.status, 304)

        const icon = await fetch(`${server.base}/favicon.svg`)
        assert.equal(icon.status, 200)
        assert.match(icon.headers.get("content-type") ?? "", /svg/)

        const missingAsset = await fetch(`${server.base}/assets/nope.js`)
        assert.equal(missingAsset.status, 404)

        const wrongMethod = await fetch(`${server.base}/api/state`, { method: "PUT" })
        assert.equal(wrongMethod.status, 405)
        assert.equal(wrongMethod.headers.get("allow"), "GET")

        assert.ok(STATIC_ASSETS.get("/assets/app-vue.js"))
    } finally {
        await stopWebPlugin()
    }
})

test("web 插件：page.html 覆盖内置页面", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin()
    const pageFile = join(root, "data", "plugin-data", "wellspring-web", "page.html")
    try {
        await mkdir(dirname(pageFile), { recursive: true })

        // 没有覆盖文件时用内置模板
        const builtin = await fetch(`${server.base}/`)
        const builtinBody = await builtin.text()
        assert.match(builtinBody, /<div id="vue-app"><\/div>/)
        assert.match(builtinBody, /\/assets\/app-vue\.js/)

        await writeFile(pageFile, "<!doctype html><html{{theme}}><body>覆盖页</body></html>")
        const overridden = await fetch(`${server.base}/`, {
            headers: { cookie: "wellspring_theme=light" },
        })
        const body = await overridden.text()
        assert.match(body, /覆盖页/)
        assert.match(body, /<html data-theme="light">/, "{{theme}} 应替换成主题属性")
        assert.ok(!body.includes("vue-app"), "覆盖后不再输出内置模板")

        // 空文件视为没有覆盖
        await writeFile(pageFile, "   ")
        const blank = await fetch(`${server.base}/`)
        assert.match(await blank.text(), /id="vue-app"/)

        await rm(pageFile, { force: true })
        const restored = await fetch(`${server.base}/`)
        assert.match(await restored.text(), /id="vue-app"/)
    } finally {
        await rm(pageFile, { force: true })
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
        // 缓存命中与上下文占用随 done 事件下发，前端据此显示统计
        assert.match(events, /"cacheReadTokens":8/)
        assert.match(events, /"contextTokens":12/)
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

test("web 插件：模型上下文窗口配置", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin()
    try {
        const cookie = await authenticate(server.base)
        const headers = { "content-type": "application/json", cookie }

        const anonymous = await fetch(`${server.base}/api/models/context`)
        assert.equal(anonymous.status, 401)

        const initial = await fetch(`${server.base}/api/models/context`, { headers: { cookie } })
        assert.equal(initial.status, 200)
        const initialBody = (await initial.json()) as { contextWindows: Record<string, number> }
        assert.deepEqual(initialBody.contextWindows, {})

        const badItems = await fetch(`${server.base}/api/models/context`, {
            method: "POST",
            headers,
            body: JSON.stringify({ items: [] }),
        })
        assert.equal(badItems.status, 400)
        const badWindow = await fetch(`${server.base}/api/models/context`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                items: [{ provider: "openai", model: "gpt-4o", contextWindow: 0 }],
            }),
        })
        assert.equal(badWindow.status, 400)
        const badProvider = await fetch(`${server.base}/api/models/context`, {
            method: "POST",
            headers,
            body: JSON.stringify({ items: [{ provider: "", model: "x", contextWindow: 1024 }] }),
        })
        assert.equal(badProvider.status, 400)

        const save = await fetch(`${server.base}/api/models/context`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                items: [
                    { provider: "openai", model: "gpt-4o", contextWindow: 131072 },
                    { provider: "custom", model: "deepseek-chat", contextWindow: 1048576 },
                ],
            }),
        })
        assert.equal(save.status, 200)
        const saved = (await save.json()) as { contextWindows: Record<string, number> }
        assert.deepEqual(saved.contextWindows, {
            "openai/gpt-4o": 131072,
            "custom/deepseek-chat": 1048576,
        })

        const clear = await fetch(`${server.base}/api/models/context`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                items: [{ provider: "openai", model: "gpt-4o", contextWindow: null }],
            }),
        })
        assert.equal(clear.status, 200)
        const cleared = (await clear.json()) as { contextWindows: Record<string, number> }
        assert.deepEqual(cleared.contextWindows, { "custom/deepseek-chat": 1048576 })
    } finally {
        await stopWebPlugin()
    }
})

test("web 插件：网络代理配置", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin()
    try {
        const cookie = await authenticate(server.base)
        const headers = { "content-type": "application/json", cookie }

        const anonymous = await fetch(`${server.base}/api/network`)
        assert.equal(anonymous.status, 401)

        const initial = await fetch(`${server.base}/api/network`, { headers: { cookie } })
        assert.equal(initial.status, 200)
        assert.deepEqual(await initial.json(), { proxy: null })

        const invalid = await fetch(`${server.base}/api/network`, {
            method: "POST",
            headers,
            body: JSON.stringify({ url: "127.0.0.1:7890" }),
        })
        assert.equal(invalid.status, 400)
        assert.match(((await invalid.json()) as { error: string }).error, /http:\/\/ 或 https:\/\//)

        const saved = await fetch(`${server.base}/api/network`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                url: "http://127.0.0.1:7890",
                noProxy: ["localhost", "127.0.0.1"],
            }),
        })
        assert.equal(saved.status, 200)
        assert.deepEqual(await saved.json(), {
            ok: true,
            proxy: {
                type: "http",
                url: "http://127.0.0.1:7890",
                noProxy: ["localhost", "127.0.0.1"],
            },
        })

        const current = await fetch(`${server.base}/api/network`, { headers: { cookie } })
        assert.deepEqual(await current.json(), {
            proxy: {
                type: "http",
                url: "http://127.0.0.1:7890",
                noProxy: ["localhost", "127.0.0.1"],
            },
        })

        const cleared = await fetch(`${server.base}/api/network`, {
            method: "POST",
            headers,
            body: JSON.stringify({ url: null }),
        })
        assert.equal(cleared.status, 200)
        assert.deepEqual(await cleared.json(), { ok: true, proxy: null })
    } finally {
        await stopWebPlugin()
    }
})

test("web 插件：插件管理接口（禁用 web 允许、卸载 web 拒绝）", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin()
    try {
        const cookie = await authenticate(server.base)
        const headers = { "content-type": "application/json", cookie }

        const anonymous = await fetch(`${server.base}/api/plugins`)
        assert.equal(anonymous.status, 401)

        const pluginsDir = join(paths().dataDir, "plugins")
        await mkdir(join(pluginsDir, "demo"), { recursive: true })
        await writeFile(
            join(pluginsDir, "demo", "index.ts"),
            "export function setup() { return null }\n",
            "utf8",
        )
        await writeFile(
            join(pluginsDir, "demo", "package.json"),
            JSON.stringify({ name: "demo", version: "2.0.0" }),
            "utf8",
        )
        await mkdir(join(pluginsDir, "wellspring-web"), { recursive: true })
        await writeFile(
            join(pluginsDir, "wellspring-web", "index.ts"),
            "export function setup() { return null }\n",
            "utf8",
        )
        await writeFile(
            join(pluginsDir, "wellspring-web", "package.json"),
            JSON.stringify({ name: "wellspring-web", version: "1.0.0" }),
            "utf8",
        )

        const listed = await fetch(`${server.base}/api/plugins`, { headers: { cookie } })
        assert.equal(listed.status, 200)
        const listedBody = (await listed.json()) as {
            plugins: Array<{ id: string; enabled: boolean }>
        }
        assert.ok(listedBody.plugins.some((plugin) => plugin.id === "demo"))
        assert.ok(listedBody.plugins.some((plugin) => plugin.id === "wellspring-web"))

        const disableDemo = await fetch(`${server.base}/api/plugins/disable`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: "demo" }),
        })
        assert.equal(disableDemo.status, 200)
        const disabledBody = (await disableDemo.json()) as { ok: boolean; restartRequired: boolean }
        assert.equal(disabledBody.ok, true)
        assert.equal(disabledBody.restartRequired, true)
        const afterDisable = (await (
            await fetch(`${server.base}/api/plugins`, { headers: { cookie } })
        ).json()) as {
            plugins: Array<{ id: string; enabled: boolean; status: string }>
        }
        const demo = afterDisable.plugins.find((plugin) => plugin.id === "demo")
        assert.equal(demo?.enabled, false)
        assert.equal(demo?.status, "disabled")

        // 允许禁用 wellspring-web（双重确认在网页端）
        const disableWeb = await fetch(`${server.base}/api/plugins/disable`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: "wellspring-web" }),
        })
        assert.equal(disableWeb.status, 200)
        assert.equal(((await disableWeb.json()) as { ok: boolean }).ok, true)

        // 但不允许卸载
        const removeWeb = await fetch(`${server.base}/api/plugins/remove`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: "wellspring-web" }),
        })
        assert.equal(removeWeb.status, 400)
        assert.match(
            ((await removeWeb.json()) as { error: string }).error,
            /不能卸载 wellspring-web/,
        )

        const badInstall = await fetch(`${server.base}/api/plugins/install`, {
            method: "POST",
            headers,
            body: JSON.stringify({ filename: "demo.tar", dataBase64: "AAAA" }),
        })
        assert.equal(badInstall.status, 400)
        const badData = await fetch(`${server.base}/api/plugins/install`, {
            method: "POST",
            headers,
            body: JSON.stringify({ filename: "demo.zip", dataBase64: "!!!not-base64!!!" }),
        })
        assert.equal(badData.status, 400)

        // 正常 zip：写入插件目录，响应里带依赖安装结果（这个包没有 dependencies）
        const pluginZip = makeZip({
            "package.json": JSON.stringify({
                name: "zip-demo",
                version: "1.0.0",
                packageManager: "npm@11.20.0",
                main: "index.ts",
            }),
            "index.ts": "export function setup() { return null }\n",
        }).toString("base64")
        const installedZip = await fetch(`${server.base}/api/plugins/install`, {
            method: "POST",
            headers,
            body: JSON.stringify({ filename: "zip-demo.zip", dataBase64: pluginZip }),
        })
        assert.equal(installedZip.status, 200)
        const installedBody = (await installedZip.json()) as {
            ok: boolean
            id: string
            restartRequired: boolean
            dependenciesInstalled?: boolean
        }
        assert.equal(installedBody.ok, true)
        assert.equal(installedBody.id, "zip-demo")
        assert.equal(installedBody.restartRequired, true)
        assert.equal(installedBody.dependenciesInstalled, false)
        const installedManifest = JSON.parse(
            await readFile(join(pluginsDir, "zip-demo", "package.json"), "utf8"),
        ) as { name?: string }
        assert.equal(installedManifest.name, "zip-demo")
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

test("web 插件：删除会话与移除工作区（不带请求体）", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin()
    try {
        const cookie = await authenticate(server.base)
        const workspaceId = await ensureWorkspace(server.base, cookie)

        const put = await fetch(
            `${server.base}/api/workspaces/${workspaceId}/conversations/c_delete_me`,
            {
                method: "PUT",
                headers: { "content-type": "application/json", cookie },
                body: JSON.stringify({
                    id: "c_delete_me",
                    title: "待删除",
                    createdAt: 1,
                    updatedAt: 2,
                    messages: [{ role: "user", text: "hi", at: 1 }],
                }),
            },
        )
        assert.equal(put.status, 200)

        // 浏览器的 DELETE 不带 content-type：不能因为「不是 JSON」被拒
        const removed = await fetch(
            `${server.base}/api/workspaces/${workspaceId}/conversations/c_delete_me`,
            { method: "DELETE", headers: { cookie } },
        )
        assert.equal(removed.status, 200)
        assert.equal(((await removed.json()) as { removed: boolean }).removed, true)

        const ungroupedPut = await fetch(
            `${server.base}/api/ungrouped/conversations/c_ungrouped_gone`,
            {
                method: "PUT",
                headers: { "content-type": "application/json", cookie },
                body: JSON.stringify({
                    id: "c_ungrouped_gone",
                    title: "未分组",
                    createdAt: 1,
                    updatedAt: 2,
                    messages: [{ role: "user", text: "hi", at: 1 }],
                }),
            },
        )
        assert.equal(ungroupedPut.status, 200)
        const ungroupedGone = await fetch(
            `${server.base}/api/ungrouped/conversations/c_ungrouped_gone`,
            {
                method: "DELETE",
                headers: { cookie },
            },
        )
        assert.equal(ungroupedGone.status, 200)
        assert.equal(((await ungroupedGone.json()) as { removed: boolean }).removed, true)

        // 移除工作区：会话转到未分组，工作区从列表里消失
        const workspaceGone = await fetch(`${server.base}/api/workspaces/${workspaceId}`, {
            method: "DELETE",
            headers: { cookie },
        })
        assert.equal(workspaceGone.status, 200)
        const payload = (await workspaceGone.json()) as {
            ok: boolean
            workspaces: unknown[]
        }
        assert.equal(payload.ok, true)
        assert.equal(payload.workspaces.length, 0)

        // 带 body 的写请求仍然必须声明 JSON
        const wrongType = await fetch(`${server.base}/api/workspaces`, {
            method: "POST",
            headers: { "content-type": "text/plain", cookie },
            body: "root=/tmp",
        })
        assert.equal(wrongType.status, 415)
    } finally {
        await stopWebPlugin()
    }
})

test("web 插件：运行中会话列表", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin({ streamDelayMs: 500 })
    try {
        const cookie = await authenticate(server.base)
        const workspaceId = await ensureWorkspace(server.base, cookie)

        const before = await fetch(`${server.base}/api/chat/running`, { headers: { cookie } })
        assert.equal(before.status, 200)
        const empty = (await before.json()) as { running: unknown[] }
        assert.deepEqual(empty.running, [])

        const stream = await fetch(`${server.base}/api/chat/stream`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ message: "跑久一点", workspaceId, conversationId: "c_running" }),
        })
        assert.equal(stream.status, 200)
        const reader = stream.body?.getReader()
        assert.ok(reader)
        await reader.read()

        // 跑的过程中能看到这个会话与它归属的工作区
        const during = await fetch(`${server.base}/api/chat/running`, { headers: { cookie } })
        const runningBody = (await during.json()) as {
            running: Array<{ conversationId: string; workspaceId: string | null }>
        }
        assert.deepEqual(runningBody.running, [{ conversationId: "c_running", workspaceId }])

        // 收尾后从列表里消失
        await reader.cancel().catch(() => undefined)
        const stop = await fetch(`${server.base}/api/chat/stop`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ conversationId: "c_running" }),
        })
        assert.equal(stop.status, 200)
        const after = await fetch(`${server.base}/api/chat/running`, { headers: { cookie } })
        assert.deepEqual(((await after.json()) as { running: unknown[] }).running, [])

        const anonymous = await fetch(`${server.base}/api/chat/running`)
        assert.equal(anonymous.status, 401)
    } finally {
        await stopWebPlugin()
    }
})

test("web 插件：停止正在跑的一轮", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin({ streamDelayMs: 400 })
    try {
        const cookie = await authenticate(server.base)
        const workspaceId = await ensureWorkspace(server.base, cookie)
        stopCalls.length = 0

        const stream = await fetch(`${server.base}/api/chat/stream`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({
                message: "写一段长的",
                workspaceId,
                conversationId: "c_stop",
            }),
        })
        assert.equal(stream.status, 200)
        const reader = stream.body?.getReader()
        assert.ok(reader)
        const first = await reader.read()
        assert.equal(first.done, false)
        assert.match(new TextDecoder().decode(first.value), /"type":"session"/)

        const response = await fetch(`${server.base}/api/chat/stop`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ conversationId: "c_stop" }),
        })
        assert.equal(response.status, 200)
        const body = (await response.json()) as { ok: boolean; stopped: boolean }
        assert.equal(body.ok, true)
        assert.equal(body.stopped, true, "宿主会话应收到停止")
        assert.deepEqual(stopCalls, ["ui-stream-session"])

        // 本轮收尾：连接上收到 stopped，之后不再有 done
        let rest = ""
        const decoder = new TextDecoder()
        while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            rest += decoder.decode(chunk.value)
        }
        assert.match(rest, /"type":"stopped"/)
        assert.doesNotMatch(rest, /"type":"done"/)

        // 续接只重放已经收尾的这一轮（active 为 false），界面据此不再继续等
        const resumed = await fetch(`${server.base}/api/chat/resume?conversationId=c_stop`, {
            headers: { cookie },
        })
        assert.equal(resumed.status, 200)
        const replay = await resumed.text()
        assert.match(replay, /"type":"resume","active":false/)
        assert.match(replay, /"type":"stopped"/)

        const again = await fetch(`${server.base}/api/chat/stop`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ conversationId: "c_stop" }),
        })
        assert.equal(again.status, 200)
        assert.equal(((await again.json()) as { stopped: boolean }).stopped, false)

        // 非法参数与未登录
        const invalid = await fetch(`${server.base}/api/chat/stop`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ conversationId: "bad id" }),
        })
        assert.equal(invalid.status, 400)
        const anonymous = await fetch(`${server.base}/api/chat/stop`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "c_stop" }),
        })
        assert.equal(anonymous.status, 401)
    } finally {
        await stopWebPlugin()
    }
})

test("web 插件：Web 扩展安装、编译产物与卸载", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin()
    try {
        const cookie = await authenticate(server.base)
        const headers = { cookie, "content-type": "application/json" }

        const initial = await fetch(`${server.base}/api/extensions`, { headers })
        assert.equal(initial.status, 200)
        const initialData = (await initial.json()) as { extensions: unknown[] }
        assert.deepEqual(initialData.extensions, [], "初始没有网页安装的扩展")

        const source = `<template>
  <section class="ext-test">
    <p>{{ message }}</p>
    <button @click="count += 1">点 {{ count }}</button>
  </section>
</template>
<script>
export const meta = { name: "测试扩展", mode: "panel" }
</script>
<script setup>
import { ref } from "vue"
const message = ref("来自测试扩展")
const count = ref(0)
</script>
<style>
.ext-test { color: rgb(1, 2, 3); }
</style>
`
        const dataBase64 = Buffer.from(source, "utf8").toString("base64")
        const installed = await fetch(`${server.base}/api/extensions/install`, {
            method: "POST",
            headers,
            body: JSON.stringify({ filename: "demo-ext.vue", dataBase64 }),
        })
        const installedText = await installed.text()
        assert.equal(installed.status, 200, installedText)
        const installedData = JSON.parse(installedText) as {
            extension: { id: string; moduleUrl: string; styleUrl: string }
            extensions: Array<{ id: string; source: string }>
        }
        assert.equal(installedData.extension.id.startsWith("demo-ext-"), true)
        assert.equal(installedData.extensions.length, 1)
        assert.equal(installedData.extensions[0]?.source, "installed")

        const moduleResponse = await fetch(`${server.base}${installedData.extension.moduleUrl}`, {
            headers: { cookie },
        })
        assert.equal(moduleResponse.status, 200)
        assert.match(moduleResponse.headers.get("content-type") ?? "", /javascript/)
        const moduleText = await moduleResponse.text()
        assert.match(moduleText, /\/assets\/app-vue\.js/, "编译产物复用主 bundle 的 Vue")
        assert.match(moduleText, /export default/)
        assert.match(moduleText, /export const meta/, "扩展的命名导出要保留")
        assert.match(moduleText, /来自测试扩展/)

        const styleResponse = await fetch(`${server.base}${installedData.extension.styleUrl}`, {
            headers: { cookie },
        })
        assert.equal(styleResponse.status, 200)
        assert.match(await styleResponse.text(), /\.ext-test/)

        const bad = await fetch(`${server.base}/api/extensions/install`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                filename: "bad.vue",
                dataBase64: Buffer.from("<p>no template</p>").toString("base64"),
            }),
        })
        assert.equal(bad.status, 400)

        const removed = await fetch(`${server.base}/api/extensions/${installedData.extension.id}`, {
            method: "DELETE",
            headers,
            body: "{}",
        })
        assert.equal(removed.status, 200)
        const afterList = (await (
            await fetch(`${server.base}/api/extensions`, { headers })
        ).json()) as {
            extensions: unknown[]
        }
        assert.deepEqual(afterList.extensions, [])
        const gone = await fetch(`${server.base}${installedData.extension.moduleUrl}`, {
            headers: { cookie },
        })
        assert.equal(gone.status, 404)

        // 内置扩展文件只读，网页端删除 = 记入隐藏列表；可恢复
        const hidden = await fetch(`${server.base}/api/extensions/hide`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: "bundled-hello" }),
        })
        assert.equal(hidden.status, 200)
        const hiddenData = (await hidden.json()) as { hiddenBundled: string[] }
        assert.deepEqual(hiddenData.hiddenBundled, ["bundled-hello"])
        const hiddenList = (await (
            await fetch(`${server.base}/api/extensions`, { headers })
        ).json()) as {
            hiddenBundled: string[]
        }
        assert.deepEqual(hiddenList.hiddenBundled, ["bundled-hello"])

        const shown = await fetch(`${server.base}/api/extensions/show`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: "bundled-hello" }),
        })
        assert.equal(shown.status, 200)
        assert.deepEqual(((await shown.json()) as { hiddenBundled: string[] }).hiddenBundled, [])

        const invalid = await fetch(`${server.base}/api/extensions/hide`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: "not-bundled" }),
        })
        assert.equal(invalid.status, 400)
    } finally {
        await stopWebPlugin()
    }
})

test("web 插件：Vue Router history 路由回退", { timeout: 20_000 }, async () => {
    const server = await startWebPlugin()
    try {
        const cookie = await authenticate(server.base)
        for (const path of [
            "/extensions",
            "/ext/demo-extension",
            "/c/conv-a-1",
            "/anything/else",
        ]) {
            const response = await fetch(`${server.base}${path}`, { headers: { cookie } })
            assert.equal(response.status, 200, path)
            assert.match(response.headers.get("content-type") ?? "", /text\/html/)
            const html = await response.text()
            assert.match(html, /<div id="vue-app"><\/div>/, path)
            assert.match(html, /\/assets\/app-vue\.js/, path)
        }
        const missingApi = await fetch(`${server.base}/api/definitely-missing`, {
            headers: { cookie },
        })
        assert.equal(missingApi.status, 404)
        assert.match(missingApi.headers.get("content-type") ?? "", /json/)
    } finally {
        await stopWebPlugin()
    }
})
