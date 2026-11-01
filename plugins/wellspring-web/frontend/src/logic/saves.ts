/*
 * 会话落盘追踪（纯逻辑，便于单测）。
 *
 * 会话内容靠 PUT 存回服务端，而列表是按工作区整份重新拉取的。切走再切回来时，
 * 如果那一轮刚好在两次请求之间收尾，服务端快照还是上一版——界面就会少最后一条回复。
 * 所以「已经发出、还没落地」的会话要记下来：落地前继续用本地对象。
 */

/** 一次保存的凭据：只有最后一次保存成功才算真正落地 */
export interface SaveTracker<T extends { id: string }> {
    /** 开始一次保存，返回这次保存的凭据 */
    begin(value: T): number
    /** 保存成功：清掉这一条，之后的列表加载以服务端为准 */
    settle(id: string, token: number): void
    /** 还可能有更新内容只在本地：id → 本地对象 */
    pending(): Map<string, T>
}

export function createSaveTracker<T extends { id: string }>(): SaveTracker<T> {
    const entries = new Map<string, { value: T; token: number }>()
    let sequence = 0
    return {
        begin(value) {
            sequence += 1
            entries.set(value.id, { value, token: sequence })
            return sequence
        },
        settle(id, token) {
            const entry = entries.get(id)
            // 期间又发起过保存：那条更新的内容还在路上，不能当成已落地
            if (entry === undefined || entry.token !== token) return
            entries.delete(id)
        },
        pending() {
            const result = new Map<string, T>()
            for (const [id, entry] of entries) result.set(id, entry.value)
            return result
        },
    }
}
