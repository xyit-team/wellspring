import assert from "node:assert/strict"
import { test } from "node:test"
import { Event, EventBus } from "../src/event/event.ts"

test("publish 投递到订阅者", () => {
    const bus = new EventBus()
    const received: Event<{ test: string }>[] = []
    bus.subscribe<{ test: string }>("test", (event) => received.push(event))
    bus.publish("test", Event.create({ test: "test message" }))
    assert.equal(received.length, 1)
    assert.deepEqual(received[0]?.getData(), { test: "test message" })
})

test("退订后不再投递", () => {
    const bus = new EventBus()
    let calls = 0
    const unsub = bus.subscribe("test", () => calls++)
    bus.publish("test", Event.create(1))
    unsub()
    bus.publish("test", Event.create(1))
    assert.equal(calls, 1)
})
