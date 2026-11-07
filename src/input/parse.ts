/*
 * 全局参数解析
 *
 * 遇到第一个位置参数（命令名）即停止解析，其余原样交给命令或插件
 */

import { parseArgs } from "node:util"

import type { LevelWithSilent } from "pino"

import { Result } from "../api/result/result.ts"
import { USAGE_CODES, usageCode } from "./codes.ts"
import type { GlobalOptions, ParsedGlobal } from "./types.ts"

const LEVELS: ReadonlySet<string> = new Set<LevelWithSilent>([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
])

function optionName(message: string): string | undefined {
    const match = /(--?[A-Za-z][\w-]*)/.exec(message)
    return match?.[1]
}

function mapParseError(error: unknown): string {
    const candidate = error as { code?: string; message?: string }
    const message = candidate.message ?? ""
    switch (candidate.code) {
        case "ERR_PARSE_ARGS_UNKNOWN_OPTION":
            return usageCode(USAGE_CODES.unknownOption, optionName(message))
        case "ERR_PARSE_ARGS_MISSING_OPTION_ARG":
            return usageCode(USAGE_CODES.missingValue, optionName(message))
        case "ERR_PARSE_ARGS_INVALID_OPTION_VALUE":
            return usageCode(USAGE_CODES.invalidValue, optionName(message))
        default:
            return usageCode(USAGE_CODES.invalidValue)
    }
}

function text(value: string | boolean | (string | boolean)[] | undefined): string | undefined {
    return typeof value === "string" ? value : undefined
}

const VALUE_OPTIONS: ReadonlySet<string> = new Set([
    "-c",
    "--config",
    "--home",
    "-l",
    "--log-level",
])

/** 手工切出全局参数前缀：遇到第一个位置参数（命令名）即停止，后续 token 全部原样保留 */
function splitGlobalPrefix(argv: readonly string[]): {
    globalArgs: string[]
    command: string | null
    commandArgv: string[]
} {
    const globalArgs: string[] = []
    let index = 0

    while (index < argv.length) {
        const token = argv[index]
        if (token === undefined) {
            break
        }
        if (token === "--") {
            index += 1
            break
        }
        if (!token.startsWith("-") || token === "-") {
            break
        }

        globalArgs.push(token)
        const equals = token.indexOf("=")
        const name = equals === -1 ? token : token.slice(0, equals)
        if (VALUE_OPTIONS.has(name) && equals === -1) {
            const value = argv[index + 1]
            if (value !== undefined) {
                globalArgs.push(value)
                index += 2
                continue
            }
        }
        index += 1
    }

    const command = argv[index] ?? null
    return {
        globalArgs,
        command,
        commandArgv: index < argv.length ? [...argv.slice(index + 1)] : [],
    }
}

export function parseGlobal(argv: readonly string[]): Result<ParsedGlobal> {
    const { globalArgs, command, commandArgv } = splitGlobalPrefix(argv)
    let values: Record<string, string | boolean | (string | boolean)[] | undefined>
    try {
        const parsed = parseArgs({
            args: globalArgs,
            options: {
                config: { type: "string", short: "c" },
                home: { type: "string" },
                "log-level": { type: "string", short: "l" },
                json: { type: "boolean" },
                quiet: { type: "boolean", short: "q" },
                help: { type: "boolean", short: "h" },
                version: { type: "boolean", short: "v" },
            },
            strict: true,
            allowPositionals: false,
        })
        values = parsed.values as typeof values
    } catch (error) {
        return Result.error<ParsedGlobal>(mapParseError(error))
    }

    const rawLevel = text(values["log-level"])
    if (rawLevel !== undefined && !LEVELS.has(rawLevel)) {
        return Result.error<ParsedGlobal>(usageCode(USAGE_CODES.invalidValue, "--log-level"))
    }

    const options: GlobalOptions = {
        config: text(values["config"]),
        home: text(values["home"]),
        logLevel: rawLevel as LevelWithSilent | undefined,
        json: values["json"] === true,
        quiet: values["quiet"] === true,
        help: values["help"] === true,
        version: values["version"] === true,
    }
    return Result.successWithData<ParsedGlobal>({ options, command, commandArgv })
}
