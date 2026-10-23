import assert from "node:assert/strict"
import { test } from "node:test"

import {
    FrameDecoder,
    MAX_FRAME_BYTES,
    SandboxProtocolError,
    encodeMessage,
    nextRequestId,
    type RpcMessage,
} from "../src/sandbox/protocol.ts"

test("帧编码/解码支持任意切分与多帧", () => {
    const messages: RpcMessage[] = [
        { v: 1, type: "request", id: "1", method: "plugin.command", params: { name: "hello" } },
        { v: 1, type: "response", id: "1", ok: true, result: { exitCode: 0 } },
        { v: 1, type: "event", method: "exec.stdout", params: { seq: 1 } },
    ]
    const encoded = Buffer.concat(messages.map(encodeMessage))

    const decoder = new FrameDecoder()
    const decoded: RpcMessage[] = []
    for (const byte of encoded) {
        decoded.push(...decoder.push(Buffer.from([byte])))
    }
    assert.deepEqual(decoded, messages)
    assert.equal(decoder.bufferedBytes, 0)
})

test("拒绝非法帧与超大帧", () => {
    const decoder = new FrameDecoder()
    const badJson = Buffer.alloc(4 + 3)
    badJson.writeUInt32BE(3, 0)
    badJson.write("x", 4)
    assert.throws(() => decoder.push(badJson), SandboxProtocolError)

    const oversized = Buffer.alloc(4)
    oversized.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    assert.throws(() => decoder.push(oversized), SandboxProtocolError)

    const wrongVersion = Buffer.from(
        JSON.stringify({ v: 2, type: "event", method: "x", params: {} }),
    )
    const frame = Buffer.alloc(4 + wrongVersion.length)
    frame.writeUInt32BE(wrongVersion.length, 0)
    wrongVersion.copy(frame, 4)
    assert.throws(() => new FrameDecoder().push(frame), /协议版本/)
})

test("request id 单调递增", () => {
    const first = nextRequestId("test")
    const second = nextRequestId("test")
    assert.notEqual(first, second)
    assert.match(first, /^test-/)
})
