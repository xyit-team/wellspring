// 插件可用的宿主能力：sandbox 代码执行与网络工具

import type { Logger } from "pino"

import type { AppSetting } from "../config/types.ts"
import {
    createDeepSeekWebClient,
    type WebFetchResult,
    type WebSearchResult,
} from "../network/web.ts"
import { createProxyFetch } from "../network/proxy.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import { SandboxManager } from "../sandbox/manager.ts"
import type { AgentCodeRequest, AgentCodeResult, StopMode } from "../sandbox/types.ts"
import { getAgentToolContext, type AgentToolContext } from "../agent/tool-context.ts"
import {
    queryTask,
    registerBackgroundTask,
    stopTask,
    type AgentTaskInfo,
} from "../agent/task-registry.ts"

export interface HostCapabilities {
    executeCode(
        input: Omit<AgentCodeRequest, "workspaceDir">,
        context?: AgentToolContext,
    ): Promise<AgentCodeResult>
    startBackgroundCode(
        input: Omit<AgentCodeRequest, "workspaceDir">,
        context?: AgentToolContext,
    ): Promise<{ taskId: string; sandboxId: string }>
    queryTask(taskId?: string): AgentTaskInfo | null
    stopTask(taskId: string | undefined, mode: StopMode): boolean
    webSearch(query: string, count?: number): Promise<readonly WebSearchResult[]>
    webFetch(url: string): Promise<WebFetchResult>
}

export interface HostCapabilitiesOptions {
    readonly config: AppSetting
    readonly paths: ResolvedPaths
    readonly logger: Logger
}

const ACCESS_RANK: Readonly<Record<string, number>> = {
    "read-only": 0,
    "workspace-write": 1,
    "danger-full-access": 2,
}

export function createHostCapabilities(options: HostCapabilitiesOptions): HostCapabilities {
    let manager: SandboxManager | null = null
    let web: ReturnType<typeof createDeepSeekWebClient> | null = null
    const sandbox = (): SandboxManager => {
        manager ??= new SandboxManager({
            settings: options.config.sandbox,
            paths: options.paths,
            logger: options.logger,
        })
        return manager
    }
    const approve = async (
        input: Omit<AgentCodeRequest, "workspaceDir">,
        context: AgentToolContext,
    ): Promise<{ access: NonNullable<AgentCodeRequest["access"]>; cwd: string }> => {
        const current = context.permission
        const requested = input.access ?? current
        const cwd = input.cwd ?? context.workspaceDir
        if ((ACCESS_RANK[requested] ?? 0) > (ACCESS_RANK[current] ?? 0)) {
            context.elog.action("[Agent] Agent请求执行命令", [
                {
                    label: "command",
                    value: [input.command, ...(input.argv ?? [])].join(" "),
                    code: true,
                },
                { label: "工作目录", value: cwd },
                { label: "权限", value: `${current} → ${requested}` },
            ])
            let allowed = context.allowExec
            if (!allowed && context.approveExec !== undefined) {
                allowed = await context.approveExec({
                    command: input.command,
                    argv: input.argv ?? [],
                    cwd,
                    currentPermission: current,
                    requestedPermission: requested,
                })
            }
            if (!allowed) {
                throw new Error("工具执行被拒绝")
            }
            context.elog.actionStatus("execute_code", "已允许")
        }
        return { access: requested, cwd }
    }
    return {
        async executeCode(input, explicitContext) {
            const context = explicitContext ?? getAgentToolContext()
            if (context === null) {
                throw new Error("executeCode 只能在 Agent 工具调用中使用")
            }
            const { access, cwd } = await approve(input, context)
            const result = await sandbox().runAgentCode({
                ...input,
                cwd,
                workspaceDir: context.workspaceDir,
                access,
            })
            context.elog.actionStatus("execute_code", `已完成 exit=${String(result.exitCode)}`)
            return result
        },
        async startBackgroundCode(input, explicitContext) {
            const context = explicitContext ?? getAgentToolContext()
            if (context === null) {
                throw new Error("startBackgroundCode 只能在 Agent 工具调用中使用")
            }
            const { access, cwd } = await approve(input, context)
            const handle = await sandbox().startAgentCode({
                ...input,
                cwd,
                workspaceDir: context.workspaceDir,
                access,
            })
            const info = registerBackgroundTask(handle)
            context.elog.actionStatus("execute_code", `后台任务 ${info.taskId}`)
            return { taskId: info.taskId, sandboxId: info.sandboxId }
        },
        queryTask(taskId?: string) {
            return queryTask(taskId)
        },
        stopTask(taskId: string | undefined, mode: StopMode) {
            return stopTask(taskId, mode)
        },
        async webSearch(query, count) {
            web ??= createDeepSeekWebClient({
                baseUrl: options.config.openai.baseUrl,
                timeoutMs: options.config.openai.timeoutMs,
                fetch: createProxyFetch(options.config.network.proxy) as typeof fetch | undefined,
            })
            const result = await web.search(query, count)
            return result.getData() ?? []
        },
        async webFetch(url) {
            web ??= createDeepSeekWebClient({
                baseUrl: options.config.openai.baseUrl,
                timeoutMs: options.config.openai.timeoutMs,
                fetch: createProxyFetch(options.config.network.proxy) as typeof fetch | undefined,
            })
            const result = await web.fetch(url)
            if (!result.isSuccess()) {
                throw new Error(result.getCode() ?? "web.fetch-failed")
            }
            const page = result.getData()
            if (page === null) {
                throw new Error("web.fetch-failed")
            }
            return page
        },
    }
}
