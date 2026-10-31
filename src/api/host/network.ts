/*
 * 宿主网络配置：给插件（例如网页设置页）读写 app-setting.json 的 network.proxy。
 *
 * 只处理出站 HTTP/HTTPS 代理；保存后下一轮模型调用、模型列表拉取与网页搜索都会使用新配置。
 */

import type { ProxySetting } from "../../config/types.ts"

/** 保存代理：url 为空 / null 表示直连 */
export interface HostNetworkProxyInput {
    readonly url: string | null
    /** 不走代理的主机后缀，例如 localhost、.internal */
    readonly noProxy?: readonly string[]
}

export interface HostNetworkState {
    /** null 表示直连 */
    readonly proxy: ProxySetting | null
}

export interface HostNetworkResult {
    readonly ok: boolean
    /** ok=false 时的错误码，例如 config.invalid:network.proxy.url */
    readonly code?: string
    readonly state: HostNetworkState
}

export interface HostNetworkApi {
    state(): Promise<HostNetworkState>
    /** 写入 app-setting.json；校验失败时不落盘 */
    saveProxy(input: HostNetworkProxyInput): Promise<HostNetworkResult>
}
