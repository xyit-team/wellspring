/*
 * 插件 id 迁移：把旧 id 的本地数据搬到新 id。
 *
 * 为什么由宿主做：插件自己的 sandbox 只放开了 pluginDir、pluginDataDir 与 workspace，
 * 看不到 <dataDir>/plugin-data 的兄弟目录、<configDir>/plugins 与 plugins-state.json。
 * 「搬文件」这种跨目录操作交给宿主，插件只负责注册命令、解析参数与输出。
 *
 * 目前只用于 wellspring-core 从无 scope 的 wellspring-core 升级到
 * @etheros/wellspring-core；接口按通用场景写，不写死具体 id。
 */

export interface HostMigrateInput {
    /** 旧插件 id（例如 wellspring-core） */
    readonly from: string
    /** 新插件 id（例如 @etheros/wellspring-core） */
    readonly to: string
    /** 连旧插件目录一起删掉；旧 id 已经不再安装时才有意义 */
    readonly removeOld?: boolean
    /** 目标已有数据时覆盖（默认拒绝，避免把两边的技能/回收站搅在一起） */
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
