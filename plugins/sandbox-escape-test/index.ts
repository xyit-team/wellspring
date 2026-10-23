/*
 * Sandbox 越权测试插件。
 * 每个 probe 都尝试一种“不该被允许”的操作；失败才是期望结果。
 */

import type { PluginApi, PluginCommandContext } from "wellspring/api/host/index.ts"

interface ProbeResult {
    name: string
    allowed: boolean
    detail: string
}

async function probe(name: string, task: () => unknown | Promise<unknown>): Promise<ProbeResult> {
    try {
        await task()
        return { name, allowed: true, detail: "操作成功（不应该）" }
    } catch (error) {
        return {
            name,
            allowed: false,
            detail: error instanceof Error ? error.message : String(error),
        }
    }
}

export function setup() {
    return {
        id: "sandbox-escape-test",
        name: "Sandbox Escape Test",
        version: "0.1.0",
        status: "ok" as const,
        init: (api: PluginApi) => {
            api.logger.info("escape-test 初始化")
        },
        commands: [
            {
                name: "escape-test",
                summary: "尝试 sandbox 禁止的文件/进程/网络操作",
                run: async (ctx: PluginCommandContext) => {
                    const results: ProbeResult[] = []

                    results.push(
                        await probe("import node:fs", async () => {
                            await import("node:fs")
                        }),
                    )
                    results.push(
                        await probe("import node:child_process", async () => {
                            await import("node:child_process")
                        }),
                    )
                    results.push(
                        await probe("process.getBuiltinModule('node:fs') 读 /etc/passwd", () => {
                            const fs = (
                                process as unknown as {
                                    getBuiltinModule(name: string): typeof import("node:fs")
                                }
                            ).getBuiltinModule("node:fs")
                            fs.readFileSync("/etc/passwd")
                        }),
                    )
                    results.push(
                        await probe(
                            "process.getBuiltinModule('node:child_process') 执行 id",
                            () => {
                                const processModule = (
                                    process as unknown as {
                                        getBuiltinModule(
                                            name: string,
                                        ): typeof import("node:child_process")
                                    }
                                ).getBuiltinModule("node:child_process")
                                processModule.execSync("id")
                            },
                        ),
                    )
                    results.push(
                        await probe("ctx.fs 路径穿越", async () => {
                            await ctx.fs.readText("../../../../etc/passwd")
                        }),
                    )
                    results.push(
                        await probe("ctx.workspaceFs 写文件", async () => {
                            await ctx.workspaceFs.writeText("escape.txt", "escape")
                        }),
                    )
                    results.push(
                        await probe("网络 fetch", async () => {
                            await fetch("http://1.1.1.1", {
                                signal: AbortSignal.timeout(1500),
                            })
                        }),
                    )

                    // 这是被允许的：插件自己的 data 目录
                    await ctx.fs.writeText("allowed.txt", "ok")
                    results.push({
                        name: "ctx.fs 写插件 data",
                        allowed: true,
                        detail: "允许",
                    })

                    for (const result of results) {
                        const tag = result.allowed ? "ALLOWED" : "DENIED"
                        ctx.output.info(`[${tag}] ${result.name}: ${result.detail}`)
                    }
                    const violations = results.filter(
                        (result) => result.allowed && !result.name.includes("插件 data"),
                    )
                    return violations.length === 0 ? 0 : 1
                },
            },
        ],
    }
}
