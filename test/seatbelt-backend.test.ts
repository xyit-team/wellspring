/*
 * macOS Seatbelt 后端：SBPL profile 生成与 launch 参数。
 *
 * 全平台可跑：只覆盖纯函数，不调用 sandbox_init，不要求 macOS
 * 真机隔离效果由 scripts/verify-sandbox.ts 在 macOS 上跑矩阵验证
 */

import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import {
    SEATBELT_CLI,
    SEATBELT_PATH,
    SeatbeltBackend,
    buildSeatbeltLaunch,
    buildSeatbeltPluginLaunch,
    buildSeatbeltProfile,
    pathForms,
    quoteSbpl,
    resolveSeatbeltCommand,
    seatbeltNodePrefix,
} from "../src/sandbox/backends/seatbelt.ts"

const noRealpath = (): null => null

interface ProfileOverrides {
    readonly access?: "read-only" | "workspace-write" | "danger-full-access"
    readonly network?: boolean
    readonly command?: string
    readonly workspaceDir?: string
    readonly scratchDir?: string
    readonly readPaths?: readonly string[]
    readonly writePaths?: readonly string[]
}

function profile(overrides: ProfileOverrides = {}): string {
    return buildSeatbeltProfile({
        access: overrides.access ?? "read-only",
        network: overrides.network ?? false,
        command: overrides.command ?? "/usr/bin/node",
        workspaceDir: overrides.workspaceDir ?? "/ws",
        scratchDir: overrides.scratchDir ?? "/scratch/1",
        readPaths: overrides.readPaths ?? ["/opt/node"],
        writePaths: overrides.writePaths ?? [],
        realpath: noRealpath,
    })
}

/** 取出以某个操作开头的规则行，缺了直接失败 */
function ruleLine(text: string, operation: string): string {
    const line = text.split("\n").find((item) => item.startsWith(`(${operation} `))
    assert.ok(line !== undefined, `缺少 ${operation} 规则`)
    return line
}

const agentInput = {
    workspaceDir: "/ws",
    scratchDir: "/scratch/1",
    cwd: "/ws",
    command: "/usr/bin/node",
    argv: ["-e", "console.log(1)"],
    env: { PATH: "/ws/node_modules/.bin:/usr/bin", HOME: "/scratch/1" },
    limits: { timeoutMs: 1_000, memoryMB: 64, pids: 16, outputLimitBytes: 1024 },
}

const pluginInput = {
    pluginDir: "/plugins/core",
    pluginEntryRel: "index.ts",
    pluginDataDir: "/data/core",
    hostSdkDir: "/data/host",
    runnerPath: "/data/host/src/sandbox/plugin-host.ts",
    env: { PATH: "/usr/bin" },
    limits: { timeoutMs: 1_000, memoryMB: 64, pids: 16, outputLimitBytes: 1024 },
}

test("read-only：写规则只覆盖 scratch，workspace 只读", () => {
    const text = profile()
    const write = ruleLine(text, "allow file-write*")
    assert.ok(write.includes('(subpath "/scratch/1")'), write)
    assert.ok(!write.includes('(subpath "/ws")'), "read-only 下 workspace 不得可写")
    const read = ruleLine(text, "allow file-read*")
    assert.ok(read.includes('(subpath "/ws")'), "read-only 仍要能读 workspace")
})

test("workspace-write：写规则放开 workspace", () => {
    const write = ruleLine(profile({ access: "workspace-write" }), "allow file-write*")
    assert.ok(write.includes('(subpath "/ws")'), write)
})

test("fail-closed 基线：deny default 在最前，元数据先放行", () => {
    const text = profile()
    assert.ok(text.startsWith("(version 1)\n(deny default)"), text.slice(0, 60))
    assert.ok(text.includes("(allow file-read-metadata)"), "缺了它 dyld / stat 会静默失败")
})

test("纵深：显式禁止新建硬链接，且放在规则末尾", () => {
    const text = profile()
    const lines = text.trimEnd().split("\n")
    assert.equal(lines.at(-1), "(deny file-link)", "硬链接 deny 必须在最后（SBPL 后匹配优先）")
    assert.ok(text.indexOf("(deny file-link)") > text.indexOf("(allow file-write*"))
})

test("写 /dev/null 单独放行（shell 重定向落点）", () => {
    assert.ok(profile().includes('(allow file-write-data (literal "/dev/null"))'))
})

test("network 只有显式请求才放开", () => {
    assert.ok(!profile().includes("(allow network*)"))
    const networked = profile({ network: true })
    assert.ok(networked.includes("(allow network*)"))
    assert.ok(networked.includes("com.apple.dnssd.service"), "DNS 走 XPC，需要 mach-lookup")
})

test("pathForms：覆盖 /private 别名与 realpath 结果", () => {
    assert.deepEqual(pathForms("/tmp", noRealpath), ["/tmp", "/private/tmp"])
    assert.deepEqual(pathForms("/private/var/db/x", noRealpath), ["/private/var/db/x", "/var/db/x"])
    assert.deepEqual(
        pathForms("/tmp", () => "/private/tmp"),
        ["/tmp", "/private/tmp"],
    )
    assert.deepEqual(pathForms("/ws", noRealpath), ["/ws"])
})

test("quoteSbpl：转义反斜杠与引号", () => {
    assert.equal(quoteSbpl('/a"b'), '"/a\\"b"')
    assert.equal(quoteSbpl("/a\\b"), '"/a\\\\b"')
})

test("agent launch：launcher 绝对路径，profile 走 -p，不用 -- 分隔", () => {
    const spec = buildSeatbeltLaunch(agentInput, SEATBELT_CLI)
    assert.equal(spec.command, SEATBELT_CLI)
    assert.equal(spec.args[0], "-p")
    assert.ok((spec.args[1] ?? "").startsWith("(version 1)"))
    assert.equal(spec.args[2], agentInput.command)
    assert.deepEqual(spec.args.slice(3), [...agentInput.argv])
    assert.ok(!spec.args.includes("--"), "sandbox-exec 会把 -- 当成命令本身")
    assert.equal(spec.cwd, agentInput.cwd)
})

test("agent launch：PATH 不继承宿主，忽略宿主给出的可写目录", () => {
    const spec = buildSeatbeltLaunch(agentInput, SEATBELT_CLI)
    const path = spec.env["PATH"] ?? ""
    assert.ok(!path.includes("/ws/node_modules/.bin"), path)
    const nodePrefix = seatbeltNodePrefix()
    const allowed = new Set([join(nodePrefix, "bin"), nodePrefix, ...SEATBELT_PATH.split(":")])
    for (const entry of path.split(":")) {
        assert.ok(allowed.has(entry), `PATH 出现未预期条目：${entry}`)
    }
    assert.equal(spec.env["NODE_OPTIONS"], "--max-old-space-size=64")
})

test("plugin launch：插件目录与宿主 SDK 只读，只写插件数据目录", () => {
    const spec = buildSeatbeltPluginLaunch(pluginInput, SEATBELT_CLI)
    assert.equal(spec.args[2], process.execPath)
    assert.equal(spec.args[3], pluginInput.runnerPath)
    const text = spec.args[1] ?? ""
    const write = ruleLine(text, "allow file-write*")
    assert.ok(write.includes('(subpath "/data/core")'), write)
    assert.ok(!write.includes('(subpath "/plugins/core")'), "插件代码不得可写")
    const read = ruleLine(text, "allow file-read*")
    assert.ok(read.includes('(subpath "/plugins/core")'), read)
    assert.ok(read.includes('(subpath "/data/host")'), read)
    assert.ok(!text.includes("(allow network*)"), "插件默认不出网")
    assert.equal(spec.cwd, pluginInput.pluginDir)
})

test("能力位：host 路径视图、无 cgroup、confined 报 partial", () => {
    const backend = new SeatbeltBackend()
    assert.equal(backend.name, "seatbelt")
    assert.equal(backend.pathStyle, "host")
    assert.equal(backend.memoryLimit, false)
    assert.equal(backend.enforcement("read-only"), "partial")
    assert.equal(backend.enforcement("workspace-write"), "partial")
    assert.equal(backend.enforcement("danger-full-access"), "none")
    const notes = backend.enforcementNotes("workspace-write").join("\n")
    for (const expected of ["memory", "network", "硬链接", "PID"]) {
        assert.ok(notes.includes(expected), `缺口说明缺 ${expected}：${notes}`)
    }
    assert.deepEqual(backend.enforcementNotes("danger-full-access"), [
        "绕开 Seatbelt，直接以宿主身份执行",
    ])
})

test("probe：非 macOS 报不可用，不静默通过", async () => {
    const status = await new SeatbeltBackend({
        deps: { platform: "linux", exists: () => true, selfTest: () => true },
    }).probe()
    assert.equal(status.available, false)
    assert.match(status.reason ?? "", /仅 macOS/)
})

test("probe：darwin 优先随包 loader，退回 CLI 并标注 deprecated", async () => {
    const packaged = await new SeatbeltBackend({
        deps: { platform: "macos", exists: () => true, selfTest: () => true },
    }).probe()
    assert.equal(packaged.available, true)
    assert.match(packaged.version ?? "", /^seatbelt-run:/)

    const cliOnly = await new SeatbeltBackend({
        deps: {
            platform: "macos",
            exists: (path: string) => path === SEATBELT_CLI,
            selfTest: () => true,
        },
    }).probe()
    assert.equal(cliOnly.available, true)
    assert.match(cliOnly.version ?? "", /sandbox-exec \(deprecated\)/)
})

test("probe：launcher 全部缺失时 fail-closed", async () => {
    const status = await new SeatbeltBackend({
        deps: { platform: "macos", exists: () => false, selfTest: () => true },
    }).probe()
    assert.equal(status.available, false)
    assert.match(status.reason ?? "", /seatbelt:build/)
})

test("没有 launcher 时 buildAgentLaunch 抛错，绝不无约束直通", () => {
    const backend = new SeatbeltBackend({
        deps: { platform: "macos", exists: () => false, selfTest: () => true },
    })
    assert.throws(() => backend.buildAgentLaunch(agentInput), /launcher 不可用/)
    assert.throws(() => backend.buildPluginLaunch(pluginInput), /launcher 不可用/)
})

const NODE_PREFIX = "/opt/node-v24"

function fakeExists(present: readonly string[]): (path: string) => boolean {
    const set = new Set(present)
    return (path: string) => set.has(path)
}

test("resolveSeatbeltCommand：裸名只查固定白名单，不读宿主 PATH", () => {
    /* 宿主 PATH 里有工作区的 node_modules/.bin，但它不在白名单里 */
    const exists = fakeExists(["/opt/node-v24/bin/node", "/workspace/node_modules/.bin/node"])
    assert.equal(
        resolveSeatbeltCommand("node", { nodePrefix: NODE_PREFIX }, exists),
        "/opt/node-v24/bin/node",
    )
    assert.throws(() => resolveSeatbeltCommand("node", { nodePrefix: NODE_PREFIX }, () => false))
})

test("resolveSeatbeltCommand：白名单目录按顺序命中", () => {
    const exists = fakeExists(["/usr/bin/git"])
    assert.equal(resolveSeatbeltCommand("git", { nodePrefix: NODE_PREFIX }, exists), "/usr/bin/git")
})

test("resolveSeatbeltCommand：含斜杠的路径按 cwd 解析成绝对路径", () => {
    const exists = fakeExists([])
    assert.equal(
        resolveSeatbeltCommand("/usr/local/bin/python3", { nodePrefix: NODE_PREFIX }, exists),
        "/usr/local/bin/python3",
    )
    assert.equal(
        resolveSeatbeltCommand("./script.sh", { nodePrefix: NODE_PREFIX, cwd: "/ws/sub" }, exists),
        "/ws/sub/script.sh",
    )
})

test("launch spec 里出现的是解析后的绝对路径，原始裸名不会进 argv", () => {
    /* 查找目录由 seatbeltNodePrefix() 决定，所以按真实前缀构造命中的文件 */
    const resolvedNode = join(seatbeltNodePrefix(), "bin", "node")
    const spec = buildSeatbeltLaunch(
        { ...agentInput, command: "node" },
        SEATBELT_CLI,
        fakeExists([resolvedNode]),
    )
    assert.equal(spec.args[2], resolvedNode)
    assert.ok(!spec.args.includes("node"), "裸名不得出现在 argv 里")
})

test("找不到命令时抛错，不把裸名透传给 launcher", () => {
    assert.throws(
        () => buildSeatbeltLaunch({ ...agentInput, command: "nope" }, SEATBELT_CLI, () => false),
        /找不到可执行文件/,
    )
})
