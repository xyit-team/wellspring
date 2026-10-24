/*
 * 宿主伪终端（PTY）API。
 *
 * 需要 node-pty 提供真正的 tty：只有 tty 才有行编辑、颜色、进度条与全屏程序。
 * node-pty 是原生模块，可能装不上（无编译器 / 无预编译包），所以它按可选依赖处理，
 * 拿不到时 available() 返回 false，调用方退回普通管道执行。
 */

export interface HostPtySpawnOptions {
    /** 可执行文件，默认取登录 shell */
    readonly file?: string
    readonly args?: readonly string[]
    readonly cwd: string
    readonly env?: Record<string, string>
    readonly cols?: number
    readonly rows?: number
}

export interface HostPtySession {
    readonly sessionId: string
    readonly pid: number
    readonly file: string
    readonly cwd: string
    readonly cols: number
    readonly rows: number
}

export interface HostPtyChunk {
    /** 自上次 poll 之后新增的输出，含 ANSI 控制序列 */
    readonly chunk: string
    readonly done: boolean
    readonly exitCode: number | null
}

/** PTY 后端：node-pty 原生模块，或 python3 自建的 pty */
export type HostPtyBackend = "node-pty" | "python-pty"

export interface HostPtyAvailability {
    readonly available: boolean
    /** 实际使用的后端 */
    readonly backend?: HostPtyBackend
    /** 不可用时的原因，便于排查（未安装 / 原生模块加载失败） */
    readonly reason?: string
}

export interface HostPtyApi {
    /** node-pty 是否可用，以及不可用的原因 */
    available(): Promise<HostPtyAvailability>
    spawn(options: HostPtySpawnOptions): Promise<HostPtySession>
    poll(sessionId: string): Promise<HostPtyChunk>
    /** 原样写入键盘输入 */
    write(sessionId: string, data: string): Promise<void>
    resize(sessionId: string, cols: number, rows: number): Promise<void>
    kill(sessionId: string): Promise<void>
}

/** 单会话输出缓冲上限，超出后丢弃最旧的输出 */
export const HOST_PTY_MAX_OUTPUT_CHARS = 512 * 1024

/** 同时保留的 PTY 会话数 */
export const HOST_PTY_MAX_SESSIONS = 8

/** 单次 poll 最多返回的字符数 */
export const HOST_PTY_MAX_POLL_CHARS = 128 * 1024

export const HOST_PTY_DEFAULT_COLS = 100
export const HOST_PTY_DEFAULT_ROWS = 28

/** 尺寸的合理范围：列不能太窄，行数允许缩到很小（终端面板可以拖得很矮） */
export const HOST_PTY_MIN_COLS = 20
export const HOST_PTY_MAX_COLS = 400
export const HOST_PTY_MIN_ROWS = 2
export const HOST_PTY_MAX_ROWS = 200
