import type { PluginApi } from "wellspring/api/host/index.ts"

import { configureHttpBus } from "./src/server.ts"

export function setup() {
    return {
        id: "wellspring-http",
        name: "Wellspring HTTP",
        description: "统一创建与管理平台内 HTTP/HTTPS 服务器（唯一持有 hostApi.http 的插件）",
        version: "1.0.0",
        status: "ok" as const,
        init: async (api: PluginApi) => {
            await configureHttpBus(api)
        },
    }
}
