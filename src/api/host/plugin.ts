/*
 * 宿主契约：平台暴露给插件与外部调用方的稳定接口
 * 实现放在各模块，api/host 只放类型、版本与钩子注册入口
 */

import type { Logger } from "pino"

import type { HostFileApi, HostFileRootsApi } from "./fs.ts"
import type { HostMigrateApi } from "./migrate.ts"
import type { HostModelsApi } from "./models.ts"
import type { HostNetworkApi } from "./network.ts"
import type { HostExecApi } from "./exec.ts"
import type { HostPtyApi } from "./pty.ts"

import type { AppSetting } from "../../config/types.ts"
import type { ResolvedPaths } from "../../platform/path.ts"
import { HOST_API_VERSION } from "./version.ts"

/** 插件自报状态 */
export type PluginStatus = "ok" | "failed"

/** 插件自己的 JSON 配置（<configDir>/plugins/<id>.json） */
export type PluginConfig = Readonly<Record<string, unknown>>

/** 插件可用的终端输出；human 模式下由 elog4js 渲染 */
export interface HostOutput {
    info(text: string): void
    warn(text: string): void
    error(text: string): void
    print(text?: string): void
}

export interface PluginCommandContext {
    /** 命令名之后的原始参数，平台不解析 */
    readonly argv: readonly string[]
    readonly env: NodeJS.ProcessEnv
    readonly paths: ResolvedPaths
    readonly config: AppSetting
    readonly logger: Logger
    readonly output: HostOutput
    /** 插件专属数据目录，已创建 */
    readonly pluginDataDir: string
    /** 插件专属配置，文件不存在时为空对象 */
    readonly pluginConfig: PluginConfig
    /** 插件数据目录内的文件操作 */
    readonly fs: HostFileApi
    /** 当前工作目录内的文件操作 */
    readonly workspaceFs: HostFileApi
    readonly cwd: string
    readonly json: boolean
    readonly stdin: NodeJS.ReadableStream
    readonly stdout: NodeJS.WritableStream
    readonly stderr: NodeJS.WritableStream
}

export interface PluginCommand {
    readonly name: string
    readonly summary: string
    readonly usage?: string
    readonly aliases?: readonly string[]
    readonly run: (context: PluginCommandContext) => number | void | Promise<number | void>
}

export interface AgentToolParam {
    readonly type?: "string" | "number" | "integer" | "boolean" | "array" | "object"
    readonly description?: string
    readonly enum?: readonly string[]
    readonly optional?: boolean
    readonly items?: { readonly type: "string" | "number" | "integer" | "boolean" }
}

/** string 是 { type: "string", description } 的简写 */
export type AgentToolParamSpec = string | AgentToolParam

export interface AgentToolIntroduction {
    /** 参数名 → 类型与说明 */
    readonly params: Record<string, AgentToolParamSpec>
    /** 工具用途说明，作为 tool description 下发给模型 */
    readonly content: string
}

export interface AgentCallToolResult {
    readonly success: boolean
    /** 给界面、日志与测试的结构化结果：不进模型上下文 */
    readonly data: Record<string, unknown>
    /**
     * 模型侧文本
     *
     * 给出时模型只看到这段文字，data 仅用于界面与日志
     * 缺省时宿主取 data.content（字符串）或序列化 data，老插件无需改动
     *
     * 由工具渲染：字段取舍与截断后的恢复指引均属工具语义
     */
    readonly content?: string
}

import type { HostAgentApi } from "./agent.ts"
import type { HostCapabilities } from "../../plugin/capabilities.ts"
import type { HostHttpApi } from "./http.ts"
import type { HostPluginsApi } from "./plugins.ts"
import type { HostWorkspacesApi } from "./workspace.ts"

/**
 * 插件 id 规则：可选 @scope/ 前缀
 *
 * 宿主与 sandbox 内的插件进程共用同一份
 */
export const PLUGIN_ID = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface AgentTool {
    readonly name: string
    readonly introduction: AgentToolIntroduction
    readonly call: (...args: unknown[]) => AgentCallToolResult | Promise<AgentCallToolResult>
}

export interface WellspringPluginInfo {
    readonly id: string
    readonly name: string
    readonly version: string
}

/** setup() 返回的插件描述与扩展 */
export interface WellspringPlugin extends WellspringPluginInfo {
    /** 插件自检状态，必须提供 */
    readonly status: PluginStatus
    readonly description?: string
    /** 依赖的插件 id，仅用于元信息与展示 */
    readonly deps?: readonly string[]
    /** 插件注册的命令；也可以在 init(api) 里调用 api.registerCommand */
    readonly commands?: readonly PluginCommand[]
    /** 插件提供的 Agent 工具；重名会导致后加载插件停用 */
    readonly agentTools?: readonly AgentTool[]
    /** 可选初始化：拿到宿主能力后再注册命令或做启动检查 */
    readonly init?: (api: PluginApi) => void | Promise<void>
}

export type PluginSetup = () => WellspringPlugin | Promise<WellspringPlugin>

export interface PluginApi {
    readonly apiVersion: typeof HOST_API_VERSION
    readonly plugin: WellspringPluginInfo
    readonly paths: ResolvedPaths
    readonly config: AppSetting
    readonly logger: Logger
    readonly output: HostOutput
    /** 插件专属数据目录，已创建 */
    readonly pluginDataDir: string
    /** 插件专属配置，文件不存在时为空对象 */
    readonly pluginConfig: PluginConfig
    /** 插件数据目录内的文件操作 */
    readonly fs: HostFileApi
    /** 当前工作目录内的文件操作 */
    readonly workspaceFs: HostFileApi
    /** 按绝对目录打开文件 API（需 hostApi: fileRoots；只给可信插件，例如代码编辑器） */
    readonly fileRoots: HostFileRootsApi
    registerCommand(command: PluginCommand): void
    registerAgentTool?(tool: AgentTool): void
    // 1.7 起插件不再注册版本探针，更新来源写在 package.json 的
    // `wellspring.npm` / `wellspring.github`，由宿主自己查询
    /** 依赖链上的插件 data 目录；无权限返回 null */
    pluginData(pluginId: string): Promise<HostFileApi | null>
    /** 宿主能力：代码执行、网页搜索/抓取 */
    capabilities: HostCapabilities
    /** 宿主 HTTP 服务 */
    http: HostHttpApi
    /** 与 Agent 会话交互 */
    agent: HostAgentApi
    /** 宿主进程执行（需 hostApi: exec 权限） */
    exec: HostExecApi
    /** 宿主伪终端（需 hostApi: pty 权限；依赖可选的 node-pty） */
    pty: HostPtyApi
    /** 自定义供应商与模型切换（需 hostApi: models 权限） */
    models: HostModelsApi
    /** 出站 HTTP/HTTPS 代理配置（需 hostApi: network 权限） */
    network: HostNetworkApi
    /** 插件安装 / 卸载 / 启用 / 禁用（需 hostApi: plugins 权限） */
    plugins: HostPluginsApi
    /** 宿主级工作区注册表（需 hostApi: workspaces 权限） */
    workspaces: HostWorkspacesApi
    /** 插件本地数据迁移（需 hostApi: migrate 权限） */
    migrate: HostMigrateApi
}
