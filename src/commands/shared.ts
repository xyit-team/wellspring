/*
 * 命令层公共类型与错误文案。
 */

import type { Logger } from "pino"

import { Result } from "../api/result/result.ts"
import type { AppSetting } from "../config/types.ts"
import { isUsageCode } from "../input/codes.ts"
import type { GlobalOptions } from "../input/types.ts"
import type { Elog } from "../logger/elog4js.ts"
import type { OpenAIClient } from "../network/openai.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import type { LoadedPlugin } from "../plugin/loader.ts"
import type { PluginRegistry } from "../plugin/registry.ts"

export interface CommandContext {
    readonly global: GlobalOptions
    readonly settings: AppSetting
    readonly settingsFile: string
    readonly configCode: string | null
    readonly paths: ResolvedPaths
    readonly logger: Logger
    readonly elog: Elog
    readonly registry: PluginRegistry
    readonly openai: OpenAIClient | null
    loadPlugins(): Promise<readonly LoadedPlugin[]>
}

export interface CommandOutcome {
    readonly result: Result<unknown>
}

export function success(data?: unknown): CommandOutcome {
    return { result: Result.successWithData<unknown>(data ?? null) }
}

export function failure(code: string): CommandOutcome {
    return { result: Result.error<unknown>(code) }
}

const MESSAGES: Readonly<Record<string, string>> = {
    "usage.unknown-command": "未知命令",
    "usage.unknown-option": "未知参数",
    "usage.unknown-subcommand": "未知子命令",
    "usage.missing-value": "缺少参数值",
    "usage.invalid-value": "参数值非法",
    "usage.missing-context": "缺少对话内容",
    "usage.invalid-session-id": "会话 id 不合法",
    "usage.unknown-config-key": "配置项不存在",
    "usage.conflicting-options": "参数互相冲突",
    "usage.missing-confirmation": "缺少 --yes 确认",
    "config.read-failed": "配置文件读取失败",
    "config.parse-failed": "配置文件解析失败",
    "config.invalid": "配置项非法",
    "config.version-unsupported": "配置版本不受支持",
    "config.write-failed": "配置文件写入失败",
    "openai.missing-api-key": "缺少 OPENAI_API_KEY",
    "openai.empty-output": "模型返回空内容",
    "openai.timeout": "模型请求超时",
    "openai.connection-failed": "无法连接模型服务",
    "openai.unauthorized": "模型服务鉴权失败",
    "openai.forbidden": "模型服务拒绝访问",
    "openai.rate-limited": "模型服务限流",
    "openai.bad-request": "模型请求参数非法",
    "openai.server-error": "模型服务内部错误",
    "openai.request-failed": "模型请求失败",
    "session.not-found": "会话不存在",
    "session.parse-failed": "会话事件解析失败",
    "session.corrupted": "会话段损坏",
    "session.ambiguous-id": "会话 id 在多处重复",
    "session.locked": "会话正在被其他进程写入",
    "plugin.command-failed": "插件命令执行失败",
    "plugin.load-failed": "插件加载失败",
    "runtime.unknown-status": "未知运行状态",
}

/** 错误码 → 人类可读文案，字段级细节保留在冒号后 */
export function errorMessage(code: string): string {
    const [base, detail] = code.split(":", 2)
    const message = MESSAGES[base ?? ""] ?? base ?? code
    return detail === undefined || detail === "" ? message : `${message}：${detail}`
}

export function exitCodeFor(code: string | null): number {
    return isUsageCode(code) ? 2 : 1
}
