/*
 * 命令级参数解析
 *
 * 统一走 node:util parseArgs，未知参数严格报错并映射为 usage.* 错误码
 */

import { parseArgs, type ParseArgsOptionsConfig } from "node:util"

import { Result } from "../api/result/result.ts"
import { USAGE_CODES, usageCode } from "./codes.ts"

export type CommandValues = Readonly<Record<string, string | boolean | undefined>>

export interface ParsedCommandLine {
    readonly values: CommandValues
    readonly positionals: readonly string[]
}

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

export function parseCommandArgs(
    argv: readonly string[],
    options: ParseArgsOptionsConfig,
): Result<ParsedCommandLine> {
    try {
        const parsed = parseArgs({
            args: [...argv],
            options,
            strict: true,
            allowPositionals: true,
        })
        return Result.successWithData<ParsedCommandLine>({
            values: parsed.values as CommandValues,
            positionals: parsed.positionals,
        })
    } catch (error) {
        return Result.error<ParsedCommandLine>(mapParseError(error))
    }
}

/** 把 unknown 值转成字符串参数 */
export function stringValue(values: CommandValues, name: string): string | undefined {
    const value = values[name]
    return typeof value === "string" ? value : undefined
}

export function booleanValue(values: CommandValues, name: string): boolean {
    return values[name] === true
}
