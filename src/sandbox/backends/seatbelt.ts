/*
 * macOS Seatbelt 后端
 *
 * SBPL profile 在目标命令启动前施加内核限制：(deny default) 起手，读 / 写 / 执行按白名单放开
 * profile 经 -p 从 argv 传入，不落盘
 *
 * launcher 顺序：随包 bin/darwin-<arch>/seatbelt-run（sandbox_init + execve），
 * 系统 /usr/bin/sandbox-exec。两者均为绝对路径，不经过 PATH 解析
 *
 * 与 bwrap 的差别：没有 mount / PID / network namespace，沙箱内是宿主真实路径
 * （pathStyle = "host"），写边界由 SBPL 规则表达
 */

import { spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { SandboxAccess } from "../../config/types.ts"
import { platform as currentPlatform, type PlatformName } from "../../platform/os.ts"
import type {
    AgentLaunchInput,
    LaunchSpec,
    PluginLaunchInput,
    SandboxBackend,
    SandboxBackendStatus,
    SandboxEnforcement,
} from "../types.ts"

/** 系统自带的 Seatbelt CLI，macOS 10.10 起 deprecated */
export const SEATBELT_CLI = "/usr/bin/sandbox-exec"

/** 随包分发的 loader 文件名 */
export const SEATBELT_LOADER = "seatbelt-run"

/** 包根目录，src 与 dist 下的 sandbox/backends 都退三级 */
const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

/**
 * 读白名单：系统与运行时
 *
 * 不存在的路径写进 profile 只是永不命中，不报错
 * 恒量输出，profile 生成保持纯函数，不探 fs
 */
const SYSTEM_READ_SUBTREES: readonly string[] = [
    "/usr/bin",
    "/usr/sbin",
    "/usr/lib",
    "/usr/share",
    "/usr/local",
    "/usr/libexec",
    "/bin",
    "/sbin",
    "/System",
    "/Library/Apple",
    "/Library/Frameworks",
    "/private/etc",
    "/private/var/db/timezone",
    "/opt/homebrew",
    "/dev/null",
    "/dev/urandom",
    "/dev/random",
    "/dev/zero",
]

/** 可执行白名单：系统部分 */
const SYSTEM_EXEC_SUBTREES: readonly string[] = [
    "/usr/bin",
    "/usr/sbin",
    "/usr/libexec",
    "/usr/local/bin",
    "/bin",
    "/sbin",
    "/opt/homebrew/bin",
]

/**
 * 沙箱内的固定 PATH
 *
 * 不拼接宿主 process.env.PATH：pnpm 布局下它含工作区内的 node_modules/.bin，
 * 该目录对模型可写，PATH 解析权会落到被约束的对象手里
 */
export const SEATBELT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

function defaultRealpath(path: string): string | null {
    try {
        return realpathSync(path)
    } catch {
        return null
    }
}

/** /tmp、/var、/etc 是 /private 下的符号链接，SBPL 按字面匹配，两种写法都要给 */
function privateAlias(path: string): string | null {
    for (const name of ["/tmp", "/var", "/etc"]) {
        if (path === name) {
            return `/private${path}`
        }
        if (path.startsWith(`${name}/`)) {
            return `/private${path}`
        }
        const privateName = `/private${name}`
        if (path === privateName) {
            return path.slice("/private".length)
        }
        if (path.startsWith(`${privateName}/`)) {
            return path.slice("/private".length)
        }
    }
    return null
}

/**
 * 一个宿主路径在 SBPL 里要覆盖的字面形式
 *
 * 原样、/private 别名、realpath 结果、realpath 的别名
 */
export function pathForms(
    path: string,
    realpath: (path: string) => string | null = defaultRealpath,
): readonly string[] {
    const forms: string[] = []
    const add = (candidate: string | null): void => {
        if (candidate === null || candidate === "" || forms.includes(candidate)) {
            return
        }
        forms.push(candidate)
    }
    const absolute = resolve(path)
    add(absolute)
    add(privateAlias(absolute))
    const real = realpath(absolute)
    if (real !== null) {
        add(real)
        add(privateAlias(real))
    }
    return forms
}

/** SBPL 字符串字面量转义 */
export function quoteSbpl(value: string): string {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function filterFor(path: string): string {
    /* /dev 下是设备文件用 literal，其余按子树 */
    return path.startsWith("/dev/")
        ? `(literal ${quoteSbpl(path)})`
        : `(subpath ${quoteSbpl(path)})`
}

function rule(
    operation: string,
    roots: readonly string[],
    realpath: (path: string) => string | null,
): string {
    const filters: string[] = []
    const seen = new Set<string>()
    for (const root of roots) {
        for (const form of pathForms(root, realpath)) {
            if (seen.has(form)) {
                continue
            }
            seen.add(form)
            filters.push(filterFor(form))
        }
    }
    return filters.length === 0 ? "" : `(${operation} ${filters.join(" ")})`
}

export interface SeatbeltProfileInput {
    readonly access: SandboxAccess
    readonly network: boolean
    /** 目标命令；裸名由 launcher 用固定 PATH 解析 */
    readonly command: string
    readonly workspaceDir: string
    readonly scratchDir: string
    /** 额外可读路径：node 前缀、插件目录、宿主 SDK 等 */
    readonly readPaths: readonly string[]
    /** 额外可写路径：插件数据目录等 */
    readonly writePaths: readonly string[]
    /** realpath 解析；测试可注入，返回 null 表示解析失败 */
    readonly realpath?: (path: string) => string | null
}

/** 纯函数：生成 SBPL profile，方便单测 */
export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
    const realpath = input.realpath ?? defaultRealpath
    const writable = input.access === "workspace-write"

    const writeRoots: string[] = [input.scratchDir, join(input.scratchDir, "tmp")]
    if (writable) {
        writeRoots.push(input.workspaceDir)
    }
    writeRoots.push(...input.writePaths)

    const execRoots: string[] = [...SYSTEM_EXEC_SUBTREES]
    if (writable) {
        /* workspace-write 下构建产物也要能起进程 */
        execRoots.push(input.workspaceDir)
    }
    execRoots.push(input.scratchDir, ...input.readPaths)

    const lines: string[] = [
        "(version 1)",
        "(deny default)",
        "",
        ";; 路径遍历，dyld 与 stat 依赖",
        "(allow file-read-metadata)",
        ";; dyld 映射二进制与动态库，缺失时进程被信号终止",
        "(allow file-map-executable)",
        ";; 基础进程能力",
        "(allow process-fork)",
        "(allow process-info* (target self))",
        "(allow signal (target self))",
        "(allow sysctl-read)",
        ";; node 启动依赖的系统服务",
        `(allow mach-lookup (global-name ${quoteSbpl("com.apple.system.logger")})`,
        `             (global-name ${quoteSbpl("com.apple.system.notification_center")})`,
        `             (global-name ${quoteSbpl("com.apple.cfprefsd.agent")}))`,
        ";; node worker_threads",
        "(allow ipc-posix-shm)",
        "",
        ";; 读全局放开",
        ";; 路径枚举下 node 在 dyld 与 xattr 阶段 SIGABRT，实测只有全局放行可启动",
        ";; 写边界不受影响，见下方 file-write* 规则",
        "(allow file-read*)",
        "",
        ";; 写：scratch 恒定可写，workspace 由 access 决定",
        rule("allow file-write*", writeRoots, realpath),
        "",
        ";; shell 重定向落点",
        `(allow file-write-data (literal ${quoteSbpl("/dev/null")}))`,
        "",
        ";; 执行：工具链与构建产物",
        rule("allow process-exec*", execRoots, realpath),
    ]

    if (input.command.startsWith("/")) {
        /* 命令可能位于白名单子树之外，单独按字面放行 */
        const literal = pathForms(input.command, realpath)
            .map((form) => `(literal ${quoteSbpl(form)})`)
            .join(" ")
        lines.push(`(allow process-exec ${literal})`)
    }

    if (input.network) {
        lines.push("")
        lines.push(";; network=true 时放开出网，DNS 走 mDNSResponder 的 XPC 通道")
        lines.push("(allow network*)")
        lines.push(`(allow mach-lookup (global-name ${quoteSbpl("com.apple.dnssd.service")}))`)
    }

    lines.push("")
    lines.push(";; 纵深：deny 按路径匹配，allow 落在 inode 上，同 inode 硬链接可绕过路径 deny")
    lines.push(";; 禁止新建硬链接，沙箱内 ln 与 cp -l 不可用")
    lines.push(";; 置于末尾，SBPL 后匹配的规则优先")
    lines.push("(deny file-link)")

    return `${lines.filter((line) => line !== "").join("\n")}\n`
}

/** 当前 node 的安装前缀，宿主真实路径 */
export function seatbeltNodePrefix(execPath: string = process.execPath): string {
    return resolve(dirname(execPath), "..")
}

/**
 * 把请求的命令解析成绝对路径
 *
 * launcher 只接受绝对路径，按 PATH 解析时工作区内可写目录能决定实际执行的文件
 * 裸名只查固定白名单目录，宿主 PATH 不参与
 */
export function resolveSeatbeltCommand(
    command: string,
    options: { readonly nodePrefix: string; readonly cwd?: string },
    exists: (path: string) => boolean = existsSync,
): string {
    if (command.includes("/")) {
        return resolve(options.cwd ?? process.cwd(), command)
    }
    const searchDir = dedupePath([
        join(options.nodePrefix, "bin"),
        options.nodePrefix,
        ...SEATBELT_PATH.split(":"),
    ]).split(":")
    for (const dir of searchDir) {
        const candidate = join(dir, command)
        if (exists(candidate)) {
            return candidate
        }
    }
    throw new Error(`找不到可执行文件：${command}（沙箱只按固定 PATH 查找，不读宿主 PATH）`)
}

function dedupePath(entries: readonly string[]): string {
    const seen = new Set<string>()
    const out: string[] = []
    for (const entry of entries) {
        if (entry === "" || seen.has(entry)) {
            continue
        }
        seen.add(entry)
        out.push(entry)
    }
    return out.join(":")
}

/** 沙箱进程的固定环境，PATH 不继承宿主 */
export function buildSeatbeltEnv(input: {
    readonly env: Readonly<Record<string, string>>
    readonly memoryMB: number
    readonly nodePrefix: string
}): Record<string, string> {
    const env: Record<string, string> = { ...input.env }
    env["PATH"] = dedupePath([
        join(input.nodePrefix, "bin"),
        input.nodePrefix,
        ...SEATBELT_PATH.split(":"),
    ])
    env["NODE_OPTIONS"] =
        `${env["NODE_OPTIONS"] ?? ""} --max-old-space-size=${input.memoryMB}`.trim()
    return env
}

/** 纯函数：agent-code 的 launch spec，launcher 与目标命令均为绝对路径 */
export function buildSeatbeltLaunch(
    input: AgentLaunchInput,
    launcher: string,
    exists: (path: string) => boolean = existsSync,
): LaunchSpec {
    const nodePrefix = seatbeltNodePrefix()
    const target = resolveSeatbeltCommand(input.command, { nodePrefix, cwd: input.cwd }, exists)
    const profile = buildSeatbeltProfile({
        access: input.access ?? "read-only",
        network: input.network === true,
        command: target,
        workspaceDir: input.workspaceDir,
        scratchDir: input.scratchDir,
        readPaths: [nodePrefix],
        writePaths: [],
    })
    return {
        command: launcher,
        /* 不加 -- 分隔符，sandbox-exec 会把 -- 当成命令本身 */
        args: ["-p", profile, target, ...input.argv],
        cwd: input.cwd,
        env: buildSeatbeltEnv({
            env: input.env,
            memoryMB: input.limits.memoryMB,
            nodePrefix,
        }),
    }
}

/** 纯函数：插件 profile 的 launch spec，只写插件数据目录 */
export function buildSeatbeltPluginLaunch(input: PluginLaunchInput, launcher: string): LaunchSpec {
    const nodePrefix = seatbeltNodePrefix()
    const profile = buildSeatbeltProfile({
        access: "read-only",
        network: false,
        command: process.execPath,
        workspaceDir: input.pluginDir,
        scratchDir: input.pluginDataDir,
        readPaths: [input.pluginDir, input.hostSdkDir, nodePrefix],
        writePaths: [input.pluginDataDir],
    })
    return {
        command: launcher,
        args: ["-p", profile, process.execPath, input.runnerPath],
        cwd: input.pluginDir,
        env: buildSeatbeltEnv({
            env: input.env,
            memoryMB: input.limits.memoryMB,
            nodePrefix,
        }),
    }
}

/** 随包分发的 loader；不存在时返回 null */
export function packagedLauncherPath(
    arch: string = process.arch,
    exists: (path: string) => boolean = existsSync,
): string | null {
    const binary = join(PACKAGE_ROOT, "bin", `darwin-${arch}`, SEATBELT_LOADER)
    return exists(binary) ? binary : null
}

function defaultSelfTest(binary: string): boolean {
    const args =
        basename(binary) === basename(SEATBELT_CLI)
            ? ["-p", "(version 1)(allow default)", "/usr/bin/true"]
            : ["--self-test"]
    const result = spawnSync(binary, args, { timeout: 5_000, encoding: "utf8" })
    return result.status === 0
}

export interface SeatbeltProbeDeps {
    readonly platform: PlatformName
    readonly exists: (path: string) => boolean
    readonly selfTest: (binary: string) => boolean
}

export interface SeatbeltBackendOptions {
    /** 显式指定 launcher 绝对路径；自定义构建或测试用 */
    readonly launcher?: string
    readonly deps?: Partial<SeatbeltProbeDeps>
}

export class SeatbeltBackend implements SandboxBackend {
    readonly name = "seatbelt"
    /* 无挂载命名空间，沙箱内外路径字符串一致 */
    readonly pathStyle = "host" as const
    /* 无 cgroup，物理内存只到 V8 堆上限 */
    readonly memoryLimit = false

    readonly #launcher: string | null
    readonly #deps: SeatbeltProbeDeps

    constructor(options: SeatbeltBackendOptions = {}) {
        this.#launcher = options.launcher ?? null
        this.#deps = {
            platform: options.deps?.platform ?? currentPlatform,
            exists: options.deps?.exists ?? existsSync,
            selfTest: options.deps?.selfTest ?? defaultSelfTest,
        }
    }

    /**
     * 文件效果由内核强制，读写两侧都能收
     * 物理内存、网络粒度、PID 可见性与 SBPL 跨版本语义均无保证，不报 full
     */
    enforcement(access: SandboxAccess): SandboxEnforcement {
        return access === "danger-full-access" ? "none" : "partial"
    }

    enforcementNotes(access: SandboxAccess): readonly string[] {
        if (access === "danger-full-access") {
            return ["绕开 Seatbelt，直接以宿主身份执行"]
        }
        return [
            "fs: 读未收敛，路径枚举下 node 无法启动，仅写边界为严格模式",
            "memory: 没有 cgroup v2，物理内存只由 --max-old-space-size 约束 V8 堆",
            "network: network=false 时 SBPL 拒绝出网；置 true 即整体放开，没有域名粒度",
            "fs: Seatbelt 按路径匹配，预先存在的同 inode 硬链接可以读穿",
            "process: 没有 PID namespace，进程可见性不受控",
            "sbpl: sandbox-exec 自 macOS 10.10 起 deprecated，语义无跨版本兼容承诺",
        ]
    }

    async probe(): Promise<SandboxBackendStatus> {
        if (this.#deps.platform !== "macos") {
            return {
                available: false,
                backend: this.name,
                reason: "Seatbelt 仅 macOS 可用",
                version: null,
            }
        }

        if (this.#launcher !== null) {
            const absolute = resolve(this.#launcher)
            if (!this.#deps.exists(absolute)) {
                return {
                    available: false,
                    backend: this.name,
                    reason: `指定的 launcher 不存在：${absolute}`,
                    version: null,
                }
            }
            return {
                available: true,
                backend: this.name,
                reason: null,
                version: `custom:${absolute}`,
            }
        }

        const packaged = packagedLauncherPath(process.arch, this.#deps.exists)
        if (packaged !== null && this.#deps.selfTest(packaged)) {
            return {
                available: true,
                backend: this.name,
                reason: null,
                version: `${SEATBELT_LOADER}:${process.arch}`,
            }
        }

        if (this.#deps.exists(SEATBELT_CLI) && this.#deps.selfTest(SEATBELT_CLI)) {
            return {
                available: true,
                backend: this.name,
                reason: null,
                version: "sandbox-exec (deprecated)",
            }
        }

        return {
            available: false,
            backend: this.name,
            reason: "找不到可用的 Seatbelt launcher：先 npm run seatbelt:build，或确认 /usr/bin/sandbox-exec 存在",
            version: null,
        }
    }

    /** launcher 一律绝对路径，永不交给 PATH 解析 */
    #resolveLauncher(): string {
        if (this.#launcher !== null) {
            return resolve(this.#launcher)
        }
        const packaged = packagedLauncherPath(process.arch, this.#deps.exists)
        if (packaged !== null) {
            return packaged
        }
        if (this.#deps.exists(SEATBELT_CLI)) {
            return SEATBELT_CLI
        }
        throw new Error(
            "Seatbelt launcher 不可用：先 npm run seatbelt:build，或确认 /usr/bin/sandbox-exec 存在",
        )
    }

    buildAgentLaunch(input: AgentLaunchInput): LaunchSpec {
        return buildSeatbeltLaunch(input, this.#resolveLauncher(), this.#deps.exists)
    }

    buildPluginLaunch(input: PluginLaunchInput): LaunchSpec {
        return buildSeatbeltPluginLaunch(input, this.#resolveLauncher())
    }
}
