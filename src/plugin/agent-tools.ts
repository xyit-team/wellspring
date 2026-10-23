// 插件 Agent 工具注册表

import type { AgentTool } from "../api/host/plugin.ts"

const TOOL_NAME = /^[a-z][a-z0-9_-]{1,63}$/

export interface RegisteredAgentTool {
    readonly pluginId: string
    readonly tool: AgentTool
}

export class AgentToolRegistry {
    readonly #tools = new Map<string, RegisteredAgentTool>()

    register(pluginId: string, tool: AgentTool): void {
        if (!TOOL_NAME.test(tool.name)) {
            throw new Error(`Agent 工具名不合法：${tool.name}`)
        }
        if (this.#tools.has(tool.name)) {
            throw new Error(`Agent 工具重名：${tool.name}`)
        }
        if (typeof tool.call !== "function") {
            throw new Error(`Agent 工具缺少 call：${tool.name}`)
        }
        this.#tools.set(tool.name, { pluginId, tool })
    }

    list(): readonly RegisteredAgentTool[] {
        return [...this.#tools.values()]
    }

    get(name: string): RegisteredAgentTool | undefined {
        return this.#tools.get(name)
    }

    removePlugin(pluginId: string): void {
        for (const [name, record] of this.#tools) {
            if (record.pluginId === pluginId) {
                this.#tools.delete(name)
            }
        }
    }
}
