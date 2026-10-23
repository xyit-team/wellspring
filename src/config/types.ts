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
    readonly network: NetworkSetting
    readonly sandbox: SandboxSetting
}
