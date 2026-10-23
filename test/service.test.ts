import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import {
    ServiceAlreadyRunningError,
    ServiceNotRunningError,
    assertServiceStartable,
    readServiceRecord,
    serviceRecordFile,
    stopService,
    writeServiceRecord,
} from "../src/service/control.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-service-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

function tempPaths(): ResolvedPaths {
    return {
        configDir: join(root, "config"),
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        logDir: join(root, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
}

function spawnSleeper(): ReturnType<typeof spawn> {
    return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
    })
}

test("stopService 向存活进程发送 SIGTERM 并清理记录", async () => {
    const paths = tempPaths()
    const child = spawnSleeper()
    await once(child, "spawn")
    const pid = child.pid
    assert.ok(pid !== undefined)

    try {
        await writeServiceRecord({ pid, startedAt: new Date().toISOString(), cwd: root }, paths)
        await assert.rejects(assertServiceStartable(paths), ServiceAlreadyRunningError)

        const exited = once(child, "exit")
        const stopped = await stopService(paths, { timeoutMs: 3_000, pollMs: 50 })
        await exited
        assert.equal(stopped, pid)
        assert.equal(await readServiceRecord(paths), null)
        assert.equal(child.signalCode, "SIGTERM")
    } finally {
        if (child.exitCode === null) {
            child.kill("SIGKILL")
        }
    }
})

test("残留 pid 记录会被 start 清理，stop 报未运行", async () => {
    const paths = tempPaths()
    const child = spawnSleeper()
    await once(child, "spawn")
    const pid = child.pid
    assert.ok(pid !== undefined)
    child.kill("SIGKILL")
    await once(child, "exit")

    await writeServiceRecord({ pid, startedAt: new Date().toISOString(), cwd: root }, paths)
    assert.notEqual(await readServiceRecord(paths), null)
    await assertServiceStartable(paths)
    assert.equal(await readServiceRecord(paths), null)

    await assert.rejects(stopService(paths, { timeoutMs: 100, pollMs: 10 }), ServiceNotRunningError)
})

test("没有服务记录时 stopService 抛 ServiceNotRunningError", async () => {
    const paths = tempPaths()
    await rm(serviceRecordFile(paths), { force: true })
    await assert.rejects(stopService(paths, { timeoutMs: 100, pollMs: 10 }), ServiceNotRunningError)
})
