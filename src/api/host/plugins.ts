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
    readonly error?: string
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
}
