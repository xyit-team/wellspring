/*
 * Wellspring 官方示例插件。
 * 演示：顶层注册钩子、setup() 返回元信息、插件命令、onInit / onShutdown。
 */

import {
    onMessage,
    onInit,
    onShutdown,
    type PluginApi,
    type WellspringPlugin,
} from "wellspring/api/host/index.ts"

// 钩子可以放在模块顶层；平台 import 时会归属到当前插件
onMessage(({ phase, prompt }) => {
    if (phase !== "before") return
    prompt.push("你是一个运行在 Wellspring 里的助手")
})

export function setup(): WellspringPlugin {
    onInit(() => {
        // wellspring start 时触发；可以在这里启动插件自己的服务
    })
    onShutdown(() => {
        // wellspring start 关闭时触发
    })

    const plugin = {
        id: "hello-plugin",
        name: "Hello Plugin",
        version: "0.1.0",
        deps: [],
        status: "ok" as const,
        commands: [
            {
                name: "hello",
                summary: "Wellspring 示例命令",
                usage: "wellspring hello [args...]",
                run: (ctx) => {
                    ctx.output.info(`hello from plugin, argv=${ctx.argv.join(",")}`)
                    return 0
                },
            },
        ],
        init: (api: PluginApi) => {
            api.logger.debug({ id: api.plugin.id }, "hello-plugin init")
        },
    } satisfies WellspringPlugin

    return plugin
}
