/*
 * 刷新/断线后的续接判定（纯逻辑，便于单测）。
 *
 * 这一轮还在不在跑只有服务端知道：前端本地的 interrupted / stopped 标记
 * 依赖关页前的 PUT 落盘，而那个请求经常随页面卸载被取消。
 * 所以「是否接管」以服务端的 active 为准，本地标记只用于兜底提示。
 */

import type { MarkdownMessage } from "../types"

/** 服务端是否说这一轮还在跑 */
export function shouldTakeover(active: boolean, tail: MarkdownMessage | null): boolean {
    if (active) return true
    // 服务端说已经收尾：本地若明显停在半路，仍然接管一次把内容对齐
    return tail !== null && unfinished(tail)
}

/**
 * 本地看这一轮是不是停在半路：最后一条是还没回复的用户消息，
 * 或回复带着刷新打断（interrupted）/ 仍在流式（streaming）的标记。
 *
 * 不看 turn 号：CLI 与旧版会话的回复没有这个字段，不能据此当成没跑完。
 * interrupted 优先于 stopped：归一化会把进行中的消息一并标成 stopped。
 */
export function unfinished(message: MarkdownMessage): boolean {
    if (message.role === "user") return true
    if (message.role !== "assistant") return false
    if (message.error !== undefined) return false
    if (message.interrupted === true) return true
    if (message.stopped === true) return false
    return message.streaming === true
}

/** 服务端已收尾、本地内容却不完整：该把回复收尾成「已停止」 */
export function shouldSettle(active: boolean, tail: MarkdownMessage): boolean {
    return !active && unfinished(tail)
}

/**
 * 是不是「网络层」错误（连接被切断、手机切网、服务重启…）
 *
 * 这类错误不代表这一轮失败：服务端那一轮可能还在跑，
 * 该做的是重连续接，而不是把浏览器原文（Chrome 的 network error /
 * Failed to fetch、Safari 的 Load failed）当成回复失败写进消息里。
 */
export function isNetworkError(error: unknown): boolean {
    if (error === null || error === undefined) return false
    // 主动 abort（用户点停止、页面卸载）不是网络故障
    if (typeof DOMException !== "undefined" && error instanceof DOMException) {
        return error.name !== "AbortError"
    }
    // 登录失效要跳登录页，不能当成网络抖动重试
    if (error instanceof Error && (error.name === "AuthError" || error.name === "AbortError")) {
        return false
    }
    if (error instanceof TypeError) return true
    if (error instanceof Error) {
        return /network|failed to fetch|load failed|networkerror|err_internet|err_connection|err_network/i.test(
            error.message,
        )
    }
    return false
}

/**
 * 流读完了却没收到收尾事件（done / error / stopped）
 *
 * 工具调用超时、反向代理静默截断、宿主重启都会让 SSE 提前结束，而服务端那一轮
 * 可能还在跑：事件继续写进本轮缓冲，页面却停在半路不动（看不到报错，也不再滚动）。
 * 这种情况必须再问一次服务端（`/api/chat/resume`），不能当成正常收尾放过。
 *
 * 用户自己点停止、网络层中断、页面正在卸载都不算：它们各有各的收尾路径。
 */
export function shouldProbeAfterStream(options: {
    /** 读到过 done / error / stopped 之一 */
    readonly terminalSeen: boolean
    /** 用户点过停止 */
    readonly stoppedByUser: boolean
    /** 网络层断了（已按退避重试） */
    readonly networkDropped: boolean
    /** 页面正在卸载/刷新 */
    readonly pageUnloading: boolean
}): boolean {
    if (options.terminalSeen) return false
    if (options.stoppedByUser || options.networkDropped || options.pageUnloading) return false
    return true
}

/**
 * 服务端是不是已经跑在本地前面
 *
 * received 是这条流里已回调的 data 事件数，base 是这条流开始前服务端已有的条数。
 * 原始流 base 为 0；续接流多一条 resume 标记（不在本轮事件缓冲里），调用方把 base
 * 传 since - 1 抵消它。true 表示有事件没送到，该立刻增量重放，而不是等这一轮跑完。
 */
export function serverAhead(total: number | null, received: number, base: number): boolean {
    return total !== null && total > base + received
}

/** 重试退避：0.6s → 1.2s → 2.4s，最多 5s */
export function retryDelayMs(attempt: number, base = 600): number {
    const index = Math.max(0, Math.floor(attempt))
    return Math.min(base * 2 ** index, 5000)
}
