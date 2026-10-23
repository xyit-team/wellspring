/*
 * OpenAI SDK 接入。
 * Responses API 为默认文本接口；chat 兼容只提供 Chat Completions 的网关。
 * API key 只从显式参数或 OPENAI_API_KEY 读取，不写入配置文件。
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

import { Result } from "../api/result/result.ts"
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
    readonly reply: OpenAIReply
    readonly chunks: readonly OpenAISessionChunk[]
    readonly toolCalls: readonly ToolCall[]
}

export interface ChatStreamOptions extends ChatOptions {
    readonly onText?: (text: string) => void
    readonly tools?: readonly ChatCompletionTool[]
    readonly toolChoice?: "auto" | "none" | "required"
}

export interface CreateOpenAIClientOptions {
    readonly settings?: OpenAISetting
    /** 覆盖 OPENAI_API_KEY */
    readonly apiKey?: string
    readonly logger?: Logger
    /** 注入 fetch，测试用 */
    readonly fetch?: ClientOptions["fetch"]
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
        const apiKey = (options.apiKey ?? readEnv("OPENAI_API_KEY"))?.trim()
        if (apiKey === undefined || apiKey === "") {
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
            return Result.successWithData<OpenAIReply>({
                text,
                model: response.model,
                id: response.id,
                inputTokens: response.usage?.input_tokens ?? null,
                outputTokens: response.usage?.output_tokens ?? null,
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
            })
            const text = completion.choices[0]?.message.content ?? ""
            if (text === "") {
                return Result.error<OpenAIReply>(OPENAI_CODES.emptyOutput)
            }
            this.#logger?.debug({ model: completion.model, id: completion.id }, "OpenAI Chat 调用")
            return Result.successWithData<OpenAIReply>({
                text,
                model: completion.model,
                id: completion.id,
                inputTokens: completion.usage?.prompt_tokens ?? null,
                outputTokens: completion.usage?.completion_tokens ?? null,
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
        try {
            const stream = await this.#client.chat.completions.create({
                model,
                messages: [...messages],
                stream: true,
                stream_options: { include_usage: true },
                ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
                ...(options.maxTokens === undefined
                    ? {}
                    : { max_completion_tokens: options.maxTokens }),
                ...(options.tools === undefined || options.tools.length === 0
                    ? {}
                    : {
                          tools: [...options.tools],
                          tool_choice: options.toolChoice ?? "auto",
                      }),
            })

            const chunks: OpenAISessionChunk[] = []
            let text = ""
            let id = ""
            let responseModel = model
            let inputTokens: number | null = null
            let outputTokens: number | null = null
            let finishReason: string | null = null
            let blockStarted = false
            const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>()
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
                    inputTokens = part.usage.prompt_tokens
                    outputTokens = part.usage.completion_tokens
                    push({
                        type: "usage",
                        usage: {
                            inputTokens,
                            outputTokens,
                            totalTokens: part.usage.total_tokens,
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
                const delta = choice.delta.content
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
            const toolCalls: ToolCall[] = [...toolCallMap.entries()]
                .sort(([left], [right]) => left - right)
                .map(([index, entry]) => ({
                    id: entry.id === "" ? `call_${index}` : entry.id,
                    name: entry.name,
                    arguments: entry.arguments,
                }))
            for (const toolCall of toolCalls) {
                push({ type: "tool-call", ...toolCall })
            }
            push({ type: "finish", reason: { kind: finishReason ?? "stop" } })

            if (text === "" && toolCalls.length === 0) {
                return Result.error<StreamReply>(OPENAI_CODES.emptyOutput)
            }
            this.#logger?.debug({ model: responseModel, id }, "OpenAI Chat 流式调用")
            return Result.successWithData<StreamReply>({
                reply: { text, model: responseModel, id, inputTokens, outputTokens },
                chunks,
                toolCalls,
            })
        } catch (error) {
            const code = mapOpenAIError(error)
            const status = error instanceof APIError ? (error.status ?? null) : null
            const reason = error instanceof Error ? error.message : String(error)
            this.#logger?.warn({ code, model, status, reason }, "OpenAI 流式调用失败")
            return Result.error<StreamReply>(code)
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
