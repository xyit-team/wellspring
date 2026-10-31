/*
 * 非 Linux 平台的插件 sandbox：Node permission model。
 *
 * Windows / macOS 没有 bwrap，无法提供 mount / PID / network namespace；
 * 这里用 Node 自带的 --permission 限制插件进程的文件读写，至少不让插件直接
 * 读写宿主任意文件。它不隔离网络与进程，所以只用于插件，不用于任意 Agent 命令。
 */

import type { SandboxAccess } from "../../config/types.ts"
import type {
    AgentLaunchInput,
    LaunchSpec,
    PluginLaunchInput,
    SandboxBackend,
    SandboxBackendStatus,
} from "../types.ts"

const BACKEND_NAME = "node-permission"

function permissionFlags(paths: readonly string[], flag: string): string[] {
    return [...new Set(paths)].map((path) => `${flag}=${path}`)
}

/** 纯函数：插件 launch spec，方便单测 */
export function buildNodePermissionPluginLaunch(input: PluginLaunchInput): LaunchSpec {
    const read = [input.pluginDir, input.hostSdkDir, input.pluginDataDir]
    const write = [input.pluginDataDir]
    return {
        command: process.execPath,
        args: [
            "--permission",
            ...permissionFlags(read, "--allow-fs-read"),
            ...permissionFlags(write, "--allow-fs-write"),
            input.runnerPath,
        ],
        cwd: input.pluginDir,
        env: input.env,
    }
}

export class NodePermissionBackend implements SandboxBackend {
    readonly name = BACKEND_NAME
    readonly pathStyle = "host" as const
    readonly memoryLimit = false

    /** 只收窄文件读写，仅在 Node 进程内生效 */
    enforcement(_access: SandboxAccess): "full" | "partial" | "none" {
        return "partial"
    }

    enforcementNotes(_access: SandboxAccess): readonly string[] {
        return [
            "fs: Node --permission 的文件读写白名单，不覆盖子进程",
            "network: 不隔离",
            "process: 不隔离",
        ]
    }

    async probe(): Promise<SandboxBackendStatus> {
        const supported = process.allowedNodeEnvironmentFlags.has("--permission")
        return {
            available: supported,
            backend: this.name,
            reason: supported
                ? "Node permission model（无网络/进程隔离）"
                : "当前 Node 不支持 --permission",
            version: process.version,
        }
    }

    buildAgentLaunch(_input: AgentLaunchInput): LaunchSpec {
        throw new Error("node-permission 后端只用于插件，不支持任意 Agent 命令")
    }

    buildPluginLaunch(input: PluginLaunchInput): LaunchSpec {
        return buildNodePermissionPluginLaunch(input)
    }
}
