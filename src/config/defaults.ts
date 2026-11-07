import {
    SETTING_VERSION,
    type AppSetting,
    type ModelsSetting,
    type PluginsSetting,
} from "./types.ts"

/** 默认模型设置；旧配置缺少 models 节时使用 */
export const DEFAULT_MODELS: ModelsSetting = Object.freeze({
    providers: Object.freeze([]),
    activeProvider: "openai",
    activeModel: null,
    activeReasoning: "off",
})

/** 插件更新默认设置：npm 渠道与官方 registry */
export const DEFAULT_PLUGINS: PluginsSetting = Object.freeze({
    update: Object.freeze({
        type: "npm" as const,
        registry: "https://registry.npmjs.org",
        githubToken: null,
    }),
})

/** 缺省配置；缺文件或读取失败时作为回退 */
export const DEFAULT_SETTINGS: AppSetting = Object.freeze({
    version: SETTING_VERSION,
    logger: Object.freeze({ level: "info" as const }),
    openai: Object.freeze({
        baseUrl: null,
        model: "gpt-4o-mini",
        timeoutMs: 60_000,
        maxRetries: 2,
    }),
    models: DEFAULT_MODELS,
    network: Object.freeze({ proxy: null }),
    plugins: DEFAULT_PLUGINS,
    sandbox: Object.freeze({
        mode: "strict" as const,
        backend: "auto" as const,
        access: "read-only" as const,
        maxConcurrent: 2,
        defaultTimeoutMs: 60_000,
        defaultMemoryMB: 512,
        outputLimitBytes: 16 * 1024 * 1024,
    }),
})
