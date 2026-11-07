/*
 * 沙箱验证矩阵：探针表、期望值、路径映射与结果归约
 *
 * 不依赖真实 OS 沙箱，任何平台都可运行
 * 最后一组用 DirectBackend 跑真实探针，验证矩阵能测出越界
 */

import assert from "node:assert/strict"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { SandboxAccess } from "../src/config/types.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { SandboxManager } from "../src/sandbox/manager.ts"
import {
    ACCESS_MODES,
    PROBES,
    classifyResult,
    isMountBackend,
    parseProbeOutput,
    probeArgs,
    probeTag,
    writeProbeScript,
    type FixturePaths,
} from "../scripts/sandbox-matrix.ts"

const fixture: FixturePaths = {
    root: "/fixture",
    workspace: "/fixture/workspace",
    secret: "/fixture/id_ed25519",
    outsideDir: "/fixture/outside",
}

function expectOf(id: string, backend: string, access: SandboxAccess): string {
    const probe = PROBES.find((item) => item.id === id)
    assert.ok(probe !== undefined, `缺少探针 ${id}`)
    return probe.expect({ backend, access })
}

test("探针表：id 唯一且覆盖全部 access 模式", () => {
    const ids = PROBES.map((item) => item.id)
    assert.equal(new Set(ids).size, ids.length, "探针 id 不得重复")
    assert.deepEqual([...ACCESS_MODES], ["read-only", "workspace-write"])
    for (const id of [
        "read:system",
        "read:workspace",
        "read:outside",
        "write:workspace",
        "write:scratch",
        "write:outside",
        "write:devnull",
        "net:egress",
        "link:hardlink",
    ]) {
        assert.ok(ids.includes(id), `缺少探针 ${id}`)
    }
})

test("期望值：两种后端共享不变项（读系统、写 scratch、写沙箱外被拒）", () => {
    for (const backend of ["bwrap", "seatbelt"]) {
        for (const access of ACCESS_MODES) {
            assert.equal(expectOf("read:system", backend, access), "allow")
            assert.equal(expectOf("read:workspace", backend, access), "allow")
            assert.equal(expectOf("write:scratch", backend, access), "allow")
            assert.equal(expectOf("write:devnull", backend, access), "allow")
            assert.equal(expectOf("write:outside", backend, access), "deny")
        }
    }
})

test("期望值：出网跟随默认策略，只有 read-only 断网（win-restricted 本期无围栏）", () => {
    for (const backend of ["bwrap", "seatbelt"]) {
        for (const access of ACCESS_MODES) {
            assert.equal(
                expectOf("net:egress", backend, access),
                access === "read-only" ? "deny" : "allow",
            )
        }
    }
    for (const access of ACCESS_MODES) {
        assert.equal(expectOf("net:egress", "win-restricted", access), "allow")
    }
})

test("期望值：读全局放开（与 DSH 对齐），两种后端都允许读 workspace 外", () => {
    for (const backend of ["bwrap", "seatbelt"]) {
        for (const access of ACCESS_MODES) {
            assert.equal(expectOf("read:outside", backend, access), "allow")
        }
    }
})

test("期望值：write:workspace 只在 workspace-write 开放", () => {
    for (const backend of ["bwrap", "seatbelt"]) {
        assert.equal(expectOf("write:workspace", backend, "read-only"), "deny")
        assert.equal(expectOf("write:workspace", backend, "workspace-write"), "allow")
    }
})

test("期望值：硬链接在 seatbelt 恒定被拒，在 bwrap 跟随 access", () => {
    assert.equal(expectOf("link:hardlink", "seatbelt", "read-only"), "deny")
    assert.equal(expectOf("link:hardlink", "seatbelt", "workspace-write"), "deny")
    assert.equal(expectOf("link:hardlink", "bwrap", "read-only"), "deny")
    assert.equal(expectOf("link:hardlink", "bwrap", "workspace-write"), "allow")
})

test("probeArgs：mount 后端用沙箱内路径，host 后端用宿主路径", () => {
    assert.equal(isMountBackend("bwrap"), true)
    assert.equal(isMountBackend("seatbelt"), false)
    assert.equal(isMountBackend("direct"), false)

    assert.deepEqual(probeArgs("read:workspace", "bwrap", fixture, "t0"), ["/workspace/demo.txt"])
    assert.deepEqual(probeArgs("read:workspace", "seatbelt", fixture, "t0"), [
        "/fixture/workspace/demo.txt",
    ])
    // scratch 一律走占位符：真实路径由探针内的 SCRATCH 环境变量展开
    assert.deepEqual(probeArgs("write:scratch", "bwrap", fixture, "t3"), ["@SCRATCH/probe-t3.txt"])
    assert.deepEqual(probeArgs("write:scratch", "seatbelt", fixture, "t3"), [
        "@SCRATCH/probe-t3.txt",
    ])
    // 沙箱外路径不做映射：bwrap 下该目录未挂进 namespace
    assert.deepEqual(probeArgs("read:outside", "bwrap", fixture, "t0"), ["/fixture/id_ed25519"])
    assert.deepEqual(probeArgs("write:outside", "seatbelt", fixture, "t1"), [
        "/fixture/outside/probe-t1.txt",
    ])
    assert.deepEqual(probeArgs("write:devnull", "bwrap", fixture, "t0"), ["/dev/null"])
    // 出网探针连宿主回环监听，不依赖外网可达性
    const egress = probeArgs("net:egress", "bwrap", fixture, "t0", 41234)
    assert.deepEqual(egress, ["127.0.0.1:41234"])
    assert.equal(probeArgs("link:hardlink", "bwrap", fixture, "t2").length, 2)
    assert.deepEqual(probeArgs("unknown:probe", "bwrap", fixture, "t0"), [])
})

test("parseProbeOutput：取最后一行 JSON，异常输入返回 null", () => {
    assert.deepEqual(parseProbeOutput('{"ok":true}'), { ok: true })
    assert.deepEqual(parseProbeOutput('noise\n{"ok":false,"code":"EAACES"}'), {
        ok: false,
        code: "EAACES",
    })
    assert.deepEqual(parseProbeOutput('{"ok":false}'), { ok: false })
    assert.equal(parseProbeOutput(""), null)
    assert.equal(parseProbeOutput("not json"), null)
    assert.equal(parseProbeOutput("[1,2]"), null)
    assert.equal(parseProbeOutput("null"), null)
})

test("classifyResult：成功输出算 allow，非零退出且无输出算 deny", () => {
    assert.deepEqual(classifyResult({ exitCode: 0, stdout: '{"ok":true}', stderr: "" }), {
        actual: "allow",
        detail: "",
    })
    assert.deepEqual(
        classifyResult({ exitCode: 0, stdout: '{"ok":false,"code":"EPERM"}', stderr: "" }),
        { actual: "deny", detail: "EPERM" },
    )
    // exec 被拦：探针未启动，按 deny 计并带上原因
    const blocked = classifyResult({
        exitCode: 126,
        stdout: "",
        stderr: "operation not permitted\n",
    })
    assert.equal(blocked.actual, "deny")
    assert.match(blocked.detail, /operation not permitted/)
    // 退出 0 却无结果：探针自身出错，计为 error
    const broken = classifyResult({ exitCode: 0, stdout: "", stderr: "" })
    assert.equal(broken.actual, "error")
    assert.match(broken.detail, /没有输出结果/)
})

// ---------- 真实探针：矩阵须能测出「没有隔离」 ----------

let root = ""
let workspace = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-matrix-"))
    workspace = join(root, "workspace")
    await mkdir(workspace, { recursive: true })
    await mkdir(join(root, "outside"), { recursive: true })
    await writeFile(join(workspace, "demo.txt"), "hello")
    await writeFile(join(root, "id_ed25519"), "secret")
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

function paths(): ResolvedPaths {
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

async function runOne(id: string): Promise<{ actual: string; detail: string }> {
    const probe = PROBES.find((item) => item.id === id)
    assert.ok(probe !== undefined)
    const manager = new SandboxManager({
        settings: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        paths: paths(),
        backend: new DirectBackend(),
    })
    const local: FixturePaths = {
        root,
        workspace,
        secret: join(root, "id_ed25519"),
        outsideDir: join(root, "outside"),
    }
    const result = await manager.runAgentCode({
        command: process.execPath,
        argv: ["-e", probe.script, ...probeArgs(id, "direct", local, "local")],
        workspaceDir: workspace,
        access: "read-only",
        timeoutMs: 15_000,
    })
    return classifyResult(result)
}

test("无隔离后端上，越界探针会被测出来（矩阵不是永远报绿）", async () => {
    const outside = await runOne("write:outside")
    assert.equal(outside.actual, "allow", "direct 后端必然能写沙箱外，探针要如实反映")

    const secret = await runOne("read:outside")
    assert.equal(secret.actual, "allow", "direct 后端必然能读私有文件")

    // 写越界期望 deny：direct 上必然 MISMATCH
    for (const id of ["write:outside"]) {
        assert.equal(expectOf(id, "direct", "read-only"), "deny")
    }
    // 读全局放开后，读越界在 direct 上符合预期
    assert.equal(expectOf("read:outside", "direct", "read-only"), "allow")
})

test("受控探针在无隔离后端上仍按预期通过", async () => {
    assert.equal((await runOne("read:system")).actual, "allow")
    assert.equal((await runOne("write:scratch")).actual, "allow")
    assert.equal((await runOne("write:devnull")).actual, "allow")
})

test("probeTag：全矩阵内唯一（硬链接探针第二轮会撞 EEXIST）", () => {
    const tags = new Set<string>()
    for (const access of ACCESS_MODES) {
        for (const [index] of PROBES.entries()) {
            const tag = probeTag(access, index)
            assert.ok(!tags.has(tag), `tag 重复：${tag}`)
            tags.add(tag)
        }
    }
    assert.equal(tags.size, ACCESS_MODES.length * PROBES.length)
    assert.notEqual(probeTag("read-only", 0), probeTag("workspace-write", 0))
})

test("完整矩阵跑两遍都稳定：硬链接在 workspace-write 不会被 EEXIST 污染", async () => {
    const local: FixturePaths = {
        root,
        workspace,
        secret: join(root, "id_ed25519"),
        outsideDir: join(root, "outside"),
    }
    const run = async (access: SandboxAccess): Promise<Record<string, string>> => {
        const out: Record<string, string> = {}
        const manager = new SandboxManager({
            settings: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
            paths: paths(),
            backend: new DirectBackend(),
        })
        for (const [index, probe] of PROBES.entries()) {
            const result = await manager.runAgentCode({
                command: process.execPath,
                argv: [
                    "-e",
                    probe.script,
                    ...probeArgs(probe.id, "direct", local, probeTag(access, index)),
                ],
                workspaceDir: workspace,
                access,
                timeoutMs: 15_000,
            })
            out[probe.id] = classifyResult(result).actual
        }
        return out
    }

    // 两轮共用同一个 workspace 目录：第一轮 read-only，第二轮 workspace-write
    const first = await run("read-only")
    const second = await run("workspace-write")

    assert.equal(first["link:hardlink"], "allow", "direct 下建硬链接应当成功")
    assert.equal(second["link:hardlink"], "allow", "第二轮不得因 EEXIST 变成 deny")
    assert.equal(second["write:workspace"], "allow")
    assert.equal(first["read:outside"], "allow", "direct 读得到沙箱外文件")
})

test("写探针把 @SCRATCH/ 展开成 SCRATCH 环境变量，并在缺失时明确报错", async () => {
    const script = writeProbeScript()
    const manager = new SandboxManager({
        settings: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        paths: paths(),
        backend: new DirectBackend(),
    })
    const result = await manager.runAgentCode({
        command: process.execPath,
        argv: ["-e", script, "@SCRATCH/expanded.txt"],
        workspaceDir: workspace,
        access: "read-only",
        timeoutMs: 15_000,
    })
    const classified = classifyResult(result)
    assert.equal(classified.actual, "allow", classified.detail)

    // SCRATCH 缺失：探针报错
    const { spawnSync } = await import("node:child_process")
    const missing = spawnSync(process.execPath, ["-e", script, "@SCRATCH/x.txt"], {
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "" },
    })
    assert.notEqual(missing.status, 0, "缺 SCRATCH 时探针不得成功")
    assert.match(missing.stderr, /SCRATCH/)
})
