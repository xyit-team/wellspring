import { SETTING_VERSION, type AppSetting } from "./types.ts"

/** 缺省配置。缺文件或读取失败时作为回退 */
export const DEFAULT_SETTINGS: AppSetting = Object.freeze({
    version: SETTING_VERSION,
    logger: Object.freeze({ level: "info" as const }),
    openai: Object.freeze({
        baseUrl: null,
        model: "gpt-4o-mini",
        timeoutMs: 60_000,
        maxRetries: 2,
    }),
    network: Object.freeze({ proxy: null }),
})
