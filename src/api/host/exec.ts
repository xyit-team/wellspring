/*
 * 宿主进程执行 API
 *
 * 插件被 access-guard 禁止直接 import node:child_process，执行命令走这里
 * 执行与输出缓冲在宿主侧，插件用 poll 拉增量，无流式 RPC
 */

export interface HostExecRunOptions {
    /** 交给 shell 解释的命令行 */
    readonly command: string
    /** 工作目录，必须落在允许的执行根内 */
    readonly cwd: string
    /** 追加的环境变量 */
    readonly env?: Record<string, string>
    /** 超时毫秒，到点终止整个进程组 */
    readonly timeoutMs?: number
}

export interface HostExecSession {
    readonly sessionId: string
    readonly pid: number | null
    readonly cwd: string
}

export interface HostExecChunk {
    /** 自上次 poll 之后新增的输出 */
    readonly chunk: string
    /** 进程是否已结束 */
    readonly done: boolean
    /** 退出码；被信号终止时为 null */
    readonly exitCode: number | null
    /** 因超时被终止 */
    readonly timedOut: boolean
    /** 输出被上限截断 */
    readonly truncated: boolean
}

export interface HostExecApi {
    run(options: HostExecRunOptions): Promise<HostExecSession>
    poll(sessionId: string): Promise<HostExecChunk>
    stop(sessionId: string): Promise<void>
}

/** 单条会话的输出上限，超出即截断并终止 */
export const HOST_EXEC_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/** 未显式指定时的超时上限 */
export const HOST_EXEC_DEFAULT_TIMEOUT_MS = 120_000
