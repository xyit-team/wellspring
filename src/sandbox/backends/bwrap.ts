/*
 * Linux bwrap 后端。
 * 由 bwrap 提供 mount / PID / network namespace；Node permission model 作为第二层。
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { basename, relative, resolve, sep } from "node:path"

import type {
    AgentLaunchInput,
    LaunchSpec,
    PluginLaunchInput,
    SandboxBackend,
    SandboxBackendStatus,
} from "../types.ts"

const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32"]

function existingSystemDirs(): string[] {
    return SYSTEM_DIRS.filter((dir) => existsSync(dir))
}

function isNodeCommand(command: string): boolean {
    const name = basename(command)
    return name === "node" || name === "nodejs"
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
    args.push("--dir", "/opt/wellspring")
    args.push("--ro-bind", process.execPath, "/opt/wellspring/node")
    const workspaceBind = input.access === "workspace-write" ? "--bind" : "--ro-bind"
    args.push(workspaceBind, resolve(input.workspaceDir), "/workspace")
    args.push("--bind", resolve(input.scratchDir), "/scratch")
    args.push("--chdir", insideWorkspace(input.workspaceDir, input.cwd))

    const env: Record<string, string> = { ...input.env }
    env["PATH"] = `/opt/wellspring:${env["PATH"] ?? "/usr/bin:/bin"}`
    if (isNodeCommand(input.command)) {
        env["NODE_OPTIONS"] =
            `${env["NODE_OPTIONS"] ?? ""} --max-old-space-size=${input.limits.memoryMB}`.trim()
    }
    for (const [key, value] of Object.entries(env)) {
        args.push("--setenv", key, value)
    }

    args.push("--")

    // prlimit 自身在 /usr/bin；用 rlimit 作为 cgroup 不可用时的兜底
    const prlimitArgs = [
        "--nofile=256",
        `--nproc=${input.limits.pids}`,
        `--cpu=${Math.max(1, Math.ceil(input.limits.timeoutMs / 1000))}`,
    ]
    if (!isNodeCommand(input.command)) {
        prlimitArgs.push(`--as=${input.limits.memoryMB * 1024 * 1024}`)
    }
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
    args.push("--dir", "/opt/wellspring")
    args.push("--ro-bind", process.execPath, "/opt/wellspring/node")
    args.push("--ro-bind", resolve(input.pluginDir), "/plugin")
    args.push("--ro-bind", resolve(input.hostSdkDir), "/host")
    args.push("--chdir", "/plugin")

    const env: Record<string, string> = { ...input.env }
    env["PATH"] = `/opt/wellspring:${env["PATH"] ?? "/usr/bin:/bin"}`
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
        "/opt/wellspring/node",
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

export class BwrapBackend implements SandboxBackend {
    readonly name = "bwrap"

    async probe(): Promise<SandboxBackendStatus> {
        if (!existsSync("/usr/bin/bwrap")) {
            return {
                available: false,
                backend: this.name,
                reason: "找不到 bwrap",
                version: null,
            }
        }
        const result = spawnSync(
            "bwrap",
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
                reason: (result.stderr ?? "").trim() || "bwrap 无法创建 namespace",
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
