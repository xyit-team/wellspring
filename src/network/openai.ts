/*
 * OpenAI SDK 接入。
 * Responses API 为默认文本接口；chat 兼容只提供 Chat Completions 的网关。
 * API key 读取顺序：显式参数 > OPENAI_API_KEY > <configDir>/credentials.json，
 * 明文只进请求，不进配置、日志与界面。
 */

import OpenAI, {
    APIConnectionError,
    APIConnectionTimeoutError,
    APIError,
    APIUserAbortError,
    AuthenticationError,
    BadRequestError,
    InternalServerError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    type ClientOptions,
} from "openai"
import type {
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from "openai/resources/chat/completions"
import type { Logger } from "pino"

import { parseProviderUsage, type ProviderUsage } from "../agent/usage.ts"
import { Result } from "../api/result/result.ts"
import { normalizeApiKey, resolveApiKeySync } from "../config/credentials.ts"
import { DEFAULT_SETTINGS } from "../config/defaults.ts"
import type { OpenAISetting } from "../config/types.ts"
import { readEnv } from "../platform/os.ts"

/** OpenAI 调用错误码 */
export const OPENAI_CODES = {
    missingApiKey: "openai.missing-api-key",
    clientInitFailed: "openai.client-init-failed",
    emptyOutput: "openai.empty-output",
    timeout: "openai.timeout",
    connectionFailed: "openai.connection-failed",
    aborted: "openai.aborted",
    unauthorized: "openai.unauthorized",
    forbidden: "openai.forbidden",
    notFound: "openai.not-found",
    rateLimited: "openai.rate-limited",
    badRequest: "openai.bad-request",
    serverError: "openai.server-error",
    apiError: "openai.api-error",
    requestFailed: "openai.request-failed",
} as const

export interface OpenAIReply {
    readonly text: string
    readonly model: string
    readonly id: string
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    /** 缓存命中 / 写入的 prompt tokens；供应商没报告时缺省 */
    readonly cacheReadTokens?: number | null
    readonly cacheWriteTokens?: number | null
    /** 输出里的推理 token；供应商没报告时缺省 */
    readonly reasoningTokens?: number | null
}

/** 把供应商 usage 里的缓存/推理项展开成可选字段，空值不写进回复对象 */
function providerUsageFields(
    usage: ProviderUsage | null,
): Pick<OpenAIReply, "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens"> {
    if (usage === null) {
        return {}
    }
    return {
        ...(usage.cacheReadTokens === null ? {} : { cacheReadTokens: usage.cacheReadTokens }),
        ...(usage.cacheWriteTokens === null ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
        ...(usage.reasoningTokens === null ? {} : { reasoningTokens: usage.reasoningTokens }),
    }
}

export interface RespondOptions {
    readonly model?: string
    readonly instructions?: string
    readonly maxOutputTokens?: number
}

export interface ChatOptions {
    readonly model?: string
    readonly temperature?: number
    readonly maxTokens?: number
    /** 推理强度；off 表示不发送 reasoning 参数 */
    readonly reasoning?: string
}

/** 规范化后的流式片段，直接落进会话事件 */
export interface OpenAISessionChunk {
    readonly type: "chunk"
    readonly time: number
    readonly chunk: Record<string, unknown>
}

export interface ToolCall {
    readonly id: string
    readonly name: string
    readonly arguments: string
}

export interface StreamReply {
    /** 这次流被 signal 中断（用户停止）；reply 里是已经收到的部分 */
    readonly interrupted?: boolean
    readonly reply: OpenAIReply
    readonly chunks: readonly OpenAISessionChunk[]
    readonly toolCalls: readonly ToolCall[]
    /** 模型返回的思考内容（DeepSeek 等推理模型的 reasoning_content）；没有时为空串 */
    readonly reasoning: string
}

export interface ChatStreamOptions extends ChatOptions {
    /**
     * 中断信号：用户停止时立刻断开这次请求
     *
     * 已经收到的增量照常返回（`interrupted: true`），调用方按「用户停止」收尾，
     * 不会因为打断丢掉半截回复。
     */
    readonly signal?: AbortSignal
    readonly onText?: (text: string) => void
    /** 思考内容增量回调；只在模型返回 reasoning_content 时触发 */
    readonly onReasoning?: (text: string) => void
    readonly tools?: readonly ChatCompletionTool[]
    readonly toolChoice?: "auto" | "none" | "required"
}

export interface CreateOpenAIClientOptions {
    readonly settings?: OpenAISetting
    /** 覆盖 OPENAI_API_KEY 与本地凭据 */
    readonly apiKey?: string
    /** 本地凭据文件路径；不传用当前 configDir 下的 credentials.json */
    readonly credentialsFile?: string
    readonly logger?: Logger
    /** 注入 fetch，测试用 */
    readonly fetch?: ClientOptions["fetch"]
}

/**
 * 推理强度映射：
 * off 不发参数；low / high / max 原样发给 OpenAI 兼容端点。
 * （标准 OpenAI 只定义到 high；若端点不接受 max 会返回 400，可换 high。）
 */
function reasoningParams(level: string | undefined): Record<string, unknown> {
    if (level === undefined || level === "" || level === "off") {
        return {}
    }
    return { reasoning_effort: level }
}

/** 把 SDK 异常归一化为错误码 */
export function mapOpenAIError(error: unknown): string {
    if (error instanceof APIUserAbortError) {
        return OPENAI_CODES.aborted
    }
    // APIConnectionTimeoutError 是 APIConnectionError 的子类，先判断超时
    if (error instanceof APIConnectionTimeoutError) {
        return OPENAI_CODES.timeout
    }
    if (error instanceof APIConnectionError) {
        return OPENAI_CODES.connectionFailed
    }
    if (error instanceof AuthenticationError) {
        return OPENAI_CODES.unauthorized
    }
    if (error instanceof PermissionDeniedError) {
        return OPENAI_CODES.forbidden
    }
    if (error instanceof NotFoundError) {
        return OPENAI_CODES.notFound
    }
    if (error instanceof RateLimitError) {
        return OPENAI_CODES.rateLimited
    }
    if (error instanceof BadRequestError) {
        return OPENAI_CODES.badRequest
    }
    if (error instanceof InternalServerError) {
        return OPENAI_CODES.serverError
    }
    if (error instanceof APIError) {
        return `${OPENAI_CODES.apiError}:${error.status ?? "unknown"}`
    }
    return OPENAI_CODES.requestFailed
}

export class OpenAIClient {
    readonly #client: OpenAI
    readonly #settings: OpenAISetting
    readonly #logger: Logger | undefined

    private constructor(client: OpenAI, settings: OpenAISetting, logger?: Logger) {
        this.#client = client
        this.#settings = settings
        this.#logger = logger
    }

    /** 创建客户端。缺少 API key 或 SDK 初始化失败时返回错误码 */
    static create(options: CreateOpenAIClientOptions = {}): Result<OpenAIClient> {
        const settings = options.settings ?? DEFAULT_SETTINGS.openai
        const explicit = options.apiKey === undefined ? null : normalizeApiKey(options.apiKey)
        if (options.apiKey !== undefined && explicit === null) {
            return Result.error<OpenAIClient>(OPENAI_CODES.missingApiKey)
        }
        const apiKey =
            explicit ??
            (options.credentialsFile === undefined
                ? resolveApiKeySync()
                : resolveApiKeySync(options.credentialsFile)
            )?.apiKey ??
            null
        if (apiKey === null) {
            return Result.error<OpenAIClient>(OPENAI_CODES.missingApiKey)
        }

        try {
            const client = new OpenAI({
                apiKey,
                timeout: settings.timeoutMs,
                maxRetries: settings.maxRetries,
                ...(settings.baseUrl === null ? {} : { baseURL: settings.baseUrl }),
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            })
            return Result.successWithData(new OpenAIClient(client, settings, options.logger))
        } catch {
            return Result.error<OpenAIClient>(OPENAI_CODES.clientInitFailed)
        }
    }

    /** 单轮文本生成，走 Responses API */
    async respond(input: string, options: RespondOptions = {}): Promise<Result<OpenAIReply>> {
        const model = options.model ?? this.#settings.model
        try {
            const response = await this.#client.responses.create({
                model,
                input,
                ...(options.instructions === undefined
                    ? {}
                    : { instructions: options.instructions }),
                ...(options.maxOutputTokens === undefined
                    ? {}
                    : { max_output_tokens: options.maxOutputTokens }),
            })
            const text = response.output_text
            if (text === "") {
                return Result.error<OpenAIReply>(OPENAI_CODES.emptyOutput)
            }
            this.#logger?.debug({ model: response.model, id: response.id }, "OpenAI Responses 调用")
            const usage = parseProviderUsage(response.usage)
            return Result.successWithData<OpenAIReply>({
                text,
                model: response.model,
                id: response.id,
                inputTokens: usage?.inputTokens ?? null,
                outputTokens: usage?.outputTokens ?? null,
                ...providerUsageFields(usage),
            })
        } catch (error) {
            return this.failure(error, model)
        }
    }

    /** 多轮对话，走 Chat Completions API */
    async chat(
        messages: readonly ChatCompletionMessageParam[],
        options: ChatOptions = {},
    ): Promise<Result<OpenAIReply>> {
        const model = options.model ?? this.#settings.model
        try {
            const completion = await this.#client.chat.completions.create({
                model,
                messages: [...messages],
                ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
                ...(options.maxTokens === undefined
                    ? {}
                    : { max_completion_tokens: options.maxTokens }),
                ...reasoningParams(options.reasoning),
            })
            const text = completion.choices[0]?.message.content ?? ""
            if (text === "") {
                return Result.error<OpenAIReply>(OPENAI_CODES.emptyOutput)
            }
            this.#logger?.debug({ model: completion.model, id: completion.id }, "OpenAI Chat 调用")
            const usage = parseProviderUsage(completion.usage)
            return Result.successWithData<OpenAIReply>({
                text,
                model: completion.model,
                id: completion.id,
                inputTokens: usage?.inputTokens ?? null,
                outputTokens: usage?.outputTokens ?? null,
                ...providerUsageFields(usage),
            })
        } catch (error) {
            return this.failure(error, model)
        }
    }

    /** 流式 Chat Completions；始终请求流式，便于完整记录 chunk */
    async chatStream(
        messages: readonly ChatCompletionMessageParam[],
        options: ChatStreamOptions = {},
    ): Promise<Result<StreamReply>> {
        const model = options.model ?? this.#settings.model
        /* 累积状态放在 try 外：被 signal 中断时也要把已收到的部分交回去 */
        const chunks: OpenAISessionChunk[] = []
        let text = ""
        let reasoning = ""
        let id = ""
        let responseModel = model
        let streamUsage: ProviderUsage | null = null
        let finishReason: string | null = null
        let blockStarted = false
        const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>()
        const collectedToolCalls = (): ToolCall[] =>
            [...toolCallMap.entries()]
                .sort(([left], [right]) => left - right)
                .map(([index, entry]) => ({
                    id: entry.id === "" ? `call_${index}` : entry.id,
                    name: entry.name,
                    arguments: entry.arguments,
                }))
        try {
            const stream = await this.#client.chat.completions.create(
                {
                    model,
                    messages: [...messages],
                    stream: true,
                    stream_options: { include_usage: true },
                    ...(options.temperature === undefined
                        ? {}
                        : { temperature: options.temperature }),
                    ...(options.maxTokens === undefined
                        ? {}
                        : { max_completion_tokens: options.maxTokens }),
                    ...reasoningParams(options.reasoning),
                    ...(options.tools === undefined || options.tools.length === 0
                        ? {}
                        : {
                              tools: [...options.tools],
                              tool_choice: options.toolChoice ?? "auto",
                          }),
                },
                // signal 是请求选项（第二个参数），放进 body 只会被当成普通字段忽略
                options.signal === undefined ? {} : { signal: options.signal },
            )

            const push = (chunk: Record<string, unknown>): void => {
                chunks.push({ type: "chunk", time: Date.now(), chunk })
            }

            for await (const part of stream) {
                if (part.id !== "") {
                    id = part.id
                }
                if (part.model !== "") {
                    responseModel = part.model
                }
                if (part.usage !== undefined && part.usage !== null) {
                    streamUsage = parseProviderUsage(part.usage)
                    push({
                        type: "usage",
                        usage: {
                            inputTokens: streamUsage?.inputTokens ?? null,
                            outputTokens: streamUsage?.outputTokens ?? null,
                            totalTokens: part.usage.total_tokens,
                            ...(streamUsage?.cacheReadTokens === null ||
                            streamUsage?.cacheReadTokens === undefined
                                ? {}
                                : { cacheReadTokens: streamUsage.cacheReadTokens }),
                            ...(streamUsage?.cacheWriteTokens === null ||
                            streamUsage?.cacheWriteTokens === undefined
                                ? {}
                                : { cacheWriteTokens: streamUsage.cacheWriteTokens }),
                        },
                    })
                }
                const choice = part.choices[0]
                if (choice === undefined) {
                    continue
                }
                if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
                    finishReason = choice.finish_reason
                }
                for (const toolCallDelta of choice.delta.tool_calls ?? []) {
                    const index = toolCallDelta.index ?? toolCallMap.size
                    const entry = toolCallMap.get(index) ?? {
                        id: "",
                        name: "",
                        arguments: "",
                    }
                    if (typeof toolCallDelta.id === "string") {
                        entry.id = toolCallDelta.id
                    }
                    if (typeof toolCallDelta.function?.name === "string") {
                        entry.name += toolCallDelta.function.name
                    }
                    if (typeof toolCallDelta.function?.arguments === "string") {
                        entry.arguments += toolCallDelta.function.arguments
                    }
                    toolCallMap.set(index, entry)
                    push({
                        type: "tool-call-delta",
                        index,
                        id: toolCallDelta.id ?? null,
                        name: toolCallDelta.function?.name ?? null,
                        argumentsDelta: toolCallDelta.function?.arguments ?? null,
                    })
                }
                // 推理模型（DeepSeek 等）把思考内容放在 delta.reasoning_content，
                // 部分网关用 delta.reasoning；两者都按增量拼接，不进正文
                const rawDelta = choice.delta as {
                    readonly content?: unknown
                    readonly reasoning_content?: unknown
                    readonly reasoning?: unknown
                }
                const reasoningDelta =
                    typeof rawDelta.reasoning_content === "string"
                        ? rawDelta.reasoning_content
                        : typeof rawDelta.reasoning === "string"
                          ? rawDelta.reasoning
                          : ""
                if (reasoningDelta !== "") {
                    reasoning += reasoningDelta
                    push({ type: "reasoning-delta", index: 1, text: reasoningDelta })
                    options.onReasoning?.(reasoningDelta)
                }
                const delta = rawDelta.content
                if (typeof delta === "string" && delta !== "") {
                    if (!blockStarted) {
                        push({ type: "block-start", index: 0, blockType: "text" })
                        blockStarted = true
                    }
                    text += delta
                    push({ type: "text-delta", index: 0, text: delta })
                    options.onText?.(delta)
                }
            }

            if (!blockStarted) {
                push({ type: "block-start", index: 0, blockType: "text" })
                push({ type: "block-end", index: 0, block: { type: "text", text } })
            } else {
                push({ type: "block-end", index: 0, block: { type: "text", text } })
            }
            const toolCalls = collectedToolCalls()
            for (const toolCall of toolCalls) {
                push({ type: "tool-call", ...toolCall })
            }
            push({ type: "finish", reason: { kind: finishReason ?? "stop" } })

            if (text === "" && toolCalls.length === 0) {
                return Result.error<StreamReply>(OPENAI_CODES.emptyOutput)
            }
            this.#logger?.debug({ model: responseModel, id }, "OpenAI Chat 流式调用")
            return Result.successWithData<StreamReply>({
                reply: {
                    text,
                    model: responseModel,
                    id,
                    inputTokens: streamUsage?.inputTokens ?? null,
                    outputTokens: streamUsage?.outputTokens ?? null,
                    ...providerUsageFields(streamUsage),
                },
                chunks,
                toolCalls,
                reasoning,
            })
        } catch (error) {
            if (options.signal?.aborted === true) {
                /*
                 * 用户主动停止：不当作失败。把已经收到的正文/思考/工具调用照常交回去，
                 * 由调用方按「已停止」收尾——半截回复比清空更有用。
                 */
                this.#logger?.debug({ model }, "OpenAI 流式调用被用户中断")
                return Result.successWithData<StreamReply>({
                    interrupted: true,
                    reply: {
                        text,
                        model: responseModel,
                        id,
                        inputTokens: streamUsage?.inputTokens ?? null,
                        outputTokens: streamUsage?.outputTokens ?? null,
                        ...providerUsageFields(streamUsage),
                    },
                    chunks,
                    toolCalls: collectedToolCalls(),
                    reasoning,
                })
            }
            const code = mapOpenAIError(error)
            const status = error instanceof APIError ? (error.status ?? null) : null
            const reason = error instanceof Error ? error.message : String(error)
            this.#logger?.warn({ code, model, status, reason }, "OpenAI 流式调用失败")
            return Result.error<StreamReply>(code)
        }
    }

    /** 拉取供应商的模型 id 列表（用于自定义供应商的“拉取模型”） */
    async listModels(): Promise<Result<readonly string[]>> {
        try {
            const page = await this.#client.models.list()
            const models = (page.data ?? [])
                .map((item) => (typeof item?.id === "string" ? item.id.trim() : ""))
                .filter((id) => id !== "")
            if (models.length === 0) {
                return Result.error<readonly string[]>(OPENAI_CODES.emptyOutput)
            }
            return Result.successWithData<readonly string[]>(models.sort())
        } catch (error) {
            const code = mapOpenAIError(error)
            const reason = error instanceof Error ? error.message : String(error)
            this.#logger?.warn({ code, reason }, "拉取模型列表失败")
            return Result.error<readonly string[]>(code)
        }
    }

    /** 轻量连通性测试：拉模型列表，不产生对话费用 */
    async testConnection(): Promise<Result<{ readonly models: number }>> {
        try {
            const page = await this.#client.models.list()
            const models = Array.isArray(page.data) ? page.data.length : 0
            if (models === 0) {
                return Result.error<{ readonly models: number }>(OPENAI_CODES.emptyOutput)
            }
            return Result.successWithData<{ readonly models: number }>({ models })
        } catch (error) {
            const code = mapOpenAIError(error)
            const reason = error instanceof Error ? error.message : String(error)
            this.#logger?.warn({ code, reason }, "OpenAI 连通性测试失败")
            return Result.error<{ readonly models: number }>(code)
        }
    }

    private failure(error: unknown, model: string): Result<OpenAIReply> {
        const code = mapOpenAIError(error)
        const status = error instanceof APIError ? (error.status ?? null) : null
        const reason = error instanceof Error ? error.message : String(error)
        this.#logger?.warn({ code, model, status, reason }, "OpenAI 调用失败")
        return Result.error<OpenAIReply>(code)
    }
}

let current: OpenAIClient | null = null

/** 初始化全局客户端，已初始化时直接返回 */
export function initOpenAIClient(options: CreateOpenAIClientOptions = {}): Result<OpenAIClient> {
    if (current !== null) {
        return Result.successWithData(current)
    }
    const created = OpenAIClient.create(options)
    if (created.isSuccess()) {
        current = created.getData()
    }
    return created
}

/** 取全局客户端，未初始化时抛错 */
export function getOpenAIClient(): OpenAIClient {
    if (current === null) {
        throw new Error("OpenAI 客户端尚未初始化：先调用 initOpenAIClient()")
    }
    return current
}

/** 清空全局客户端，供测试与关停使用 */
export function resetOpenAIClient(): void {
    current = null
}
