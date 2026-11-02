import type { PluginApi } from "wellspring/api/host/index.ts"

// 侧栏扩展点：订阅其它插件通过事件总线注册的 nav-bottom 链接
import "./src/addon.ts"
import { configureServer } from "./src/server.ts"

export function setup() {
    return {
        id: "wellspring-web",
        name: "Wellspring Web 插件",
        version: "1.21.0",
        status: "ok" as const,
        deps: ["wellspring-http"],
        init: async (api: PluginApi) => {
            await configureServer(api)
        },
    }
}
