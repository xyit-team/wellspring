/*
 * 终端会话。
 *
 * 命令由宿主的 api.exec 执行（插件被 access-guard 禁止直接 spawn），
 * 输出缓冲留在宿主侧，这里按会话维护「已读位置 + 提交历史」，
 * 浏览器用长轮询拉增量——不需要为终端单独引入流式 RPC。
 */

import type { PluginApi } from "wellspring/api/host/index.ts"

/** 单条命令输出上限（字符），超出即停止累积 */
const MAX_OUTPUT_CHARS = 400_000
/** 同时保留的会话数 */
const MAX_SESSIONS = 8
/** 单次 poll 最多返回的字符数，避免一次推爆 HTTP */
const MAX_POLL_CHARS = 64_000
/** 命令历史条数 */
const MAX_HISTORY = 60

interface TerminalSession {
    readonly id: string
    readonly hostSessionId: string
    readonly command: string
    readonly cwd: string
    output: string
    cursor: number
    done: boolean
    exitCode: number | null
    timedOut: boolean
    truncated: boolean
    startedAt: number
    finishedAt: number | null
}

const sessions = new Map<string, TerminalSession>()
const history: string[] = []
let sequence = 0

function prune(): void {
    while (sessions.size > MAX_SESSIONS) {
        // Map 保持插入顺序，先淘汰最早的已结束会话
        const finished = [...sessions.values()].find((item) => item.done)
        if (finished === undefined) break
        sessions.delete(finished.id)
    }
}

function trimOutput(session: TerminalSession, text: string): void {
    if (session.truncated) return
    if (session.output.length >= MAX_OUTPUT_CHARS) {
        session.truncated = true
        return
    }
    const room = MAX_OUTPUT_CHARS - session.output.length
    if (text.length > room) {
        session.output += text.slice(0, room)
        session.truncated = true
        return
    }
    session.output += text
}

function rememberCommand(command: string): void {
    if (history[history.length - 1] === command) return
    history.push(command)
    while (history.length > MAX_HISTORY) history.shift()
}

export interface TerminalStartResult {
    readonly id: string
    readonly command: string
    readonly cwd: string
}

export interface TerminalPollResult {
    readonly chunk: string
    readonly done: boolean
    readonly exitCode: number | null
    readonly timedOut: boolean
    readonly truncated: boolean
}

/** 启动一条命令；cwd 由调用方保证在工作区根内 */
export async function startCommand(
    api: PluginApi,
    command: string,
    cwd: string,
): Promise<TerminalStartResult> {
    const trimmed = command.trim()
    if (trimmed === "") throw new Error("命令不能为空")
    const started = await api.exec.run({ command: trimmed, cwd })
    sequence += 1
    const id = `t${sequence}`
    const session: TerminalSession = {
        id,
        hostSessionId: started.sessionId,
        command: trimmed,
        cwd: started.cwd,
        output: "",
        cursor: 0,
        done: false,
        exitCode: null,
        timedOut: false,
        truncated: false,
        startedAt: Date.now(),
        finishedAt: null,
    }
    sessions.set(id, session)
    rememberCommand(trimmed)
    prune()
    return { id, command: trimmed, cwd: started.cwd }
}

/** 拉取自上次 poll 之后的新增输出 */
export async function pollCommand(api: PluginApi, id: string): Promise<TerminalPollResult> {
    const session = sessions.get(id)
    if (session === undefined) throw new Error("终端会话不存在或已过期")

    if (!session.done) {
        const chunk = await api.exec.poll(session.hostSessionId)
        trimOutput(session, chunk.chunk)
        if (chunk.done) {
            session.done = true
            session.exitCode = chunk.exitCode
            session.timedOut = chunk.timedOut
            session.truncated = session.truncated || chunk.truncated
            session.finishedAt = Date.now()
        }
    }

    const pending = session.output.slice(session.cursor, session.cursor + MAX_POLL_CHARS)
    session.cursor += pending.length
    return {
        chunk: pending,
        done: session.done,
        exitCode: session.exitCode,
        timedOut: session.timedOut,
        truncated: session.truncated,
    }
}

/** 终止仍在运行的命令 */
export async function stopCommand(api: PluginApi, id: string): Promise<void> {
    const session = sessions.get(id)
    if (session === undefined || session.done) return
    await api.exec.stop(session.hostSessionId)
}

/** 命令历史，供前端上下键回溯 */
export function commandHistory(): readonly string[] {
    return history
}

/** 插件卸载时结束所有会话 */
export async function shutdownTerminals(api: PluginApi): Promise<void> {
    for (const session of sessions.values()) {
        if (session.done) continue
        try {
            await api.exec.stop(session.hostSessionId)
        } catch {
            /* 进程可能已退出 */
        }
    }
    sessions.clear()
}
