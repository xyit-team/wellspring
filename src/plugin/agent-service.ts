/*
 * 宿主 Agent 服务：给 sandbox 插件提供聊天入口。
 * 复用 CLI 的会话存储与 Agent 轮次，不经过 stdout/readline。
 */

import { join } from "node:path"

import type { HostAgentApi, HostAgentChatInput, HostAgentChatResult } from "../api/host/agent.ts"
import type { CommandContext } from "../commands/shared.ts"
import { executeTurn } from "../commands/conversation.ts"
import { SETTING_FILE_NAME } from "../config/loader.ts"
import type { AppSetting } from "../config/types.ts"
import { getElog } from "../logger/elog4js.ts"
import type { Logger } from "pino"
import type { OpenAIClient } from "../network/openai.ts"
import { initOpenAIClient } from "../network/openai.ts"
import { createProxyFetch } from "../network/proxy.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import type { AgentToolRegistry } from "./agent-tools.ts"
import type { PluginRegistry } from "./registry.ts"
import { registerSession } from "../session/registry.ts"
import { Session } from "../session/session.ts"
import { SessionStore } from "../session/store.ts"

export interface HostAgentServiceOptions {
    readonly settings: AppSetting
    readonly paths: ResolvedPaths
    readonly logger: Logger
    readonly registry: PluginRegistry
    readonly agentTools: AgentToolRegistry
    readonly cwd?: string
}

export interface HostAgentService extends HostAgentApi {
    chat(input: HostAgentChatInput): Promise<HostAgentChatResult>
}

export function createHostAgentService(options: HostAgentServiceOptions): HostAgentService {
    const cwd = options.cwd ?? process.cwd()
    const store = new SessionStore()
    const queues = new Map<string, Promise<unknown>>()
    let client: OpenAIClient | null = null

    const openai = (): OpenAIClient => {
        if (client !== null) {
            return client
        }
        const result = initOpenAIClient({
            settings: options.settings.openai,
            logger: options.logger.child({ module: "openai" }),
            fetch: createProxyFetch(options.settings.network.proxy),
        })
        const created = result.getData()
        if (!result.isSuccess() || created === null) {
            throw new Error(result.getCode() ?? "openai.missing-api-key")
        }
        client = created
        return created
    }

    const context = (): CommandContext => ({
        global: { json: true, quiet: true, help: false, version: false },
        settings: options.settings,
        settingsFile: join(options.paths.configDir, SETTING_FILE_NAME),
        configCode: null,
        paths: options.paths,
        logger: options.logger,
        elog: getElog(),
        registry: options.registry,
        agentTools: options.agentTools,
        openai: openai(),
        loadPlugins: async () => [],
    })

    const chatOnce = async (input: HostAgentChatInput): Promise<HostAgentChatResult> => {
        const message = input.message.trim()
        if (message === "") {
            throw new Error("消息不能为空")
        }
        const model = input.model ?? options.settings.openai.model
        const data =
            input.sessionId === undefined
                ? await store.create({ cwd, model })
                : await store.open(input.sessionId, cwd)
        registerSession(new Session(data, store))
        const result = await executeTurn({
            ctx: context(),
            client: openai(),
            store,
            session: data,
            mode: "run",
            input: message,
            model,
            system: input.system,
            stream: false,
            display: false,
            allowExec: false,
            permission: options.settings.sandbox.access,
        })
        if (!result.isSuccess()) {
            throw new Error(result.getCode() ?? "agent.failed")
        }
        const turn = result.getData()
        if (turn === null) {
            throw new Error("agent.empty-result")
        }
        return {
            sessionId: turn.sessionId,
            reply: turn.reply,
            model: turn.model,
            usage: turn.usage,
        }
    }

    return {
        async chat(input) {
            const key = input.sessionId ?? "new"
            const previous = queues.get(key) ?? Promise.resolve()
            const next = previous.then(
                async () => await chatOnce(input),
                async () => await chatOnce(input),
            )
            queues.set(
                key,
                next.catch(() => undefined),
            )
            const result = await next
            if (input.sessionId === undefined) {
                queues.delete(key)
                queues.set(result.sessionId, Promise.resolve(result))
            }
            return result
        },
    }
}
