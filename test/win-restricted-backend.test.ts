import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { test } from "node:test"

import { candidateBackends } from "../src/sandbox/manager.ts"
import {
    buildWinSandboxLaunch,
    createSidState,
    packagedLauncherPath,
    WinRestrictedBackend,
} from "../src/sandbox/backends/win-restricted.ts"

const sids = { sidR: "S-1-5-21-1-2-3-1001", sidW: "S-1-5-21-1-2-3-1002" }

function input(overrides: Record<string, unknown> = {}) {
    return {
        workspaceDir: "C:\\wellspring-ws",
        scratchDir: "C:\\wellspring-scratch",
        cwd: "C:\\wellspring-ws",
        command: "cmd.exe",
        argv: ["/c", "echo", "hi"],
        env: {},
        limits: { timeoutMs: 5_000, memoryMB: 256, pids: 16, outputLimitBytes: 1024 },
        ...overrides,
    }
}

test("buildWinSandboxLaunch：固定参数顺序、受限 token 的 SID、Job Object 限制", () => {
    const spec = buildWinSandboxLaunch(
        { ...input(), access: "workspace-write" },
        "C:\\bin\\win-sandbox.exe",
        sids,
    )
    assert.equal(spec.command, "C:\\bin\\win-sandbox.exe")
    assert.equal(spec.cwd, resolve("C:\\wellspring-ws"))
    const args = spec.args
    assert.equal(args[0], "--exec")
    assert.equal(args[1], "--access")
    assert.equal(args[2], "workspace-write")
    assert.ok(args.includes("--sid-r"))
    assert.ok(args.includes(sids.sidR))
    assert.ok(args.includes("--sid-w"))
    assert.ok(args.includes(sids.sidW))
    assert.ok(args.includes("--memory-mb"))
    assert.ok(args.includes("--pids"))
    const separator = args.indexOf("--")
    assert.ok(separator > 0)
    assert.deepEqual(args.slice(separator + 1), ["cmd.exe", "/c", "echo", "hi"])

    const env = spec.env
    assert.ok((env["TEMP"] ?? "").endsWith("tmp"))
    assert.ok((env["NODE_OPTIONS"] ?? "").includes("--max-old-space-size=256"))
    assert.equal(env["WORKSPACE"], resolve("C:\\wellspring-ws"))
    assert.equal(env["SCRATCH"], resolve("C:\\wellspring-scratch"))
})

test("read-only / workspace-write 只改 access 参数，不重建 ACL", () => {
    const readOnly = buildWinSandboxLaunch(input({ access: "read-only" }), "launcher.exe", sids)
    const write = buildWinSandboxLaunch(
        input({ access: "workspace-write" }),
        "launcher.exe",
        sids,
    )
    assert.equal(readOnly.args[2], "read-only")
    assert.equal(write.args[2], "workspace-write")
    assert.deepEqual(
        readOnly.args.filter((arg) => arg !== "read-only" && arg !== "workspace-write"),
        write.args.filter((arg) => arg !== "read-only" && arg !== "workspace-write"),
    )
})

test("能力位：host 路径视图、无 cgroup、partial 与缺口说明", () => {
    const backend = new WinRestrictedBackend({ launcher: "C:\\fake\\win-sandbox.exe" })
    assert.equal(backend.name, "win-restricted")
    assert.equal(backend.pathStyle, "host")
    assert.equal(backend.memoryLimit, false)
    assert.equal(backend.enforcement("read-only"), "partial")
    assert.equal(backend.enforcement("workspace-write"), "partial")
    assert.equal(backend.enforcement("danger-full-access"), "none")
    const notes = backend.enforcementNotes("workspace-write").join("\n")
    assert.match(notes, /network/)
    assert.match(notes, /读全局放开/)
    assert.deepEqual(backend.enforcementNotes("danger-full-access"), [
        "绕开 win-sandbox，以宿主身份执行",
    ])
})

test("probe：仅 Windows 可用，且自检失败时 fail-closed", async () => {
    const linux = new WinRestrictedBackend({
        platform: "linux",
        launcher: "C:\\fake\\win-sandbox.exe",
    })
    const linuxStatus = await linux.probe()
    assert.equal(linuxStatus.available, false)
    assert.match(linuxStatus.reason ?? "", /仅 Windows/)

    const ok = new WinRestrictedBackend({
        platform: "windows",
        launcher: "C:\\fake\\win-sandbox.exe",
        exists: () => true,
        selfTest: () => true,
    })
    const okStatus = await ok.probe()
    assert.equal(okStatus.available, true)
    assert.equal(okStatus.backend, "win-restricted")

    const broken = new WinRestrictedBackend({
        platform: "windows",
        launcher: "C:\\fake\\win-sandbox.exe",
        exists: () => true,
        selfTest: () => false,
    })
    const brokenStatus = await broken.probe()
    assert.equal(brokenStatus.available, false)
    assert.match(brokenStatus.reason ?? "", /self-test/)
})

test("candidateBackends：Windows auto 选 win-restricted，显式指定不回退", () => {
    assert.deepEqual(
        candidateBackends("auto", "windows", { dataDir: "C:\\data" }).map((item) => item.name),
        ["win-restricted"],
    )
    assert.deepEqual(
        candidateBackends("win-restricted", "linux").map((item) => item.name),
        ["win-restricted"],
    )
    assert.deepEqual(candidateBackends("auto", "macos").map((item) => item.name), ["seatbelt"])
})

test("packagedLauncherPath：按架构解析随包产物", () => {
    const expected = join("win32-x64", "win-sandbox.exe")
    const path = packagedLauncherPath("x64", (candidate) => candidate.endsWith(expected))
    assert.ok(path !== null)
    assert.ok(path.endsWith(expected))
    assert.equal(packagedLauncherPath("x64", () => false), null)
})

test("createSidState：生成合法 SID，且可注入随机源", () => {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32LE(7, 0)
    const generated = createSidState(() => buffer)
    assert.equal(generated.sidR, "S-1-5-21-7-7-7-7")
    assert.equal(generated.sidW, "S-1-5-21-7-7-7-7")
})
