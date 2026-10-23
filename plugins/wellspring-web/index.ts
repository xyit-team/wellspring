import type { PluginApi } from "wellspring/api/host"

export let api: PluginApi

export function setup() {
    return {
        id: "wellspring-web",
        name: "Wellspring Web 插件",
        version: "1.0.0",
        status: "ok" as const,
    }
}
