import type { LevelWithSilent } from "pino"

/** 配置文件结构版本，字段变更时递增并在 loader 中迁移 */
export const SETTING_VERSION = 1

export interface LoggerSetting {
    readonly level: LevelWithSilent
}

export interface OpenAISetting {
    /** 兼容网关地址；null 表示使用 SDK 默认值或 OPENAI_BASE_URL */
    readonly baseUrl: string | null
    readonly model: string
    readonly timeoutMs: number
    readonly maxRetries: number
}

/** 自定义模型供应商（OpenAI 兼容接口）；内置供应商 openai 由 openai.* 字段描述 */
export interface ModelProviderSetting {
    /** 供应商标识，1-32 位 [a-z0-9-_.]；不能叫 openai */
    readonly id: string
    readonly name: string
    /** null 表示使用 SDK 默认地址 */
    readonly baseUrl: string | null
    /** 预置模型列表；可手动维护，也可从供应商接口拉取 */
    readonly models: readonly string[]
    /** 该供应商缺省模型；null 时取列表第一个或全局 openai.model */
    readonly defaultModel: string | null
    /** 可选：用这个环境变量提供该供应商的 API Key（优先级高于本地凭据） */
    readonly apiKeyEnv: string | null
}

/** 推理强度；参考 Harness：off / low / high / max */
export type ReasoningLevel = "off" | "low" | "high" | "max"

export const REASONING_LEVELS: readonly ReasoningLevel[] = ["off", "low", "high", "max"]

export interface ModelsSetting {
    /** 自定义供应商；内置 openai 不在列表里 */
    readonly providers: readonly ModelProviderSetting[]
    /** 当前使用的供应商 id；openai 表示内置 */
    readonly activeProvider: string
    /** 当前使用的模型；null 表示用供应商缺省模型 */
    readonly activeModel: string | null
    /** 当前推理强度；off 表示不发推理参数 */
    readonly activeReasoning: ReasoningLevel
}

/** 代理类型，一期只支持 http/https 代理 */
export type ProxyType = "http"

export interface ProxySetting {
    readonly type: ProxyType
    /** 代理地址，认证信息可写在 URL 里 */
    readonly url: string
    /** 不走代理的主机后缀，例如 example.com、.internal */
    readonly noProxy: readonly string[]
}

export interface NetworkSetting {
    /** null 表示直连 */
    readonly proxy: ProxySetting | null
}

export type SandboxMode = "off" | "strict" | "best-effort"
export type SandboxBackend = "auto" | "bwrap" | "nsjail"
export type SandboxAccess = "read-only" | "workspace-write" | "danger-full-access"

/** OS 级 sandbox 配置 */
export interface SandboxSetting {
    readonly mode: SandboxMode
    readonly backend: SandboxBackend
    readonly access: SandboxAccess
    readonly maxConcurrent: number
    readonly defaultTimeoutMs: number
    readonly defaultMemoryMB: number
    readonly outputLimitBytes: number
}

export interface AppSetting {
    readonly version: number
    readonly logger: LoggerSetting
    readonly openai: OpenAISetting
    /** 多供应商/模型设置；旧配置没有这一节时按默认值处理 */
    readonly models?: ModelsSetting
    readonly network: NetworkSetting
    readonly sandbox: SandboxSetting
}
