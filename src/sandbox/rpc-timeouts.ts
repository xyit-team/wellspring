/*
 * 插件 sandbox（child）→ 宿主（host）方向 RPC 的超时策略。
 * 单位毫秒；null 表示不设上限，时长由被调用能力自己的步骤/网络超时兜底。
 */

export interface RpcTimeouts {
    /** 普通 RPC：文件、事件、HTTP 建服务、插件数据等 */
    readonly default: number
    /** Agent 单轮对话（非流式）：耗时取决于模型与工具步骤 */
    readonly agentChat: number
    /** Agent 流式对话：一轮可能持续很久，不设上限 */
    readonly agentStream: number | null
    /** 拉取供应商模型列表：要等网络超时与重试 */
    readonly modelsFetch: number
}

export const RPC_TIMEOUT_MS: RpcTimeouts = {
    default: 30_000,
    agentChat: 180_000,
    agentStream: null,
    modelsFetch: 120_000,
}
