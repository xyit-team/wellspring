import assert from "node:assert/strict"
import { test } from "node:test"

import { createMarkdownStream, renderMarkdown } from "../src/display/markdown.ts"

test("renderMarkdown 输出 TTY 文本", () => {
    const output = renderMarkdown("# 标题\n\n这是 **粗体** 和 `code`\n\n- 一\n- 二\n")
    assert.match(output, /标题/)
    assert.match(output, /粗体/)
    assert.ok(!output.includes("**粗体**"))
    assert.ok(!output.includes("# 标题"))
})

test("预处理图片、任务列表与 details", () => {
    const output = renderMarkdown(
        "- [x] 已完成\n- [ ] 未完成\n\n![截图](https://example.com/a.png)\n\n<details><summary>更多</summary>\n\n内容\n\n</details>\n",
    )
    assert.match(output, /☑ 已完成/)
    assert.match(output, /☐ 未完成/)
    assert.match(output, /图片：截图（https:\/\/example\.com\/a\.png）/)
    assert.match(output, /▶ 更多/)
    assert.match(output, /内容/)
})

test("单行代码块也画框", () => {
    const output = renderMarkdown("```bash\necho hi\n```\n")
    assert.match(output, /\[bash\]/)
    assert.match(output, /┌/)
    assert.match(output, /echo hi/)
})

test("createMarkdownStream 增量输出", () => {
    const stream = createMarkdownStream()
    const first = stream.push("# 标")
    const second = stream.push("题\n\n内容\n")
    const tail = stream.finish()
    const output = `${first}${second}${tail}`
    assert.match(output, /标题/)
    assert.match(output, /内容/)
})
