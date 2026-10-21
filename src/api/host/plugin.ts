/*
 * 宿主契约：平台暴露给插件与外部调用方的稳定接口。
 * 实现放在各模块，api/host 只放类型与版本，不反向依赖实现。
 */

import type { Logger } from "pino"

import type { AppSetting } from "../../config/types.ts"
import type { ResolvedPaths } from "../../platform/path.ts"
import { HOST_API_VERSION } from "./version.ts"

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

export interface PluginApi {
    readonly apiVersion: typeof HOST_API_VERSION
    readonly pluginName: string
    readonly paths: ResolvedPaths
    readonly config: AppSetting
    readonly logger: Logger
    readonly output: HostOutput
    registerCommand(command: PluginCommand): void
}

export type PluginRegister = (api: PluginApi) => void | Promise<void>
