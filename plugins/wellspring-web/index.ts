import type { PluginApi } from "wellspring/api/host/index.ts"

import { configureServer } from "./src/server.ts"

export function setup() {
    return {
        id: "wellspring-web",
        name: "Wellspring Web 插件",
        version: "1.0.0",
        status: "ok" as const,
        init: (api: PluginApi) => {
            configureServer(api)
        },
    }
}
