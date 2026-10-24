/*
 * 宿主模型 API：给插件（Web 设置界面）管理自定义供应商与模型切换。
 *
 * 供应商配置写回 app-setting.json 的 models 节；每个供应商的 Key 单独存凭据文件。
 * 状态里只给掩码，读不到明文。
 */

/** 一个供应商的展示信息（含 Key 状态，不含明文） */
export interface HostModelProvider {
    readonly id: string
    readonly name: string
    readonly baseUrl: string | null
    readonly models: readonly string[]
    readonly defaultModel: string | null
    readonly apiKeyEnv: string | null
    /** 内置供应商（由 openai.* 描述）不能删除 */
    readonly builtin: boolean
    readonly keyConfigured: boolean
    readonly keySource: "env" | "credentials" | null
    readonly keyMasked: string | null
    /** 该供应商可用的环境变量名（内置为 OPENAI_API_KEY） */
    readonly envVar: string | null
    /** 本地凭据文件里是否有 Key（即使被环境变量覆盖） */
    readonly keyStored: boolean
}

export interface HostModelsState {
    readonly providers: readonly HostModelProvider[]
    readonly activeProvider: string
    readonly activeModel: string | null
    /** 当前推理强度：off / low / high / max */
    readonly activeReasoning: string
    /** 支持的推理强度（界面用） */
    readonly reasoningLevels: readonly string[]
}

/** 新增/修改供应商；id 为空时按 name 生成或新增 */
export interface HostModelProviderInput {
    readonly id?: string | null
    readonly name: string
    readonly baseUrl?: string | null
    readonly models?: readonly string[]
    readonly defaultModel?: string | null
    readonly apiKeyEnv?: string | null
    /** 可选：一起保存该供应商的 API Key（明文只写不读） */
    readonly apiKey?: string | null
}

export interface HostModelsStateResult {
    readonly ok: boolean
    /** ok=false 时的错误码，例如 config.invalid */
    readonly code?: string
    readonly state: HostModelsState
}

export interface HostModelsFetchResult {
    readonly ok: boolean
    readonly code?: string
    readonly models?: readonly string[]
}

export interface HostModelsApi {
    /** 供应商列表、当前供应商与模型 */
    state(): Promise<HostModelsState>
    /** 切换当前供应商、模型与推理强度；model/reasoning 为 null 时保持缺省 */
    setActive(
        providerId: string,
        model: string | null,
        reasoning?: string | null,
    ): Promise<HostModelsState>
    /** 新增或更新自定义供应商 */
    saveProvider(input: HostModelProviderInput): Promise<HostModelsStateResult>
    /** 删除自定义供应商（内置 openai 不可删） */
    removeProvider(id: string): Promise<HostModelsStateResult>
    /** 从供应商接口拉取模型列表（候选 key 优先，其次用已保存的） */
    fetchModels(id: string, apiKey?: string): Promise<HostModelsFetchResult>
    /** 保存某个供应商的 API Key */
    saveKey(id: string, apiKey: string): Promise<HostModelsStateResult>
    /** 清除某个供应商的本地 API Key */
    clearKey(id: string): Promise<HostModelsState>
}
