/*
 * 长会话的显示窗口：只渲染最近若干轮，更早的折在「加载更早」后面。
 *
 * 为什么按「轮」而不是按「条」切：
 * 一条 user 消息开启一轮，后面跟着 assistant 回复、工具行与插话行。
 * 按消息条数切，切点会落在轮中间——用户看到的第一条是没有提问的回复，
 * 上下文是断的。所以这里所有切点都吸附到「轮起点」。
 *
 * 这里全部是纯函数：渲染期不写任何状态，避免 computed 里的副作用把渲染打回自激。
 */

/** 一轮的范围；end 不含 */
export interface RoundSpan {
    readonly start: number
    readonly end: number
}

/** 只关心 role，方便测试与复用 */
export interface MessageLike {
    readonly role: string
}

/**
 * 把消息序列切成轮
 *
 * 每条 user 消息开启新一轮，它之后的 assistant / 工具行都归这一轮；
 * 第一条消息无论是什么角色都开启第一轮（历史数据里可能有以回复开头的会话）。
 */
export function rounds(messages: readonly MessageLike[]): RoundSpan[] {
    if (messages.length === 0) return []
    const spans: RoundSpan[] = []
    let start = 0
    for (let index = 1; index < messages.length; index += 1) {
        if (messages[index]?.role !== "user") continue
        spans.push({ start, end: index })
        start = index
    }
    spans.push({ start, end: messages.length })
    return spans
}

/**
 * 把任意消息下标吸附到它所在轮的起点
 *
 * 存下来的窗口起点可能因为会话被裁剪而落到轮中间，渲染前统一吸附一次。
 */
export function alignToRound(messages: readonly MessageLike[], index: number): number {
    if (messages.length === 0) return 0
    const target = Math.min(Math.max(0, Math.floor(index) || 0), messages.length - 1)
    for (let cursor = target; cursor > 0; cursor -= 1) {
        if (messages[cursor]?.role === "user") return cursor
    }
    return 0
}

/**
 * 默认窗口的起点：保留最近 visibleRounds 轮
 *
 * 会话不超过 visibleRounds 轮时返回 0 —— 一条都不隐藏，也就不会出现「加载更早」按钮。
 */
export function defaultVisibleFrom(
    messages: readonly MessageLike[],
    visibleRounds: number,
): number {
    const spans = rounds(messages)
    const keep = Math.max(1, Math.floor(visibleRounds) || 1)
    if (spans.length <= keep) return 0
    return spans[spans.length - keep]?.start ?? 0
}

/**
 * 窗口起点之前被完整隐藏的轮数
 *
 * 起点已经吸附到轮起点，所以「结束位置不超过 from」的轮就是全隐藏的轮。
 */
export function hiddenRounds(messages: readonly MessageLike[], from: number): number {
    if (from <= 0) return 0
    return rounds(messages).filter((span) => span.end <= from).length
}

/**
 * 「加载更早」的目标起点：从当前起点往前再露 page 轮
 *
 * 已经在顶上时返回 0（等于全部展开），调用方据此判断是否还有东西可加载。
 */
export function earlierVisibleFrom(
    messages: readonly MessageLike[],
    from: number,
    page: number,
): number {
    const spans = rounds(messages)
    if (spans.length === 0) return 0
    const step = Math.max(1, Math.floor(page) || 1)
    const aligned = alignToRound(messages, from)
    const current = spans.findIndex((span) => span.start === aligned)
    if (current <= 0) return 0
    const target = Math.max(0, current - step)
    return spans[target]?.start ?? 0
}

/**
 * 结算出实际要用的窗口起点
 *
 * @param stored 已经钉住的起点（用户点过「加载更早」，或打开会话时按默认窗口钉过一次）
 *
 * 钉住的值优先，这就是防「读着读着内容被折叠」的关键：
 * 默认窗口永远盯着「最近 visibleRounds 轮」，会话每多一轮起点就往后挪一轮；
 * 不钉住的话，流式回复期间用户正在看的旧轮会被自动收起来。
 * 存下来的值可能因为会话被裁剪而失效，所以先夹到合法范围再吸附到轮起点。
 */
export function resolveVisibleFrom(
    messages: readonly MessageLike[],
    stored: number | undefined,
    visibleRounds: number,
): number {
    if (messages.length === 0) return 0
    if (typeof stored === "number") {
        const clamped = Math.min(Math.max(0, Math.floor(stored) || 0), messages.length - 1)
        return alignToRound(messages, clamped)
    }
    return defaultVisibleFrom(messages, visibleRounds)
}
