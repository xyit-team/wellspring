import assert from "node:assert/strict"
import { startHttpHostPlugin } from "./helpers/http-host.ts"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { EDITOR_JS } from "../plugins/wellspring-code/src/assets/editor.ts"
import {
    CLIENT_SCRIPT,
    CLIENT_STYLES,
    STATIC_ASSETS,
} from "../plugins/wellspring-code/src/assets/index.ts"
import { HIGHLIGHT_JS } from "../plugins/wellspring-code/src/assets/highlight.ts"
import { ICON_SPRITE } from "../plugins/wellspring-code/src/assets/icons.ts"
import { isLoopbackAddress, resolveListenConfig } from "../plugins/wellspring-code/src/listen.ts"
import { CodeAuthStore, LoginThrottle } from "../plugins/wellspring-code/src/auth.ts"
import { renderHome } from "../plugins/wellspring-code/src/pages.ts"
import type { HostFileApi } from "../src/api/host/fs.ts"
import { configureHost } from "../src/api/host/host.ts"
import { PluginDataService } from "../src/plugin/data-access.ts"
import { emitInitHooks, emitShutdownHooks } from "../src/api/host/hooks.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { eventBus } from "../src/event/event.ts"
import { initElog, type ElogStream } from "../src/logger/elog4js.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { PluginSandboxClient, shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"

const projectRoot = join(import.meta.dirname, "..")
const pluginDir = join(projectRoot, "plugins", "wellspring-code")

let tempRoot = ""
let addonEvents: Array<{ type: string; meta: Record<string, unknown> }> = []
let workspace = ""
let subWorkspace = ""
let previousCwd = ""
let base = ""
let client: PluginSandboxClient | null = null
let output = { text: "" } as ElogStream & { text: string }

function paths(): ResolvedPaths {
    return {
        configDir: join(tempRoot, "config"),
        dataDir: join(tempRoot, "data"),
        cacheDir: join(tempRoot, "cache"),
        logDir: join(tempRoot, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
}

function createDataAccess(): PluginDataService {
    const dataAccess = new PluginDataService(paths())
    dataAccess.setPlugins([
        { id: "wellspring-code", deps: ["wellspring-web"] },
        { id: "wellspring-web", deps: [] },
    ])
    return dataAccess
}

async function startPlugin(config: Record<string, unknown> = { port: 0 }): Promise<string> {
    output = { text: "" } as ElogStream & { text: string }
    output.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    configureHost({ paths: paths(), os: { cwd: workspace } })
    await startHttpHostPlugin(paths())
    const nextClient = new PluginSandboxClient({
        pluginId: "wellspring-code",
        pluginName: "Wellspring Code",
        pluginVersion: "1.1.0",
        pluginDir,
        pluginEntry: join(pluginDir, "index.ts"),
        paths: paths(),
        config: DEFAULT_SETTINGS,
        pluginConfig: config,
        backend: new DirectBackend(),
        limits: { timeoutMs: 15_000, memoryMB: 256, pids: 32, outputLimitBytes: 16_384 },
        logger: pino({ level: "silent" }),
        permissions: {
            hostApi: ["logger", "fs", "http", "event", "getHost", "exec", "pty", "fileRoots"],
            workspaceRead: true,
            workspaceWrite: true,
        },
        dataAccess: createDataAccess(),
    })
    client = nextClient
    await nextClient.start()
    await emitInitHooks()
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output.text)
    assert.ok(match, output.text)
    return `http://127.0.0.1:${match[1]}`
}

before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "wellspring-code-plugin-"))
    workspace = join(tempRoot, "workspace")
    subWorkspace = join(workspace, "packages", "demo")
    await mkdir(join(workspace, "src"), { recursive: true })
    await mkdir(join(subWorkspace, "src"), { recursive: true })
    await writeFile(join(workspace, "package.json"), '{\n    "name": "demo"\n}\n')
    await writeFile(
        join(workspace, "src", "main.ts"),
        'export const hello = "world"\nconsole.log(hello)\n',
    )
    await writeFile(join(workspace, "README.md"), "# Wellspring\n\nhello **world**\n")
    await writeFile(join(workspace, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
    await writeFile(join(workspace, "huge.txt"), "x".repeat(3 * 1024 * 1024))
    await writeFile(join(subWorkspace, "hello.md"), "# 子工作区\n")
    await writeFile(join(subWorkspace, "src", "nested.ts"), "export const nested = 1\n")

    // 不再写宿主工作区注册表：code 插件首次启动会把自己管理的默认工作区写进插件数据目录
    await mkdir(paths().dataDir, { recursive: true })
    addonEvents = []
    eventBus.subscribe("wellspring-web:addon:register", (event) => {
        addonEvents.push(event.getData() as { type: string; meta: Record<string, unknown> })
    })
    previousCwd = process.cwd()
    process.chdir(workspace)
    base = await startPlugin()
})

after(async () => {
    await emitShutdownHooks()
    await shutdownAllSandboxPlugins()
    client = null
    process.chdir(previousCwd)
    await rm(tempRoot, { recursive: true, force: true })
})

test("页面与静态资源：严格 CSP、ETag 与无内联脚本", async () => {
    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    const html = await page.text()
    const csp = page.headers.get("content-security-policy") ?? ""
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /script-src 'self'/)
    assert.match(csp, /style-src 'self'/)
    assert.match(page.headers.get("content-type") ?? "", /text\/html/)
    assert.match(html, /Wellspring Code/)
    assert.match(html, /id="tree"/)
    assert.match(html, /id="code-input"/)
    assert.match(html, /id="palette-overlay"/)
    assert.match(html, /id="workspace-add"/, "切换工作区面板要有添加工作区按钮")
    assert.match(html, /id="setting-ui-font"/)
    assert.match(html, /id="statusbar"|class="statusbar"/)
    assert.match(html, /<script src="\/assets\/app.js" defer>/)
    assert.doesNotMatch(html, /<style[\s>]/i)
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i)
    assert.doesNotMatch(html, /<[^>]+\sstyle=/i)
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+=/i)
    // 高亮层必须就是那个 pre：内层 <code> 会被 UA 换成 monospace 字体，
    // 和 textarea 的字形度量不一致，字号放大后文字与选区会逐行错位。
    assert.match(html, /<pre class="code-layer" id="code-highlight" aria-hidden="true"><\/pre>/)
    // 终端高度拖拽条
    assert.match(html, /id="terminal-resizer"/)
    assert.match(html, /role="separator" aria-orientation="horizontal"/)
    // 差异比较窗口
    assert.match(html, /id="diff-view"/)
    assert.match(html, /id="diff-view-body"/)
    assert.match(html, /id="diff-close"/)
    assert.match(html, /id="diff-open-file"/)
    // 暂存按钮；正常状态不显示说明文案
    assert.match(html, /id="scm-hint" hidden/)
    assert.match(html, /id="scm-stage-all"/)
    assert.match(html, /id="scm-unstage-all"/)
    // 只读 Git 面板
    assert.match(html, /id="scm-badge"/)
    assert.match(html, /id="btn-refresh-scm"/)
    assert.match(html, /id="scm-groups"/)
    assert.match(html, /data-view="scm"/)
    // 默认未设密码：直接进应用，设置里有访问密码面板
    assert.match(html, /data-auth-state="none"/)
    assert.match(html, /data-auth-configured="false"/)
    assert.match(html, /id="password-save"/)
    assert.match(html, /id="password-current"/)
    // 查找替换：Ctrl+H 展开替换行
    assert.match(html, /id="find-replace-row"/)
    assert.match(html, /id="replace-input"/)
    assert.match(html, /id="replace-one"/)
    assert.match(html, /id="replace-all"/)
    assert.match(html, /id="find-toggle-replace"/)
    // 自动补全浮层：listbox 挂在代码视图里，textarea 通过 aria 关联
    assert.match(html, /id="autocomplete"/)
    assert.match(html, /id="autocomplete-list"/)
    assert.match(html, /aria-controls="autocomplete"/)
    assert.match(html, /aria-autocomplete="list"/)
    // 语法诊断：活动栏入口、侧栏问题面板、状态栏计数
    assert.match(html, /data-view="problems"/)
    assert.match(html, /id="problems-list"/)
    assert.match(html, /id="problems-badge"/)
    assert.match(html, /id="status-diagnostics"/)
    assert.match(html, /id="diagnostics-count"/)
    // 移动端：软键盘由隐藏 textarea 承接，视口高度交给 visualViewport
    assert.match(html, /id="terminal-capture"/)
    assert.match(html, /interactive-widget=resizes-content/)
    // 终端回看滚动条与回到底部按钮
    assert.match(html, /id="terminal-scrollbar"/)
    assert.match(html, /id="terminal-jump"/)
    assert.doesNotMatch(html, /<code[^>]*id="code-highlight"/)

    const styles = await fetch(`${base}/assets/app.css`)
    assert.equal(styles.status, 200)
    const etag = styles.headers.get("etag") ?? ""
    assert.match(etag, /^"[0-9a-f]{16}"$/)
    assert.match(await styles.text(), /--bg-editor/)
    const cached = await fetch(`${base}/assets/app.css`, { headers: { "if-none-match": etag } })
    assert.equal(cached.status, 304)

    const script = await fetch(`${base}/assets/app.js`)
    assert.equal(script.status, 200)
    const body = await script.text()
    assert.match(body, /createEditor/)
    assert.match(body, /Wellspring Code/)
    assert.match(body, /byId\("code-highlight"\)/)
    assert.doesNotMatch(body, /byId\("code-layer"\)/)

    const icon = await fetch(`${base}/favicon.svg`)
    assert.equal(icon.status, 200)
    assert.match(icon.headers.get("content-type") ?? "", /svg/)
})

test("高亮层与 textarea 共用同一套字体度量", () => {
    // 高亮层里的元素（包括 UA 自带字体的 code/pre/strong）都必须沿用编辑器的字体与行高，
    // 否则字号越大，正文和高亮背景/选区的错位越明显。
    assert.match(
        CLIENT_STYLES,
        /\.code-layer \*\s*\{[^}]*font-family: var\(--font-mono\)[^}]*line-height: var\(--line-height\)/,
    )
    assert.match(CLIENT_STYLES, /\.code-input \{[^}]*line-height: var\(--line-height\)/)
    assert.match(CLIENT_STYLES, /\.code-layer \{[^}]*line-height: var\(--line-height\)/)
})

test("镜像层与上色分开调度，按住退格时文字跟上按键", () => {
    // textarea 是 color: transparent，可见文字来自 .code-layer；上色要全文分词，
    // 只能按停顿合并。两者共用重置式计时器时，键盘重复会不停清掉计时器，
    // 画面停在旧内容上直到松手
    assert.match(EDITOR_JS, /function syncLayerText\(/)
    assert.match(EDITOR_JS, /requestAnimationFrame\(function \(\) \{[\s\S]{0,220}syncLayerText\(\)/)
    const schedule = EDITOR_JS.slice(
        EDITOR_JS.indexOf("function scheduleHighlight"),
        EDITOR_JS.indexOf("function syncScroll"),
    )
    assert.ok(schedule.includes("syncLayerText()"), "计时器之外要有每帧同步")
    assert.ok(
        schedule.indexOf("requestAnimationFrame") < schedule.indexOf("clearTimeout"),
        "每帧同步不能被计时器重置影响",
    )
    assert.ok(
        (EDITOR_JS.match(/clearTimeout\(highlightTimer\)/g) ?? []).length >= 1,
        "上色计时器要能被重置与取消",
    )
})

test("大文件高亮只渲染视口附近的行", () => {
    // 整篇文档几十万字符时，DOM 里堆几万个 span 再换 innerHTML，浏览器要重排整篇文本
    // （4000 行实测一次输入后要 1s 才能重新上色）。改成只渲染视口上下几百行。
    assert.match(EDITOR_JS, /VIEWPORT_CONTEXT_LINES = 240/)
    assert.match(EDITOR_JS, /VIEWPORT_BUFFER_LINES = 160/)
    assert.match(EDITOR_JS, /LINE_VIEW_BUFFER = 120/)
    assert.match(EDITOR_JS, /function highlightRange\(\) \{/)
    assert.match(EDITOR_JS, /function renderSliceView\(\) \{[\s\S]{0,400}highlightRange\(\)/)
    // 行范围按 lineStarts 切，末尾不带换行
    assert.match(EDITOR_JS, /range\.starts\[range\.end\] - 1 : value\.length/)
    // 层用 transform 平移到行首/行号位置（层自身没有 padding）
    assert.match(EDITOR_JS, /paddingLeft\(\) - ta\.scrollLeft/)
    assert.match(EDITOR_JS, /paddingTop\(\) \+ viewStart \* lineHeight - ta\.scrollTop/)
    // 滚动时已经覆盖就不重渲染，只平移
    assert.match(EDITOR_JS, /function viewCoversVisible\(\)/)
    assert.match(EDITOR_JS, /if \(!viewCoversVisible\(\)\) scheduleViewportRender\(\)/)
    // 全量分片渲染已经移除
    assert.doesNotMatch(EDITOR_JS, /renderChunkedHighlight/)
    assert.doesNotMatch(EDITOR_JS, /hl-rest/)
    // 组合输入期间不再每帧重建镜像层 / 上色 / 缩略图
    const schedule = EDITOR_JS.slice(
        EDITOR_JS.indexOf("function scheduleHighlight"),
        EDITOR_JS.indexOf("function syncScroll"),
    )
    assert.match(schedule, /if \(composing\) return/)
    assert.match(EDITOR_JS, /function drawMinimap\(\) \{[\s\S]{0,80}composing/)
    // 光标行列改用行索引二分，不再对大文件做整串切片
    assert.match(EDITOR_JS, /var caret = lineColumnAt\(end\)/)
})

test("C 家族按行增量着色：只重算改动的行", () => {
    // 行首状态 + 每行着色结果缓存；改一行只重分词一行、只更新这一行 DOM，
    // 跨行结构变化（块注释/模板字符串）才沿行状态向后传播。
    assert.match(HIGHLIGHT_JS, /function tokenizeCFamilyLine\(line, startState, language\)/)
    assert.match(HIGHLIGHT_JS, /var LINE_STATE_BLOCK_COMMENT = 1/)
    assert.match(HIGHLIGHT_JS, /var LINE_STATE_STRING = 2/)
    assert.match(EDITOR_JS, /function incrementalLanguage\(language\)/)
    assert.match(EDITOR_JS, /var lineCache = null/)
    assert.match(EDITOR_JS, /function tokenizeCacheLine\(starts\)/)
    assert.match(EDITOR_JS, /function applyLineCacheEdit\(diff, value, starts\)/)
    // 普通输入：状态收敛后直接认定后续行还有效，只分词改动行
    assert.match(
        EDITOR_JS,
        /lineStateEquals\(info\.previousNextState, info\.state\)[\s\S]{0,80}cache\.tokenizedTo = cache\.lineCount/,
    )
    // 渲染用行元素，改行只改对应元素的 innerHTML
    assert.match(EDITOR_JS, /node\.className = "view-line"/)
    assert.match(EDITOR_JS, /function buildLineViewNodes\(start, end\)/)
    assert.match(EDITOR_JS, /lineViewNodes\[line - start\]/)
    assert.match(CLIENT_STYLES, /\.code-layer \.view-line \{[^}]*display: block/)
    // 增量路径不需要「先铺纯文本再防抖上色」
    assert.match(
        EDITOR_JS,
        /incrementalLanguage\(model === null \? "" : model\.language\)\) \{[\s\S]{0,620}requestAnimationFrame/,
    )
})

test("控制台持有焦点时，全局快捷键让位给终端", () => {
    /** 从客户端脚本里取一个函数源码（配对大括号），真跑一遍而不是只看字符串 */
    const extract = (signature: string): string => {
        const start = CLIENT_SCRIPT.indexOf(`function ${signature}(`)
        assert.notEqual(start, -1, `找不到 ${signature}`)
        const open = CLIENT_SCRIPT.indexOf("{", start)
        let depth = 0
        for (let index = open; index < CLIENT_SCRIPT.length; index += 1) {
            const char = CLIENT_SCRIPT[index]
            if (char === "{") depth += 1
            else if (char === "}") {
                depth -= 1
                if (depth === 0) return CLIENT_SCRIPT.slice(start, index + 1)
            }
        }
        assert.fail(`${signature} 的大括号没有配对`)
    }

    interface Guard {
        focused: boolean
        blocked: (lower: string) => boolean
    }

    /** 按「当前焦点是谁」造一份运行环境，返回与 onGlobalKeydown 同义的闸门 */
    const guardWithFocus = (focus: string): Guard => {
        const nodes: Record<string, { id: string }> = {
            output: { id: "terminal-output" },
            input: { id: "terminal-input" },
            capture: { id: "terminal-capture" },
            editor: { id: "editor-input" },
        }
        const build = new Function(
            "termOutput",
            "byId",
            "document",
            `${extract("terminalFocused")}\n${extract("terminalOwnsKey")}\nreturn { terminalFocused: terminalFocused, terminalOwnsKey: terminalOwnsKey }`,
        ) as (
            termOutput: () => unknown,
            byId: (id: string) => unknown,
            document: { activeElement: unknown },
        ) => { terminalFocused: () => boolean; terminalOwnsKey: (lower: string) => boolean }
        const api = build(
            () => nodes.output,
            (id) =>
                id === "terminal-input"
                    ? nodes.input
                    : id === "terminal-capture"
                      ? nodes.capture
                      : null,
            { activeElement: nodes[focus] },
        )
        return {
            focused: api.terminalFocused(),
            blocked: (lower) => api.terminalFocused() && api.terminalOwnsKey(lower),
        }
    }

    // 控制台的三个入口（输出区、命令框、移动端隐藏输入）都算持有焦点
    for (const where of ["output", "input", "capture"]) {
        const guard = guardWithFocus(where)
        assert.equal(guard.focused, true, `${where} 应当算控制台持有焦点`)
        // Ctrl+Shift+V 预览、Ctrl+B 侧栏、Ctrl+P 快速打开、Ctrl+S 保存：全部让位给终端
        for (const key of ["v", "b", "p", "s", "w", "n", "f", "z"]) {
            assert.equal(guard.blocked(key), true, `焦点在 ${where} 时 Ctrl+${key} 必须让位`)
        }
        // 只留「关掉控制台」：PTY 里 Escape 会送给前台程序，没这条焦点就困住了
        assert.equal(guard.blocked("`"), false, `焦点在 ${where} 时 Ctrl+反引号 必须可用`)
        assert.equal(guard.blocked("~"), false)
    }

    // 焦点不在控制台：快捷键一条都不能被挡
    const outside = guardWithFocus("editor")
    assert.equal(outside.focused, false)
    for (const key of ["v", "b", "p", "s", "`"]) {
        assert.equal(outside.blocked(key), false, `焦点不在控制台时 Ctrl+${key} 不能被挡`)
    }

    // 闸门必须排在 onGlobalKeydown 各条快捷键之前，尤其是 Markdown 预览那条
    const handler = extract("onGlobalKeydown")
    const gate = handler.indexOf("terminalFocused() && terminalOwnsKey(lower)")
    assert.ok(gate > -1, "onGlobalKeydown 里要有这道闸门")
    assert.ok(handler.indexOf('lower === "v" && event.shiftKey') > gate, "Ctrl+Shift+V 不能被漏掉")

    // 控制台自己的粘贴/复制仍然在，不然让位之后 Ctrl+Shift+V 就什么也不做了
    assert.match(CLIENT_SCRIPT, /event\.ctrlKey && key === "v"[\s\S]{0,80}pasteIntoTerminal/)
    assert.match(CLIENT_SCRIPT, /event\.ctrlKey && event\.shiftKey && key === "c"/)

    // 另一半：Ctrl+Shift+字母 不再当控制码发给 PTY
    const consoleKey = /function handleConsoleKeydown\(event\) \{[\s\S]*?\n    \}/.exec(
        CLIENT_SCRIPT,
    )
    assert.ok(consoleKey !== null)
    const chord = consoleKey[0].indexOf("event.ctrlKey && event.shiftKey) return")
    assert.ok(chord > -1, "要有 Ctrl+Shift 组合的拦截")
    // 否则 Ctrl+Shift+K 清屏会顺手发 ^K 把命令行后半段删掉
    assert.ok(consoleKey[0].indexOf("termKeyBytes(event)") > chord, "拦截必须排在发控制码之前")
})

test("Markdown 行分词：块引用尖括号不重复转义，围栏状态可增量维护", () => {
    const helpers = new Function(
        HIGHLIGHT_JS +
            "\nreturn { tokenize: tokenizeMarkdownLine, highlight: highlightMarkdown, state: markdownLineState }",
    )() as {
        tokenize: (
            line: string,
            state: { fence: string; language: string },
        ) => { html: string; state: { fence: string; language: string } }
        highlight: (code: string) => string
        state: (fence: string, language: string) => { fence: string; language: string }
    }

    const quote = helpers.highlight("> 引用")
    assert.match(quote, /tok-comment">&gt;<\/span> 引用/)
    assert.doesNotMatch(quote, /&amp;gt;/, "不能把 &gt; 再转义成 &amp;gt;")

    let state = helpers.state("", "")
    const heading = helpers.tokenize("# 标题", state)
    assert.match(heading.html, /tok-keyword">#<\/span> 标题/)
    assert.equal(heading.state.fence, "")
    state = heading.state

    const open = helpers.tokenize("```ts", state)
    assert.match(open.html, /tok-fence">```ts/)
    assert.equal(open.state.fence, "`")
    assert.equal(open.state.language, "ts")

    const code = helpers.tokenize("const x = 1", open.state)
    assert.match(code.html, /const x = 1/)
    assert.equal(code.state.fence, "`")

    const close = helpers.tokenize("```", code.state)
    assert.match(close.html, /tok-fence">```/)
    assert.equal(close.state.fence, "")

    // 编辑器把 Markdown 也接进了行缓存增量路径
    assert.match(EDITOR_JS, /language === "markdown" && typeof tokenizeMarkdownLine === "function"/)
    assert.match(EDITOR_JS, /function lineStateEquals\(left, right\)/)
})

test("C 家族行分词：分类与跨行状态", () => {
    const helpers = new Function(
        HIGHLIGHT_JS +
            "\nreturn { tokenize: tokenizeCFamilyLine, code: LINE_STATE_CODE, block: LINE_STATE_BLOCK_COMMENT, string: LINE_STATE_STRING }",
    )() as {
        tokenize: (line: string, state: number, language: string) => { html: string; state: number }
        code: number
        block: number
        string: number
    }

    const line = helpers.tokenize('const value = "abc" // note', helpers.code, "typescript")
    assert.match(line.html, /tok-keyword">const/)
    assert.match(line.html, /tok-variable">value/)
    assert.match(line.html, /tok-string">&quot;abc&quot;/)
    assert.match(line.html, /tok-comment">\/\/ note/)
    assert.equal(line.state, helpers.code)

    const call = helpers.tokenize("obj.run(0x1f) + 42.5", helpers.code, "typescript")
    assert.match(call.html, /tok-variable">obj/)
    assert.match(call.html, /tok-function">run/)
    assert.match(call.html, /tok-number">0x1f/)
    assert.match(call.html, /tok-number">42.5/)

    // 块注释跨行：第二行整行是注释，第三行闭合后恢复正常分词
    const first = helpers.tokenize("/* start", helpers.code, "typescript")
    assert.equal(first.state, helpers.block)
    assert.match(first.html, /tok-comment/)
    const middle = helpers.tokenize("middle", helpers.block, "typescript")
    assert.equal(middle.state, helpers.block)
    assert.match(middle.html, /^<span class="tok-comment">middle<\/span>$/)
    const last = helpers.tokenize("end */ const x = 1", helpers.block, "typescript")
    assert.equal(last.state, helpers.code)
    assert.match(last.html, /tok-comment">end \*\//)
    assert.match(last.html, /tok-keyword">const/)

    // 模板字符串跨行
    const open = helpers.tokenize("const s = `abc", helpers.code, "typescript")
    assert.equal(open.state, helpers.string)
    const inside = helpers.tokenize("def", helpers.string, "typescript")
    assert.equal(inside.state, helpers.string)
    assert.match(inside.html, /^<span class="tok-string">def<\/span>$/)
    const close = helpers.tokenize("ghi` + 1", helpers.string, "typescript")
    assert.equal(close.state, helpers.code)
    assert.match(close.html, /tok-string">ghi`/)
    assert.match(close.html, /tok-number">1/)

    // HTML 必须转义
    const escaped = helpers.tokenize("a < b && c > d", helpers.code, "typescript")
    assert.ok(
        escaped.html.includes("&lt;") &&
            escaped.html.includes("&gt;") &&
            escaped.html.includes("&amp;"),
    )
})

test("文本差异换算成需要重分词的行范围（纯函数）", () => {
    const helpers = new Function(
        HIGHLIGHT_JS +
            EDITOR_JS +
            "\nreturn { changedLineRange: changedLineRange, lineIndexOfOffset: lineIndexOfOffset }",
    )() as {
        changedLineRange: (
            oldValue: string,
            newValue: string,
            oldLineCount: number,
            newLineCount: number,
        ) => { startLine: number; oldEndLine: number; newEndLine: number }
        lineIndexOfOffset: (value: string, offset: number) => number
    }
    const base = "aaa\nbbb\nccc"
    assert.deepEqual(helpers.changedLineRange(base, "aaa\nbbX\nccc", 3, 3), {
        startLine: 1,
        oldEndLine: 2,
        newEndLine: 2,
    })
    // 行内插入字符
    assert.deepEqual(helpers.changedLineRange(base, "aaa\nbbbb\nccc", 3, 3), {
        startLine: 1,
        oldEndLine: 2,
        newEndLine: 2,
    })
    // 插入换行：影响两行
    assert.deepEqual(helpers.changedLineRange(base, "aaa\nbb\nb\nccc", 3, 4), {
        startLine: 1,
        oldEndLine: 2,
        newEndLine: 3,
    })
    // 删除一整行：换算时可能多带一行（多重算一行无害，少算才会留下旧颜色）
    assert.deepEqual(helpers.changedLineRange(base, "aaa\nccc", 3, 2), {
        startLine: 1,
        oldEndLine: 3,
        newEndLine: 2,
    })
    // 文件末尾追加
    assert.deepEqual(helpers.changedLineRange(base, base + "\nddd", 3, 4), {
        startLine: 2,
        oldEndLine: 3,
        newEndLine: 4,
    })
    assert.equal(helpers.lineIndexOfOffset(base, 0), 0)
    assert.equal(helpers.lineIndexOfOffset(base, 4), 1)
    assert.equal(helpers.lineIndexOfOffset(base, base.length), 2)
})

test("中文组合输入快路径", () => {
    assert.match(EDITOR_JS, /var imeFastPathDisabled = false/)
    assert.match(EDITOR_JS, /function beginComposition\(\) \{[\s\S]{0,400}isLargeDocument\(value\)/)
    assert.match(EDITOR_JS, /document\.execCommand\("insertText", false, inserted\)/)
})

test("中文组合输入：大文件把 textarea 缩成光标行", () => {
    // 原生 textarea 装几千行时，Chromium 每次 IME 组合更新都要重排整篇文本，
    // 光标越靠文档后段越慢（4000 行可到秒级）。这里照 VS Code 的思路：
    // 组合期间 textarea 只装光标所在行，贴到该行位置，正文继续由高亮层显示。
    assert.match(EDITOR_JS, /var IME_CONTEXT_CHARS = 240/)
    assert.match(EDITOR_JS, /var IME_TRAILING_CHARS = 1200/)
    assert.match(EDITOR_JS, /function beginComposition\(\) \{[\s\S]{0,400}isLargeDocument\(value\)/)
    assert.match(
        EDITOR_JS,
        /function positionComposition\(\) \{[\s\S]{0,1400}ta\.style\.height = lineHeight \+ "px"/,
    )
    // 组合期间读正文都走 composition.full，不能把单行 textarea 当全文
    assert.match(EDITOR_JS, /function documentText\(\) \{[\s\S]{0,140}composition\.full/)
    assert.match(EDITOR_JS, /function getValue\(\) \{\s*return compositionDocument\(\)/)
    const inputHandler = EDITOR_JS.slice(
        EDITOR_JS.indexOf('ta.addEventListener("input"'),
        EDITOR_JS.indexOf('ta.addEventListener("click"'),
    )
    assert.match(inputHandler, /if \(composing\)[\s\S]{0,320}compositionDocument\(\)/)
    // 组合结束还原全文，并把这次输入作为一次可撤销的插入重放（value 赋值会清空原生撤销栈）
    assert.match(EDITOR_JS, /document\.execCommand\("insertText", false, inserted\)/)
    // 小文件 / 只读 / 带选区退回原来的原生行为
    assert.match(EDITOR_JS, /compositionstart[\s\S]{0,500}layer\.classList\.add\("is-hidden"\)/)
    // 输入法拒绝「组合期间换 value」时连续两次失败就永久退回原生路径
    assert.match(EDITOR_JS, /var imeFastPathDisabled = false/)
    assert.match(EDITOR_JS, /if \(imeFastPathDisabled\) return false/)
    assert.match(EDITOR_JS, /imeFastPathFailures >= 2\) imeFastPathDisabled = true/)
    // 高亮层里的当前行用同底色遮罩盖掉，避免和单行 textarea 重字
    assert.match(CLIENT_STYLES, /\.ime-line-cover \{[^}]*background: var\(--bg-editor\)/)
    assert.match(CLIENT_STYLES, /\.code-view\.is-ime-composing \.code-input \{[^}]*z-index: 4/)
    // 保存、记忆浏览位置必须读编辑器全文，而不是组合期间的单行 textarea
    assert.match(CLIENT_SCRIPT, /function editorContent\(\)/)
    assert.match(CLIENT_SCRIPT, /app\.active\.content = editorContent\(\)/)
})

test("组合输入正文重组（纯函数）", () => {
    const helpers = new Function(
        HIGHLIGHT_JS +
            EDITOR_JS +
            "\nreturn { composeDocument: composeDocument, composedInsertedText: composedInsertedText }",
    )() as {
        composeDocument: (
            full: string,
            lineStart: number,
            lineEnd: number,
            windowStart: number,
            windowEnd: number,
            windowText: string,
        ) => string
        composedInsertedText: (
            windowText: string,
            caretInWindow: number,
            committedEnd: number,
        ) => string
    }

    const full = "const a = 1\nconst b = 2\nconst c = 3"
    const lineStart = full.indexOf("const b")
    const lineEnd = full.indexOf("\n", lineStart)
    assert.equal(
        helpers.composeDocument(full, lineStart, lineEnd, lineStart, lineEnd, "const b = 22"),
        "const a = 1\nconst b = 22\nconst c = 3",
    )
    // 最后一行没有换行
    const lastStart = full.lastIndexOf("const c")
    assert.equal(
        helpers.composeDocument(
            full,
            lastStart,
            full.length,
            lastStart,
            full.length,
            "const c = 33",
        ),
        "const a = 1\nconst b = 2\nconst c = 33",
    )
    // 空行里组合
    assert.equal(helpers.composeDocument("a\n\nb", 2, 2, 2, 2, "你好"), "a\n你好\nb")
    // 超长行只替换窗口，窗口外的字符必须原样保留
    const long = "ab\n0123456789\ncd"
    assert.equal(helpers.composeDocument(long, 3, 13, 5, 9, "XX"), "ab\n01XX6789\ncd")
    // 提交文本只取 textarea 里输入法真的插进去的那一段
    assert.equal(helpers.composedInsertedText("abcdef", 2, 4), "cd")
    assert.equal(helpers.composedInsertedText("abc", 3, 3), "")
    assert.equal(helpers.composedInsertedText("abc", 3, 1), "")
})

test("自动补全：前缀位置、文档词与候选排序", () => {
    const helpers = new Function(
        HIGHLIGHT_JS +
            EDITOR_JS +
            "\nreturn { prefixRange: completionPrefixRange, collectWords: collectDocumentWords, build: buildCompletions, minPrefix: COMPLETION_MIN_PREFIX }",
    )() as {
        prefixRange: (value: string, position: number) => { start: number; prefix: string }
        collectWords: (text: string, limit: number) => string[]
        build: (input: {
            prefix: string
            words: string[]
            language: string
        }) => Array<{ label: string; keyword: boolean; weight: number }>
        minPrefix: number
    }

    assert.equal(helpers.minPrefix, 1, "输入一个字符就开始补全")
    const text = "const fetchData = 1"
    assert.deepEqual(helpers.prefixRange(text, text.indexOf("fetchData") + 5), {
        start: 6,
        prefix: "fetch",
    })
    assert.deepEqual(helpers.prefixRange("a.b", 3), { start: 2, prefix: "b" })
    assert.deepEqual(helpers.prefixRange("中文foo", 5), { start: 2, prefix: "foo" })
    assert.deepEqual(helpers.prefixRange("foo bar", 4), { start: 4, prefix: "" })

    assert.deepEqual(helpers.collectWords("const foo = foo + bar\nfunction f() {}", 100), [
        "const",
        "foo",
        "bar",
        "function",
    ])

    const javascript = helpers.build({
        prefix: "fu",
        words: ["fuzzy", "fun", "function", "Fu"],
        language: "javascript",
    })
    assert.deepEqual(
        javascript.map((item) => item.label),
        ["function", "fun", "fuzzy", "Fu"],
        "关键字优先，其后按前缀一致性与长度排序",
    )
    assert.equal(javascript[0]?.keyword, true)

    assert.deepEqual(
        helpers
            .build({ prefix: "FE", words: ["fetchData", "fed"], language: "plaintext" })
            .map((item) => item.label),
        ["fed", "fetchData"],
        "忽略大小写匹配，短词在前",
    )
    assert.deepEqual(
        helpers
            .build({ prefix: "", words: ["beta", "alpha", "alpha"], language: "plaintext" })
            .map((item) => item.label),
        ["beta", "alpha"].sort((left, right) =>
            left.length !== right.length ? left.length - right.length : left < right ? -1 : 1,
        ),
        "空前缀列出文档词并去重",
    )
    assert.equal(
        helpers.build({ prefix: "", words: ["zzz"], language: "javascript" })[0]?.label,
        "zzz",
        "手动打开的空前缀先列文件里的词",
    )
    // TypeScript 的候选要合并 JS 关键字 / TS 额外关键字 / 类型 / 字面量
    const typescript = helpers.build({ prefix: "c", words: [], language: "typescript" })
    const tsLabels = typescript.map((item) => item.label)
    assert.ok(tsLabels.includes("class"), "JS 关键字")
    assert.ok(tsLabels.includes("const"), "JS 关键字")
    assert.ok(tsLabels.includes("catch"), "JS 关键字")
    assert.ok(
        helpers
            .build({ prefix: "dec", words: [], language: "typescript" })
            .some((item) => item.label === "declare"),
        "TS 额外关键字需要单独并进来",
    )
    const many = Array.from({ length: 120 }, (_, index) => `alpha${index}`)
    assert.equal(
        helpers.build({ prefix: "a", words: many, language: "plaintext" }).length,
        50,
        "候选数量有上限",
    )

    assert.match(CLIENT_SCRIPT, /function buildCompletions\(/)
    assert.match(CLIENT_SCRIPT, /function openCompletion\(/)
    assert.match(CLIENT_SCRIPT, /function positionCompletion\(/)
    assert.match(CLIENT_SCRIPT, /event.ctrlKey \|\| event.metaKey\) && event.key === " "/)
    assert.match(CLIENT_STYLES, /\.autocomplete \{/)
    assert.match(CLIENT_STYLES, /\.completion-probe \{/)
    assert.match(CLIENT_STYLES, /\.autocomplete-match \{/)
    // 语法分析：结构检查、问题面板、行内波浪线
    assert.match(CLIENT_SCRIPT, /function analyzeSyntax\(/)
    assert.match(CLIENT_SCRIPT, /function scheduleDiagnostics\(/)
    assert.match(CLIENT_SCRIPT, /function renderProblemsList\(/)
    assert.match(CLIENT_SCRIPT, /function renderDiagnostics\(/)
    assert.match(CLIENT_SCRIPT, /setDiagnostics: setDiagnostics/)
    assert.match(CLIENT_STYLES, /\.diagnostic-mark::after/)
    assert.match(CLIENT_STYLES, /\.problem-item \{/)
    // 括号配对与缩进参考线
    assert.match(CLIENT_SCRIPT, /function bracketMatchAt\(/)
    assert.match(CLIENT_SCRIPT, /function renderBracketMatch\(/)
    assert.match(CLIENT_SCRIPT, /function drawIndentGuides\(/)
    assert.match(CLIENT_STYLES, /\.bracket-mark \{/)
    assert.match(CLIENT_STYLES, /\.indent-canvas \{/)
    assert.match(CLIENT_STYLES, /--indent-guide/)
    // 符号搜索与转到定义
    assert.match(CLIENT_SCRIPT, /function openSymbolSearch\(/)
    assert.match(CLIENT_SCRIPT, /function renderSymbolQuickList\(/)
    assert.match(CLIENT_SCRIPT, /function goToDefinition\(/)
    assert.match(CLIENT_SCRIPT, /wordAtCaret/)
    assert.match(CLIENT_SCRIPT, /lower === "g" && event\.shiftKey/)
    assert.match(CLIENT_SCRIPT, /"symbol-search"/)
    // 查找替换
    assert.match(CLIENT_SCRIPT, /function openFindReplace\(/)
    assert.match(CLIENT_SCRIPT, /function replaceCurrent\(/)
    assert.match(CLIENT_SCRIPT, /function replaceAllMatches\(/)
    assert.match(CLIENT_SCRIPT, /Ctrl\+H/)
    assert.match(CLIENT_STYLES, /\.find-row \{/)
    // 工作区符号搜索
    assert.match(CLIENT_SCRIPT, /function addWorkspace\(/)
    assert.match(CLIENT_SCRIPT, /function openWorkspaceSymbols\(/)
    assert.match(CLIENT_SCRIPT, /function renderWorkspaceSymbols\(/)
    assert.match(CLIENT_SCRIPT, /\/api\/symbols/)
    assert.match(CLIENT_SCRIPT, /"workspace-symbols"/)
    // 只读 Git 面板
    assert.match(CLIENT_SCRIPT, /function loadScmStatus\(/)
    assert.match(CLIENT_SCRIPT, /function renderScm\(/)
    assert.match(CLIENT_SCRIPT, /function openScmDiff\(/)
    assert.match(CLIENT_SCRIPT, /function showDiffTab\(/)
    assert.match(CLIENT_SCRIPT, /function buildDiffRows\(/)
    assert.match(CLIENT_SCRIPT, /function renderDiffTab\(/)
    assert.match(CLIENT_SCRIPT, /\/api\/git\/status/)
    assert.match(CLIENT_SCRIPT, /function stageScmPaths\(/)
    assert.match(CLIENT_SCRIPT, /hint\.hidden = hintText === ""/)
    assert.match(CLIENT_SCRIPT, /iconSvg\(staged === true \? "minus" : "plus"/)
    assert.match(CLIENT_SCRIPT, /\/api\/git\/stage/)
    assert.match(CLIENT_SCRIPT, /\/api\/git\/unstage/)
    assert.match(CLIENT_STYLES, /\.scm-item \{/)
    assert.match(CLIENT_STYLES, /\.diff-view-row \{/)
    assert.match(CLIENT_STYLES, /\.diff-view-hunk \{/)
    assert.match(CLIENT_STYLES, /\.tree-scm \{/)
})

test("缩略图：短文件按固定行距渲染，点击底部停在最后一行", () => {
    const helpers = new Function(
        EDITOR_JS +
            "\nreturn { rowHeight: minimapRowHeightFor, contentHeight: minimapContentHeightFor, targetLine: minimapTargetLine, maxRowHeight: MINIMAP_ROW_HEIGHT }",
    )() as {
        rowHeight: (count: number, height: number) => number
        contentHeight: (count: number, height: number) => number
        targetLine: (offsetY: number, rowHeight: number, count: number) => number
        maxRowHeight: number
    }
    // 101 行（末尾换行）在 783px 高的缩略图里只占上面约 242px，不再拉满整条
    assert.equal(helpers.rowHeight(101, 783), helpers.maxRowHeight)
    assert.ok(helpers.contentHeight(101, 783) < 260)
    assert.ok(helpers.contentHeight(101, 783) < 783)
    // 超长文件才按比例压缩到容器高度
    assert.ok(helpers.rowHeight(5000, 783) < 0.2)
    assert.ok(Math.abs(helpers.contentHeight(5000, 783) - 783) < 1e-6)
    // 点在缩略图内容下方落在最后一行，向上越界落在第一行
    assert.equal(helpers.targetLine(700, helpers.maxRowHeight, 101), 100)
    assert.equal(helpers.targetLine(0, helpers.maxRowHeight, 101), 0)
    assert.equal(helpers.targetLine(-20, helpers.maxRowHeight, 101), 0)
    assert.equal(helpers.targetLine(12, helpers.maxRowHeight, 101), 5)
})

test("高亮层高度由内容决定，不被自身裁成视口高度", () => {
    // 四边全钉 0 会把高亮层压成 .code-view 的可见高度，超出一屏的行直接被丢掉；
    // syncScroll 平移整块 pre 后，可见区落进丢掉的那段 —— 只有初始视口有着色，往下全白。
    // textarea 独立滚动且文字透明，所以表现为「能选中却没颜色」。
    const block = /\.code-layer \{([^}]*)\}/.exec(CLIENT_STYLES)?.[1] ?? ""
    assert.ok(block.length > 0)
    const decl = block.replace(/\/\*[\s\S]*?\*\//g, "")
    assert.doesNotMatch(decl, /inset:\s*0/)
    assert.doesNotMatch(decl, /overflow:\s*hidden/)
    assert.match(decl, /overflow:\s*visible/)
    assert.match(decl, /width:\s*max-content/)
    assert.match(decl, /top:\s*0/)
})

test("终端面板与 exec 权限已接线", () => {
    // 插件被 access-guard 禁止 child_process，终端走宿主 exec hostApi；
    // 前端用轮询拉增量输出，所以四件套（面板/样式/脚本/命令）都得在。
    assert.match(CLIENT_STYLES, /\.terminal \{[^}]*flex-direction: column/)
    assert.match(CLIENT_STYLES, /\.terminal-body \{[^}]*overflow: auto/)
    assert.match(CLIENT_SCRIPT, /function bindTerminal\(\)/)
    assert.match(CLIENT_SCRIPT, /function toggleTerminal\(\)/)
    assert.match(CLIENT_SCRIPT, /\/api\/term\/run/)
    assert.match(CLIENT_SCRIPT, /\/api\/term\/poll/)
    assert.ok(ICON_SPRITE.includes('id="i-stop"'))
})

test("PTY 有双后端：node-pty 装不上时回退 python", () => {
    // node-pty 是原生模块，很多机器装不出来；宿主内置一个 python pty 桥接器兜底，
    // 两条路径都给调用方一个真 tty，只是 backend 名字不同。
    const bridge = join(projectRoot, "src", "sandbox", "pty-bridge.py")
    assert.ok(existsSync(bridge))
    const source = readFileSync(bridge, "utf8")
    assert.match(source, /TIOCSWINSZ/)
    assert.match(source, /os\.openpty/)
})

test("控制台走 PTY，前端带 ANSI 屏幕模型", () => {
    // 真 tty 由宿主 api.pty 提供（node-pty 是可选依赖），插件只做会话管理；
    // 输出是带 ANSI 控制序列的字节流，没有屏幕模型就只是一堆转义字符。
    assert.match(CLIENT_SCRIPT, /function createVtScreen\b/)
    assert.match(CLIENT_SCRIPT, /\/api\/console\/open/)
    assert.match(CLIENT_SCRIPT, /\/api\/console\/poll/)
    assert.match(CLIENT_SCRIPT, /\/api\/console\/input/)
    assert.match(CLIENT_SCRIPT, /function termKeyBytes\b/)
    assert.match(CLIENT_STYLES, /\.vt-row \{/)
    assert.match(CLIENT_STYLES, /\.vt-cursor \{/)
    assert.match(CLIENT_STYLES, /--ansi-3:/)
    assert.ok(ICON_SPRITE.includes('id="i-terminal"'))
    assert.ok(ICON_SPRITE.includes('id="i-plus"'))
})

test("控制台：多会话互相独立，关一个不影响另一个", async () => {
    const state = (await (await fetch(`${base}/api/console/state`)).json()) as {
        available?: boolean
    }
    if (state.available !== true) return // 没有 node-pty / python3 的机器跳过
    const open = async (): Promise<string> => {
        const response = await fetch(`${base}/api/console/open`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd: "", cols: 80, rows: 20 }),
        })
        assert.equal(response.status, 200)
        return ((await response.json()) as { id: string }).id
    }
    const list = async (): Promise<string[]> => {
        const response = await fetch(`${base}/api/console/list`)
        assert.equal(response.status, 200)
        const data = (await response.json()) as { sessions: Array<{ id: string }> }
        return data.sessions.map((session) => session.id)
    }
    const first = await open()
    const second = await open()
    assert.deepEqual(await list(), [first, second])
    // 会话保留最近输出，页面刷新后前端重放它恢复屏幕
    await fetch(`${base}/api/console/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: first, data: "echo history-one\r" }),
    })
    let history = ""
    for (let attempt = 0; attempt < 50 && !history.includes("history-one"); attempt += 1) {
        const polled = await fetch(`${base}/api/console/poll?id=${first}`)
        history += ((await polled.json()) as { chunk: string }).chunk
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.match(history, /history-one/)
    const listed = (await (await fetch(`${base}/api/console/list`)).json()) as {
        sessions: Array<{ id: string; history: string }>
    }
    const firstEntry = listed.sessions.find((session) => session.id === first)
    assert.ok(firstEntry !== undefined)
    assert.match(firstEntry.history, /history-one/)
    const closed = await fetch(`${base}/api/console/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: first }),
    })
    assert.equal(closed.status, 200)
    // 关掉第一个后，第二个还在，并且仍能写入
    assert.deepEqual(await list(), [second])
    const input = await fetch(`${base}/api/console/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: second, data: "echo still-alive\r" }),
    })
    assert.equal(input.status, 200)
    await fetch(`${base}/api/console/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: second }),
    })
    assert.deepEqual(await list(), [])
})

test("终端：垃圾桶按钮关闭终端，清屏走命令面板", () => {
    // 工具栏垃圾桶 = 关闭当前终端（移除标签）；清屏用命令面板 / Ctrl+Shift+K
    const stopBody =
        /function stopTerminalSession\(\) \{([\s\S]*?)\n\}/.exec(CLIENT_SCRIPT)?.[1] ?? ""
    assert.ok(stopBody.length > 0)
    assert.match(stopBody, /closeTermSession\(/)
    assert.match(
        CLIENT_SCRIPT,
        /byId\("terminal-clear"\)\.addEventListener\("click", stopTerminalSession\)/,
    )
    assert.doesNotMatch(CLIENT_SCRIPT, /terminal-kill/)
    assert.match(CLIENT_SCRIPT, /id: "clear-terminal"/)
    assert.match(CLIENT_SCRIPT, /ctrlKey && event.shiftKey && event.key.toLowerCase\(\) === "k"/)
    assert.match(CLIENT_SCRIPT, /function closeTermSession\(/)
    assert.match(CLIENT_SCRIPT, /function closeTerminal\(/)
    const panelBody = /function closeTerminal\(\) \{([\s\S]*?)\n\}/.exec(CLIENT_SCRIPT)?.[1] ?? ""
    assert.ok(panelBody.length > 0)
    assert.match(panelBody, /panel\.hidden = true/)
    assert.doesNotMatch(panelBody, /closeTermSession\(/)
})

test("终端：选择复制、回看滚动条、退出重开", () => {
    // 选中只覆盖文字（行尾空白裁掉）；Ctrl+C 有选中时复制、Ctrl+V 粘贴；回看有滚动条与回底按钮
    assert.match(CLIENT_SCRIPT, /function cellVisible\(/)
    assert.match(CLIENT_SCRIPT, /function terminalSelectionText\(/)
    assert.match(CLIENT_SCRIPT, /function pasteIntoTerminal\(/)
    assert.match(CLIENT_SCRIPT, /navigator\.clipboard/)
    assert.match(CLIENT_SCRIPT, /function syncTerminalScroll\(/)
    assert.match(CLIENT_SCRIPT, /scrollToEnd/)
    assert.match(CLIENT_SCRIPT, /进程已退出/)
    assert.match(CLIENT_STYLES, /\.terminal-scrollbar/)
    assert.match(CLIENT_STYLES, /\.terminal-jump/)
    assert.match(CLIENT_STYLES, /\.terminal-body ::selection/)
})

test("终端：标签可单独关闭，页面刷新后恢复会话", () => {
    // 关闭一个标签只结束它自己的 PTY；会话存在插件服务里，刷新页面能拿回来
    assert.match(CLIENT_SCRIPT, /function closeTermSession\(/)
    assert.match(CLIENT_SCRIPT, /function restoreTermSessions\(/)
    assert.match(CLIENT_SCRIPT, /\/api\/console\/list/)
    assert.match(CLIENT_STYLES, /\.terminal-tab-close/)
    assert.match(CLIENT_STYLES, /\.terminal-empty/)
})

test("终端：宽字符占两格，块光标按真实字宽定位", () => {
    // CJK / emoji 的字宽不等于等宽格宽，光标位置必须按同字体量出来的前缀宽度算，
    // 否则含中文的提示符会把块光标画在文字中间。
    const match = CLIENT_SCRIPT.match(/function vtCharWidth\(ch\) \{[\s\S]*?\n\}/)
    assert.ok(match !== null, "找不到 vtCharWidth")
    const widthOf = new Function(match[0] + "\nreturn vtCharWidth")() as (ch: string) => number
    assert.equal(widthOf("a"), 1)
    assert.equal(widthOf("中"), 2)
    assert.equal(widthOf("😀"), 2)
    assert.equal(widthOf("Ａ"), 2)
    assert.match(CLIENT_SCRIPT, /function vtMeasure\(/)
    assert.match(CLIENT_SCRIPT, /function rowPrefixText\(/)
    assert.match(CLIENT_STYLES, /\.vt-cursor\.is-idle/)
    assert.match(CLIENT_STYLES, /@keyframes vt-cursor-blink/)
})

test("终端：顶部拖拽条可调高度并持久化", () => {
    // 面板高度由 --terminal-height 控制，拖拽条把它写回设置
    assert.match(CLIENT_STYLES, /--terminal-height/)
    assert.match(CLIENT_STYLES, /\.terminal-resizer/)
    assert.match(CLIENT_STYLES, /body\.is-resizing-terminal/)
    assert.match(CLIENT_SCRIPT, /function setTerminalHeight/)
    assert.match(CLIENT_SCRIPT, /function terminalMinHeight/)
    assert.match(CLIENT_SCRIPT, /function refitTerminal/)
    assert.match(CLIENT_SCRIPT, /terminalHeight: 240/)
    assert.match(CLIENT_SCRIPT, /TERM_MIN_HEIGHT = 96/)
})

test("图标精灵使用 Lucide，保留自有 logo", () => {
    assert.equal((ICON_SPRITE.match(/<symbol /g) ?? []).length, 38)
    assert.ok(ICON_SPRITE.includes('id="i-logo"'))
    assert.ok(ICON_SPRITE.includes('id="i-search"'))
    assert.ok(ICON_SPRITE.includes('id="i-sun"'))
    assert.ok(ICON_SPRITE.includes('id="i-moon"'))
    assert.ok(ICON_SPRITE.includes('id="i-git-branch"'))
    assert.ok(ICON_SPRITE.includes('id="i-minus"'))
})

test("客户端脚本可以编译，样式表与静态资源清单完整", () => {
    assert.doesNotThrow(() => new Function(CLIENT_SCRIPT))
    assert.ok(CLIENT_SCRIPT.length > 40_000)
    assert.ok(CLIENT_STYLES.includes("--bg-editor"))
    assert.ok(CLIENT_STYLES.includes('[data-theme="light"]'))
    assert.match(CLIENT_STYLES, /--font-size-base: 1\.2rem/)
    assert.match(CLIENT_STYLES, /--font-size-8xl: 3\.7rem/)
    assert.match(CLIENT_STYLES, /--ui-font-size, 1rem/)
    assert.ok(STATIC_ASSETS.has("/assets/app.js"))
    assert.ok(STATIC_ASSETS.has("/assets/app.css"))
    assert.ok(STATIC_ASSETS.has("/favicon.svg"))
    let depth = 0
    for (const character of CLIENT_STYLES) {
        if (character === "{") depth += 1
        if (character === "}") depth -= 1
        assert.ok(depth >= 0)
    }
    assert.equal(depth, 0)
})

test("GET /api/state 返回工作区、版本与只读状态", async () => {
    const response = await fetch(`${base}/api/state`)
    assert.equal(response.status, 200)
    const data = (await response.json()) as {
        root: string
        name: string
        workspaceId: string
        hostRoot: string
        version: string
        readOnly: boolean
        branch: string
        host: { platform: string; node: string }
    }
    assert.equal(data.root, workspace)
    assert.equal(data.name, basename(workspace))
    assert.match(data.workspaceId, /^[0-9a-f]{16}$/)
    assert.equal(data.hostRoot, workspace)
    assert.equal(data.version, "1.1.0")
    assert.equal(data.readOnly, false)
    assert.equal(data.branch, "")
    assert.ok(data.host.node.startsWith("v"))
})

test("GET /api/tree 返回目录在前且带文件类型徽标", async () => {
    const response = await fetch(`${base}/api/tree?path=`)
    assert.equal(response.status, 200)
    const data = (await response.json()) as {
        path: string
        entries: Array<{
            name: string
            path: string
            type: string
            badge: string
            tone: string
            language: string
        }>
    }
    assert.equal(data.path, "")
    const names = data.entries.map((entry) => entry.name)
    assert.deepEqual(names.slice(0, 2), ["packages", "src"])
    const packageEntry = data.entries.find((entry) => entry.name === "package.json")
    assert.ok(packageEntry !== undefined)
    assert.equal(packageEntry?.badge, "{}")
    assert.equal(packageEntry?.language, "json")
    const bad = await fetch(`${base}/api/tree?path=..%2Foutside`)
    assert.equal(bad.status, 400)
})

test("启动后向 wellspring-web 注册侧栏入口", () => {
    const entry = addonEvents.find(
        (event) => event.type === "nav-bottom" && event.meta["label"] === "代码编辑器",
    )
    assert.ok(entry !== undefined)
    assert.equal(entry.meta["id"], "wellspring-code")
    const port = /:(\d+)$/.exec(base)?.[1] ?? ""
    assert.equal(entry.meta["to"], `127.0.0.1:${port}`)
})

test("code 插件独立管理工作区，可添加任意文件夹", async () => {
    const response = await fetch(`${base}/api/workspaces`)
    assert.equal(response.status, 200)
    const data = (await response.json()) as {
        workspaces: Array<{
            id: string
            name: string
            root: string
            accessible: boolean
            active: boolean
            source: string
        }>
        active: { id: string; root: string }
        hostRoot: string
        error: string | null
    }
    assert.equal(data.error, null)
    assert.equal(data.hostRoot, workspace)
    assert.equal(data.workspaces.length, 1)
    const main = data.workspaces[0]
    assert.ok(main !== undefined)
    assert.equal(main.root, workspace)
    assert.equal(main.source, "plugin")
    assert.equal(main.active, true)

    // 添加一个工作区目录
    const added = await fetch(`${base}/api/workspaces/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: subWorkspace, name: "子工作区" }),
    })
    assert.equal(added.status, 200)
    const addedBody = (await added.json()) as {
        active: { root: string; name: string }
        workspaces: Array<{ root: string; accessible: boolean }>
    }
    assert.equal(addedBody.active.root, subWorkspace)
    assert.equal(addedBody.active.name, "子工作区")
    assert.equal(addedBody.workspaces.length, 2)

    // 任意目录都可以作为工作区，不受服务进程 cwd 限制
    const outsideRoot = join(tempRoot, "outside-root")
    await mkdir(join(outsideRoot, "notes"), { recursive: true })
    await writeFile(join(outsideRoot, "notes", "outside.txt"), "outside-data\n")
    const outside = await fetch(`${base}/api/workspaces/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: outsideRoot, name: "外部工作区" }),
    })
    assert.equal(outside.status, 200)
    const outsideBody = (await outside.json()) as {
        active: { root: string; id: string }
        workspaces: Array<{ id: string; root: string; accessible: boolean }>
    }
    assert.equal(outsideBody.active.root, outsideRoot)
    const outsideEntry = outsideBody.workspaces.find((entry) => entry.root === outsideRoot)
    assert.equal(outsideEntry?.accessible, true)
    const outsideTree = await fetch(`${base}/api/tree?path=notes`)
    assert.deepEqual(
        ((await outsideTree.json()) as { entries: Array<{ name: string }> }).entries.map(
            (entry) => entry.name,
        ),
        ["outside.txt"],
    )
    const outsideFile = await fetch(`${base}/api/file?path=notes%2Foutside.txt`)
    assert.equal(outsideFile.status, 200)
    assert.match(((await outsideFile.json()) as { content: string }).content, /outside-data/)

    // 删掉外部工作区，回到默认工作区
    const removed = await fetch(`${base}/api/workspaces/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: outsideBody.active.id }),
    })
    assert.equal(removed.status, 200)
    const catalog = (await (await fetch(`${base}/api/workspaces`)).json()) as {
        workspaces: Array<{ id: string; root: string; active: boolean }>
        active: { root: string }
    }
    assert.equal(catalog.workspaces.length, 2)
    // 删除当前工作区后回退到列表里的第一个（默认工作区）
    assert.equal(catalog.active.root, workspace)
})

test("切换工作区后所有文件接口跟随新根目录", async () => {
    const catalog = (await (await fetch(`${base}/api/workspaces`)).json()) as {
        workspaces: Array<{ id: string; root: string }>
    }
    const main = catalog.workspaces.find((entry) => entry.root === workspace)
    const sub = catalog.workspaces.find((entry) => entry.root === subWorkspace)
    assert.ok(main !== undefined)
    assert.ok(sub !== undefined)

    const switched = await fetch(`${base}/api/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: sub.id }),
    })
    assert.equal(switched.status, 200)
    const switchedBody = (await switched.json()) as { active: { id: string; root: string } }
    assert.equal(switchedBody.active.id, sub.id)
    assert.equal(switchedBody.active.root, subWorkspace)

    const state = (await (await fetch(`${base}/api/state`)).json()) as {
        root: string
        name: string
    }
    assert.equal(state.root, subWorkspace)
    assert.equal(state.name, "子工作区")

    const tree = (await (await fetch(`${base}/api/tree?path=`)).json()) as {
        entries: Array<{ name: string }>
    }
    assert.deepEqual(
        tree.entries.map((entry) => entry.name),
        ["src", "hello.md"],
    )
    const file = await fetch(`${base}/api/file?path=src%2Fnested.ts`)
    assert.equal(file.status, 200)
    assert.match(((await file.json()) as { content: string }).content, /nested/)

    const missing = await fetch(`${base}/api/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ws-missing" }),
    })
    assert.equal(missing.status, 404)

    const back = await fetch(`${base}/api/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: main.id }),
    })
    assert.equal(back.status, 200)
    const restored = (await (await fetch(`${base}/api/state`)).json()) as { root: string }
    assert.equal(restored.root, workspace)
})

test("x-workspace-id 请求头按客户端隔离当前工作区", async () => {
    const catalog = (await (await fetch(`${base}/api/workspaces`)).json()) as {
        workspaces: Array<{ id: string; root: string }>
    }
    const main = catalog.workspaces.find((entry) => entry.root === workspace)
    const sub = catalog.workspaces.find((entry) => entry.root === subWorkspace)
    assert.ok(main !== undefined)
    assert.ok(sub !== undefined)

    const switched = await fetch(`${base}/api/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: sub.id }),
    })
    assert.equal(switched.status, 200)

    const mainState = await fetch(`${base}/api/state`, {
        headers: { "x-workspace-id": main.id },
    })
    const mainBody = (await mainState.json()) as { root: string; name: string }
    assert.equal(mainBody.root, workspace)
    assert.equal(mainBody.name, basename(workspace))

    const mainTree = await fetch(`${base}/api/tree?path=`, {
        headers: { "x-workspace-id": main.id },
    })
    const mainNames = ((await mainTree.json()) as { entries: Array<{ name: string }> }).entries.map(
        (entry) => entry.name,
    )
    assert.ok(mainNames.includes("package.json"))

    // 不带请求头时回退到服务端当前工作区（刚才切到子工作区）
    const fallback = (await (await fetch(`${base}/api/state`)).json()) as { root: string }
    assert.equal(fallback.root, subWorkspace)

    const missing = await fetch(`${base}/api/state`, {
        headers: { "x-workspace-id": "ws-missing" },
    })
    assert.equal(missing.status, 404)

    const restore = await fetch(`${base}/api/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: main.id }),
    })
    assert.equal(restore.status, 200)
})

test("GET /api/symbols 返回工作区符号索引", async () => {
    const response = await fetch(`${base}/api/symbols?q=hello`)
    assert.equal(response.status, 200)
    const data = (await response.json()) as {
        query: string
        symbols: Array<{ path: string; name: string; kind: string; line: number }>
        total: number
        truncated: boolean
        scanned: number
    }
    assert.equal(data.query, "hello")
    assert.ok(data.scanned > 0)
    assert.equal(data.truncated, false)
    const hello = data.symbols.find((symbol) => symbol.path === "src/main.ts")
    assert.ok(hello !== undefined)
    assert.equal(hello?.name, "hello")
    assert.equal(hello?.line, 1)

    // 查询不区分大小写，Markdown 标题也能搜到
    const heading = (await (await fetch(`${base}/api/symbols?q=wellspring`)).json()) as {
        symbols: Array<{ path: string; name: string; kind: string }>
    }
    assert.ok(
        heading.symbols.some(
            (symbol) =>
                symbol.path === "README.md" &&
                symbol.name === "Wellspring" &&
                symbol.kind === "heading",
        ),
    )

    // 空查询返回前若干个符号，limit 生效
    const all = (await (await fetch(`${base}/api/symbols?limit=1`)).json()) as {
        symbols: unknown[]
        total: number
    }
    assert.equal(all.symbols.length, 1)
    assert.ok(all.total >= 2)

    const none = (await (await fetch(`${base}/api/symbols?q=zzz-not-found`)).json()) as {
        symbols: unknown[]
        total: number
    }
    assert.deepEqual(none.symbols, [])
    assert.equal(none.total, 0)
})

test("GET /api/git/status 与 /api/git/diff 只读接口", async () => {
    const status = await fetch(`${base}/api/git/status`)
    assert.equal(status.status, 200)
    const data = (await status.json()) as {
        available: boolean
        repo: boolean
        branch: string
        changes: unknown[]
        error: string
    }
    // 临时工作区不在 git 仓库里；git 不可用时 available=false，否则 repo=false
    assert.equal(data.repo, false)
    assert.deepEqual(data.changes, [])
    assert.equal(typeof data.error, "string")
    assert.ok(data.available === true || data.available === false)
    if (data.available === false) {
        assert.match(data.error, /git/i)
    }

    const missing = await fetch(`${base}/api/git/diff`)
    assert.equal(missing.status, 400)
    const diff = await fetch(`${base}/api/git/diff?path=src%2Fmain.ts`)
    assert.equal(diff.status, 200)
    const diffBody = (await diff.json()) as { repo: boolean; content: string; error: string }
    assert.equal(diffBody.repo, false)
    assert.equal(diffBody.content, "")
})

test("POST /api/git/stage|unstage 的校验与错误处理", async () => {
    const post = async (path: string, body: unknown) =>
        await fetch(`${base}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        })

    assert.equal((await post("/api/git/stage", {})).status, 400)
    assert.equal((await post("/api/git/stage", { paths: [] })).status, 400)
    assert.equal((await post("/api/git/stage", { paths: [1] })).status, 400)
    assert.equal((await post("/api/git/stage", { paths: ["/etc/passwd"] })).status, 400)
    assert.equal((await post("/api/git/stage", { paths: ["../outside"] })).status, 400)
    assert.equal((await post("/api/git/unstage", { paths: ["src/main.ts"] })).status, 200)

    // 临时工作区不是 git 仓库：接口正常返回 ok:false
    const response = await post("/api/git/stage", { paths: ["src/main.ts"] })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { repo: boolean; ok: boolean; error: string }
    assert.equal(body.repo, false)
    assert.equal(body.ok, false)
    assert.equal(typeof body.error, "string")
})

test("GET /api/file 读取文本与二进制、拒绝超大文件与路径穿越", async () => {
    const text = await fetch(`${base}/api/file?path=src%2Fmain.ts`)
    assert.equal(text.status, 200)
    const file = (await text.json()) as {
        binary: boolean
        content: string
        mtimeMs: number
        kind: { language: string; label: string }
        eol: string
    }
    assert.equal(file.binary, false)
    assert.match(file.content, /hello/)
    assert.equal(file.kind.language, "typescript")
    assert.ok(file.mtimeMs > 0)

    const binary = await fetch(`${base}/api/file?path=logo.png`)
    const binaryBody = (await binary.json()) as { binary: boolean; kind: { media: string } }
    assert.equal(binaryBody.binary, true)
    assert.equal(binaryBody.kind.media, "image")

    const raw = await fetch(`${base}/api/raw?path=logo.png`)
    assert.equal(raw.status, 200)
    assert.equal(raw.headers.get("content-type"), "image/png")
    assert.equal(Buffer.from(await raw.arrayBuffer()).toString("hex"), "89504e470d0a")

    const huge = await fetch(`${base}/api/file?path=huge.txt`)
    assert.equal(huge.status, 413)

    const missing = await fetch(`${base}/api/file?path=missing.txt`)
    assert.equal(missing.status, 404)

    const traversal = await fetch(`${base}/api/file?path=..%2Foutside.txt`)
    assert.equal(traversal.status, 400)
    const absolute = await fetch(`${base}/api/file?path=%2Fetc%2Fpasswd`)
    assert.equal(absolute.status, 400)
})

test("写接口：创建、保存、mtime 冲突、重命名与删除", async () => {
    const created = await fetch(`${base}/api/file`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "notes.txt", type: "file" }),
    })
    assert.equal(created.status, 201)

    const read = await fetch(`${base}/api/file?path=notes.txt`)
    const readBody = (await read.json()) as { mtimeMs: number; content: string }
    assert.equal(readBody.content, "")

    const saved = await fetch(`${base}/api/file`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            path: "notes.txt",
            content: "第一行\n第二行\n",
            baseMtimeMs: readBody.mtimeMs,
        }),
    })
    assert.equal(saved.status, 200)
    const savedBody = (await saved.json()) as { mtimeMs: number }
    assert.ok(savedBody.mtimeMs >= readBody.mtimeMs)

    const conflict = await fetch(`${base}/api/file`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            path: "notes.txt",
            content: "冲突内容",
            baseMtimeMs: readBody.mtimeMs,
        }),
    })
    assert.equal(conflict.status, 409)

    const overwrite = await fetch(`${base}/api/file`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "notes.txt", content: "覆盖后的内容\n" }),
    })
    assert.equal(overwrite.status, 200)

    const directory = await fetch(`${base}/api/file`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "docs", type: "directory" }),
    })
    assert.equal(directory.status, 201)

    const renamed = await fetch(`${base}/api/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "notes.txt", to: "docs/notes.txt" }),
    })
    assert.equal(renamed.status, 200)
    const afterRename = await fetch(`${base}/api/file?path=docs%2Fnotes.txt`)
    assert.equal(afterRename.status, 200)

    const deleted = await fetch(`${base}/api/file?path=docs%2Fnotes.txt`, { method: "DELETE" })
    assert.equal(deleted.status, 200)
    const gone = await fetch(`${base}/api/file?path=docs%2Fnotes.txt`)
    assert.equal(gone.status, 404)

    const rootDelete = await fetch(`${base}/api/file?path=`, { method: "DELETE" })
    assert.equal(rootDelete.status, 400)

    const noType = await fetch(`${base}/api/file`, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "x",
    })
    assert.equal(noType.status, 415)

    const traversal = await fetch(`${base}/api/file`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "../escape.txt", type: "file" }),
    })
    assert.equal(traversal.status, 400)
})

test("搜索接口：全文检索、正则、区分大小写与快速打开", async () => {
    const text = await fetch(`${base}/api/search/text?q=hello`)
    assert.equal(text.status, 200)
    const result = (await text.json()) as {
        matchCount: number
        files: Array<{
            path: string
            badge: string
            tone: string
            matches: Array<{ line: number }>
        }>
    }
    assert.ok(result.matchCount >= 1)
    const mainFile = result.files.find((file) => file.path === "src/main.ts")
    assert.ok(mainFile !== undefined)
    assert.equal(mainFile?.badge, "TS")
    assert.equal(mainFile?.tone, "ts")

    const regex = await fetch(`${base}/api/search/text?q=hel%2B&regex=1`)
    assert.equal(regex.status, 200)
    const invalidRegex = await fetch(`${base}/api/search/text?q=%28&regex=1`)
    assert.equal(invalidRegex.status, 400)

    const quick = await fetch(`${base}/api/search/files?q=main`)
    assert.equal(quick.status, 200)
    const quickBody = (await quick.json()) as {
        entries: Array<{ path: string; name: string; badge: string; tone: string }>
    }
    const mainEntry = quickBody.entries.find((entry) => entry.path === "src/main.ts")
    assert.ok(mainEntry !== undefined)
    assert.equal(mainEntry?.badge, "TS")
    assert.equal(mainEntry?.tone, "ts")

    const stat = await fetch(`${base}/api/stat?path=src%2Fmain.ts&path=missing.txt`)
    const statBody = (await stat.json()) as { entries: Array<{ exists: boolean }> }
    assert.equal(statBody.entries[0]?.exists, true)
    assert.equal(statBody.entries[1]?.exists, false)

    const host = await fetch(`${base}/api/host`)
    assert.equal(host.status, 200)
})

test("监听配置：非回环地址需要密码或 allowRemote，TLS 可选", () => {
    const fallback = resolveListenConfig({
        host: "0.0.0.0",
        port: 9000,
        allowRemote: false,
        authConfigured: false,
    })
    assert.equal(fallback.host, "127.0.0.1")
    assert.ok(fallback.warnings.some((warning) => warning.includes("拒绝在非回环地址启动")))

    // 设置密码后直接监听 0.0.0.0，不再需要 allowRemote
    const withAuth = resolveListenConfig({ host: "0.0.0.0", port: 9000, authConfigured: true })
    assert.equal(withAuth.host, "0.0.0.0")
    assert.equal(withAuth.port, 9000)
    assert.equal(withAuth.tls, null)
    assert.deepEqual(withAuth.warnings, [])

    // 只设 allowRemote 也能绑，但没密码时远程请求会被拒绝
    const legacy = resolveListenConfig({
        host: "0.0.0.0",
        port: 0,
        allowRemote: true,
        authConfigured: false,
    })
    assert.equal(legacy.host, "0.0.0.0")
    assert.ok(legacy.warnings.some((warning) => warning.includes("还没有设置访问密码")))

    const tls = resolveListenConfig({
        host: "127.0.0.1",
        tls: { cert: "CERT", key: "KEY" },
        authConfigured: true,
    })
    assert.deepEqual(tls.tls, { cert: "CERT", key: "KEY" })
    const brokenTls = resolveListenConfig({
        tls: { cert: "CERT" },
        authConfigured: false,
    })
    assert.equal(brokenTls.tls, null)
    assert.ok(brokenTls.warnings.some((warning) => warning.includes("tls 配置不完整")))

    assert.equal(isLoopbackAddress("127.0.0.1"), true)
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true)
    assert.equal(isLoopbackAddress("::1"), true)
    assert.equal(isLoopbackAddress("192.168.1.5"), false)
    assert.equal(isLoopbackAddress(undefined), false)
})

test("登录页与远程未启用提示按状态渲染", () => {
    assert.match(renderHome(), /data-auth-state="none"/)
    assert.doesNotMatch(renderHome(), /id="auth-form"/)
    assert.doesNotMatch(renderHome(), /<div class="workbench" id="workbench" hidden>/)
    const login = renderHome({ state: "login", configured: true })
    assert.match(login, /data-auth-state="login"/)
    assert.match(login, /data-auth-configured="true"/)
    assert.match(login, /id="auth-form"/)
    assert.match(login, /<div class="workbench" id="workbench" hidden>/)
    const blocked = renderHome({ state: "blocked", configured: false })
    assert.match(blocked, /data-auth-state="blocked"/)
    assert.match(blocked, /远程访问未启用/)
    assert.match(blocked, /id="auth-form" hidden/)
    assert.match(blocked, /<div class="workbench" id="workbench" hidden>/)
    assert.match(CLIENT_SCRIPT, /function bindAuth\(/)
    assert.match(CLIENT_SCRIPT, /function bindPasswordSettings\(/)
    assert.match(CLIENT_SCRIPT, /\/api\/auth\/login/)
    assert.match(CLIENT_STYLES, /\.auth-card \{/)
    // 移动端适配：侧栏抽屉错位、编辑器触摸滚动、控制台软键盘
    assert.match(CLIENT_STYLES, /--activity-width/)
    assert.match(
        CLIENT_STYLES,
        /\.sidebar\.is-hidden,\s*\n\s*\.workbench\.sidebar-hidden \.sidebar \{/,
    )
    assert.match(CLIENT_STYLES, /\.workbench \{[^}]*height: var\(--app-height/)
    assert.match(CLIENT_STYLES, /\.terminal-capture \{/)
    assert.match(CLIENT_STYLES, /\.code-input \{[^}]*touch-action: pan-x pan-y/)
    assert.match(CLIENT_SCRIPT, /function syncAppHeight\(/)
    assert.match(CLIENT_SCRIPT, /function collapseSidebarOnMobile\(/)
    assert.match(CLIENT_SCRIPT, /function focusConsole\(/)
    assert.match(CLIENT_SCRIPT, /byId\("terminal-capture"\)/)
    assert.match(CLIENT_SCRIPT, /addEventListener\("beforeinput"/)
    assert.match(CLIENT_STYLES, /\.settings-group \{/)
})

test("访问密码：设置后所有 API 要求登录，登录/改密/退出生效", async () => {
    const state = (await (await fetch(`${base}/api/auth/state`)).json()) as {
        configured: boolean
        authenticated: boolean
        loopback: boolean
        tls: boolean
    }
    assert.deepEqual(
        {
            configured: state.configured,
            authenticated: state.authenticated,
            loopback: state.loopback,
        },
        { configured: false, authenticated: false, loopback: true },
    )
    assert.equal(state.tls, false)
    // 未设密码时本机直接可用
    assert.equal((await fetch(`${base}/api/tree`)).status, 200)

    // 首次设置密码：本机允许，成功后自动发会话 cookie
    const setup = await fetch(`${base}/api/auth/password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: "wellspring-123" }),
    })
    assert.equal(setup.status, 200)
    const setupCookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    assert.match(setupCookie, /^wellspring_code_session=/)
    assert.match(setup.headers.get("set-cookie") ?? "", /HttpOnly/)
    assert.match(setup.headers.get("set-cookie") ?? "", /SameSite=Lax/)

    // 密码太短被拒绝
    const short = await fetch(`${base}/api/auth/password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: "123" }),
    })
    assert.equal(short.status, 400)

    // 设置后未登录一律 401
    assert.equal((await fetch(`${base}/api/tree`)).status, 401)
    assert.equal((await fetch(`${base}/api/state`)).status, 401)
    // 页面渲染登录态
    const loginHtml = await (await fetch(`${base}/`)).text()
    assert.match(loginHtml, /data-auth-state="login"/)
    assert.match(loginHtml, /id="auth-form"/)
    // 带 cookie 恢复访问
    assert.equal(
        (await fetch(`${base}/api/tree`, { headers: { cookie: setupCookie } })).status,
        200,
    )

    // 错误密码
    const wrong = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "nope" }),
    })
    assert.equal(wrong.status, 401)
    // 正确密码登录
    const login = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wellspring-123" }),
    })
    assert.equal(login.status, 200)
    const loginCookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    assert.match(loginCookie, /^wellspring_code_session=/)

    // 改密码：需要登录且当前密码正确
    const deniedChange = await fetch(`${base}/api/auth/password`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: loginCookie },
        body: JSON.stringify({ currentPassword: "bad", newPassword: "wellspring-456" }),
    })
    assert.equal(deniedChange.status, 403)
    const changed = await fetch(`${base}/api/auth/password`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: loginCookie },
        body: JSON.stringify({ currentPassword: "wellspring-123", newPassword: "wellspring-456" }),
    })
    assert.equal(changed.status, 200)
    const changedCookie = (changed.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    // 旧会话全部失效，新 cookie 可继续用
    assert.equal(
        (await fetch(`${base}/api/tree`, { headers: { cookie: loginCookie } })).status,
        401,
    )
    assert.equal(
        (await fetch(`${base}/api/tree`, { headers: { cookie: changedCookie } })).status,
        200,
    )
    // 新密码可登录
    const relogin = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wellspring-456" }),
    })
    assert.equal(relogin.status, 200)

    // 退出登录后旧 cookie 失效
    const logout = await fetch(`${base}/api/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: changedCookie },
        body: "{}",
    })
    assert.equal(logout.status, 200)
    assert.equal(
        (await fetch(`${base}/api/tree`, { headers: { cookie: changedCookie } })).status,
        401,
    )
})

test("访问密码：哈希落盘、会话 cookie 与登录限流", async () => {
    const files = new Map<string, string>()
    const fs = {
        readJson: async (path: string) => {
            const text = files.get(path)
            return text === undefined ? null : (JSON.parse(text) as unknown)
        },
        writeJson: async (path: string, value: unknown) => {
            files.set(path, JSON.stringify(value))
        },
    } as unknown as HostFileApi

    const store = new CodeAuthStore(fs)
    await store.load()
    assert.equal(store.configured, false)
    await store.setPassword("wellspring-123")
    assert.equal(store.configured, true)
    assert.match(files.get("auth.json") ?? "", /"salt"/)
    assert.doesNotMatch(files.get("auth.json") ?? "", /wellspring-123/, "落盘的是哈希不是明文")
    assert.equal(store.verifyPassword("wellspring-123"), true)
    assert.equal(store.verifyPassword("bad"), false)

    const session = store.createSession()
    const cookie = store.cookie(session)
    assert.match(cookie, /^wellspring_code_session=/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.doesNotMatch(cookie, /; Secure/)
    store.setSecure(true)
    assert.match(store.cookie(session), /; Secure/)

    const request = { headers: { cookie: cookie.split(";")[0] ?? "" } }
    assert.equal(store.authenticated(request), true)
    store.clearSessions()
    assert.equal(store.authenticated(request), false)

    const reloaded = new CodeAuthStore(fs)
    await reloaded.load()
    assert.equal(reloaded.verifyPassword("wellspring-123"), true)

    const throttle = new LoginThrottle()
    assert.equal(throttle.status("192.0.2.10").blocked, false)
    for (let index = 0; index < 5; index += 1) {
        throttle.recordFailure("192.0.2.10")
    }
    assert.equal(throttle.status("192.0.2.10").blocked, true)
    assert.ok(throttle.status("192.0.2.10").retryAfter > 0)
    assert.equal(throttle.status("192.0.2.11").blocked, false)
    throttle.reset("192.0.2.10")
    assert.equal(throttle.status("192.0.2.10").blocked, true, "锁定期内 reset 不清除锁定")
})
