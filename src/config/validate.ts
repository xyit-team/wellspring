import type { LevelWithSilent } from "pino"

import { Result } from "../api/result/result.ts"
import { CONFIG_CODES, invalidCode } from "./codes.ts"
import { DEFAULT_SETTINGS } from "./defaults.ts"
import {
    SETTING_VERSION,
    type AppSetting,
    type NetworkSetting,
    type OpenAISetting,
    type ProxySetting,
} from "./types.ts"

const LEVELS: ReadonlySet<string> = new Set<LevelWithSilent>([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isLevel(value: unknown): value is LevelWithSilent {
    return typeof value === "string" && LEVELS.has(value)
}

function isBaseUrl(value: unknown): value is string {
    if (typeof value !== "string" || value.trim() === "") {
        return false
    }
    try {
        const url = new URL(value)
        return url.protocol === "http:" || url.protocol === "https:"
    } catch {
        return false
    }
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function validateOpenAI(input: Record<string, unknown>): Result<OpenAISetting> {
    let baseUrl = DEFAULT_SETTINGS.openai.baseUrl
    const rawBaseUrl = input["baseUrl"]
    if (rawBaseUrl !== undefined && rawBaseUrl !== null) {
        if (!isBaseUrl(rawBaseUrl)) {
            return Result.error<OpenAISetting>(invalidCode("openai.baseUrl"))
        }
        baseUrl = rawBaseUrl
    }

    let model = DEFAULT_SETTINGS.openai.model
    const rawModel = input["model"]
    if (rawModel !== undefined) {
        if (typeof rawModel !== "string" || rawModel.trim() === "") {
            return Result.error<OpenAISetting>(invalidCode("openai.model"))
        }
        model = rawModel.trim()
    }

    let timeoutMs = DEFAULT_SETTINGS.openai.timeoutMs
    const rawTimeout = input["timeoutMs"]
    if (rawTimeout !== undefined) {
        if (!isPositiveInteger(rawTimeout)) {
            return Result.error<OpenAISetting>(invalidCode("openai.timeoutMs"))
        }
        timeoutMs = rawTimeout
    }

    let maxRetries = DEFAULT_SETTINGS.openai.maxRetries
    const rawRetries = input["maxRetries"]
    if (rawRetries !== undefined) {
        if (!isNonNegativeInteger(rawRetries)) {
            return Result.error<OpenAISetting>(invalidCode("openai.maxRetries"))
        }
        maxRetries = rawRetries
    }

    return Result.successWithData<OpenAISetting>({ baseUrl, model, timeoutMs, maxRetries })
}

function validateProxy(input: Record<string, unknown>): Result<ProxySetting> {
    const rawType = input["type"]
    if (rawType !== undefined && rawType !== "http") {
        return Result.error<ProxySetting>(invalidCode("network.proxy.type"))
    }

    const rawUrl = input["url"]
    if (!isBaseUrl(rawUrl)) {
        return Result.error<ProxySetting>(invalidCode("network.proxy.url"))
    }

    const noProxy: string[] = []
    const rawNoProxy = input["noProxy"]
    if (rawNoProxy !== undefined) {
        if (!Array.isArray(rawNoProxy)) {
            return Result.error<ProxySetting>(invalidCode("network.proxy.noProxy"))
        }
        for (const item of rawNoProxy) {
            if (typeof item !== "string" || item.trim() === "") {
                return Result.error<ProxySetting>(invalidCode("network.proxy.noProxy"))
            }
            noProxy.push(item.trim())
        }
    }

    return Result.successWithData<ProxySetting>({ type: "http", url: rawUrl, noProxy })
}

function validateNetwork(input: Record<string, unknown>): Result<NetworkSetting> {
    const rawProxy = input["proxy"]
    if (rawProxy === undefined || rawProxy === null) {
        return Result.successWithData<NetworkSetting>({ proxy: null })
    }
    if (!isPlainObject(rawProxy)) {
        return Result.error<NetworkSetting>(invalidCode("network.proxy"))
    }
    const validated = validateProxy(rawProxy)
    if (!validated.isSuccess()) {
        return Result.error<NetworkSetting>(validated.getCode() ?? CONFIG_CODES.invalid)
    }
    return Result.successWithData<NetworkSetting>({
        proxy: validated.getData() ?? null,
    })
}

/** 校验并补齐默认值；未声明字段忽略，不做保留 */
export function validateSettings(input: unknown): Result<AppSetting> {
    if (!isPlainObject(input)) {
        return Result.error<AppSetting>(invalidCode("root"))
    }

    const version = input["version"]
    if (version !== undefined && version !== SETTING_VERSION) {
        return Result.error<AppSetting>(`${CONFIG_CODES.versionUnsupported}:${String(version)}`)
    }

    const logger = input["logger"]
    if (logger !== undefined && !isPlainObject(logger)) {
        return Result.error<AppSetting>(invalidCode("logger"))
    }

    const rawLevel = logger === undefined ? undefined : logger["level"]
    if (rawLevel !== undefined && !isLevel(rawLevel)) {
        return Result.error<AppSetting>(invalidCode("logger.level"))
    }

    const openai = input["openai"]
    if (openai !== undefined && !isPlainObject(openai)) {
        return Result.error<AppSetting>(invalidCode("openai"))
    }
    let openaiSetting = DEFAULT_SETTINGS.openai
    if (openai !== undefined) {
        const validated = validateOpenAI(openai)
        if (!validated.isSuccess()) {
            return Result.error<AppSetting>(validated.getCode() ?? CONFIG_CODES.invalid)
        }
        openaiSetting = validated.getData() ?? DEFAULT_SETTINGS.openai
    }

    const network = input["network"]
    if (network !== undefined && !isPlainObject(network)) {
        return Result.error<AppSetting>(invalidCode("network"))
    }
    let networkSetting = DEFAULT_SETTINGS.network
    if (network !== undefined) {
        const validated = validateNetwork(network)
        if (!validated.isSuccess()) {
            return Result.error<AppSetting>(validated.getCode() ?? CONFIG_CODES.invalid)
        }
        networkSetting = validated.getData() ?? DEFAULT_SETTINGS.network
    }

    return Result.successWithData<AppSetting>({
        version: SETTING_VERSION,
        logger: { level: rawLevel ?? DEFAULT_SETTINGS.logger.level },
        openai: openaiSetting,
        network: networkSetting,
    })
}
