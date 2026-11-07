// 宿主网络配置服务：读写 app-setting.json 的 network.proxy
// 只写这一个字段，其余配置原样保留；写入前经过 validateSettings，非法 URL / noProxy 不落盘
// 模型调用、拉模型、网页搜索每轮重读配置，保存后下一轮请求生效

import type { Logger } from "pino"

import type { HostNetworkApi, HostNetworkResult, HostNetworkState } from "../api/host/network.ts"
import { CONFIG_CODES, invalidCode } from "../config/codes.ts"
import { loadSettings, saveSettings } from "../config/loader.ts"
import type { AppSetting, ProxySetting } from "../config/types.ts"

const MAX_NO_PROXY = 100
const MAX_NO_PROXY_LENGTH = 256

export interface HostNetworkServiceOptions {
    /** 启动时的配置；配置文件不存在或读取失败时回退到它 */
    readonly settings: AppSetting
    readonly settingsFile: string
    readonly logger?: Logger
}

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value)
        return url.protocol === "http:" || url.protocol === "https:"
    } catch {
        return false
    }
}

/** noProxy 归一：去空、去重、限长 */
function normalizeNoProxy(values: readonly string[] | undefined): string[] {
    const result: string[] = []
    for (const raw of values ?? []) {
        if (typeof raw !== "string") continue
        const value = raw.trim()
        if (value === "" || value.length > MAX_NO_PROXY_LENGTH) continue
        if (result.includes(value)) continue
        if (result.length >= MAX_NO_PROXY) break
        result.push(value)
    }
    return result
}

export function createHostNetworkService(options: HostNetworkServiceOptions): HostNetworkApi {
    const currentSettings = async (): Promise<AppSetting> => {
        try {
            const loaded = await loadSettings(options.settingsFile)
            return loaded.getData() ?? options.settings
        } catch {
            return options.settings
        }
    }

    const stateOf = (settings: AppSetting): HostNetworkState => ({
        proxy: settings.network.proxy,
    })

    return {
        async state(): Promise<HostNetworkState> {
            return stateOf(await currentSettings())
        },

        async saveProxy(input): Promise<HostNetworkResult> {
            const settings = await currentSettings()
            const rawUrl = typeof input.url === "string" ? input.url.trim() : ""
            if (rawUrl !== "" && !isHttpUrl(rawUrl)) {
                return {
                    ok: false,
                    code: invalidCode("network.proxy.url"),
                    state: stateOf(settings),
                }
            }
            let proxy: ProxySetting | null = null
            if (rawUrl !== "") {
                proxy = {
                    type: "http",
                    url: rawUrl,
                    noProxy: normalizeNoProxy(input.noProxy),
                }
            }
            const next: AppSetting = { ...settings, network: { proxy } }
            const saved = await saveSettings(next, options.settingsFile)
            if (!saved.isSuccess()) {
                return {
                    ok: false,
                    code: saved.getCode() ?? CONFIG_CODES.invalid,
                    state: stateOf(settings),
                }
            }
            options.logger?.info(
                { proxy: proxy?.url ?? null, noProxy: proxy?.noProxy ?? [] },
                proxy === null ? "已关闭 HTTP 代理" : "已更新 HTTP 代理",
            )
            return { ok: true, state: stateOf(next) }
        },
    }
}
