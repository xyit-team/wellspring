import assert from "node:assert/strict"
import { test } from "node:test"

import { MARKDOWN_JS } from "../plugins/wellspring-web/src/assets/markdown.ts"
import { createMarkdownRenderer } from "./helpers/mini-dom.ts"

const render = createMarkdownRenderer(MARKDOWN_JS)

test("markdown：标题、段落、行内样式与链接", () => {
    const html = render("# 标题\n\n段落 **加粗** _斜体_ `code` [文档](https://example.com/docs)")
    assert.match(html, /<h2>标题<\/h2>/)
    assert.match(html, /<strong>加粗<\/strong>/)
    assert.match(html, /<em>斜体<\/em>/)
    assert.match(html, /<code>code<\/code>/)
    assert.match(html, /href="https:\/\/example\.com\/docs"/)
    assert.match(html, /rel="noopener noreferrer"/)
    assert.match(html, /target="_blank"/)
})

test("markdown：列表、任务列表、引用、表格与代码块", () => {
    assert.match(render("- 一\n- 二"), /<ul><li>一<\/li><li>二<\/li><\/ul>/)
    assert.match(render("1. 一\n2. 二"), /<ol><li>一<\/li><li>二<\/li><\/ol>/)
    assert.match(render("- 一\n  - 一·一"), /<ul><li>一<ul><li>一·一<\/li><\/ul><\/li><\/ul>/)
    const tasks = render("- [x] 完成\n- [ ] 未完成")
    assert.match(tasks, /checked=""/)
    assert.match(tasks, /disabled=""/)
    assert.match(render("> 引用"), /<blockquote><p>引用<\/p><\/blockquote>/)
    const table = render("| 名称 | 值 |\n|---|---|\n| a | 1 |")
    assert.match(table, /<table><thead><tr><th>名称<\/th><th>值<\/th><\/tr><\/thead>/)
    assert.match(table, /<tbody><tr><td>a<\/td><td>1<\/td><\/tr><\/tbody>/)
    const code = render("```js\nconst a = 1 < 2\n```")
    assert.match(code, /class="code-block"/)
    assert.match(code, /<span>js<\/span>/)
    assert.match(code, /const a = 1 &lt; 2/)
})

test("markdown：不产生 HTML 注入", () => {
    const html = render("<script>alert(1)</script><img src=x onerror=alert(1)>")
    assert.ok(!html.includes("<script"), html)
    assert.ok(!html.includes("<img"), html)
    assert.match(html, /&lt;script&gt;/)
})

test("markdown：链接协议白名单", () => {
    const javascript = render("[点我](javascript:alert(1))")
    assert.ok(!javascript.includes("<a"), javascript)
    assert.match(javascript, /点我/)
    const data = render("[x](data:text/html;base64,PHNjcmlwdD4=)")
    assert.ok(!data.includes("<a"), data)
    const https = render("见 https://example.com/path?a=1 。")
    assert.match(https, /<a href="https:\/\/example\.com\/path\?a=1"/)
})

test("markdown：链接文本里的 URL 不产生嵌套锚点", () => {
    const html = render("[https://a.example](https://b.example)")
    assert.equal((html.match(/<a /g) ?? []).length, 1, html)
})

test("markdown：病态输入不抛栈溢出、不退化", () => {
    const started = Date.now()
    assert.doesNotThrow(() => render(`${">".repeat(6000)} x`))
    assert.doesNotThrow(() => render(`${"__".repeat(8000)}x${"__".repeat(8000)}`))
    const deepList = Array.from({ length: 2000 }, (_, index) => `${"  ".repeat(index)}- x`).join(
        "\n",
    )
    assert.doesNotThrow(() => render(deepList))
    assert.doesNotThrow(() => render("[".repeat(50_000)))
    assert.ok(Date.now() - started < 3000, `病态输入渲染耗时 ${Date.now() - started}ms`)
})

test("markdown：未闭合代码围栏吞掉剩余内容", () => {
    const html = render("```js\nconst a = 1\n没有结束围栏")
    assert.match(html, /class="code-block"/)
    assert.match(html, /没有结束围栏/)
})
