import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { onMessage, SessionMessageEvent } from "../src/api/host/hooks.ts"
import { getSession as getHostSession } from "../src/api/host/session.ts"
import { registerSession } from "../src/session/registry.ts"
import { Session, SessionMessage } from "../src/session/session.ts"
import { toChatMessages } from "../src/session/replay.ts"
import { SessionStore } from "../src/session/store.ts"

let root = ""
let cwd = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-session-api-"))
    cwd = await mkdtemp(join(tmpdir(), "wellspring-session-api-cwd-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
})

test("会话头记录 type / metadata / workspace", async () => {
    const store = new SessionStore(root)
    const created = await store.create({
        cwd,
        workspace: cwd,
        model: "m",
        id: "session-header",
        type: "agent",
        metadata: { product: "wellspring" },
    })
    assert.equal(created.meta.type, "agent")
    assert.deepEqual(created.meta.metadata, { product: "wellspring" })
    const opened = await store.open("session-header", cwd)
    assert.equal(opened.header.type, "agent")
    assert.deepEqual(opened.header.metadata, { product: "wellspring" })
})

test("getSession 与 message 触发 onMessage", async () => {
    const store = new SessionStore(root)
    const data = await store.create({ cwd, model: "m", id: "session-message" })
    const session = new Session(data, store)
    registerSession(session)
    assert.equal(await getHostSession("session-message"), session)

    const seen: string[] = []
    const off = onMessage((event) => {
        assert.ok(event instanceof SessionMessageEvent)
        seen.push(event.content)
    })
    try {
        const message = await session.message("hello")
        assert.ok(message instanceof SessionMessage)
        assert.deepEqual(message.content, ["hello"])
        assert.equal(seen[0], "hello")
    } finally {
        off()
    }
})

test("空闲 Session.message 落盘，活跃时排队", async () => {
    const store = new SessionStore(root)
    const data = await store.create({ cwd, model: "m", id: "session-inbox" })
    const session = new Session(data, store)

    await session.message("idle")
    const opened = await store.open("session-inbox", cwd)
    assert.equal(
        toChatMessages(opened.events).some((m) => m.role === "user" && m.content === "idle"),
        true,
    )

    session.begin()
    await session.message("queued")
    assert.deepEqual(
        session.take().map((m) => m.content),
        [["queued"]],
    )
    assert.deepEqual(session.take(), [])
    session.end()
})
