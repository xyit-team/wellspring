/*
 * Linux bwrap 后端。
 * 由 bwrap 提供 mount / PID / network namespace；Node permission model 作为第二层。
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

import type { SandboxAccess } from "../../config/types.ts"
import { findExecutable } from "../../platform/executable.ts"
import { platform as currentPlatform, type PlatformName } from "../../platform/os.ts"
import type {
    AgentLaunchInput,
    LaunchSpec,
    PluginLaunchInput,
    SandboxBackend,
    SandboxBackendStatus,
} from "../types.ts"

const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32"]

/** 沙箱内挂载 Node 运行时的目录 */
export const NODE_ROOT = "/opt/wellspring"

function existingSystemDirs(): string[] {
    return SYSTEM_DIRS.filter((dir) => existsSync(dir))
}

export interface NodeRuntimeLayout {
    /** 可整体挂载的 Node 前缀（含 bin/npm 与 lib/node_modules）；只有裸二进制时为 null */
    readonly prefix: string | null
    /** 沙箱内的 node 路径 */
    readonly nodePath: string
    /** PATH 里的目录 */
    readonly pathEntry: string
}

/**
 * 找到当前 node 的安装前缀。
 *
 * 只 bind 单个 node 二进制会丢掉同目录的 npm/npx（npm 在 lib/node_modules/npm 里），
 * 所以优先把整个前缀挂到 /opt/wellspring；找不到 npm 的发行版才退回裸二进制。
 */
export function resolveNodeRuntime(
    execPath: string = process.execPath,
    exists: (path: string) => boolean = existsSync,
): NodeRuntimeLayout {
    const prefix = resolve(dirname(execPath), "..")
    const hasNpm =
        exists(join(prefix, "bin", "npm")) ||
        exists(join(prefix, "lib", "node_modules", "npm")) ||
        exists(join(prefix, "share", "nodejs", "npm"))
    if (hasNpm) {
        return {
            prefix,
            nodePath: `${NODE_ROOT}/bin/node`,
            pathEntry: `${NODE_ROOT}/bin`,
        }
    }
    return {
        prefix: null,
        nodePath: `${NODE_ROOT}/node`,
        pathEntry: NODE_ROOT,
    }
}

function nodeRuntimeMount(runtime: NodeRuntimeLayout, execPath: string): string[] {
    if (runtime.prefix !== null) {
        return ["--dir", NODE_ROOT, "--ro-bind", runtime.prefix, NODE_ROOT]
    }
    return ["--dir", NODE_ROOT, "--ro-bind", execPath, `${NODE_ROOT}/node`]
}

function insideWorkspace(workspaceDir: string, cwd: string): string {
    const root = resolve(workspaceDir)
    const target = resolve(cwd)
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
        throw new Error(`cwd 不在 workspace 内：${cwd}`)
    }
    const rel = relative(root, target)
    return rel === "" ? "/workspace" : `/workspace/${rel.split(sep).join("/")}`
}

/** 纯函数，方便单测 */
export function buildBwrapLaunch(input: AgentLaunchInput): LaunchSpec {
    const args: string[] = [
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--cap-drop",
        "ALL",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
    ]

    if (input.network === true) {
        args.push("--share-net")
    }
    for (const dir of existingSystemDirs()) {
        args.push("--ro-bind-try", dir, dir)
    }
    // DNS、CA 证书与用户解析
    args.push("--ro-bind-try", "/etc", "/etc")
    // systemd-resolved 的 resolv.conf 指向 /run；先建目标目录再尝试绑定
    if (existsSync("/run/systemd/resolve")) {
        args.push("--dir", "/run", "--dir", "/run/systemd", "--dir", "/run/systemd/resolve")
        args.push("--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve")
    }
    const nodeRuntime = resolveNodeRuntime()
    args.push(...nodeRuntimeMount(nodeRuntime, process.execPath))
    const workspaceBind = input.access === "workspace-write" ? "--bind" : "--ro-bind"
    args.push(workspaceBind, resolve(input.workspaceDir), "/workspace")
    args.push("--bind", resolve(input.scratchDir), "/scratch")
    args.push("--chdir", insideWorkspace(input.workspaceDir, input.cwd))

    const env: Record<string, string> = { ...input.env }
    env["PATH"] = `${nodeRuntime.pathEntry}:${env["PATH"] ?? "/usr/bin:/bin"}`
    /*
     * 不再限制 RLIMIT_AS（虚拟地址空间会直接打死 V8 / JVM / Go）。
     * 物理内存由 SandboxManager 挂 cgroup v2 memory.max；这里只留 V8 堆上限，
     * 且对所有命令生效，npx / npm 派生的 node 子进程也能继承。
     */
    env["NODE_OPTIONS"] =
        `${env["NODE_OPTIONS"] ?? ""} --max-old-space-size=${input.limits.memoryMB}`.trim()
    for (const [key, value] of Object.entries(env)) {
        args.push("--setenv", key, value)
    }

    args.push("--")

    // prlimit 自身在 /usr/bin；只留文件描述符与进程数上限，超时交给 supervisor 的 wall timeout
    const prlimitArgs = ["--nofile=256", `--nproc=${input.limits.pids}`]
    args.push("/usr/bin/prlimit", ...prlimitArgs, "--", input.command, ...input.argv)

    return {
        command: "bwrap",
        args,
        cwd: resolve(input.workspaceDir),
        env: { ...input.env },
    }
}

/** 纯函数：插件 profile 的 bwrap launch spec */
export function buildBwrapPluginLaunch(input: PluginLaunchInput): LaunchSpec {
    const args: string[] = [
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--cap-drop",
        "ALL",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
    ]
    for (const dir of existingSystemDirs()) {
        args.push("--ro-bind-try", dir, dir)
    }
    const nodeRuntime = resolveNodeRuntime()
    args.push(...nodeRuntimeMount(nodeRuntime, process.execPath))
    args.push("--ro-bind", resolve(input.pluginDir), "/plugin")
    args.push("--ro-bind", resolve(input.hostSdkDir), "/host")
    args.push("--chdir", "/plugin")

    const env: Record<string, string> = { ...input.env }
    env["PATH"] = `${nodeRuntime.pathEntry}:${env["PATH"] ?? "/usr/bin:/bin"}`
    env["NODE_OPTIONS"] =
        `${env["NODE_OPTIONS"] ?? ""} --max-old-space-size=${input.limits.memoryMB}`.trim()
    for (const [key, value] of Object.entries(env)) {
        args.push("--setenv", key, value)
    }
    args.push("--")
    args.push(
        "/usr/bin/prlimit",
        "--nofile=256",
        `--nproc=${input.limits.pids}`,
        "--",
        nodeRuntime.nodePath,
        "--permission",
        "--allow-fs-read=/plugin",
        "--allow-fs-read=/host",
        "/host/src/sandbox/plugin-host.ts",
    )

    return {
        command: "bwrap",
        args,
        cwd: resolve(input.pluginDir),
        env: { ...input.env },
    }
}

/**
 * 找不到 bwrap 时的说明
 *
 * Android 要单独说：Termux 仓库里没有 bwrap 包，这条路根本走不通，
 * 报「装一下 bwrap」等于把人指向死胡同
 */
export function bwrapMissingReason(osPlatform: PlatformName): string {
    if (osPlatform === "android") {
        return "Android 上没有可用的 OS 级沙箱：Termux 仓库没有 bwrap，内核也不允许非特权 user namespace"
    }
    return "PATH 里找不到 bwrap（Debian/Ubuntu：apt install bubblewrap）"
}

/** bwrap 探测失败时的说明；Android 额外点明 user namespace 是根因 */
export function bwrapProbeFailureReason(stderr: string, osPlatform: PlatformName): string {
    const detail = stderr.trim().split("\n")[0]?.trim() ?? ""
    const base = detail === "" ? "bwrap 无法创建 namespace" : detail
    return osPlatform === "android" ? `${base}（Android 禁止非特权 user namespace）` : base
}

export class BwrapBackend implements SandboxBackend {
    readonly name = "bwrap"
    /* 根文件系统只读挂载后 --bind 工作区，沙箱内路径为重映射结果 */
    readonly pathStyle = "mount" as const
    /* 物理内存由 SandboxManager 挂 cgroup v2 memory.max */
    readonly memoryLimit = true

    /**
     * 文件效果由 namespace 与只读挂载强制，报 full
     * 网络与进程可见性不在 access 的承诺范围内
     */
    enforcement(access: SandboxAccess): "full" | "partial" | "none" {
        return access === "danger-full-access" ? "none" : "full"
    }

    enforcementNotes(access: SandboxAccess): readonly string[] {
        return access === "danger-full-access" ? ["绕开 bwrap，以宿主身份执行"] : []
    }

    async probe(): Promise<SandboxBackendStatus> {
        /* 按 PATH 找：Termux 在 $PREFIX/bin、NixOS 在 /nix/store，都不在 /usr/bin */
        const command = findExecutable("bwrap")
        if (command === null) {
            return {
                available: false,
                backend: this.name,
                reason: bwrapMissingReason(currentPlatform),
                version: null,
            }
        }
        const result = spawnSync(
            command,
            [
                "--unshare-all",
                "--die-with-parent",
                "--ro-bind",
                "/",
                "/",
                "--dev",
                "/dev",
                "--proc",
                "/proc",
                "--",
                "/bin/true",
            ],
            { timeout: 3_000, encoding: "utf8" },
        )
        if (result.status !== 0) {
            return {
                available: false,
                backend: this.name,
                reason: bwrapProbeFailureReason(result.stderr ?? "", currentPlatform),
                version: null,
            }
        }
        return {
            available: true,
            backend: this.name,
            reason: null,
            version: null,
        }
    }

    buildAgentLaunch(input: AgentLaunchInput): LaunchSpec {
        return buildBwrapLaunch(input)
    }

    buildPluginLaunch(input: PluginLaunchInput): LaunchSpec {
        return buildBwrapPluginLaunch(input)
    }
}
