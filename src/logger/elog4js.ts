/*
 * 终端 UI 输出器（elog4js）。
 * human 模式专用：级别标签、颜色、流式输出；Pino 只负责结构化日志与文件。
 * --json 模式下所有方法静默，stdout 只留给 Result envelope。
 */

export type ElogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export interface ElogStream {
    write(text: string): unknown
}

export interface ElogOptions {
    readonly stdout?: ElogStream
    readonly stderr?: ElogStream
    /** 未指定时按 TTY 与 NO_COLOR 自动判断 */
    readonly color?: boolean
    readonly json?: boolean
}

const TAGS: Readonly<Record<ElogLevel, string>> = {
    trace: "[TRACE]",
    debug: "[DEBUG]",
    info: "[INFO ]",
    warn: "[WARN ]",
    error: "[ERROR]",
    fatal: "[FATAL]",
}

const COLORS: Readonly<Record<ElogLevel, string>> = {
    trace: "\x1b[90m",
    debug: "\x1b[36m",
    info: "\x1b[32m",
    warn: "\x1b[33m",
    error: "\x1b[31m",
    fatal: "\x1b[35m",
}

const RESET = "\x1b[0m"

function detectColor(stream: ElogStream | undefined): boolean {
    const force = process.env["FORCE_COLOR"]
    if (force === "0") {
        return false
    }
    if (force !== undefined && force !== "") {
        return true
    }
    if (process.env["NO_COLOR"] !== undefined) {
        return false
    }
    return process.stdout.isTTY === true && stream === process.stdout
}

export class Elog {
    #stdout: ElogStream
    #stderr: ElogStream
    #color: boolean
    #json: boolean
    #sessionName = ""
    #streaming = false

    constructor(options: ElogOptions = {}) {
        this.#stdout = options.stdout ?? process.stdout
        this.#stderr = options.stderr ?? process.stderr
        this.#color = options.color ?? detectColor(options.stdout ?? process.stdout)
        this.#json = options.json ?? false
    }

    setJson(json: boolean): void {
        this.#json = json
    }

    isJson(): boolean {
        return this.#json
    }

    setSessionName(name: string): void {
        this.#sessionName = name
    }

    getSessionName(): string {
        return this.#sessionName
    }

    setColor(color: boolean): void {
        this.#color = color
    }

    /** 普通信息，stdout */
    info(text: string): void {
        this.#line("info", text, this.#stdout)
    }

    /** 成功信息，stdout */
    success(text: string): void {
        this.#line("info", text, this.#stdout, "[ OK  ]")
    }

    debug(text: string): void {
        this.#line("debug", text, this.#stderr)
    }

    warn(text: string): void {
        this.#line("warn", text, this.#stderr)
    }

    error(text: string): void {
        this.#line("error", text, this.#stderr)
    }

    /** 只带级别标签，不再拼插件名 */
    tag(level: ElogLevel, text: string): void {
        const stream = level === "error" || level === "warn" ? this.#stderr : this.#stdout
        this.#line(level, text, stream)
    }

    /** 插件输出：`[LEVEL] plugin message` */
    plugin(level: ElogLevel, pluginName: string, message: string): void {
        const stream = level === "error" || level === "warn" ? this.#stderr : this.#stdout
        this.#line(level, `${pluginName} ${message}`, stream)
    }

    /** 流式写正文，不加换行与标签 */
    stream(text: string): void {
        if (this.#json || text === "") {
            return
        }
        this.#streaming = true
        this.#stdout.write(text)
    }

    /** 结束当前流式行 */
    line(): void {
        if (this.#json || !this.#streaming) {
            return
        }
        this.#streaming = false
        this.#stdout.write("\n")
    }

    /** 提示行，stderr，无级别标签 */
    notice(text: string): void {
        if (this.#json) {
            return
        }
        this.#stderr.write(`${text}\n`)
    }

    /** 纯文本行，stdout */
    print(text = ""): void {
        if (this.#json) {
            return
        }
        this.#stdout.write(`${text}\n`)
    }

    /** 清屏，仅 TTY 有效 */
    clear(): void {
        if (this.#json || process.stdout.isTTY !== true) {
            return
        }
        process.stdout.write("\x1b[2J\x1b[H")
    }

    #line(level: ElogLevel, text: string, stream: ElogStream, tag = TAGS[level]): void {
        if (this.#json) {
            return
        }
        const coloredTag =
            this.#color && stream === this.#stdout ? `${COLORS[level]}${tag}${RESET}` : tag
        stream.write(`${coloredTag} ${text}\n`)
    }
}

let singleton: Elog | null = null

/** 初始化全局 elog4js；重复调用会替换实例 */
export function initElog(options: ElogOptions = {}): Elog {
    singleton = new Elog(options)
    return singleton
}

/** 取全局 elog4js，未初始化时按默认参数创建 */
export function getElog(): Elog {
    if (singleton === null) {
        singleton = new Elog()
    }
    return singleton
}

/** 重置全局实例，供测试使用 */
export function resetElog(): void {
    singleton = null
}
