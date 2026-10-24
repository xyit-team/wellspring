/*
 * Agent 提问：ask 工具把问题交给界面，等待用户回答后把答案还回工具循环。
 * 和提权审批一样是“一轮对话中途停下来等人”的机制，只是不需要权限判断。
 */

import { randomUUID } from "node:crypto"

/** 等待用户回答的上限；超时后工具返回“没有回答”并继续 */
export const ASK_TIMEOUT_MS = 5 * 60_000

interface PendingAsk {
    readonly sessionId: string
    readonly resolve: (answer: string | null) => void
    readonly timer: NodeJS.Timeout
}

const pending = new Map<string, PendingAsk>()

export function createAskId(): string {
    return `ask_${randomUUID()}`
}

/**
 * 登记一个等待回答的问题。answerAsk 先把 answer 交给这个 Promise；
 * 超时兑现 null（用户没回答）。
 */
export function waitForAsk(input: {
    readonly askId: string
    readonly sessionId: string
    readonly timeoutMs?: number
}): Promise<string | null> {
    return new Promise<string | null>((resolvePromise) => {
        let settled = false
        let timer: NodeJS.Timeout | null = null
        const finish = (answer: string | null): void => {
            if (settled) {
                return
            }
            settled = true
            if (timer !== null) {
                clearTimeout(timer)
            }
            pending.delete(input.askId)
            resolvePromise(answer)
        }
        timer = setTimeout(() => {
            finish(null)
        }, input.timeoutMs ?? ASK_TIMEOUT_MS)
        pending.set(input.askId, {
            sessionId: input.sessionId,
            resolve: finish,
            timer,
        })
    })
}

/** 用户回答；命中等待中的问题时返回 true */
export function answerAsk(askId: string, answer: string): boolean {
    const entry = pending.get(askId)
    if (entry === undefined) {
        return false
    }
    entry.resolve(answer)
    return true
}

/** 取消一次等待（工具循环收尾、异常退出时调用） */
export function cancelAsk(askId: string): void {
    const entry = pending.get(askId)
    if (entry === undefined) {
        return
    }
    entry.resolve(null)
}

/** 会话结束时清掉遗留的等待 */
export function cancelSessionAsks(sessionId: string): void {
    for (const [askId, entry] of [...pending]) {
        if (entry.sessionId === sessionId) {
            cancelAsk(askId)
        }
    }
}

/** 当前等待回答的数量（测试与诊断用） */
export function pendingAskCount(): number {
    return pending.size
}
