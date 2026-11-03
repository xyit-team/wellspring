/*
 * 宿主插件管理：列出已安装插件，安装 / 卸载 / 启用 / 禁用。
 * 所有改动都在下次启动时生效；运行期不热加载插件。
 */

export type HostPluginEntryStatus = "ok" | "failed" | "disabled" | "unknown"

export interface HostPluginEntry {
    readonly id: string
    readonly name: string
    readonly version: string
    readonly status: HostPluginEntryStatus
    readonly enabled: boolean
    /** 依赖的其它插件 id */
    readonly deps: readonly string[]
    readonly commands: readonly string[]
    /** 插件根目录下的目录名 */
    readonly dir: string
}

export interface HostPluginListResult {
    readonly plugins: readonly HostPluginEntry[]
}

export interface HostPluginInstallInput {
    /** 原始文件名，必须是 .zip */
    readonly filename: string
    /** zip 包的 base64 编码 */
    readonly dataBase64: string
    /** 允许覆盖同名插件 */
    readonly force?: boolean
}

export interface HostPluginMutationResult {
    readonly ok: boolean
    readonly id: string
    readonly restartRequired: boolean
    /** true 表示已即时生效，不需要重启 */
    readonly hot?: boolean
    readonly changed?: boolean
    /** 依赖目标插件的其它插件；禁用/卸载时要提示 */
    readonly dependents?: readonly string[]
    /** 安装时实际使用的包管理器（没有安装依赖时为 null） */
    readonly packageManager?: string | null
    /** 安装时是否自动安装了依赖 */
    readonly dependenciesInstalled?: boolean
    readonly error?: string
}

/** 单个插件的检查更新结果 */
export interface HostPluginUpdateEntry {
    readonly id: string
    /** 已装版本（来自 package.json） */
    readonly installed: string
    /** 插件自报的最新版本；没有探针、探针失败或超时为 null */
    readonly latest: string | null
    readonly updateAvailable: boolean
    /** 失败原因；成功或没有探针时为 null */
    readonly error: string | null
    /** 插件是否注册了版本探针 */
    readonly hasProbe: boolean
    /** 最新版 zip 包地址；插件没给或地址不合法时为 null */
    readonly downloadUrl: string | null
}

export interface HostPluginUpdateResult {
    readonly plugins: readonly HostPluginUpdateEntry[]
}

export interface HostPluginsApi {
    /** 列出插件根目录下的全部插件（含禁用与加载失败的） */
    list(): Promise<HostPluginListResult>
    /** 从 zip 安装或覆盖插件 */
    install(input: HostPluginInstallInput): Promise<HostPluginMutationResult>
    /** 删除插件目录；运行中的进程不受影响，重启后不再加载 */
    remove(id: string): Promise<HostPluginMutationResult>
    enable(id: string): Promise<HostPluginMutationResult>
    disable(id: string): Promise<HostPluginMutationResult>
    /**
     * 检查更新
     *
     * 调用插件的版本探针（可能查询网络），与已装版本比较
     * 探针可只报版本号，也可附带最新版 zip 地址
     * 单个插件失败不影响其他插件；无探针的插件标 hasProbe: false
     */
    checkUpdates(): Promise<HostPluginUpdateResult>
}
