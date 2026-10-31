import type { PluginApi } from "wellspring/api/host/index.ts"

import { configureServer } from "./src/server.ts"

export function setup() {
    return {
        id: "wellspring-code",
        name: "Wellspring Code",
        description: "工作区文件浏览器、代码编辑器与搜索，全部在浏览器里",
        version: "1.18.0",
        deps: ["wellspring-http"],
        status: "ok" as const,
        init: async (api: PluginApi) => {
            await configureServer(api)
        },
    }
}
