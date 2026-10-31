/*
 * 控制台（PTY 会话）。
 *
 * 真 tty 由宿主的 api.pty 提供（node-pty）。装上 node-pty 时这里是可交互的 shell：
 * 键盘原样写入、输出带 ANSI 控制序列、尺寸可调整，vim / htop / top 都能跑。
 * 没装时 available() 为 false，前端退回 /api/term/* 的一次性命令模式。
 */

import type { PluginApi } from "wellspring/api/host/index.ts"

/** 同时保留的控制台会话数 */
const MAX_CONSOLE_SESSIONS = 4

/** 每个会话保留的输出历史（供页面刷新后重放），超出后按行丢弃最旧的一半 */
const MAX_CONSOLE_HISTORY_CHARS = 64 * 1024

export const DEFAULT_COLS = 100
export const DEFAULT_ROWS = 28

export const MIN_COLS = 20
export const MAX_COLS = 400
export const MIN_ROWS = 6
export const MAX_ROWS = 200

interface ConsoleSession {
    readonly id: string
    readonly hostSessionId: string
    readonly cwd: string
    cols: number
    rows: number
    done: boolean
    exitCode: number | null
    createdAt: number
    /** 最近输出，页面刷新后重放到 VT 屏幕 */
    history: string
}

const sessions = new Map<string, ConsoleSession>()
let sequence = 0
let availability: boolean | null = null
let unavailableReason: string | null = null
let backendName: string | null = null

function clamp(value: unknown, min: number, max: number, fallback: number): number {
    const size = typeof value === "number" ? Math.round(value) : Number.NaN
    if (!Number.isFinite(size)) return fallback
    return Math.min(max, Math.max(min, size))
}

/** node-pty 是否可用；结果缓存，装/卸依赖需要重启服务 */
export async function consoleAvailable(api: PluginApi): Promise<boolean> {
    if (availability === null) {
        try {
            const result = await api.pty.available()
            availability = result.available === true
            unavailableReason = result.reason ?? null
            backendName = result.backend ?? null
        } catch (error) {
            availability = false
            unavailableReason = error instanceof Error ? error.message : String(error)
        }
        if (!availability) {
            // 没装与装坏了是两类问题，日志留一条便于对照
            api.logger.warn(
                { reason: unavailableReason ?? "unknown" },
                "node-pty 不可用，控制台退回命令模式",
            )
        }
    }
    return availability
}

/** 不可用原因，供 /api/console/state 展示 */
export function consoleUnavailableReason(): string | null {
    return unavailableReason
}

/** 实际使用的 PTY 后端（node-pty / python-pty） */
export function consoleBackend(): string | null {
    return backendName
}

function prune(): void {
    while (sessions.size > MAX_CONSOLE_SESSIONS) {
        const finished = [...sessions.values()].find((item) => item.done)
        if (finished === undefined) break
        sessions.delete(finished.id)
    }
}

export interface ConsoleListEntry {
    readonly id: string
    readonly cwd: string
    readonly cols: number
    readonly rows: number
    readonly done: boolean
    readonly createdAt: number
    /** 最近输出；页面刷新后前端重放它恢复屏幕内容 */
    readonly history: string
}

/**
 * 页面刷新后恢复终端用：列出仍在运行的会话。
 * 会话存在插件服务进程里，所以页面重载不会丢；服务重启后列表自然为空。
 */
export function listConsoles(): ConsoleListEntry[] {
    return [...sessions.values()].map((session) => ({
        id: session.id,
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        done: session.done,
        createdAt: session.createdAt,
        history: session.history,
    }))
}

export interface ConsoleOpenResult {
    readonly id: string
    readonly cwd: string
    readonly cols: number
    readonly rows: number
    readonly shell: string
}

/** 打开一个 shell 会话；cwd 由调用方保证在工作区内 */
export async function openConsole(
    api: PluginApi,
    cwd: string,
    cols: unknown,
    rows: unknown,
): Promise<ConsoleOpenResult> {
    if (!(await consoleAvailable(api))) {
        throw new Error("node-pty 未安装，控制台不可用")
    }
    prune()
    if (sessions.size >= MAX_CONSOLE_SESSIONS) {
        throw new Error(`控制台最多同时开 ${MAX_CONSOLE_SESSIONS} 个，先关掉一个`)
    }
    const width = clamp(cols, MIN_COLS, MAX_COLS, DEFAULT_COLS)
    const height = clamp(rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS)
    const started = await api.pty.spawn({ cwd, cols: width, rows: height })
    sequence += 1
    const id = `c${sequence}`
    sessions.set(id, {
        id,
        hostSessionId: started.sessionId,
        cwd: started.cwd,
        cols: started.cols,
        rows: started.rows,
        done: false,
        exitCode: null,
        createdAt: Date.now(),
        history: "",
    })
    prune()
    return { id, cwd: started.cwd, cols: started.cols, rows: started.rows, shell: started.file }
}

export interface ConsolePollResult {
    readonly chunk: string
    readonly done: boolean
    readonly exitCode: number | null
}

export async function pollConsole(api: PluginApi, id: string): Promise<ConsolePollResult> {
    const session = sessions.get(id)
    if (session === undefined) throw new Error("控制台会话不存在或已过期")
    if (session.done) {
        return { chunk: "", done: true, exitCode: session.exitCode }
    }
    const chunk = await api.pty.poll(session.hostSessionId)
    if (chunk.done) {
        session.done = true
        session.exitCode = chunk.exitCode
    }
    if (chunk.chunk !== "") {
        session.history += chunk.chunk
        if (session.history.length > MAX_CONSOLE_HISTORY_CHARS) {
            const keep = session.history.slice(-Math.floor(MAX_CONSOLE_HISTORY_CHARS / 2))
            const newline = keep.indexOf("\n")
            session.history = newline === -1 ? keep : keep.slice(newline + 1)
        }
    }
    // 不在插件侧截断：宿主已按上限返回，剩下的留到下次 poll，截掉就永久丢了
    return {
        chunk: chunk.chunk,
        done: session.done,
        exitCode: session.exitCode,
    }
}

/** 键盘输入原样写入 PTY */
export async function writeConsole(api: PluginApi, id: string, data: string): Promise<void> {
    const session = sessions.get(id)
    if (session === undefined) throw new Error("控制台会话不存在或已过期")
    if (session.done || data === "") return
    await api.pty.write(session.hostSessionId, data)
}

export async function resizeConsole(
    api: PluginApi,
    id: string,
    cols: unknown,
    rows: unknown,
): Promise<void> {
    const session = sessions.get(id)
    if (session === undefined || session.done) return
    const width = clamp(cols, MIN_COLS, MAX_COLS, session.cols)
    const height = clamp(rows, MIN_ROWS, MAX_ROWS, session.rows)
    if (width === session.cols && height === session.rows) return
    session.cols = width
    session.rows = height
    await api.pty.resize(session.hostSessionId, width, height)
}

export async function closeConsole(api: PluginApi, id: string): Promise<void> {
    const session = sessions.get(id)
    if (session === undefined) return
    sessions.delete(id)
    if (session.done) return
    await api.pty.kill(session.hostSessionId)
}

/** 插件卸载时结束所有控制台 */
export async function shutdownConsoles(api: PluginApi): Promise<void> {
    const pending = [...sessions.values()]
    sessions.clear()
    for (const session of pending) {
        if (session.done) continue
        try {
            await api.pty.kill(session.hostSessionId)
        } catch {
            /* 进程可能已退出 */
        }
    }
}
