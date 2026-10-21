/*
 * config 命令：path / show / get / set。
 */

import { Result } from "../api/result/result.ts"
import { saveSettings } from "../config/loader.ts"
import type { AppSetting } from "../config/types.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { parseCommandArgs } from "../input/parse-options.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

const KEYS = [
    "logger.level",
    "openai.model",
    "openai.baseUrl",
    "openai.timeoutMs",
    "openai.maxRetries",
    "network.proxy",
] as const

type ConfigKey = (typeof KEYS)[number]

function isKey(value: string): value is ConfigKey {
    return (KEYS as readonly string[]).includes(value)
}

function readValue(settings: AppSetting, key: ConfigKey): unknown {
    switch (key) {
        case "logger.level":
            return settings.logger.level
        case "openai.model":
            return settings.openai.model
        case "openai.baseUrl":
            return settings.openai.baseUrl
        case "openai.timeoutMs":
            return settings.openai.timeoutMs
        case "openai.maxRetries":
            return settings.openai.maxRetries
        case "network.proxy":
            return settings.network.proxy
    }
}

function writeValue(settings: AppSetting, key: ConfigKey, raw: string): AppSetting | string {
    switch (key) {
        case "logger.level":
            return { ...settings, logger: { level: raw as AppSetting["logger"]["level"] } }
        case "openai.model":
            return { ...settings, openai: { ...settings.openai, model: raw } }
        case "openai.baseUrl": {
            const baseUrl = raw === "null" || raw === "none" ? null : raw
            return { ...settings, openai: { ...settings.openai, baseUrl } }
        }
        case "openai.timeoutMs": {
            const value = Number(raw)
            if (!Number.isInteger(value) || value <= 0) {
                return `${USAGE_CODES.invalidValue}:openai.timeoutMs`
            }
            return { ...settings, openai: { ...settings.openai, timeoutMs: value } }
        }
        case "openai.maxRetries": {
            const value = Number(raw)
            if (!Number.isInteger(value) || value < 0) {
                return `${USAGE_CODES.invalidValue}:openai.maxRetries`
            }
            return { ...settings, openai: { ...settings.openai, maxRetries: value } }
        }
        case "network.proxy":
            return `${USAGE_CODES.invalidValue}:network.proxy（请直接编辑配置文件）`
    }
}

export async function runConfigCommand(
    ctx: CommandContext,
    argv: readonly string[],
): Promise<CommandOutcome> {
    const [subcommand, ...rest] = argv
    const parsed = parseCommandArgs(rest, {})
    if (!parsed.isSuccess()) {
        return { result: Result.error<unknown>(parsed.getCode() ?? USAGE_CODES.invalidValue) }
    }
    const line = parsed.getData()
    if (line === null) {
        return failure(USAGE_CODES.invalidValue)
    }

    switch (subcommand) {
        case "path": {
            ctx.elog.print(ctx.settingsFile)
            return success({ path: ctx.settingsFile })
        }
        case "show": {
            ctx.elog.print(JSON.stringify(ctx.settings, null, 4))
            return success(ctx.settings)
        }
        case "get": {
            const key = line.positionals[0]
            if (key === undefined) {
                return failure(`${USAGE_CODES.missingValue}:key`)
            }
            if (!isKey(key)) {
                return failure(`${USAGE_CODES.unknownConfigKey}:${key}`)
            }
            const value = readValue(ctx.settings, key)
            ctx.elog.print(value === null ? "null" : JSON.stringify(value))
            return success({ key, value })
        }
        case "set": {
            const key = line.positionals[0]
            const raw = line.positionals[1]
            if (key === undefined || raw === undefined) {
                return failure(`${USAGE_CODES.missingValue}:key value`)
            }
            if (!isKey(key)) {
                return failure(`${USAGE_CODES.unknownConfigKey}:${key}`)
            }
            const next = writeValue(ctx.settings, key, raw)
            if (typeof next === "string") {
                return failure(next)
            }
            const saved = await saveSettings(next, ctx.settingsFile)
            if (!saved.isSuccess()) {
                return failure(saved.getCode() ?? "config.write-failed")
            }
            ctx.elog.info(`已更新 ${key}`)
            return success({ key, value: readValue(next, key) })
        }
        default:
            return failure(`${USAGE_CODES.unknownSubcommand}:config ${subcommand ?? ""}`)
    }
}
