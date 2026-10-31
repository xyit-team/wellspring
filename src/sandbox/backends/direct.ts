/*
 * 无隔离 fallback：仅用于 best-effort / 测试。
 * 不提供 fs、网络、进程隔离；严格模式禁止使用。
 */

import type { SandboxAccess } from "../../config/types.ts"
import type {
    AgentLaunchInput,
    LaunchSpec,
    PluginLaunchInput,
    SandboxBackend,
    SandboxBackendStatus,
} from "../types.ts"

export class DirectBackend implements SandboxBackend {
    readonly name = "direct"
    readonly pathStyle = "host" as const
    readonly memoryLimit = false

    /** 无隔离，任何 access 都是宿主直接执行 */
    enforcement(_access: SandboxAccess): "full" | "partial" | "none" {
        return "none"
    }

    enforcementNotes(_access: SandboxAccess): readonly string[] {
        return ["无隔离：以宿主用户身份执行，文件、网络、进程不受限"]
    }

    async probe(): Promise<SandboxBackendStatus> {
        return {
            available: true,
            backend: this.name,
            reason: null,
            version: null,
        }
    }

    buildAgentLaunch(input: AgentLaunchInput): LaunchSpec {
        return {
            command: input.command,
            args: [...input.argv],
            cwd: input.cwd,
            env: input.env,
        }
    }

    buildPluginLaunch(input: PluginLaunchInput): LaunchSpec {
        return {
            command: process.execPath,
            args: [input.runnerPath],
            cwd: input.pluginDir,
            env: input.env,
        }
    }
}
