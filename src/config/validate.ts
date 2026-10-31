import type { LevelWithSilent } from "pino"

import { Result } from "../api/result/result.ts"
import { CONFIG_CODES, invalidCode } from "./codes.ts"
import { DEFAULT_MODELS, DEFAULT_SETTINGS } from "./defaults.ts"
import {
    REASONING_LEVELS,
    SETTING_VERSION,
    type AppSetting,
    type ModelProviderSetting,
    type ModelsSetting,
    type NetworkSetting,
    type OpenAISetting,
    type ProxySetting,
    type SandboxAccess,
    type SandboxBackend,
    type SandboxMode,
    type SandboxSetting,
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

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const BUILTIN_PROVIDER_ID = "openai"
const MAX_PROVIDERS = 20
const MAX_MODELS_PER_PROVIDER = 200

function validateProvider(
    input: Record<string, unknown>,
    seen: ReadonlySet<string>,
): Result<ModelProviderSetting> {
    const rawId = input["id"]
    const id = typeof rawId === "string" && PROVIDER_ID.test(rawId.trim()) ? rawId.trim() : null
    if (id === null || id === BUILTIN_PROVIDER_ID) {
        return Result.error<ModelProviderSetting>(invalidCode("models.providers.id"))
    }
    if (seen.has(id)) {
        return Result.error<ModelProviderSetting>(invalidCode(`models.providers.${id}`))
    }
    const rawName = input["name"]
    const name =
        typeof rawName === "string" && rawName.trim() !== "" && rawName.trim().length <= 60
            ? rawName.trim()
            : null
    if (name === null) {
        return Result.error<ModelProviderSetting>(invalidCode(`models.providers.${id}.name`))
    }
    let baseUrl: string | null = null
    const rawBaseUrl = input["baseUrl"]
    if (rawBaseUrl !== undefined && rawBaseUrl !== null) {
        if (!isBaseUrl(rawBaseUrl)) {
            return Result.error<ModelProviderSetting>(invalidCode(`models.providers.${id}.baseUrl`))
        }
        baseUrl = rawBaseUrl.trim()
    }
    const models: string[] = []
    const rawModels = input["models"]
    if (rawModels !== undefined) {
        if (!Array.isArray(rawModels) || rawModels.length > MAX_MODELS_PER_PROVIDER) {
            return Result.error<ModelProviderSetting>(invalidCode(`models.providers.${id}.models`))
        }
        for (const item of rawModels) {
            if (typeof item !== "string" || item.trim() === "" || item.trim().length > 120) {
                return Result.error<ModelProviderSetting>(
                    invalidCode(`models.providers.${id}.models`),
                )
            }
            const model = item.trim()
            if (!models.includes(model)) {
                models.push(model)
            }
        }
    }
    let defaultModel: string | null = null
    const rawDefault = input["defaultModel"]
    if (rawDefault !== undefined && rawDefault !== null) {
        if (typeof rawDefault !== "string" || rawDefault.trim() === "") {
            return Result.error<ModelProviderSetting>(
                invalidCode(`models.providers.${id}.defaultModel`),
            )
        }
        defaultModel = rawDefault.trim()
    }
    let apiKeyEnv: string | null = null
    const rawEnv = input["apiKeyEnv"]
    if (rawEnv !== undefined && rawEnv !== null) {
        if (typeof rawEnv !== "string" || !ENV_NAME.test(rawEnv.trim())) {
            return Result.error<ModelProviderSetting>(
                invalidCode(`models.providers.${id}.apiKeyEnv`),
            )
        }
        apiKeyEnv = rawEnv.trim()
    }
    return Result.successWithData<ModelProviderSetting>({
        id,
        name,
        baseUrl,
        models,
        defaultModel,
        apiKeyEnv,
    })
}

function validateModels(input: Record<string, unknown>): Result<ModelsSetting> {
    const providers: ModelProviderSetting[] = []
    const rawProviders = input["providers"]
    if (rawProviders !== undefined && rawProviders !== null) {
        if (!Array.isArray(rawProviders) || rawProviders.length > MAX_PROVIDERS) {
            return Result.error<ModelsSetting>(invalidCode("models.providers"))
        }
        const seen = new Set<string>()
        for (const item of rawProviders) {
            if (!isPlainObject(item)) {
                return Result.error<ModelsSetting>(invalidCode("models.providers"))
            }
            const validated = validateProvider(item, seen)
            if (!validated.isSuccess()) {
                return Result.error<ModelsSetting>(validated.getCode() ?? CONFIG_CODES.invalid)
            }
            const provider = validated.getData()
            if (provider === null) {
                return Result.error<ModelsSetting>(invalidCode("models.providers"))
            }
            seen.add(provider.id)
            providers.push(provider)
        }
    }

    let activeProvider = DEFAULT_MODELS.activeProvider
    const rawActiveProvider = input["activeProvider"]
    if (rawActiveProvider !== undefined && rawActiveProvider !== null) {
        if (typeof rawActiveProvider !== "string" || rawActiveProvider.trim() === "") {
            return Result.error<ModelsSetting>(invalidCode("models.activeProvider"))
        }
        activeProvider = rawActiveProvider.trim()
    }
    const known =
        activeProvider === BUILTIN_PROVIDER_ID || providers.some((p) => p.id === activeProvider)
    if (!known) {
        return Result.error<ModelsSetting>(invalidCode("models.activeProvider"))
    }

    let activeModel: string | null = DEFAULT_MODELS.activeModel
    const rawActiveModel = input["activeModel"]
    if (rawActiveModel !== undefined && rawActiveModel !== null) {
        if (typeof rawActiveModel !== "string" || rawActiveModel.trim() === "") {
            return Result.error<ModelsSetting>(invalidCode("models.activeModel"))
        }
        activeModel = rawActiveModel.trim()
    }

    let activeReasoning = DEFAULT_MODELS.activeReasoning
    const rawActiveReasoning = input["activeReasoning"]
    if (rawActiveReasoning !== undefined && rawActiveReasoning !== null) {
        if (
            typeof rawActiveReasoning !== "string" ||
            !(REASONING_LEVELS as readonly string[]).includes(rawActiveReasoning)
        ) {
            return Result.error<ModelsSetting>(invalidCode("models.activeReasoning"))
        }
        activeReasoning = rawActiveReasoning as ModelsSetting["activeReasoning"]
    }

    return Result.successWithData<ModelsSetting>({
        providers,
        activeProvider,
        activeModel,
        activeReasoning,
    })
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

const SANDBOX_MODES: ReadonlySet<string> = new Set<SandboxMode>(["off", "strict", "best-effort"])
const SANDBOX_BACKENDS: ReadonlySet<string> = new Set<SandboxBackend>([
    "auto",
    "bwrap",
    "nsjail",
    "seatbelt",
])
const SANDBOX_ACCESS: ReadonlySet<string> = new Set<SandboxAccess>([
    "read-only",
    "workspace-write",
    "danger-full-access",
])

function validateSandbox(input: Record<string, unknown>): Result<SandboxSetting> {
    let mode = DEFAULT_SETTINGS.sandbox.mode
    const rawMode = input["mode"]
    if (rawMode !== undefined) {
        if (typeof rawMode !== "string" || !SANDBOX_MODES.has(rawMode)) {
            return Result.error<SandboxSetting>(invalidCode("sandbox.mode"))
        }
        mode = rawMode as SandboxMode
    }

    let backend = DEFAULT_SETTINGS.sandbox.backend
    const rawBackend = input["backend"]
    if (rawBackend !== undefined) {
        if (typeof rawBackend !== "string" || !SANDBOX_BACKENDS.has(rawBackend)) {
            return Result.error<SandboxSetting>(invalidCode("sandbox.backend"))
        }
        backend = rawBackend as SandboxBackend
    }

    let access = DEFAULT_SETTINGS.sandbox.access
    const rawAccess = input["access"]
    if (rawAccess !== undefined) {
        if (typeof rawAccess !== "string" || !SANDBOX_ACCESS.has(rawAccess)) {
            return Result.error<SandboxSetting>(invalidCode("sandbox.access"))
        }
        access = rawAccess as SandboxAccess
    }

    let maxConcurrent = DEFAULT_SETTINGS.sandbox.maxConcurrent
    const rawMaxConcurrent = input["maxConcurrent"]
    if (rawMaxConcurrent !== undefined) {
        if (!isPositiveInteger(rawMaxConcurrent) || rawMaxConcurrent > 32) {
            return Result.error<SandboxSetting>(invalidCode("sandbox.maxConcurrent"))
        }
        maxConcurrent = rawMaxConcurrent
    }

    let defaultTimeoutMs = DEFAULT_SETTINGS.sandbox.defaultTimeoutMs
    const rawTimeout = input["defaultTimeoutMs"]
    if (rawTimeout !== undefined) {
        if (!isPositiveInteger(rawTimeout) || rawTimeout > 600_000) {
            return Result.error<SandboxSetting>(invalidCode("sandbox.defaultTimeoutMs"))
        }
        defaultTimeoutMs = rawTimeout
    }

    let defaultMemoryMB = DEFAULT_SETTINGS.sandbox.defaultMemoryMB
    const rawMemory = input["defaultMemoryMB"]
    if (rawMemory !== undefined) {
        if (!isPositiveInteger(rawMemory) || rawMemory > 8192) {
            return Result.error<SandboxSetting>(invalidCode("sandbox.defaultMemoryMB"))
        }
        defaultMemoryMB = rawMemory
    }

    let outputLimitBytes = DEFAULT_SETTINGS.sandbox.outputLimitBytes
    const rawOutput = input["outputLimitBytes"]
    if (rawOutput !== undefined) {
        if (!isPositiveInteger(rawOutput) || rawOutput < 1024 || rawOutput > 64 * 1024 * 1024) {
            return Result.error<SandboxSetting>(invalidCode("sandbox.outputLimitBytes"))
        }
        outputLimitBytes = rawOutput
    }

    return Result.successWithData<SandboxSetting>({
        mode,
        backend,
        access,
        maxConcurrent,
        defaultTimeoutMs,
        defaultMemoryMB,
        outputLimitBytes,
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

    const models = input["models"]
    if (models !== undefined && models !== null && !isPlainObject(models)) {
        return Result.error<AppSetting>(invalidCode("models"))
    }
    let modelsSetting = DEFAULT_MODELS
    if (models !== undefined && models !== null) {
        const validated = validateModels(models)
        if (!validated.isSuccess()) {
            return Result.error<AppSetting>(validated.getCode() ?? CONFIG_CODES.invalid)
        }
        modelsSetting = validated.getData() ?? DEFAULT_MODELS
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

    const sandbox = input["sandbox"]
    if (sandbox !== undefined && !isPlainObject(sandbox)) {
        return Result.error<AppSetting>(invalidCode("sandbox"))
    }
    let sandboxSetting = DEFAULT_SETTINGS.sandbox
    if (sandbox !== undefined) {
        const validated = validateSandbox(sandbox)
        if (!validated.isSuccess()) {
            return Result.error<AppSetting>(validated.getCode() ?? CONFIG_CODES.invalid)
        }
        sandboxSetting = validated.getData() ?? DEFAULT_SETTINGS.sandbox
    }

    return Result.successWithData<AppSetting>({
        version: SETTING_VERSION,
        logger: { level: rawLevel ?? DEFAULT_SETTINGS.logger.level },
        openai: openaiSetting,
        models: modelsSetting,
        network: networkSetting,
        sandbox: sandboxSetting,
    })
}
