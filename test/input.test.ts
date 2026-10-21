import assert from "node:assert/strict"
import { test } from "node:test"

import { formatGlobalHelp } from "../src/input/help.ts"
import { parseCommandArgs } from "../src/input/parse-options.ts"
import { parseGlobal } from "../src/input/parse.ts"

test("parseGlobal 在命令处停止解析", () => {
    const result = parseGlobal(["--json", "chat", "--session-id", "x", "hi"])
    assert.equal(result.isSuccess(), true)
    const data = result.getData()
    assert.equal(data?.options.json, true)
    assert.equal(data?.command, "chat")
    assert.deepEqual(data?.commandArgv, ["--session-id", "x", "hi"])
})

test("parseGlobal 支持日志级别与配置覆盖", () => {
    const data = parseGlobal([
        "-l",
        "debug",
        "-c",
        "/tmp/settings.json",
        "config",
        "show",
    ]).getData()
    assert.equal(data?.options.logLevel, "debug")
    assert.equal(data?.options.config, "/tmp/settings.json")
    assert.equal(data?.command, "config")
})

test("parseGlobal 没有命令", () => {
    const data = parseGlobal(["-q"]).getData()
    assert.equal(data?.command, null)
    assert.equal(data?.options.quiet, true)
})

test("parseGlobal 非法级别与未知参数", () => {
    assert.equal(parseGlobal(["-l", "verbose"]).getCode(), "usage.invalid-value:--log-level")
    assert.match(parseGlobal(["--nope"]).getCode() ?? "", /^usage\.unknown-option/)
})

test("命令级参数解析错误映射", () => {
    const result = parseCommandArgs(["--nope"], {})
    assert.match(result.getCode() ?? "", /^usage\.unknown-option/)
})

test("帮助文本包含内置命令与全局参数", () => {
    const text = formatGlobalHelp([])
    assert.match(text, /chat/)
    assert.match(text, /run/)
    assert.match(text, /--json/)
})
