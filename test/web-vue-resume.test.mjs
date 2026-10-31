/*
 * 刷新续接判定：这一轮还在不在跑以服务端 active 为准，本地标记只作兜底。
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { normalizeConversation } from "../plugins/wellspring-web/frontend/src/logic/conversations.ts"
import {
    isNetworkError,
    retryDelayMs,
    serverAhead,
    shouldProbeAfterStream,
    shouldSettle,
    shouldTakeover,
    unfinished,
} from "../plugins/wellspring-web/frontend/src/logic/resume.ts"

const assistant = (extra = {}) => ({ role: "assistant", text: "半截", at: 1, ...extra })
const user = (extra = {}) => ({ role: "user", text: "问题", at: 1, ...extra })

test("shouldTakeover：服务端说还在跑就一定接管", () => {
    assert.equal(shouldTakeover(true, null), true)
    assert.equal(shouldTakeover(true, assistant()), true)
    assert.equal(shouldTakeover(true, assistant({ stopped: true })), true)
    assert.equal(shouldTakeover(true, user()), true)
})

test("shouldTakeover：服务端已收尾时只接管本地半截的会话", () => {
    // 刷新时 PUT 没落地：服务端只剩「半截 + stopped」，本地也没有 interrupted
    // 这正是之前漏掉的组合——正文停在半路却不再续接
    assert.equal(shouldTakeover(false, assistant({ stopped: true })), false)
    assert.equal(shouldTakeover(false, assistant({ interrupted: true })), true)
    assert.equal(shouldTakeover(false, assistant({ streaming: true })), true)
    assert.equal(shouldTakeover(false, user()), true)
    assert.equal(shouldTakeover(false, null), false)
})

test("unfinished：正常完成的回复不算中断", () => {
    assert.equal(unfinished(assistant({ turn: 1, steps: 2 })), false)
    assert.equal(unfinished(assistant({ error: "boom" })), false)
    assert.equal(unfinished(assistant({ stopped: true })), false)
    // 没有 turn 号不能当成没跑完（CLI / 旧版会话没有这个字段）
    assert.equal(unfinished(assistant()), false)
})

test("unfinished：被打断或仍在流式的回复算中断", () => {
    assert.equal(unfinished(assistant({ interrupted: true })), true)
    assert.equal(unfinished(assistant({ streaming: true })), true)
    // interrupted 优先于 stopped：归一化会把进行中的消息一并标成 stopped
    assert.equal(unfinished(assistant({ interrupted: true, stopped: true })), true)
    assert.equal(unfinished(user()), true)
})

test("shouldSettle：服务端已收尾且本地半截才收尾成已停止", () => {
    assert.equal(shouldSettle(true, assistant({ interrupted: true })), false)
    assert.equal(shouldSettle(false, assistant({ interrupted: true })), true)
    assert.equal(shouldSettle(false, assistant({ streaming: true })), true)
    assert.equal(shouldSettle(false, assistant({ turn: 1 })), false)
})

test("normalizeConversation：保留思考的起止时间（刷新后仍能显示耗时）", () => {
    const conv = normalizeConversation({
        id: "c1",
        title: "t",
        createdAt: 1,
        updatedAt: 2,
        messages: [
            {
                role: "assistant",
                text: "答",
                at: 1,
                process: [
                    {
                        kind: "reasoning",
                        text: "想一想",
                        at: 0,
                        startedAt: 1793293000000,
                        endedAt: 1793293002500,
                    },
                ],
            },
        ],
    })
    assert.ok(conv !== null)
    const item = conv.messages[0].process[0]
    assert.equal(item.startedAt, 1793293000000)
    assert.equal(item.endedAt, 1793293002500)
    assert.equal(item.running, undefined)
})

test("isNetworkError：浏览器原文与登录/主动中止的区分", () => {
    // 挂后台/切网/服务重启时浏览器抛的原文
    assert.equal(isNetworkError(new TypeError("Failed to fetch")), true)
    assert.equal(isNetworkError(new Error("network error")), true)
    assert.equal(isNetworkError(new Error("Load failed")), true)
    assert.equal(isNetworkError(new Error("net::ERR_INTERNET_DISCONNECTED")), true)
    // 主动中止不是故障
    assert.equal(isNetworkError(new DOMException("aborted", "AbortError")), false)
    // 登录失效要跳登录，不能当网络抖动重试
    const auth = new Error("登录状态已失效，请重新登录")
    auth.name = "AuthError"
    assert.equal(isNetworkError(auth), false)
    // 正常的业务错误照常显示
    assert.equal(isNetworkError(new Error("HTTP 500")), false)
    assert.equal(isNetworkError(null), false)
})

test("retryDelayMs：退避递增且有上限", () => {
    assert.equal(retryDelayMs(0), 600)
    assert.equal(retryDelayMs(1), 1200)
    assert.equal(retryDelayMs(2), 2400)
    assert.equal(retryDelayMs(9), 5000, "上限 5 秒")
    assert.equal(retryDelayMs(-1), 600)
})

test("shouldProbeAfterStream：流提前结束要再问一次服务端", () => {
    const base = {
        terminalSeen: false,
        stoppedByUser: false,
        networkDropped: false,
        pageUnloading: false,
    }
    // 工具调用超时 / 反代静默截断：SSE 结束了但没等到 done，服务端那一轮还在跑
    assert.equal(shouldProbeAfterStream(base), true)
    // 读到过 done / error / stopped 就是正常收尾
    assert.equal(shouldProbeAfterStream({ ...base, terminalSeen: true }), false)
    // 用户点停止、网络断了、页面在卸载：各有各的收尾路径
    assert.equal(shouldProbeAfterStream({ ...base, stoppedByUser: true }), false)
    assert.equal(shouldProbeAfterStream({ ...base, networkDropped: true }), false)
    assert.equal(shouldProbeAfterStream({ ...base, pageUnloading: true }), false)
})

test("serverAhead：服务端跑在前面就该立刻增量重放", () => {
    // 原始流：base 0，收到的条数就是本地进度
    assert.equal(serverAhead(3, 3, 0), false)
    assert.equal(serverAhead(4, 3, 0), true)
    // 续接流：since=2 起放，第一条 resume 标记不算本轮事件（base 传 since-1 抵消）
    assert.equal(serverAhead(5, 4, 1), false)
    assert.equal(serverAhead(6, 4, 1), true)
    // 拿不到进度时不重放，避免误判
    assert.equal(serverAhead(null, 0, 0), false)
})
