/*
 * 沙箱验证矩阵：探针表、期望值与参数映射
 *
 * 与 verify-sandbox.ts 分离，使这些纯数据可在无 OS 沙箱的机器上单测
 * 真机运行需要 macOS 或允许非特权 user namespace 的 Linux
 */

import type { SandboxAccess } from "../src/config/types.ts"

/** 探针的期望结果 */
export type Outcome = "allow" | "deny"

/** 实际观测结果；error 表示探针自身没跑起来 */
export type Actual = Outcome | "error"

export interface ProbeContext {
    readonly backend: string
    readonly access: SandboxAccess
}

export interface Probe {
    readonly id: string
    readonly label: string
    /** node -e 的执行体；额外参数从 process.argv[1] 起 */
    readonly script: string
    /** 期望：allow = 应当成功，deny = 应当被拦 */
    readonly expect: (context: ProbeContext) => Outcome
    /** 与直觉不同时给出理由，打印在表格下方 */
    readonly why?: (context: ProbeContext) => string | null
}

/**
 * scratch 路径的占位前缀
 *
 * scratch 真实路径由 SandboxManager 运行时决定：mount 后端是 /scratch，
 * host 后端是一段宿主绝对路径，探针只能经 SCRATCH 环境变量取得
 */
export const SCRATCH_SENTINEL = "@SCRATCH/"

/** 探针脚本公共前导：把 @SCRATCH/ 前缀展开成真实路径 */
const PROBE_PREAMBLE = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    `const PREFIX = ${JSON.stringify(SCRATCH_SENTINEL)}`,
    "let target = process.argv[1]",
    "if (target.startsWith(PREFIX)) {",
    "  if (!process.env.SCRATCH) throw new Error('SCRATCH 未设置')",
    "  target = path.join(process.env.SCRATCH, target.slice(PREFIX.length))",
    "}",
].join("\n")

/** 探针脚本统一：成功打印 {ok:true}，失败打印 {ok:false, code}，两者都以 0 退出 */
export function readProbeScript(): string {
    return [
        PROBE_PREAMBLE,
        "try { fs.readFileSync(target); process.stdout.write(JSON.stringify({ ok: true })) }",
        "catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code })) }",
    ].join("\n")
}

export function writeProbeScript(): string {
    return [
        PROBE_PREAMBLE,
        "try { fs.writeFileSync(target, 'probe'); process.stdout.write(JSON.stringify({ ok: true })) }",
        "catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code })) }",
    ].join("\n")
}

export const NETWORK_TARGET = "http://1.1.1.1"

export const ACCESS_MODES: readonly SandboxAccess[] = ["read-only", "workspace-write"]

/**
 * 探针文件名里的唯一标记
 *
 * 带上 access：每个模式重跑全部探针，同名文件会让 link:hardlink 在第二轮撞 EEXIST，
 * 归约为 deny
 */
export function probeTag(access: SandboxAccess, index: number): string {
    return `${access === "read-only" ? "ro" : "ww"}-${index}`
}

export const PROBES: readonly Probe[] = [
    {
        id: "read:system",
        label: "读系统文件 /etc/passwd",
        script: readProbeScript(),
        expect: () => "allow",
    },
    {
        id: "read:workspace",
        label: "读 workspace 内文件",
        script: readProbeScript(),
        expect: () => "allow",
    },
    {
        id: "read:outside",
        label: "读 workspace 外的私有文件",
        script: readProbeScript(),
        expect: () => "deny",
        why: () => "这是沙箱存在的主要理由之一：凭证不该对模型可见",
    },
    {
        id: "write:workspace",
        label: "写 workspace",
        script: writeProbeScript(),
        expect: ({ access }) => (access === "workspace-write" ? "allow" : "deny"),
    },
    {
        id: "write:scratch",
        label: "写 scratch（临时区）",
        script: writeProbeScript(),
        expect: () => "allow",
        why: () => "scratch 是两种 access 都承诺可写的区域",
    },
    {
        id: "write:outside",
        label: "写 workspace 外的目录",
        script: writeProbeScript(),
        expect: () => "deny",
    },
    {
        id: "write:devnull",
        label: "写 /dev/null（shell 重定向落点）",
        script: writeProbeScript(),
        expect: () => "allow",
        why: () => "漏了它任何 2>/dev/null 的脚本都会莫名其妙失败",
    },
    {
        id: "net:egress",
        label: "未申请时的出网",
        script: [
            "const target = process.argv[1]",
            "fetch(target, { signal: AbortSignal.timeout(3000) })",
            "  .then(() => process.stdout.write(JSON.stringify({ ok: true })))",
            "  .catch((error) => process.stdout.write(JSON.stringify({ ok: false, code: error.name })))",
        ].join("\n"),
        expect: () => "deny",
        why: ({ backend }) =>
            backend === "bwrap"
                ? "bwrap 用 --unshare-all，未 --share-net 时无路由"
                : "Seatbelt 只在 network=true 时才写 (allow network*)",
    },
    {
        id: "link:hardlink",
        label: "在工作区内建硬链接",
        script: [
            "const fs = require('node:fs')",
            "const [source, target] = [process.argv[1], process.argv[2]]",
            "try { fs.linkSync(source, target); process.stdout.write(JSON.stringify({ ok: true })) }",
            "catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code })) }",
        ].join("\n"),
        /*
         * Seatbelt 显式 deny file-link，硬链接别名是路径型 deny 的绕过面
         * bwrap 无此规则，workspace-write 下建硬链接属正常文件效果
         */
        expect: ({ backend, access }) => {
            if (backend === "seatbelt") {
                return "deny"
            }
            return access === "workspace-write" ? "allow" : "deny"
        },
        why: ({ backend }) =>
            backend === "seatbelt"
                ? "Seatbelt 报 partial 的一项：禁用 ln 与 cp -l，换取硬链接别名不可用"
                : null,
    },
]

export interface FixturePaths {
    readonly root: string
    readonly workspace: string
    readonly secret: string
    readonly outsideDir: string
}

/** mount = 沙箱内有重映射路径；host = 直接用宿主真实路径 */
export function isMountBackend(backend: string): boolean {
    return backend === "bwrap"
}

/**
 * 探针的额外参数：按后端决定用宿主路径还是沙箱内路径。
 *
 * tag 必须在一次矩阵运行内唯一：每个 access 模式都会重跑全部探针，
 * 复用同名文件会让 link:hardlink 在第二轮撞 EEXIST，被误判成“被沙箱拒绝”。
 */
export function probeArgs(
    probeId: string,
    backend: string,
    fixture: FixturePaths,
    tag: string,
): readonly string[] {
    const mount = isMountBackend(backend)
    switch (probeId) {
        case "read:system":
            return ["/etc/passwd"]
        case "read:workspace":
            return [mount ? "/workspace/demo.txt" : `${fixture.workspace}/demo.txt`]
        case "read:outside":
            /* bwrap 没把该目录挂进 namespace，读会 ENOENT，同样是 deny */
            return [fixture.secret]
        case "write:workspace":
            return [mount ? `/workspace/probe-${tag}.txt` : `${fixture.workspace}/probe-${tag}.txt`]
        case "write:scratch":
            /* 两种后端都走 SCRATCH 环境变量，宿主侧路径对探针不可预知 */
            return [`${SCRATCH_SENTINEL}probe-${tag}.txt`]
        case "write:outside":
            return [`${fixture.outsideDir}/probe-${tag}.txt`]
        case "write:devnull":
            return ["/dev/null"]
        case "net:egress":
            return [NETWORK_TARGET]
        case "link:hardlink":
            return [
                mount ? "/workspace/demo.txt" : `${fixture.workspace}/demo.txt`,
                mount ? `/workspace/link-${tag}.txt` : `${fixture.workspace}/link-${tag}.txt`,
            ]
        default:
            return []
    }
}

/** 从探针 stdout 取最后一行 JSON；取不到返回 null */
export function parseProbeOutput(stdout: string): { ok: boolean; code?: string } | null {
    const line = stdout
        .trim()
        .split("\n")
        .filter((item) => item !== "")
        .at(-1)
    if (line === undefined) {
        return null
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(line)
    } catch {
        return null
    }
    /* 只接受 { ok: boolean }，其余形状视为无结论 */
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null
    }
    const record = parsed as Record<string, unknown>
    if (typeof record["ok"] !== "boolean") {
        return null
    }
    const code = record["code"]
    return {
        ok: record["ok"],
        ...(typeof code === "string" ? { code } : {}),
    }
}

/** 把一次运行归约成 actual + detail */
export function classifyResult(input: {
    readonly exitCode: number | null
    readonly signal?: string | null
    readonly stdout: string
    readonly stderr: string
}): { actual: Actual; detail: string } {
    const parsed = parseProbeOutput(input.stdout)
    if (parsed === null) {
        if (input.exitCode === 0) {
            return { actual: "error", detail: "探针没有输出结果" }
        }
        /* 探针未启动时按 deny 计，带上退出状态与 stderr 首行 */
        const exit = input.signal ? `signal=${input.signal}` : `exit=${String(input.exitCode)}`
        const reason = input.stderr.trim().split("\n")[0] ?? ""
        return { actual: "deny", detail: `${exit} ${reason}`.trim() }
    }
    return {
        actual: parsed.ok ? "allow" : "deny",
        detail: parsed.ok ? "" : (parsed.code ?? "拒绝"),
    }
}
