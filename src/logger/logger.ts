/*
 * Pino 日志。
 * 输出到 log 根目录下的 app.log；human 模式只写文件，插件日志镜像到 elog4js。
 * --json 模式额外写 stderr（JSONL），stdout 留给 Result envelope。
 */

import { join } from "node:path"
import { Writable } from "node:stream"

import pino, { type LevelWithSilent, type Logger, type LoggerOptions, type StreamEntry } from "pino"

import { DEFAULT_SETTINGS } from "../config/defaults.ts"
import { loadSettings, SETTING_FILE_NAME } from "../config/loader.ts"
import type { AppSetting } from "../config/types.ts"
import { assertWritableFile, ensureDirs } from "../platform/file.ts"
import { getPaths, type ResolvedPaths } from "../platform/path.ts"
import { getElog, type ElogLevel } from "./elog4js.ts"

export const LOG_FILE_NAME = "app.log"

const APP_NAME = "wellspring"

type FileDestination = ReturnType<typeof pino.destination>

/** 直接创建 logger，不读取配置、不写全局单例 */
export interface CreateLoggerOptions {
    readonly level?: LevelWithSilent
    /** 日志文件路径；false 表示只写 stdout */
    readonly file?: string | false
    /** 是否写 stdout，默认 false */
    readonly stdout?: boolean
    /** 是否写 stderr，默认 false；--json 模式下开启 */
    readonly stderr?: boolean
    /** 是否把插件日志镜像到 elog4js，默认 false */
    readonly mirrorPlugin?: boolean
    readonly redact?: LoggerOptions["redact"]
}

/** 初始化全局 logger 的参数 */
export interface InitLoggerOptions extends Omit<CreateLoggerOptions, "file"> {
    /** 直接指定配置，跳过读取配置文件 */
    readonly settings?: AppSetting
    readonly configFile?: string
    /** 覆盖目录解析结果，测试用 */
    readonly paths?: ResolvedPaths
    /** 覆盖日志文件路径；false 表示只写 stdout */
    readonly file?: string | false
    /** --json 模式：Pino 额外写 stderr，插件日志不镜像到终端 */
    readonly json?: boolean
}

/** 记录每个 logger 对应的文件目标，关闭时只刷新文件，不碰 stdout */
const fileDestinations = new WeakMap<Logger, FileDestination>()

let current: Logger | null = null

const LEVEL_NAMES: Readonly<Record<number, ElogLevel>> = {
    10: "trace",
    20: "debug",
    30: "info",
    40: "warn",
    50: "error",
    60: "fatal",
}

/** 把带 plugin 字段的 Pino JSON 行镜像到 elog4js */
class ElogMirrorStream extends Writable {
    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        try {
            const line = JSON.parse(chunk.toString()) as {
                plugin?: unknown
                level?: unknown
                msg?: unknown
            }
            if (typeof line.plugin === "string" && typeof line.msg === "string") {
                const level = LEVEL_NAMES[Number(line.level)] ?? "info"
                const elog = getElog()
                if (line.msg.startsWith("插件 ")) {
                    // 拦截消息本身已含插件名，不再重复前缀
                    elog.tag(level, line.msg)
                } else if (line.msg.startsWith(`${line.plugin} `)) {
                    elog.plugin(level, line.plugin, line.msg.slice(line.plugin.length + 1))
                } else {
                    elog.plugin(level, line.plugin, line.msg)
                }
            }
        } catch {
            // 非 JSON 行忽略
        }
        callback()
    }
}

/** 创建 logger。file 默认落在 logDir/app.log */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
    const level = options.level ?? DEFAULT_SETTINGS.logger.level
    const streams: StreamEntry[] = []
    let destination: FileDestination | null = null

    if (options.file !== false) {
        const file = options.file ?? join(getPaths().logDir, LOG_FILE_NAME)
        try {
            // SonicBoom 的文件打开是异步的，坏路径不会在构造时抛错，先同步确认可写
            assertWritableFile(file)
            destination = pino.destination({
                dest: file,
                mkdir: true,
                sync: false,
                mode: 0o600,
            })
        } catch (error) {
            throw new Error(`日志文件不可写：${file}`, { cause: error })
        }
        // 运行期写入失败（磁盘满、文件被删除）时不再抛出未处理错误
        destination.on("error", (error: Error) => {
            process.stderr.write(`日志写入失败：${file}：${error.message}\n`)
        })
        streams.push({ level: "trace", stream: destination })
    }
    if (options.stdout === true) {
        streams.push({ level: "trace", stream: process.stdout })
    }
    if (options.stderr === true) {
        streams.push({ level: "trace", stream: process.stderr })
    }
    if (options.mirrorPlugin === true) {
        streams.push({ level: "trace", stream: new ElogMirrorStream() })
    }
    if (streams.length === 0) {
        throw new Error("日志输出未启用")
    }

    const logger = pino(
        {
            name: APP_NAME,
            level,
            timestamp: pino.stdTimeFunctions.isoTime,
            ...(options.redact === undefined ? {} : { redact: options.redact }),
        },
        streams.length === 1 ? streams[0]?.stream : pino.multistream(streams),
    )
    if (destination !== null) {
        fileDestinations.set(logger, destination)
    }
    return logger
}

/** 取全局 logger，未初始化时抛错 */
export function getLogger(): Logger {
    if (current === null) {
        throw new Error("logger 尚未初始化：先调用 initLogger()")
    }
    return current
}

/** 初始化全局 logger。重复调用返回已有实例 */
export async function initLogger(options: InitLoggerOptions = {}): Promise<Logger> {
    if (current !== null) {
        return current
    }

    const paths = options.paths ?? getPaths()
    let settings = options.settings
    let configCode: string | null = null

    if (settings === undefined && options.level === undefined) {
        const file = options.configFile ?? join(paths.configDir, SETTING_FILE_NAME)
        const result = await loadSettings(file)
        settings = result.getData() ?? DEFAULT_SETTINGS
        if (!result.isSuccess()) {
            configCode = result.getCode()
        }
    }

    const level = options.level ?? settings?.logger.level ?? DEFAULT_SETTINGS.logger.level
    const file = options.file ?? join(paths.logDir, LOG_FILE_NAME)
    let logger: Logger

    try {
        if (file !== false) {
            await ensureDirs(paths)
        }
        logger = createLogger({
            level,
            file,
            stdout: options.stdout ?? false,
            stderr: options.stderr ?? options.json === true,
            mirrorPlugin: options.mirrorPlugin ?? options.json !== true,
            redact: options.redact,
        })
    } catch (error) {
        logger = createLogger({
            level,
            file: false,
            stdout: true,
            stderr: options.stderr ?? options.json === true,
            mirrorPlugin: options.mirrorPlugin ?? options.json !== true,
            redact: options.redact,
        })
        const reason = error instanceof Error ? error.message : String(error)
        logger.warn({ file, reason }, "日志文件不可写，输出到 stdout")
    }

    current = logger
    if (configCode !== null) {
        logger.warn({ code: configCode }, "配置加载失败，使用默认配置")
    }
    return logger
}

/** 关闭全局 logger。等待文件目标刷新并关闭，stdout 保持打开 */
export function closeLogger(): Promise<void> {
    const logger = current
    if (logger === null) {
        return Promise.resolve()
    }
    current = null
    const destination = fileDestinations.get(logger)
    if (destination === undefined) {
        return Promise.resolve()
    }
    fileDestinations.delete(logger)

    return new Promise<void>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const done = (): void => {
            if (settled) {
                return
            }
            settled = true
            if (timer !== undefined) {
                clearTimeout(timer)
            }
            resolve()
        }
        destination.once("close", done)
        destination.once("error", done)
        // 打开失败或目标始终未就绪时，end 不会再触发 close
        timer = setTimeout(done, 2_000)
        try {
            destination.end()
        } catch {
            done()
        }
    })
}
