// 插件可用的宿主能力：sandbox 代码执行与网络工具

import type { Logger } from "pino"

import { loadSettings } from "../config/loader.ts"
import type { AppSetting } from "../config/types.ts"
import { credentialsFile, resolveApiKeySync } from "../config/credentials.ts"
import {
    WEB_CODES,
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
    /** 配置文件路径；提供时每次联网工具调用都重读，网页里改的代理不需要重启 */
    readonly settingsFile?: string
}

const ACCESS_RANK: Readonly<Record<string, number>> = {
    "read-only": 0,
    "workspace-write": 1,
    "danger-full-access": 2,
}

export function createHostCapabilities(options: HostCapabilitiesOptions): HostCapabilities {
    let manager: SandboxManager | null = null
    let web: ReturnType<typeof createDeepSeekWebClient> | null = null
    let webCacheKey: string | null = null

    /** 联网工具用默认供应商（OpenAI/DeepSeek）的 Key：环境变量 > credentials.json */
    const resolveWebApiKey = (): string | null =>
        resolveApiKeySync(credentialsFile(options.paths.configDir))?.apiKey ?? null

    /** 配置文件可能存在网页/CLI 运行中修改（Key、Base URL、代理）：每次调用重读 */
    const currentConfig = async (): Promise<AppSetting> => {
        if (options.settingsFile === undefined) return options.config
        try {
            const loaded = await loadSettings(options.settingsFile)
            return loaded.getData() ?? options.config
        } catch {
            return options.config
        }
    }

    /** Key / 代理 / Base URL 都可能在运行中变化，缓存按这些字段失效 */
    const webClient = async (): Promise<ReturnType<typeof createDeepSeekWebClient>> => {
        const config = await currentConfig()
        const apiKey = resolveWebApiKey()
        const proxy = config.network.proxy
        const cacheKey = [
            apiKey ?? "",
            config.openai.baseUrl ?? "",
            String(config.openai.timeoutMs),
            proxy?.url ?? "",
            (proxy?.noProxy ?? []).join(","),
        ].join("|")
        if (web === null || webCacheKey !== cacheKey) {
            webCacheKey = cacheKey
            web = createDeepSeekWebClient({
                baseUrl: config.openai.baseUrl,
                timeoutMs: config.openai.timeoutMs,
                fetch: createProxyFetch(proxy) as typeof fetch | undefined,
                ...(apiKey === null ? {} : { apiKey }),
            })
        }
        return web
    }

    const webError = (code: string | null, action: string): Error => {
        if (code === WEB_CODES.missingApiKey) {
            return new Error(
                "web.missing-api-key：联网工具缺少 API Key。设置环境变量 OPENAI_API_KEY，或运行 wellspring key set（网页：左下角「供应商」里填写该供应商的 Key）",
            )
        }
        return new Error(code ?? `web.${action}-failed`)
    }
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
        /** 调用方是 startAgentCode（后台任务）而不是 runAgentCode */
        background = false,
    ): Promise<{ access: NonNullable<AgentCodeRequest["access"]>; cwd: string }> => {
        const current = context.permission
        const requested = input.access ?? current
        const cwd = input.cwd ?? context.workspaceDir
        if ((ACCESS_RANK[requested] ?? 0) > (ACCESS_RANK[current] ?? 0)) {
            const argv = input.argv ?? []
            const stdin = typeof input.stdin === "string" ? input.stdin.trim() : ""
            /*
             * 参数逐个列出，而不是把 command 和 argv 拼成一行：
             * 「bash -lc 'curl … | sh'」里危险的是参数边界，拼行会看不出引号归属。
             */
            context.elog.action("请求执行命令", [
                { label: "command", value: input.command, code: true },
                ...argv.map((arg, index) => ({
                    label: `参数 ${index + 1}`,
                    value: arg,
                    code: true,
                })),
                { label: "工作目录", value: cwd },
                { label: "权限", value: `${current} → ${requested}` },
                ...(input.network === true ? [{ label: "网络", value: "请求联网" }] : []),
                ...(background ? [{ label: "运行方式", value: "后台执行" }] : []),
                ...(typeof input.timeoutMs === "number"
                    ? [{ label: "超时", value: `${Math.round(input.timeoutMs / 1000)} 秒` }]
                    : []),
                ...(stdin === ""
                    ? []
                    : [
                          {
                              label: "标准输入",
                              value: stdin.length > 200 ? `${stdin.slice(0, 200)}…` : stdin,
                              code: true,
                          },
                      ]),
            ])
            let allowed = context.allowExec
            if (!allowed && context.approveExec !== undefined) {
                allowed = await context.approveExec({
                    command: input.command,
                    argv: input.argv ?? [],
                    cwd,
                    currentPermission: current,
                    requestedPermission: requested,
                    justification: input.justification,
                    ...(input.network === true ? { network: true } : {}),
                    ...(background ? { background: true } : {}),
                    ...(typeof input.stdin === "string" && input.stdin !== ""
                        ? { stdin: input.stdin }
                        : {}),
                    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
                })
            }
            if (!allowed) {
                throw new Error("工具执行被拒绝")
            }
            context.elog.toolResult("已允许提权")
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
            if (result.exitCode !== 0) {
                context.elog.toolResult(`exit=${String(result.exitCode)}`)
            }
            return result
        },
        async startBackgroundCode(input, explicitContext) {
            const context = explicitContext ?? getAgentToolContext()
            if (context === null) {
                throw new Error("startBackgroundCode 只能在 Agent 工具调用中使用")
            }
            const { access, cwd } = await approve(input, context, true)
            const handle = await sandbox().startAgentCode({
                ...input,
                cwd,
                workspaceDir: context.workspaceDir,
                access,
            })
            const info = registerBackgroundTask(handle)
            context.elog.toolResult(`后台任务 ${info.taskId}`)
            return { taskId: info.taskId, sandboxId: info.sandboxId }
        },
        queryTask(taskId?: string) {
            return queryTask(taskId)
        },
        stopTask(taskId: string | undefined, mode: StopMode) {
            return stopTask(taskId, mode)
        },
        async webSearch(query, count) {
            const client = await webClient()
            const result = await client.search(query, count)
            if (!result.isSuccess()) {
                throw webError(result.getCode(), "search")
            }
            return result.getData() ?? []
        },
        async webFetch(url) {
            const client = await webClient()
            const result = await client.fetch(url)
            if (!result.isSuccess()) {
                throw webError(result.getCode(), "fetch")
            }
            const page = result.getData()
            if (page === null) {
                throw webError(null, "fetch")
            }
            return page
        },
    }
}
