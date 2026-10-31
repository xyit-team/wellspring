/* 浏览器端 HTTP/JSON 小工具（401 统一抛 AuthError，由上层跳到登录页）。 */

import NProgress from "nprogress"

/** 同时有多个请求时只显示一条进度条 */
let pending = 0

function progressStart(): void {
    pending += 1
    if (pending === 1) NProgress.start()
}

function progressDone(): void {
    pending = Math.max(0, pending - 1)
    if (pending === 0) NProgress.done()
}

export class AuthError extends Error {
    constructor() {
        super("登录状态已失效，请重新登录")
        this.name = "AuthError"
    }
}

export async function readJson<T = any>(response: Response): Promise<T | null> {
    try {
        return (await response.json()) as T
    } catch {
        return null
    }
}

export interface ApiOptions {
    /** 后台轮询用：不显示顶部进度条，避免它一直闪 */
    readonly silent?: boolean
}

export async function apiJson<T = any>(
    path: string,
    init?: RequestInit,
    options: ApiOptions = {},
): Promise<T> {
    const showProgress = options.silent !== true
    if (showProgress) progressStart()
    let response: Response
    try {
        response = await fetch(path, init)
    } finally {
        // 响应头返回后立刻收起进度条，正文读取不再拖慢交互
        if (showProgress) progressDone()
    }
    if (response.status === 401) {
        throw new AuthError()
    }
    const data = await readJson<T>(response)
    if (!response.ok) {
        const message =
            data !== null && typeof data === "object" && typeof (data as any).error === "string"
                ? (data as any).error
                : `HTTP ${response.status}`
        throw new Error(message)
    }
    return data as T
}

export function jsonBody(body: unknown): RequestInit {
    return {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    }
}

export function reloadOnAuth(error: unknown): boolean {
    if (error instanceof AuthError) {
        window.location.reload()
        return true
    }
    return false
}

/** 连接彻底没数据了（连注释 ping 都收不到） */
export class StreamStalledError extends Error {
    constructor() {
        super("实时流已停滞")
        this.name = "StreamStalledError"
    }
}

/** 流还连着，但服务端已经有更多事件：该按已有进度增量重放 */
export class StreamResyncError extends Error {
    constructor(readonly received: number) {
        super("服务端已有更多事件，需要重放")
        this.name = "StreamResyncError"
    }
}

export interface SseWatchdog {
    /** 连续这么久没有 data 事件就回调；返回 true 表示要立刻增量重放 */
    readonly idleMs?: number
    readonly onIdle?: (received: number) => boolean | Promise<boolean>
    /** 连续这么久没有任何字节（含 ping）就认定连接已死 */
    readonly stallMs?: number
}

/** 探针间隔：定时器粒度，不是业务超时 */
const WATCH_POLL_MS = 500

function delay(ms: number): Promise<null> {
    return new Promise((resolve) => {
        window.setTimeout(() => resolve(null), ms)
    })
}

/**
 * 读取 SSE：按空行切分事件，回调 data 文本
 *
 * 带看门狗（可选）：
 * - `stallMs` 内连一个字节都没读到（服务端每 15s 会发注释 ping）→ 抛 `StreamStalledError`；
 * - `idleMs` 内没有 data 事件就调 `onIdle(received)`，它说服务端跑在前面就抛 `StreamResyncError`。
 *
 * 这样「流没断但事件不再到达」能在秒级被发现并立刻重放，而不是等到这一轮跑完。
 * 注意同一时刻只允许一个 `read()` 在飞（多播会丢数据），所以超时那一路只等待、不重发读。
 */
export async function consumeSse(
    response: Response,
    onEvent: (event: string, data: string) => void,
    watchdog: SseWatchdog = {},
): Promise<void> {
    const reader = response.body?.getReader()
    if (reader === undefined) {
        throw new Error("浏览器不支持流式响应")
    }
    const decoder = new TextDecoder()
    const idleMs = watchdog.idleMs ?? 0
    const stallMs = watchdog.stallMs ?? 0
    let buffer = ""
    /** 已经回调过的 data 事件数：和本轮事件缓冲的下标一一对应 */
    let received = 0
    let lastByteAt = Date.now()
    let lastDataAt = Date.now()
    let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
    const readOnce = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        pendingRead ??= reader.read().then((result) => {
            pendingRead = null
            return result
        })
        return pendingRead
    }
    for (;;) {
        const result =
            idleMs === 0 && stallMs === 0
                ? await readOnce()
                : await Promise.race([readOnce(), delay(WATCH_POLL_MS)])
        if (result === null) {
            const now = Date.now()
            if (stallMs > 0 && now - lastByteAt >= stallMs) {
                void reader.cancel().catch(() => undefined)
                throw new StreamStalledError()
            }
            if (idleMs > 0 && watchdog.onIdle !== undefined && now - lastDataAt >= idleMs) {
                // 先记一次时刻：探针本身是网络请求，别在它返回前反复触发
                lastDataAt = now
                if (await watchdog.onIdle(received)) {
                    void reader.cancel().catch(() => undefined)
                    throw new StreamResyncError(received)
                }
            }
            continue
        }
        if (result.done) break
        lastByteAt = Date.now()
        buffer += decoder.decode(result.value, { stream: true })
        let boundary = buffer.indexOf("\n\n")
        while (boundary !== -1) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            let event = "message"
            const dataLines: string[] = []
            for (const line of block.split("\n")) {
                if (line.startsWith("event:")) event = line.slice(6).trim()
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
            }
            if (dataLines.length > 0) {
                received += 1
                lastDataAt = Date.now()
                onEvent(event, dataLines.join("\n"))
            }
            boundary = buffer.indexOf("\n\n")
        }
    }
}
