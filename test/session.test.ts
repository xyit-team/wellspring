import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { decodeEvents, encodeEvents } from "../src/session/compress.ts"
import { toChatMessages } from "../src/session/replay.ts"
import {
    SessionStore,
    isValidSessionId,
    newSessionId,
    sessionBucket,
} from "../src/session/store.ts"
import type { SessionEvent } from "../src/session/types.ts"

let root = ""
let cwdA = ""
let cwdB = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-session-"))
    cwdA = await mkdtemp(join(tmpdir(), "wellspring-cwd-a-"))
    cwdB = await mkdtemp(join(tmpdir(), "wellspring-cwd-b-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(cwdA, { recursive: true, force: true })
    await rm(cwdB, { recursive: true, force: true })
})

function event(type: string, seq: number, data: Record<string, unknown>): SessionEvent {
    return { type, seq, time: 1792510000000 + seq, data }
}

function turnEvents(turn: number, input: string, reply: string): SessionEvent[] {
    return [
        event("turn/start", 0, { turn, mode: "chat" }),
        event("user/message", 1, {
            message: { role: "user", content: [{ type: "text", text: input }] },
        }),
        event("assistant/message", 2, {
            turn,
            step: 1,
            message: { role: "assistant", content: [{ type: "text", text: reply }] },
            usage: { inputTokens: 1, outputTokens: 2 },
        }),
        event("turn/end", 3, { turn, reason: { kind: "completed" } }),
    ]
}

test("encode/decode 会话段", () => {
    const events = turnEvents(1, "hi", "hello")
    const data = encodeEvents(events)
    assert.equal(data.subarray(0, 4).toString("hex"), "28b52ffd")
    assert.deepEqual(decodeEvents(data), events)
})

test("cwd 桶命名可读且稳定", () => {
    const bucket = sessionBucket(cwdA)
    assert.match(bucket, /^[A-Za-z0-9._-]+-[0-9a-f]{8}$/)
    assert.equal(sessionBucket(cwdA), bucket)
    assert.notEqual(sessionBucket(cwdB), bucket)
})

test("会话 id 生成与校验", () => {
    const id = newSessionId(new Date(2026, 9, 21, 17, 30, 0))
    assert.match(id, /^20261021-173000-[0-9a-f]{4}$/)
    assert.equal(isValidSessionId(id), true)
    assert.equal(isValidSessionId("../etc"), false)
})

test("创建、追加、读取、列表与删除", async () => {
    const store = new SessionStore(root)
    const session = await store.create({
        cwd: cwdA,
        model: "test-model",
        id: "20261021-120000-ab12",
    })
    assert.equal(session.meta.id, "20261021-120000-ab12")

    await store.appendTurn(session, turnEvents(1, "hi", "hello"))

    const opened = await store.open("20261021-120000-ab12", cwdA)
    assert.equal(opened.events.length, 4)
    assert.equal(opened.turns.length, 1)
    assert.deepEqual(toChatMessages(opened.events), [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
    ])
    assert.equal(await store.lastId(cwdA), "20261021-120000-ab12")

    const list = await store.list({ cwd: cwdA })
    assert.equal(list.length, 1)
    assert.equal(list[0]?.turns, 1)
    assert.equal(list[0]?.last, true)

    const reopened = await store.openLastOrCreate(cwdA, "test-model")
    assert.equal(reopened.meta.id, "20261021-120000-ab12")

    await store.remove("20261021-120000-ab12")
    await assert.rejects(store.open("20261021-120000-ab12"), /会话不存在/)
    assert.equal(await store.lastId(cwdA), null)
})

test("cwd 之间互相隔离", async () => {
    const store = new SessionStore(root)
    const a = await store.create({ cwd: cwdA, model: "m", id: "a-session" })
    const b = await store.create({ cwd: cwdB, model: "m", id: "b-session" })
    await store.appendTurn(a, turnEvents(1, "a", "a"))
    await store.appendTurn(b, turnEvents(1, "b", "b"))

    const listA = await store.list({ cwd: cwdA })
    assert.equal(listA.length, 1)
    assert.equal(listA[0]?.id, "a-session")

    const all = await store.list({ cwd: cwdA, all: true })
    assert.equal(all.length, 2)

    await store.removeAll(cwdB)
    const allAfter = await store.list({ cwd: cwdA, all: true })
    assert.deepEqual(
        allAfter.map((item) => item.id),
        ["a-session"],
    )
})

test("拒绝非法会话 id", async () => {
    const store = new SessionStore(root)
    await assert.rejects(store.open("../escape"), /不合法/)
})
