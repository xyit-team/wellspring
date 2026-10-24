import assert from "node:assert/strict"
import { test } from "node:test"

import { toolArgs, toolLabel, toolSummary } from "../src/display/tool-label.ts"

test("工具中文名：与网页工具行一致", () => {
    assert.equal(toolLabel("execute_code"), "执行命令")
    assert.equal(toolLabel("read"), "读取文件")
    assert.equal(toolLabel("delete_file"), "删除文件")
    assert.equal(toolLabel("web_search"), "搜索网页")
    assert.equal(toolLabel("web_fetch"), "抓取网页")
    assert.equal(toolLabel("query_task"), "查询任务")
    assert.equal(toolLabel("stop_task"), "停止任务")
    assert.equal(toolLabel("ask"), "询问用户")
    assert.equal(toolLabel("skill_install"), "安装技能")
    assert.equal(toolLabel("unknown_tool"), "unknown_tool")
})

test("工具摘要：执行命令拼接 command 与 argv", () => {
    assert.equal(
        toolSummary("execute_code", { command: "node", argv: ["-e", "console.log(1)"] }),
        "node -e console.log(1)",
    )
    assert.equal(toolSummary("execute_code", { command: "node", argv: "['-e','1']" }), "node")
    assert.equal(toolSummary("read", { file_path: "src/main.ts" }), "src/main.ts")
    assert.equal(toolSummary("delete_file", { path: ".tmp/a.txt" }), ".tmp/a.txt")
    assert.equal(toolSummary("web_search", { query: "DeepSeek V4" }), "DeepSeek V4")
    assert.equal(toolSummary("web_fetch", { url: "https://example.com" }), "https://example.com")
    assert.equal(toolSummary("ask", { question: "用哪个分支？" }), "用哪个分支？")
    assert.equal(toolSummary("skill_modify", { name: "demo", description: "x" }), "demo")
    assert.equal(toolSummary("stop_task", { task_id: "t1", type: "ctrl_c" }), "t1 ctrl_c")
})

test("工具摘要：未知工具取第一个字符串参数，超长截断", () => {
    assert.equal(toolSummary("custom", { meta: 1, path: "a/b" }), "a/b")
    const long = "x".repeat(200)
    const summary = toolSummary("read", { file_path: long })
    assert.equal(summary.length, 161)
    assert.match(summary, /…$/)
})

test("工具参数：JSON 解析失败视为空对象", () => {
    assert.deepEqual(toolArgs('{"file_path":"a.txt"}'), { file_path: "a.txt" })
    assert.deepEqual(toolArgs("not json"), {})
    assert.deepEqual(toolArgs("[]"), {})
})
