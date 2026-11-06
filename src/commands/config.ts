/*
 * config 命令：path / show / get / set。
 */

import { Result } from "../api/result/result.ts"
import { CONFIG_CODES } from "../config/codes.ts"
import { saveSettings } from "../config/loader.ts"
import { DEFAULT_PLUGINS } from "../config/defaults.ts"
import { modelsSetting } from "../config/providers.ts"
import type { AppSetting } from "../config/types.ts"
import { readJsonIfExists, writeJsonAtomic } from "../platform/file.ts"
import { PLUGIN_ID } from "../plugin/paths.ts"
import { pluginConfigFile } from "../plugin/runtime.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { parseCommandArgs } from "../input/parse-options.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

const KEYS = [
    "logger.level",
    "openai.model",
    "openai.baseUrl",
    "openai.timeoutMs",
    "openai.maxRetries",
    "models.activeProvider",
    "models.activeModel",
    "models.activeReasoning",
    "network.proxy",
    "network.noProxy",
    "plugins.update.type",
    "plugins.update.registry",
    "plugins.update.githubToken",
] as const

type ConfigKey = (typeof KEYS)[number]

function modelsOf(settings: AppSetting) {
    return modelsSetting(settings)
}

function isKey(value: string): value is ConfigKey {
    return (KEYS as readonly string[]).includes(value)
}

const PLUGIN_CONFIG_DPIREFIX = "plugins."
const PLUGIN_CONFIG_FIELD = /^[A-Za-z0-9_-]+$/

interface PluginConfigRef {
    readonly pluginId: string
    /** 插件配置里的顶层字段；省略表示整份配置 */
    readonly field: string | null
}

/**
 * `plugins.<id>.<field>`：读写插件自己的 <configDir>/plugins/<id>.json。
 * 插件 id 本身允许点号的情况极少，因此按“最后一个点”切分字段；
 * 没有点时表示整份配置。
 */
function parsePluginKey(key: string): PluginConfigRef | null {
    if (!key.startsWith(PLUGIN_CONFIG_DPIREFIX)) {
        return null
    }
    const rest = key.slice(PLUGIN_CONFIG_DPIREFIX.length)
    const dot = rest.lastIndexOf(".")
    if (dot > 0) {
        const pluginId = rest.slice(0, dot)
        const field = rest.slice(dot + 1)
        if (PLUGIN_ID.test(pluginId) && PLUGIN_CONFIG_FIELD.test(field)) {
            return { pluginId, field }
        }
    }
    if (PLUGIN_ID.test(rest)) {
        return { pluginId: rest, field: null }
    }
    return null
}

async function readPluginConfig(
    ctx: CommandContext,
    pluginId: string,
): Promise<Record<string, unknown> | string> {
    const file = pluginConfigFile(pluginId, ctx.paths)
    try {
        const value = await readJsonIfExists<unknown>(file)
        if (value === null) {
            return {}
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return `${CONFIG_CODES.invalid}:${file}（插件配置必须是 JSON 对象）`
        }
        return { ...(value as Record<string, unknown>) }
    } catch {
        return `${CONFIG_CODES.parseFailed}:${file}`
    }
}

/** 先按 JSON 解析，失败就当裸字符串；这样 port 能存成数字、host 仍是字符串 */
function parsePluginValue(raw: string): unknown {
    try {
        return JSON.parse(raw)
    } catch {
        return raw
    }
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
        case "models.activeProvider":
            return modelsOf(settings).activeProvider
        case "models.activeModel":
            return modelsOf(settings).activeModel
        case "models.activeReasoning":
            return modelsOf(settings).activeReasoning
        case "network.proxy":
            return settings.network.proxy
        case "network.noProxy":
            return settings.network.proxy?.noProxy ?? []
        case "plugins.update.type":
            return settings.plugins?.update.type ?? "npm"
        case "plugins.update.registry":
            return settings.plugins?.update.registry ?? "https://registry.npmjs.org"
        case "plugins.update.githubToken":
            return settings.plugins?.update.githubToken ?? null
    }
}

/** CLI 里接受 none/null/off/空串表示直连；其余按 http(s) URL 校验 */
function normalizeProxyUrl(raw: string): string | null | string {
    const value = raw.trim()
    if (value === "" || value === "none" || value === "null" || value === "off") {
        return null
    }
    try {
        const url = new URL(value)
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return `${USAGE_CODES.invalidValue}:network.proxy（只支持 http/https）`
        }
    } catch {
        return `${USAGE_CODES.invalidValue}:network.proxy`
    }
    return value
}

function splitNoProxy(raw: string): string[] {
    const result: string[] = []
    for (const item of raw.split(/[,，\s]+/)) {
        const value = item.trim()
        if (value !== "" && !result.includes(value)) result.push(value)
    }
    return result
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
        case "models.activeProvider": {
            const next = modelsOf(settings)
            return { ...settings, models: { ...next, activeProvider: raw } }
        }
        case "models.activeModel": {
            const next = modelsOf(settings)
            const value = raw === "null" || raw === "none" || raw === "" ? null : raw
            return { ...settings, models: { ...next, activeModel: value } }
        }
        case "models.activeReasoning": {
            if (raw !== "off" && raw !== "low" && raw !== "high" && raw !== "max") {
                return `${USAGE_CODES.invalidValue}:models.activeReasoning`
            }
            const next = modelsOf(settings)
            return { ...settings, models: { ...next, activeReasoning: raw } }
        }
        case "network.proxy": {
            const url = normalizeProxyUrl(raw)
            if (typeof url === "string" && url.startsWith(USAGE_CODES.invalidValue)) {
                return url
            }
            const noProxy = settings.network.proxy?.noProxy ?? []
            return {
                ...settings,
                network: { proxy: url === null ? null : { type: "http", url, noProxy } },
            }
        }
        case "plugins.update.type": {
            if (raw !== "npm" && raw !== "github" && raw !== "file") {
                return `${USAGE_CODES.invalidValue}:plugins.update.type（npm / github / file）`
            }
            return {
                ...settings,
                plugins: {
                    update: {
                        ...(settings.plugins?.update ?? DEFAULT_PLUGINS.update),
                        type: raw,
                    },
                },
            }
        }
        case "plugins.update.registry": {
            const url = normalizeProxyUrl(raw)
            if (typeof url === "string" && url.startsWith(USAGE_CODES.invalidValue)) {
                return `${USAGE_CODES.invalidValue}:plugins.update.registry`
            }
            if (url === null) {
                return `${USAGE_CODES.invalidValue}:plugins.update.registry`
            }
            return {
                ...settings,
                plugins: {
                    update: {
                        ...(settings.plugins?.update ?? DEFAULT_PLUGINS.update),
                        registry: url,
                    },
                },
            }
        }
        case "plugins.update.githubToken": {
            const token = raw === "null" || raw === "none" || raw === "" ? null : raw
            return {
                ...settings,
                plugins: {
                    update: {
                        ...(settings.plugins?.update ?? DEFAULT_PLUGINS.update),
                        githubToken: token,
                    },
                },
            }
        }
        case "network.noProxy": {
            const noProxy = splitNoProxy(raw)
            const current = settings.network.proxy
            if (current === null && noProxy.length > 0) {
                return `${USAGE_CODES.invalidValue}:network.noProxy（先设置 network.proxy）`
            }
            return {
                ...settings,
                network: {
                    proxy: current === null ? null : { ...current, noProxy },
                },
            }
        }
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
            if (isKey(key)) {
                const value = readValue(ctx.settings, key)
                ctx.elog.print(value === null ? "null" : JSON.stringify(value))
                return success({ key, value })
            }
            const pluginRef = parsePluginKey(key)
            if (pluginRef !== null) {
                const config = await readPluginConfig(ctx, pluginRef.pluginId)
                if (typeof config === "string") {
                    return failure(config)
                }
                const value = pluginRef.field === null ? config : (config[pluginRef.field] ?? null)
                ctx.elog.print(value === null ? "null" : JSON.stringify(value))
                return success({ key, value })
            }
            return failure(`${USAGE_CODES.unknownConfigKey}:${key}`)
        }
        case "set": {
            const key = line.positionals[0]
            const raw = line.positionals[1]
            if (key === undefined || raw === undefined) {
                return failure(`${USAGE_CODES.missingValue}:key value`)
            }
            /* 全局键优先：plugins.update.* 不是某个插件的配置 */
            if (isKey(key)) {
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
            const pluginRef = parsePluginKey(key)
            if (pluginRef !== null) {
                const config = await readPluginConfig(ctx, pluginRef.pluginId)
                if (typeof config === "string") {
                    return failure(config)
                }
                const value = parsePluginValue(raw)
                if (pluginRef.field === null) {
                    if (typeof value !== "object" || value === null || Array.isArray(value)) {
                        return failure(`${CONFIG_CODES.invalid}:${key}（整份配置需要 JSON 对象）`)
                    }
                    await writeJsonAtomic(pluginConfigFile(pluginRef.pluginId, ctx.paths), value)
                } else {
                    config[pluginRef.field] = value
                    await writeJsonAtomic(pluginConfigFile(pluginRef.pluginId, ctx.paths), config)
                }
                ctx.elog.info(`已更新 ${key}（重启服务后生效）`)
                return success({ key, value })
            }
            return failure(`${USAGE_CODES.unknownConfigKey}:${key}`)
        }
        default:
            return failure(`${USAGE_CODES.unknownSubcommand}:config ${subcommand ?? ""}`)
    }
}
