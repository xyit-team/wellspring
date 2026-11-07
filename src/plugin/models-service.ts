// 宿主模型服务：给 sandbox 插件提供自定义供应商与模型切换
// 配置写在 app-setting.json 的 models 节，每次调用实时读写，改完下一轮对话生效
// 供应商 Key 存在 credentials.json，状态只返回掩码

import type { Logger } from "pino"

import type {
    HostModelProvider,
    HostModelProviderInput,
    HostModelsApi,
    HostModelsFetchResult,
    HostModelsState,
    HostModelsStateResult,
} from "../api/host/models.ts"
import { CONFIG_CODES } from "../config/codes.ts"
import {
    clearProviderApiKey,
    credentialsFile,
    normalizeApiKey,
    providerKeyStatusSync,
    saveProviderApiKey,
} from "../config/credentials.ts"
import { DEFAULT_SETTINGS } from "../config/defaults.ts"
import { REASONING_LEVELS, type ReasoningLevel } from "../config/types.ts"
import { loadSettings, saveSettings, SETTING_FILE_NAME } from "../config/loader.ts"
import {
    BUILTIN_PROVIDER_ID,
    listModelProviders,
    modelsSetting,
    providerApiKey,
} from "../config/providers.ts"
import type { AppSetting, ModelProviderSetting } from "../config/types.ts"
import { OpenAIClient } from "../network/openai.ts"
import { createProxyFetch } from "../network/proxy.ts"

export interface HostModelsServiceOptions {
    readonly settings: AppSetting
    /** app-setting.json 的绝对路径 */
    readonly settingsFile: string
    /** 凭据文件所在 config 目录 */
    readonly configDir: string
    readonly logger: Logger
}

export interface HostModelsService extends HostModelsApi {
    state(): Promise<HostModelsState>
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/
const MAX_MODEL_CHARS = 120

function normalizeModels(value: readonly string[] | undefined): string[] {
    const models: string[] = []
    for (const item of value ?? []) {
        if (typeof item !== "string") {
            continue
        }
        const model = item.trim()
        if (model === "" || model.length > MAX_MODEL_CHARS || models.includes(model)) {
            continue
        }
        models.push(model)
    }
    return models
}

function slugOf(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32)
    return PROVIDER_ID.test(slug) ? slug : "provider"
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
    if (!taken.has(base) && base !== BUILTIN_PROVIDER_ID) {
        return base
    }
    for (let index = 2; index < 100; index += 1) {
        const candidate = `${base}-${index}`
        if (
            !taken.has(candidate) &&
            candidate !== BUILTIN_PROVIDER_ID &&
            PROVIDER_ID.test(candidate)
        ) {
            return candidate
        }
    }
    return `provider-${Date.now().toString(36)}`
}

export function createHostModelsService(options: HostModelsServiceOptions): HostModelsService {
    const logger = options.logger.child({ module: "models" })
    const settingsFile = options.settingsFile
    const credentialsPath = credentialsFile(options.configDir)

    const currentSettings = async (): Promise<AppSetting> => {
        const loaded = await loadSettings(settingsFile)
        return loaded.getData() ?? options.settings ?? DEFAULT_SETTINGS
    }

    const stateOf = (settings: AppSetting): HostModelsState => {
        const models = modelsSetting(settings)
        const providers: HostModelProvider[] = listModelProviders(settings).map((provider) => {
            const key = providerKeyStatusSync(
                { id: provider.id, apiKeyEnv: provider.apiKeyEnv },
                credentialsPath,
            )
            return {
                id: provider.id,
                name: provider.name,
                baseUrl: provider.baseUrl,
                models: provider.models,
                defaultModel: provider.defaultModel,
                apiKeyEnv: provider.apiKeyEnv,
                builtin: provider.builtin,
                keyConfigured: key.configured,
                keySource: key.source,
                keyMasked: key.masked,
                envVar: key.envVar,
                keyStored: key.stored,
            }
        })
        const activeProvider = providers.some((provider) => provider.id === models.activeProvider)
            ? models.activeProvider
            : BUILTIN_PROVIDER_ID
        return {
            providers,
            activeProvider,
            activeModel: models.activeModel,
            activeReasoning: models.activeReasoning,
            reasoningLevels: REASONING_LEVELS,
        }
    }

    const saveProviderConfig = async (
        settings: AppSetting,
        provider: ModelProviderSetting,
    ): Promise<HostModelsStateResult> => {
        const models = modelsSetting(settings)
        const providers = [...models.providers]
        const index = providers.findIndex((item) => item.id === provider.id)
        if (index === -1) {
            if (providers.length >= 20) {
                return { ok: false, code: "models.too-many-providers", state: stateOf(settings) }
            }
            providers.push(provider)
        } else {
            providers[index] = provider
        }
        const next: AppSetting = {
            ...settings,
            models: { ...models, providers },
        }
        const saved = await saveSettings(next, settingsFile)
        if (!saved.isSuccess()) {
            return {
                ok: false,
                code: saved.getCode() ?? CONFIG_CODES.invalid,
                state: stateOf(settings),
            }
        }
        return { ok: true, state: stateOf(next) }
    }

    const fail = async (code: string): Promise<HostModelsStateResult> => ({
        ok: false,
        code,
        state: stateOf(await currentSettings()),
    })

    return {
        async state(): Promise<HostModelsState> {
            return stateOf(await currentSettings())
        },

        async setActive(
            providerId: string,
            model: string | null,
            reasoning?: string | null,
        ): Promise<HostModelsState> {
            const settings = await currentSettings()
            const models = modelsSetting(settings)
            const id = providerId.trim()
            const exists = listModelProviders(settings).some((provider) => provider.id === id)
            if (!exists) {
                throw new Error("models.provider-not-found")
            }
            const nextModel = typeof model === "string" && model.trim() !== "" ? model.trim() : null
            if (nextModel !== null && nextModel.length > MAX_MODEL_CHARS) {
                throw new Error("models.invalid-model")
            }
            const nextReasoning =
                typeof reasoning === "string" && reasoning.trim() !== ""
                    ? reasoning.trim()
                    : models.activeReasoning
            if (!(REASONING_LEVELS as readonly string[]).includes(nextReasoning)) {
                throw new Error("models.invalid-reasoning")
            }
            const next: AppSetting = {
                ...settings,
                models: {
                    ...models,
                    activeProvider: id,
                    activeModel: nextModel,
                    activeReasoning: nextReasoning as ReasoningLevel,
                },
            }
            const saved = await saveSettings(next, settingsFile)
            if (!saved.isSuccess()) {
                throw new Error(saved.getCode() ?? CONFIG_CODES.invalid)
            }
            logger.info({ provider: id, model: nextModel, reasoning: nextReasoning }, "切换模型")
            return stateOf(next)
        },

        async saveProvider(input: HostModelProviderInput): Promise<HostModelsStateResult> {
            const settings = await currentSettings()
            const models = modelsSetting(settings)
            const name = typeof input.name === "string" ? input.name.trim() : ""
            if (name === "" || name.length > 60) {
                return await fail(CONFIG_CODES.invalid)
            }
            const explicitId =
                typeof input.id === "string" && input.id.trim() !== "" ? input.id.trim() : ""
            const taken = new Set(models.providers.map((provider) => provider.id))
            let id = explicitId
            if (id === "") {
                id = uniqueId(slugOf(name), taken)
            } else if (!PROVIDER_ID.test(id) || id === BUILTIN_PROVIDER_ID) {
                return await fail(CONFIG_CODES.invalid)
            }
            const apiKey =
                typeof input.apiKey === "string" && input.apiKey.trim() !== ""
                    ? normalizeApiKey(input.apiKey)
                    : null
            if (typeof input.apiKey === "string" && input.apiKey.trim() !== "" && apiKey === null) {
                return { ok: false, code: CONFIG_CODES.invalidApiKey, state: stateOf(settings) }
            }
            const rawBaseUrl = input.baseUrl
            const baseUrl =
                typeof rawBaseUrl === "string" && rawBaseUrl.trim() !== ""
                    ? rawBaseUrl.trim()
                    : null
            const provider: ModelProviderSetting = {
                id,
                name,
                baseUrl,
                models: normalizeModels(input.models),
                defaultModel:
                    typeof input.defaultModel === "string" && input.defaultModel.trim() !== ""
                        ? input.defaultModel.trim()
                        : null,
                apiKeyEnv:
                    typeof input.apiKeyEnv === "string" && input.apiKeyEnv.trim() !== ""
                        ? input.apiKeyEnv.trim()
                        : null,
            }
            const result = await saveProviderConfig(settings, provider)
            if (!result.ok) {
                return result
            }
            if (apiKey !== null) {
                const keyed = await saveProviderApiKey(id, apiKey, credentialsPath)
                if (!keyed.isSuccess()) {
                    return await fail(keyed.getCode() ?? CONFIG_CODES.credentialsWriteFailed)
                }
            }
            return { ok: true, state: stateOf(await currentSettings()) }
        },

        async removeProvider(id: string): Promise<HostModelsStateResult> {
            const settings = await currentSettings()
            const models = modelsSetting(settings)
            if (id === BUILTIN_PROVIDER_ID) {
                return await fail("models.builtin-provider")
            }
            const providers = models.providers.filter((provider) => provider.id !== id)
            if (providers.length === models.providers.length) {
                return await fail("models.provider-not-found")
            }
            const next: AppSetting = {
                ...settings,
                models: {
                    ...models,
                    providers,
                    activeProvider:
                        models.activeProvider === id ? BUILTIN_PROVIDER_ID : models.activeProvider,
                    activeModel: models.activeProvider === id ? null : models.activeModel,
                },
            }
            const saved = await saveSettings(next, settingsFile)
            if (!saved.isSuccess()) {
                return await fail(saved.getCode() ?? CONFIG_CODES.invalid)
            }
            await clearProviderApiKey(id, credentialsPath)
            logger.info({ provider: id }, "删除自定义供应商")
            return { ok: true, state: stateOf(next) }
        },

        async fetchModels(id: string, candidate?: string): Promise<HostModelsFetchResult> {
            const settings = await currentSettings()
            const provider = listModelProviders(settings).find((item) => item.id === id)
            if (provider === undefined) {
                return { ok: false, code: "models.provider-not-found" }
            }
            let apiKey: string | undefined
            if (typeof candidate === "string" && candidate.trim() !== "") {
                const normalized = normalizeApiKey(candidate)
                if (normalized === null) {
                    return { ok: false, code: CONFIG_CODES.invalidApiKey }
                }
                apiKey = normalized
            } else {
                apiKey = providerApiKey(provider, options.configDir) ?? undefined
            }
            if (apiKey === undefined) {
                return { ok: false, code: "openai.missing-api-key" }
            }
            let proxyFetch: ReturnType<typeof createProxyFetch> | undefined
            try {
                proxyFetch = createProxyFetch(settings.network.proxy)
            } catch {
                proxyFetch = undefined
            }
            const created = OpenAIClient.create({
                settings: {
                    ...settings.openai,
                    baseUrl: provider.baseUrl,
                    model: provider.defaultModel ?? provider.models[0] ?? settings.openai.model,
                },
                apiKey,
                credentialsFile: credentialsPath,
                logger,
                fetch: proxyFetch,
            })
            const client = created.getData()
            if (!created.isSuccess() || client === null) {
                return { ok: false, code: created.getCode() ?? "openai.missing-api-key" }
            }
            const listed = await client.listModels()
            const data = listed.getData()
            if (!listed.isSuccess() || data === null) {
                return { ok: false, code: listed.getCode() ?? "openai.request-failed" }
            }
            return { ok: true, models: data }
        },

        async saveKey(id: string, apiKey: string): Promise<HostModelsStateResult> {
            const settings = await currentSettings()
            const exists = listModelProviders(settings).some((provider) => provider.id === id)
            if (!exists) {
                return await fail("models.provider-not-found")
            }
            const saved = await saveProviderApiKey(id, apiKey, credentialsPath)
            if (!saved.isSuccess()) {
                return {
                    ok: false,
                    code: saved.getCode() ?? CONFIG_CODES.invalidApiKey,
                    state: stateOf(settings),
                }
            }
            return { ok: true, state: stateOf(settings) }
        },

        async clearKey(id: string): Promise<HostModelsState> {
            const settings = await currentSettings()
            const exists = listModelProviders(settings).some((provider) => provider.id === id)
            if (!exists) {
                throw new Error("models.provider-not-found")
            }
            const cleared = await clearProviderApiKey(id, credentialsPath)
            if (!cleared.isSuccess()) {
                throw new Error(cleared.getCode() ?? CONFIG_CODES.credentialsWriteFailed)
            }
            return stateOf(settings)
        },
    }
}
