/*
 * 测试用插件：只注册一个 Agent 工具 probe
 *
 * mode=gate   先等 webSearch 闸门放行，再调 executeCode
 * mode=late   立即返回，稍后在调用链之外调 executeCode（插件定时器 / 后台续作）
 * mode=write  workspaceFs.writeText
 * mode=rooted fileRoots 写文件
 */

import type { AgentTool, PluginApi } from "wellspring/api/host/index.ts"

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function text(value: unknown): string {
    return typeof value === "string" ? value : ""
}

export function setup(): unknown {
    let api: PluginApi | null = null

    async function report(outcome: string): Promise<void> {
        if (api === null) {
            return
        }
        await api.capabilities.webSearch(`report:${outcome}`)
    }

    const probe: AgentTool = {
        name: "probe",
        introduction: {
            params: {
                mode: "gate / late / write / rooted",
                tag: "本次调用的标记",
                path: { type: "string", description: "写入路径", optional: true },
            },
            content: "测试用：验证 Agent 工具调用身份的传递",
        },
        async call(args) {
            const input = (args ?? {}) as Record<string, unknown>
            const mode = text(input["mode"])
            const tag = text(input["tag"])
            if (api === null) {
                return { success: false, data: { error: "插件未初始化" } }
            }
            const client = api
            if (mode === "gate") {
                // 闸门：测试放行前挂住，保证两次调用重叠
                await client.capabilities.webSearch(`gate:${tag}`)
                const result = (await client.capabilities.executeCode({
                    tag,
                } as never)) as unknown as Record<string, unknown>
                return { success: true, data: { tag, exitCode: result["exitCode"] ?? null } }
            }
            if (mode === "late") {
                if (input["gate"] === true) {
                    await client.capabilities.webSearch(`gate:${tag}`)
                }
                const delay = Number(input["delayMs"] ?? 0)
                setTimeout(
                    () => {
                        void (async () => {
                            try {
                                await client.capabilities.executeCode({ tag } as never)
                                await report(`late-ok:${tag}`)
                            } catch {
                                await report(`late-denied:${tag}`)
                            }
                        })()
                    },
                    Number.isFinite(delay) ? delay : 0,
                )
                return { success: true, data: { scheduled: true } }
            }
            if (mode === "write") {
                await client.capabilities.webSearch(`gate:${tag}`)
                const path = text(input["path"])
                try {
                    await client.workspaceFs.writeText(path, tag)
                    return { success: true, data: { tag, wrote: path } }
                } catch (error) {
                    return {
                        success: false,
                        data: {
                            tag,
                            error: error instanceof Error ? error.message : String(error),
                        },
                    }
                }
            }
            if (mode === "rooted") {
                const path = text(input["path"])
                const root = text(input["root"])
                try {
                    const fs = await client.fileRoots.open(root)
                    await fs.writeText(path, tag)
                    return { success: true, data: { tag, wrote: path } }
                } catch (error) {
                    return {
                        success: false,
                        data: {
                            tag,
                            error: error instanceof Error ? error.message : String(error),
                        },
                    }
                }
            }
            await sleep(1)
            return { success: true, data: { tag, mode } }
        },
    }

    return {
        id: "context-probe",
        name: "Context Probe Fixture",
        version: "1.0.0",
        status: "ok" as const,
        init(pluginApi: PluginApi) {
            api = pluginApi
            pluginApi.registerAgentTool?.(probe)
        },
    }
}
