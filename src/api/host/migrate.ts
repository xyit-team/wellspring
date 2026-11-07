/*
 * 插件 id 迁移：把旧 id 的本地数据搬到新 id
 *
 * 插件 sandbox 只放开 pluginDir、pluginDataDir 与 workspace
 * 看不到 <dataDir>/plugin-data 的兄弟目录、<configDir>/plugins 与 plugins-state.json
 * 跨目录搬文件由宿主执行，插件只注册命令、解析参数与输出
 *
 * 目前用于 wellspring-core 从无 scope 的 wellspring-core 升级到 @etheros/wellspring-core
 * 接口按通用场景写，不写死具体 id
 */

export interface HostMigrateInput {
    /** 旧插件 id（例如 wellspring-core） */
    readonly from: string
    /** 新插件 id（例如 @etheros/wellspring-core） */
    readonly to: string
    /** 同时删除旧插件目录；旧 id 已不再安装时使用 */
    readonly removeOld?: boolean
    /** 目标已有数据时覆盖；默认拒绝 */
    readonly force?: boolean
}

export interface HostMigrateResult {
    readonly ok: boolean
    readonly from: string
    readonly to: string
    /** 实际做过的事，按顺序；命令直接逐行打印 */
    readonly steps: readonly string[]
    /** 没做但不算失败的项（例如旧数据本来就不存在） */
    readonly skipped: readonly string[]
    readonly error?: string
}

export interface HostMigrateApi {
    /** 迁移插件本地数据：plugin-data、插件配置、禁用状态，可选删掉旧插件目录 */
    movePluginData(input: HostMigrateInput): Promise<HostMigrateResult>
}
