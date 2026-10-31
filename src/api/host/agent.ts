/*
 * 宿主 Agent 能力：让 sandbox 插件与 Agent 会话交互。
 */

import type { TokenUsage } from "../../agent/usage.ts"

/** Agent 运行时的 sandbox 权限；与 CLI 的 --permission 取值一致 */
export type HostAgentPermission = "read-only" | "workspace-write" | "danger-full-access"

export interface HostAgentChatInput {
    /** 用户消息 */
    readonly message: string
    /** 已有会话 id；不传则创建新会话 */
    readonly sessionId?: string
    /** 覆盖本次使用的模型 */
    readonly model?: string
    /** 覆盖本次使用的供应商 id（内置为 openai） */
    readonly provider?: string
    /** 覆盖本次推理强度：off / low / high / max */
    readonly reasoning?: string
    /** 覆盖本次 system prompt */
    readonly system?: string
    /** 会话所在工作目录；不传使用宿主当前目录 */
    readonly cwd?: string
    /** 用户在输入框里用 @ 引用的工作区相对路径 */
    readonly references?: readonly string[]
    /** 覆盖本轮的 sandbox 权限；不传则使用宿主配置的 sandbox.access */
    readonly permission?: HostAgentPermission
}

export interface HostAgentChatResult {
    readonly sessionId: string
    /** 会话内第几轮 */
    readonly turn: number
    /** 本轮执行的步数 */
    readonly steps: number
    readonly reply: string
    readonly model: string
    /** 本轮 token 用量：含缓存命中/写入、推理与收尾时的上下文占用 */
    readonly usage: TokenUsage | null
}

export interface HostWorkspaceFileEntry {
    /** 相对工作区根的路径，使用 / 分隔 */
    readonly path: string
    readonly name: string
    readonly type: "file" | "directory"
}

export interface HostWorkspaceFilesResult {
    readonly ok: boolean
    readonly root: string
    readonly entries: readonly HostWorkspaceFileEntry[]
    readonly truncated: boolean
    readonly error?: string
}

/** 工作目录校验结果：root 为规范化后的绝对路径 */
export interface HostWorkspaceCheck {
    readonly ok: boolean
    readonly root: string
    readonly name: string
    /** ok=false 时的原因 */
    readonly error?: string
}

export interface HostAgentApprovalRequest {
    readonly approvalId: string
    readonly command: string
    readonly argv: readonly string[]
    readonly cwd: string
    readonly currentPermission?: string
    readonly requestedPermission?: string
    readonly justification?: string
    /** 请求联网 */
    readonly network?: boolean
    /** 请求后台执行 */
    readonly background?: boolean
    /** 标准输入；界面按长度截断显示 */
    readonly stdin?: string
    /** 请求的超时毫秒 */
    readonly timeoutMs?: number
}

/** Agent 用 ask 工具向用户提问；界面回答后 Agent 继续 */
export interface HostAgentAskRequest {
    readonly askId: string
    readonly question: string
    /** 候选答案；用户可以选，也可以自由输入 */
    readonly options?: readonly string[]
}

/** 一次工具调用的生命周期事件；界面用来显示“正在调用什么工具” */
export interface HostAgentToolEvent {
    readonly id: string
    readonly name: string
    readonly phase: "start" | "end"
    /** start 时为模型的原始参数 JSON */
    readonly arguments?: string
    /** end 时是否执行成功 */
    readonly ok?: boolean
    /** end 时的工具输出（过长时截断） */
    readonly result?: string
    /** result 是否被截断 */
    readonly truncated?: boolean
}

export type HostAgentStreamEvent =
    /** 会话已创建/打开：客户端可先保存 sessionId，刷新后仍能续上同一会话 */
    | { readonly type: "session"; readonly sessionId: string; readonly turn?: number }
    | { readonly type: "delta"; readonly text: string }
    /** 模型思考内容增量（reasoning_content） */
    | { readonly type: "reasoning"; readonly text: string }
    /** 工具调用开始/结束 */
    | ({ readonly type: "tool" } & HostAgentToolEvent)
    /** Agent 提问，等待用户回答 */
    | { readonly type: "ask"; readonly request: HostAgentAskRequest }
    /** 开始执行第 step 步；用于界面显示进度 */
    | { readonly type: "step"; readonly turn: number; readonly step: number }
    /** 工具请求提升权限，等待用户批准 */
    | { readonly type: "approval"; readonly request: HostAgentApprovalRequest }

export interface HostAgentApi {
    chat(input: HostAgentChatInput): Promise<HostAgentChatResult>
    /** 流式执行；delta 通过回调推送，Promise 在完成时返回最终结果 */
    stream(
        input: HostAgentChatInput,
        onEvent: (event: HostAgentStreamEvent) => void,
    ): Promise<HostAgentChatResult>
    /** 校验工作目录：必须是已存在的目录；返回规范化路径与目录名 */
    validateWorkspace(path: string): Promise<HostWorkspaceCheck>
    /** 打开宿主系统的原生文件夹选择对话框，返回选中的目录 */
    pickDirectory(): Promise<HostWorkspaceCheck>
    /**
     * 在工作区里搜索文件与目录
     *
     * 空 query 列根目录一层；query 以 / 结尾且目录存在时列该目录一层
     * 单关键字按文件名优先排序，其次路径段、路径包含、子序列
     * 多段查询（a/b/c）按路径段链式匹配，前缀目录不必存在
     * 跳过依赖/构建目录与符号链接；受扫描条目、深度与时间上限约束
     */
    searchWorkspaceFiles(root: string, query: string): Promise<HostWorkspaceFilesResult>
    /**
     * 向正在运行的会话插话
     *
     * 消息进入该会话的待注入队列，在 Agent 下一次模型调用前作为用户消息插入同一轮
     * 会话不在运行中（尚未开始或已结束）返回 false，调用方按下一轮处理
     */
    interject(sessionId: string, message: string): Promise<boolean>
    /**
     * 停止正在运行的一轮
     *
     * 已发出的模型调用不会被切断：循环在当前步结束后收尾，
     * 后续步骤、工具执行都不再发起。等待中的提问与提权请求按“跳过 / 拒绝”了结。
     * 会话不在运行中返回 false
     */
    stop(sessionId: string): Promise<boolean>
    /** 回复提权请求；返回是否命中待处理的请求 */
    respondApproval(approvalId: string, approved: boolean): Promise<boolean>
    /** 回答 Agent 的提问；返回是否命中待处理的提问 */
    respondAsk(askId: string, answer: string): Promise<boolean>
}
