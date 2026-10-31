/*
 * 把一条回复拆成「正文段 + 过程行」的展示序列（纯逻辑，便于单测）。
 *
 * 过程行记着自己出现时的正文字符偏移（at），据此和正文按顺序穿插。
 * 这里也解释了为什么不能用最终 reply 覆盖正文：覆盖后偏移就对不上了，
 * 总结会插进代码调用中间。
 */

import type { ProcessItem } from "../types"

export type MessageBlock =
    | { readonly type: "md"; readonly text: string }
    | { readonly type: "proc"; readonly item: ProcessItem; readonly index: number }

export function messageBlocks(text: string, process: readonly ProcessItem[]): MessageBlock[] {
    const items = [...process].sort((left, right) => (left.at ?? 0) - (right.at ?? 0))
    const result: MessageBlock[] = []
    let offset = 0
    items.forEach((item, index) => {
        const at = Math.min(Math.max(item.at ?? 0, offset), text.length)
        if (at > offset) {
            result.push({ type: "md", text: text.slice(offset, at) })
            offset = at
        }
        result.push({ type: "proc", item, index })
    })
    if (offset < text.length) result.push({ type: "md", text: text.slice(offset) })
    return result
}
