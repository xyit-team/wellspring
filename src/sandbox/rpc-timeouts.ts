/*
 * 插件 sandbox（child）→ 宿主（host）方向 RPC 的超时策略。
 * 单位毫秒；null 表示不设上限，时长由被调用能力自己的步骤/网络超时兜底。
 */

export interface RpcTimeouts {
    /** 普通 RPC：文件、事件、HTTP 建服务、插件数据等 */
    readonly default: number
    /** Agent 单轮对话（非流式）：耗时取决于模型与工具步骤 */
    readonly agentChat: number
    /** Agent 流式对话：一轮可能持续很久，不设上限 */
    readonly agentStream: number | null
    /** 拉取供应商模型列表：要等网络超时与重试 */
    readonly modelsFetch: number
    /** 安装插件：解压、写文件，以及按插件声明的包管理器自动安装依赖（最多 5 分钟） */
    readonly pluginsInstall: number
    /**
     * 卸载插件：删目录
     *
     * Windows 上带 node_modules 的目录删起来比想象中慢，文件锁还要等一会儿才释放；
     * 默认 30s 会在删到一半时先超时。
     */
    readonly pluginsRemove: number
    /** 检查插件更新：探针查询网络，容纳多个插件的耗时 */
    readonly pluginsCheckUpdates: number
    /**
     * 调用插件提供的 Agent 工具
     *
     * 工具自己决定执行多久（`api.exec` 的 timeoutMs 上限 600s），
     * RPC 若用默认 30s 就会先超时：宿主放弃等待、插件仍在跑，
     * 后续工具调用还会排在它后面，界面表现为「工具被中断后卡住」。
     */
    readonly agentTool: number
    /**
     * 执行沙箱命令（execute_code）
     *
     * 沙箱自己的 timeoutMs 最长 600s，RPC 必须比它长；否则宿主已经放弃等待，
     * 沙箱里的进程还在跑，调用方只能看到一条「host RPC 超时」。
     */
    readonly sandboxExec: number
    /**
     * 打开原生文件夹选择框
     *
     * 这是个模态窗口，停留多久取决于用户翻目录，不能用默认的 30s。
     * 之前用默认值：用户还在选目录，RPC 已经超时放弃，插件把错误回给界面，
     * 表现就是「点了添加工作区没反应」。上限要略大于选择框自身的超时（300s）。
     */
    readonly picker: number
}

export const RPC_TIMEOUT_MS: RpcTimeouts = {
    default: 30_000,
    agentChat: 180_000,
    agentStream: null,
    modelsFetch: 120_000,
    pluginsInstall: 660_000,
    pluginsRemove: 180_000,
    pluginsCheckUpdates: 120_000,
    /* 比 exec 的最长上限（600s）再留一点余量；不设 null，避免坏插件把宿主永久挂住 */
    agentTool: 660_000,
    sandboxExec: 660_000,
    /* 选择框自己 300s 后放弃（见 PICKER_TIMEOUT_MS），这里留 20s 收尾余量 */
    picker: 320_000,
}
