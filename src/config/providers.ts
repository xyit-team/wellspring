/*
 * 模型供应商与模型解析
 *
 * 内置供应商 id 为 openai，由 app-setting.json 的 openai.* 描述
 * 自定义供应商来自 models.providers，接口按 OpenAI 兼容处理（baseUrl + key）
 */

import { BUILTIN_PROVIDER_ID, credentialsFile, resolveProviderApiKeySync } from "./credentials.ts"
import { DEFAULT_MODELS } from "./defaults.ts"
import type { AppSetting, ModelProviderSetting, ModelsSetting } from "./types.ts"

export { BUILTIN_PROVIDER_ID }

/** 解析后的供应商：内置项同样带 builtin 标记与可用的模型列表 */
export interface ResolvedModelProvider extends ModelProviderSetting {
    readonly builtin: boolean
}

/** 旧配置没有 models 节时用默认值 */
export function modelsSetting(settings: AppSetting): ModelsSetting {
    return settings.models ?? DEFAULT_MODELS
}

/** 供应商列表：内置 openai 永远排第一，自定义按配置顺序 */
export function listModelProviders(settings: AppSetting): readonly ResolvedModelProvider[] {
    const builtin: ResolvedModelProvider = {
        id: BUILTIN_PROVIDER_ID,
        name: settings.openai.baseUrl === null ? "OpenAI（默认）" : "默认供应商",
        baseUrl: settings.openai.baseUrl,
        models: [settings.openai.model],
        defaultModel: settings.openai.model,
        apiKeyEnv: "OPENAI_API_KEY",
        builtin: true,
    }
    return [
        builtin,
        ...modelsSetting(settings).providers.map((provider) => ({ ...provider, builtin: false })),
    ]
}

export function findModelProvider(settings: AppSetting, id: string): ResolvedModelProvider | null {
    return listModelProviders(settings).find((provider) => provider.id === id) ?? null
}

/** 当前生效的供应商；配置里的 id 失效时退回内置 openai */
export function activeModelProvider(settings: AppSetting): ResolvedModelProvider {
    const active = findModelProvider(settings, modelsSetting(settings).activeProvider)
    return active ?? listModelProviders(settings)[0]!
}

// 某次请求实际使用的模型，优先级从高到低：
// 显式覆盖 > 全局 activeModel（仅当前供应商）> 供应商 defaultModel > 模型列表第一个 > 全局 openai.model
export function effectiveModel(
    settings: AppSetting,
    provider: ResolvedModelProvider,
    override?: string | null,
): string {
    const explicit = typeof override === "string" ? override.trim() : ""
    if (explicit !== "") {
        return explicit
    }
    const models = modelsSetting(settings)
    if (provider.id === models.activeProvider && models.activeModel !== null) {
        return models.activeModel
    }
    if (provider.defaultModel !== null && provider.defaultModel !== "") {
        return provider.defaultModel
    }
    if (provider.models.length > 0) {
        return provider.models[0]!
    }
    return settings.openai.model
}

/** 某次请求使用的供应商；请求未指定时取全局当前供应商 */
export function requestProvider(
    settings: AppSetting,
    providerId?: string | null,
): ResolvedModelProvider {
    const requested = typeof providerId === "string" ? providerId.trim() : ""
    if (requested !== "") {
        const found = findModelProvider(settings, requested)
        if (found !== null) {
            return found
        }
    }
    return activeModelProvider(settings)
}

// 某次请求的推理强度：显式覆盖 > 全局 activeReasoning（仅当前供应商）> off
export function effectiveReasoning(
    settings: AppSetting,
    provider: ResolvedModelProvider,
    override?: string | null,
): string {
    const explicit = typeof override === "string" ? override.trim() : ""
    if (explicit !== "") {
        return explicit
    }
    const models = modelsSetting(settings)
    if (provider.id === models.activeProvider) {
        return models.activeReasoning
    }
    return "off"
}

/** 供应商对应的 OpenAI 设置（baseUrl + 实际模型） */
export function providerOpenAISettings(
    settings: AppSetting,
    provider: ResolvedModelProvider,
    model?: string | null,
): AppSetting["openai"] {
    return {
        ...settings.openai,
        baseUrl: provider.baseUrl,
        model: effectiveModel(settings, provider, model),
    }
}

/** 供应商的 key：环境变量优先，然后本地凭据；没有返回 null */
export function providerApiKey(provider: ResolvedModelProvider, configDir: string): string | null {
    return (
        resolveProviderApiKeySync(
            { id: provider.id, apiKeyEnv: provider.apiKeyEnv },
            credentialsFile(configDir),
        )?.apiKey ?? null
    )
}
