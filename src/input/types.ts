import type { LevelWithSilent } from "pino"

export interface GlobalOptions {
    readonly config?: string
    readonly home?: string
    readonly logLevel?: LevelWithSilent
    readonly json: boolean
    readonly quiet: boolean
    readonly help: boolean
    readonly version: boolean
}

export interface ParsedGlobal {
    readonly options: GlobalOptions
    /** 命令名；没有子命令时为 null */
    readonly command: string | null
    /** 命令名之后的原始参数，原样交给命令或插件 */
    readonly commandArgv: readonly string[]
}
