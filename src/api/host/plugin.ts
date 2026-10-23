/*
 * 宿主契约：平台暴露给插件与外部调用方的稳定接口。
 * 实现放在各模块，api/host 只放类型、版本与钩子注册入口。
 */

import type { Logger } from "pino"

import type { HostFileApi } from "./fs.ts"

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

/** string 作为简写，等价于 { type: "string", description } */
export type AgentToolParamSpec = string | AgentToolParam

export interface AgentToolIntroduction {
    /** 参数名 → 类型与说明 */
    readonly params: Record<string, AgentToolParamSpec>
    /** 工具用途说明，作为 tool description 下发给模型 */
    readonly content: string
}

export interface AgentCallToolResult {
    readonly success: boolean
    readonly data: Record<string, unknown>
}

import type { HostCapabilities } from "../../plugin/capabilities.ts"
import type { HostHttpApi } from "./http.ts"

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
    registerCommand(command: PluginCommand): void
    registerAgentTool?(tool: AgentTool): void
    /** 依赖链上的插件 data 目录；无权限返回 null */
    pluginData(pluginId: string): Promise<HostFileApi | null>
    /** 宿主能力：代码执行、网页搜索/抓取 */
    capabilities: HostCapabilities
    /** 宿主 HTTP 服务 */
    http: HostHttpApi
}
