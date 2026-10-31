/*
 * 沙箱物理内存限制：cgroup v2（systemd user scope）的装配与降级路径。
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
    createSandboxMemoryLimit,
    parseOomKill,
    wrapSpecInCgroup,
    type MemoryLimitCommandResult,
    type MemoryLimitDeps,
} from "../src/sandbox/memory-limit.ts"
import type { LaunchSpec } from "../src/sandbox/types.ts"

interface Calls {
    readonly run: string[][]
    readonly holder: string[][]
}

function deps(
    overrides: {
        readonly controlGroup?: string
        readonly events?: string | null
        readonly writable?: boolean
        readonly holderError?: string
    } = {},
): { readonly deps: MemoryLimitDeps; readonly calls: Calls } {
    const calls: Calls = { run: [], holder: [] }
    const controlGroup = overrides.controlGroup ?? "/user.slice/test-sandbox.scope\n"
    const value: MemoryLimitDeps = {
        platform: "linux",
        env: {},
        run: async (command, args): Promise<MemoryLimitCommandResult> => {
            calls.run.push([command, ...args])
            if (args.includes("show")) {
                return { code: 0, stdout: controlGroup, stderr: "" }
            }
            return { code: 0, stdout: "", stderr: "" }
        },
        spawnHolder: (command, args) => {
            if (overrides.holderError !== undefined) {
                throw new Error(overrides.holderError)
            }
            calls.holder.push([command, ...args])
            return { pid: 4242 }
        },
        readText: (path) => (path.endsWith("memory.events") ? (overrides.events ?? null) : null),
        writable: () => overrides.writable ?? true,
        sleep: async () => undefined,
        randomSuffix: () => "abcd1234",
    }
    return { deps: value, calls }
}

function spec(): LaunchSpec {
    return {
        command: "/usr/bin/prlimit",
        args: ["--nproc=64", "--", "node", "-e", "console.log(1)"],
        cwd: "/workspace",
        env: { PATH: "/usr/bin:/bin" },
    }
}

test("parseOomKill：只认 memory.events 里的 oom_kill", () => {
    assert.equal(parseOomKill("oom 0\noom_kill 0\n"), false)
    assert.equal(parseOomKill("low 0\nhigh 0\noom_kill 2\n"), true)
    assert.equal(parseOomKill(null), false)
    assert.equal(parseOomKill("oom_kill\n"), false)
})

test("wrapSpecInCgroup：先写 cgroup.procs 再 exec 原命令", () => {
    const wrapped = wrapSpecInCgroup(spec(), "/sys/fs/cgroup/user.slice/x.scope")
    assert.equal(wrapped.command, "/bin/sh")
    assert.deepEqual(wrapped.args.slice(0, 3), [
        "-c",
        'echo $$ > "$1/cgroup.procs" || exit 126; shift; exec "$@"',
        "sh",
    ])
    assert.equal(wrapped.args[3], "/sys/fs/cgroup/user.slice/x.scope")
    assert.equal(wrapped.args[4], "/usr/bin/prlimit")
    assert.deepEqual(wrapped.args.slice(5), ["--nproc=64", "--", "node", "-e", "console.log(1)"])
    assert.deepEqual(wrapped.env, spec().env)
})

test("创建带 MemoryMax / MemorySwapMax=0 的 systemd scope", async () => {
    const fake = deps({ events: "oom 0\noom_kill 1\n" })
    const limit = await createSandboxMemoryLimit({
        bytes: 256 * 1024 * 1024,
        timeoutMs: 60_000,
        deps: fake.deps,
    })
    assert.equal(limit.active, true)
    assert.equal(limit.reason, null)

    const holder = fake.calls.holder[0] ?? []
    assert.equal(holder[0], "systemd-run")
    assert.ok(holder.includes("--user"))
    assert.ok(holder.includes("--scope"))
    assert.ok(holder.includes("MemoryMax=268435456"))
    assert.ok(holder.includes("MemorySwapMax=0"))
    assert.ok(holder.includes("/bin/sleep"))
    assert.match(holder.join(" "), /--unit wellspring-sandbox-\d+-abcd1234/)

    const wrapped = limit.wrap(spec())
    assert.equal(wrapped.command, "/bin/sh")
    assert.ok(wrapped.args.includes("/sys/fs/cgroup/user.slice/test-sandbox.scope"))

    assert.deepEqual(await limit.finish(), { oomKilled: true })
    assert.deepEqual(await limit.finish(), { oomKilled: true }, "finish 可重复调用")
    assert.equal(fake.calls.run.filter((call) => call.includes("stop")).length, 1, "只 stop 一次")
})

test("memory.events 不可读时 oomKilled 为 false", async () => {
    const fake = deps({ events: null })
    const limit = await createSandboxMemoryLimit({
        bytes: 128 * 1024 * 1024,
        timeoutMs: 1_000,
        deps: fake.deps,
    })
    assert.equal(limit.active, true)
    assert.deepEqual(await limit.finish(), { oomKilled: false })
})

test("systemd/user scope 不可用时降级且不阻塞命令", async () => {
    const noSystemd = await createSandboxMemoryLimit({
        bytes: 128 * 1024 * 1024,
        timeoutMs: 1_000,
        deps: deps({ holderError: "spawn systemd-run ENOENT" }).deps,
    })
    assert.equal(noSystemd.active, false)
    assert.match(noSystemd.reason ?? "", /systemd-run 不可用/)
    const unchanged = noSystemd.wrap(spec())
    assert.deepEqual(unchanged, spec(), "降级时原样返回 launch spec")
    assert.deepEqual(await noSystemd.finish(), { oomKilled: false })

    const noScope = await createSandboxMemoryLimit({
        bytes: 128 * 1024 * 1024,
        timeoutMs: 1_000,
        deps: deps({ controlGroup: "" }).deps,
    })
    assert.equal(noScope.active, false)
    assert.match(noScope.reason ?? "", /systemd user scope 不可用/)

    const readOnly = await createSandboxMemoryLimit({
        bytes: 128 * 1024 * 1024,
        timeoutMs: 1_000,
        deps: deps({ writable: false }).deps,
    })
    assert.equal(readOnly.active, false)
    assert.match(readOnly.reason ?? "", /无法写入 cgroup/)
})

test("非 Linux 或内存上限过小时直接降级", async () => {
    const darwin = await createSandboxMemoryLimit({
        bytes: 128 * 1024 * 1024,
        timeoutMs: 1_000,
        deps: { platform: "darwin" },
    })
    assert.equal(darwin.active, false)

    const tiny = await createSandboxMemoryLimit({
        bytes: 8 * 1024 * 1024,
        timeoutMs: 1_000,
        deps: deps().deps,
    })
    assert.equal(tiny.active, false)
})
