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

// 字符显示宽度
function charWidth(codePoint: number): number {
    if (codePoint === 0x200b) {
        return 0
    }
    return codePoint >= 0x1100 &&
        (codePoint <= 0x115f ||
            codePoint === 0x2329 ||
            codePoint === 0x232a ||
            (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
            (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
            (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
            (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
            (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
            (codePoint >= 0xff00 && codePoint <= 0xff60) ||
            (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
            (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
            (codePoint >= 0x1f900 && codePoint <= 0x1f9ff))
        ? 2
        : 1
}

function displayWidth(text: string): number {
    let width = 0
    for (const char of text) {
        width += charWidth(char.codePointAt(0) ?? 0)
    }
    return width
}

function wrapLine(text: string, width: number): string[] {
    if (displayWidth(text) <= width) {
        return [text]
    }
    const chunks: string[] = []
    let rest = text
    while (displayWidth(rest) > width) {
        let taken = 0
        let current = 0
        let lastSpace = -1
        for (const char of rest) {
            const next = charWidth(char.codePointAt(0) ?? 0)
            if (current + next > width) {
                break
            }
            current += next
            taken += char.length
            if (char === " ") {
                lastSpace = taken
            }
        }
        const cut = lastSpace > 0 ? lastSpace : taken
        chunks.push(rest.slice(0, cut))
        rest = rest.slice(cut)
    }
    chunks.push(rest)
    return chunks
}

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
    if (process.env["TERM"] === "dumb") {
        return false
    }
    return (stream as { isTTY?: boolean } | undefined)?.isTTY === true
}

export class Elog {
    #stdout: ElogStream
    #stderr: ElogStream
    #colorStdout: boolean
    #colorStderr: boolean
    #json: boolean
    #sessionName = ""
    #streaming = false

    constructor(options: ElogOptions = {}) {
        this.#stdout = options.stdout ?? process.stdout
        this.#stderr = options.stderr ?? process.stderr
        this.#colorStdout = options.color ?? detectColor(this.#stdout)
        this.#colorStderr = options.color ?? detectColor(this.#stderr)
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
        this.#colorStdout = color
        this.#colorStderr = color
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

    /** Agent 输出前缀 */
    agentStart(): void {
        if (this.#json) {
            return
        }
        const color = this.#colorStdout
        const prefix = color ? `\x1b[36m[Agent]\x1b[0m` : "[Agent]"
        this.#stdout.write(`\n${prefix}\n`)
    }

    /** Agent 输出行 */
    agent(text: string): void {
        if (this.#json) {
            return
        }
        this.agentStart()
        this.#stdout.write(`${text}\n`)
    }

    /** 步骤分隔行 */
    step(step: number, total?: number): void {
        if (this.#json) {
            return
        }
        const color = this.#colorStdout
        const text = total === undefined ? `── step ${step} ──` : `── step ${step}/${total} ──`
        this.#stdout.write(`\n${color ? `\x1b[36m${text}\x1b[0m` : text}\n`)
    }

    /** 代码块 */
    #codeBlock(label: string, code: string): void {
        const columns = process.stdout.columns ?? 80
        const width = Math.max(40, columns - 2)
        const inner = width - 4
        const color = this.#colorStdout
        const border = (text: string): string => (color ? `\x1b[90m${text}\x1b[0m` : text)
        const header = `┌ [${label}]`
        this.#stdout.write(
            `${border(`${header}${"─".repeat(Math.max(1, width - header.length - 1))}┐`)}\n`,
        )
        for (const source of code.split("\n")) {
            const text = source.replace(/\t/g, "    ")
            for (let index = 0; index < Math.max(1, text.length); index += inner) {
                const chunk = text.slice(index, index + inner)
                this.#stdout.write(`${border("│")} ${chunk.padEnd(inner)} ${border("│")}\n`)
            }
        }
        this.#stdout.write(`${border(`└${"─".repeat(width - 2)}┘`)}\n`)
    }

    /** 操作请求块 */
    action(
        title: string,
        rows: readonly {
            readonly label: string
            readonly value: string
            readonly code?: boolean
        }[],
    ): void {
        if (this.#json) {
            return
        }
        const color = this.#colorStdout
        const label = color ? `\x1b[33m${title}\x1b[0m` : title
        this.#stdout.write(`\n${label}\n`)
        for (const row of rows) {
            if (row.code === true) {
                this.#stdout.write(`  ${row.label}\n`)
                this.#codeBlock("bash", row.value)
                continue
            }
            this.#stdout.write(`  ${row.label} ${row.value}\n`)
        }
    }

    /** 操作结果行 */
    actionStatus(name: string, status: string): void {
        if (this.#json) {
            return
        }
        const color = this.#colorStdout
        const label = color ? `\x1b[90m[操作]\x1b[0m` : "[操作]"
        this.#stdout.write(`${label} ${name} ${status}\n`)
    }

    /** 只带级别标签，不再拼插件名 */
    tag(level: ElogLevel, text: string): void {
        const stream = level === "error" || level === "warn" ? this.#stderr : this.#stdout
        this.#line(level, text, stream)
    }

    /** 插件输出：`[LEVEL] [plugin] message` */
    plugin(level: ElogLevel, pluginName: string, message: string): void {
        const stream = level === "error" || level === "warn" ? this.#stderr : this.#stdout
        this.#line(level, `[${pluginName}] ${message}`, stream)
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
        const color = stream === this.#stdout ? this.#colorStdout : this.#colorStderr
        const coloredTag = color ? `${COLORS[level]}${tag}${RESET}` : tag
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
