/*
 * 插件 sandbox（child）→ 宿主（host）方向 RPC 的超时策略。
 * 单位毫秒；null 表示不设上限。
 *
 * 这里的分工不是「猜这个操作要多久」，而是两条：
 *
 * 1. 时长由用户或外部进程决定的，写 null。
 *    选择框要等用户翻目录、一轮对话要串起若干次工具调用，这类调用给个固定秒数
 *    必然误杀：宿主还在干活，插件这边已经报「host RPC 超时」，用户看到的是
 *    「点了没反应」。前提是这条链路自己有时间界（脚本、模型客户端、exec 的
 *    timeoutMs、探针的 10s），不能靠 RPC 兜底。
 *
 * 2. 纯宿主内的快操作，保留有限值。
 *    文件、事件、插件数据这些正常都是毫秒级，写几十秒不是性能预算，而是
 *    「宿主卡住时插件别无声挂死」的探针：超时会在日志里留一条
 *    `host RPC 超时：xxx`（picker 那个 bug 就是靠它定位的），也让界面能显示
 *    错误而不是永远转圈，插件侧的 pending 表也不会泄漏。
 *
 * 另外，宿主与插件互相等待时（宿主等某个工具返回、工具又反过来要宿主做事），
 * 有限超时是唯一能自动解开的死锁断路器——所以不整体改成无超时。
 */

export interface RpcTimeouts {
    /** 普通 RPC：文件、事件、HTTP 建服务、插件数据等 */
    readonly default: number
    /** Agent 单轮对话（非流式）：一轮里可能串多个工具，时长由模型与工具决定 */
    readonly agentChat: number | null
    /** Agent 流式对话：一轮可能持续很久，不设上限 */
    readonly agentStream: number | null
    /**
     * 拉取供应商模型列表
     *
     * 供应商客户端自己按 `openai.timeoutMs`（默认 60s）× (1 + maxRetries 2) 结束，
     * 最坏接近 180s；固定 120s 会在重试时先超时。
     */
    readonly modelsFetch: number | null
    /** 安装插件：解压、写文件，以及按插件声明的包管理器自动安装依赖（最多 5 分钟） */
    readonly pluginsInstall: number
    /**
     * 启用/禁用插件
     *
     * 启用会真的把插件拉起来：起沙盒子进程 + 跑 init，而 init 自己就有 30s 的 RPC 上限，
     * 用默认 30s 等于一点余量都没有。
     */
    readonly pluginsToggle: number
    /** 迁移插件数据：搬目录 + 配置，文件多时要一会儿 */
    readonly pluginsMigrate: number
    /**
     * 卸载插件：删目录
     *
     * Windows 上带 node_modules 的目录删起来比想象中慢，文件锁还要等一会儿才释放；
     * 默认 30s 会在删到一半时先超时。
     */
    readonly pluginsRemove: number
    /** 检查插件更新：逐个数探针，探针自身 10s 超时，总量由插件数量决定 */
    readonly pluginsCheckUpdates: number | null
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
    /** 联网工具（webSearch / webFetch）：联网客户端自己有 openai.timeoutMs */
    readonly webTools: number | null
    /** 打开原生文件夹选择框：等用户翻目录，脚本自己 300s 放弃 */
    readonly picker: number | null
}

export const RPC_TIMEOUT_MS: RpcTimeouts = {
    default: 30_000,
    /* 一轮对话的时长由模型与工具决定，各步骤自己就有超时 */
    agentChat: null,
    agentStream: null,
    /* 供应商客户端自己按 timeoutMs × 重试次数结束，固定 120s 会在重试时先超时 */
    modelsFetch: null,
    pluginsInstall: 660_000,
    pluginsToggle: 120_000,
    pluginsMigrate: 180_000,
    pluginsRemove: 180_000,
    /* 逐个探针跑，探针 10s 一个；插件多时 120s 根本不够（20 个就 200s） */
    pluginsCheckUpdates: null,
    /* 比 exec 的最长上限（600s）再留一点余量；不设 null，避免坏插件把宿主永久挂住 */
    agentTool: 660_000,
    sandboxExec: 660_000,
    /* 联网客户端自己按时长 openai.timeoutMs（默认 60s，用户可调）超时，别再套一层固定值 */
    webTools: null,
    /* 选择框自己 300s 放弃（见 agent-service 的 PICKER_TIMEOUT_MS） */
    picker: null,
}
