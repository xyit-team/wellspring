import assert from "node:assert/strict"
import { test } from "node:test"

import { Elog, type ElogStream } from "../src/logger/elog4js.ts"

class Capture implements ElogStream {
    text = ""
    write(text: string): void {
        this.text += text
    }
}

function create(json = false): { elog: Elog; out: Capture; err: Capture } {
    const out = new Capture()
    const err = new Capture()
    return { elog: new Elog({ stdout: out, stderr: err, color: false, json }), out, err }
}

test("info / warn / error 带级别标签", () => {
    const { elog, out, err } = create()
    elog.info("hello")
    elog.warn("careful")
    elog.error("boom")
    assert.equal(out.text, "[INFO ] hello\n")
    assert.equal(err.text, "[WARN ] careful\n[ERROR] boom\n")
})

test("插件输出带插件名与标签", () => {
    const { elog, out, err } = create()
    elog.plugin("info", "wellspring-web", "started")
    elog.plugin("error", "wellspring-web", "failed")
    assert.equal(out.text, "[INFO ] [wellspring-web] started\n")
    assert.equal(err.text, "[ERROR] [wellspring-web] failed\n")
})

test("stream 与 line 不额外加标签", () => {
    const { elog, out } = create()
    elog.stream("Event")
    elog.stream("Bus")
    elog.line()
    assert.equal(out.text, "EventBus\n")
})

test("标签着色，stderr 也着色", () => {
    const out = new Capture()
    const err = new Capture()
    const elog = new Elog({ stdout: out, stderr: err, color: true, json: false })
    elog.info("ok")
    elog.error("boom")
    assert.match(out.text, /\x1b\[32m\[INFO \]\x1b\[0m ok/)
    assert.match(err.text, /\x1b\[31m\[ERROR\]\x1b\[0m boom/)
})

test("--json 模式静默", () => {
    const { elog, out, err } = create(true)
    elog.info("hello")
    elog.warn("careful")
    elog.plugin("info", "p", "x")
    elog.stream("data")
    elog.line()
    elog.notice("session: 1")
    elog.print("text")
    assert.equal(out.text, "")
    assert.equal(err.text, "")
})
