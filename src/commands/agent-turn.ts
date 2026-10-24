/*
 * Agent 轮次：run 模式的工具循环
 */

import { randomUUID } from "node:crypto"

import type {
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from "openai/resources/chat/completions"

import {
    emitAfterStep,
    emitAfterTurn,
    emitAgentAsk,
    emitAgentCallTool,
    emitAgentRunSync,
    emitAgentSubmit,
    emitBeforeStep,
    emitBeforeTurn,
    emitOnMessage,
    emitUserAnswer,
} from "../api/host/hooks.ts"
import type { HostAgentAskRequest, HostAgentToolEvent } from "../api/host/agent.ts"
import type { AgentTool } from "../api/host/plugin.ts"
import type { SandboxAccess } from "../config/types.ts"
import { createAskId, cancelAsk, waitForAsk } from "../agent/pending-asks.ts"
import { toolLabel, toolSummary } from "../display/tool-label.ts"
import { withAgentToolContext } from "../agent/tool-context.ts"
import { Result } from "../api/result/result.ts"
import type { OpenAIClient, ToolCall } from "../network/openai.ts"
import { createMarkdownStream, renderMarkdown, type MarkdownStream } from "../display/markdown.ts"
import { lastSeq, lastTurnNumber, toChatMessages } from "../session/replay.ts"
import type { SessionStore, SessionData } from "../session/store.ts"
import type { ContentPart, SessionEvent, SessionMessageRecord } from "../session/types.ts"
import { getSession } from "../session/registry.ts"
import type { TurnData } from "./conversation.ts"
import type { CommandContext } from "./shared.ts"

export interface ExecApprovalRequest {
    readonly sessionId: string
    readonly turn: number
    readonly step: number
    readonly command: string
    readonly argv: readonly string[]
    readonly cwd: string
    readonly currentPermission?: SandboxAccess
    readonly requestedPermission?: SandboxAccess
    readonly justification?: string
}

export type ExecApproval = (request: ExecApprovalRequest) => Promise<boolean>

export interface AgentTurnParams {
    readonly ctx: CommandContext
    readonly client: OpenAIClient
    readonly store: SessionStore
    readonly session: SessionData
    readonly input: string
    readonly model: string
    readonly reasoning?: string
    readonly system?: string
    readonly stream: boolean
    readonly display: boolean
    readonly allowExec?: boolean
    readonly permission?: SandboxAccess
    readonly maxSteps?: number
    readonly approveExec?: ExecApproval
    readonly onDelta?: (text: string) => void
    /** 模型思考内容增量 */
    readonly onReasoning?: (text: string) => void
    /** 工具调用开始/结束；界面用来显示工具提示 */
    readonly onTool?: (event: HostAgentToolEvent) => void
    /** ask 工具提问；界面收到后把问题展示给用户 */
    readonly onAsk?: (request: HostAgentAskRequest) => void
    /** 直接问当前终端用户（CLI）；缺省时等待 HostAgentApi.respondAsk */
    readonly askUser?: (request: HostAgentAskRequest) => Promise<string | null>
    readonly onStep?: (event: { readonly turn: number; readonly step: number }) => void
}

/** 平台内置提问工具：模型用它向用户要信息，宿主等回答后再继续 */
const ASK_TOOL_NAME = "ask"
const ASK_QUESTION_LIMIT = 2000
const ASK_OPTION_LIMIT = 10
const ASK_ANSWER_LIMIT = 8000

const ASK_TOOL_SCHEMA: ChatCompletionTool = {
    type: "function",
    function: {
        name: ASK_TOOL_NAME,
        description:
            "向用户提问并等待回答。用于缺少必要信息、需要在几个方案里选择或确认时。问题要简短、自包含，用用户看得懂的话；不要用它代替执行任务。如果你推荐某个选项，把它放第一个，并在标签后加「（推荐）」。",
        parameters: {
            type: "object",
            additionalProperties: false,
            required: ["question"],
            properties: {
                question: { type: "string", description: "要问用户的问题" },
                options: {
                    type: "array",
                    items: { type: "string" },
                    description:
                        "可选答案；推荐的选项放第一个并在标签后加「（推荐）」，用户也可以自由输入",
                },
            },
        },
    },
}

/** 推给界面的工具输出上限；完整内容仍写进会话 */
const TOOL_EVENT_RESULT_LIMIT = 4000

function toolEventResult(text: string): { readonly result: string; readonly truncated: boolean } {
    if (text.length <= TOOL_EVENT_RESULT_LIMIT) {
        return { result: text, truncated: false }
    }
    return { result: text.slice(0, TOOL_EVENT_RESULT_LIMIT), truncated: true }
}

interface ToolArgs {
    readonly [key: string]: unknown
}

function parseToolArguments(raw: string): ToolArgs {
    try {
        const value: unknown = JSON.parse(raw)
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            return value as ToolArgs
        }
        return {}
    } catch {
        return {}
    }
}

function toolCallParts(toolCalls: readonly ToolCall[]): SessionMessageRecord["content"] {
    return toolCalls.map((call) => ({
        type: "tool-call" as const,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
    }))
}

// 插件工具 → 模型 schema
function pluginToolSchema(tool: AgentTool): ChatCompletionTool {
    const entries = Object.entries(tool.introduction.params)
    const required: string[] = []
    const properties: Record<string, Record<string, unknown>> = {}
    for (const [name, spec] of entries) {
        if (typeof spec === "string") {
            required.push(name)
            properties[name] = { type: "string", description: spec }
            continue
        }
        if (spec.optional !== true) {
            required.push(name)
        }
        properties[name] = {
            type: spec.type ?? "string",
            ...(spec.description === undefined ? {} : { description: spec.description }),
            ...(spec.enum === undefined ? {} : { enum: [...spec.enum] }),
            ...(spec.items === undefined ? {} : { items: { ...spec.items } }),
        }
    }
    return {
        type: "function",
        function: {
            name: tool.name,
            description: tool.introduction.content,
            parameters: {
                type: "object",
                additionalProperties: false,
                required,
                properties,
            },
        },
    }
}

export async function executeAgentTurn(params: AgentTurnParams): Promise<Result<TurnData>> {
    const { ctx, client, store, session, input, model, system, stream, display } = params
    const turn = lastTurnNumber(session.events) + 1
    let seq = lastSeq(session.events) + 1
    const startedAt = Date.now()

    await emitBeforeTurn({
        sessionId: session.meta.id,
        mode: "run",
        turn,
        input,
        cwd: session.meta.workspace ?? session.meta.cwd,
    })
    await emitAgentRunSync({
        sessionId: session.meta.id,
        turn,
        input,
        cwd: session.meta.workspace ?? session.meta.cwd,
    })

    const events: SessionEvent[] = [
        { type: "turn/start", seq: seq++, time: startedAt, data: { turn, mode: "run" } },
        {
            type: "user/message",
            seq: seq++,
            time: Date.now(),
            data: {
                message: {
                    role: "user",
                    content: [{ type: "text", text: input }],
                    source: { kind: "cli" },
                    id: randomUUID(),
                } satisfies SessionMessageRecord,
                surfaceOp: "append",
            },
        },
    ]

    const prompt: string[] = []
    if (system !== undefined && system.trim() !== "") {
        prompt.push(system)
    }
    await emitOnMessage({
        sessionId: session.meta.id,
        mode: "run",
        turn,
        role: "user",
        phase: "before",
        content: input,
        prompt,
    })

    const messages: ChatCompletionMessageParam[] = []
    const systemText = prompt
        .map((item) => item.trim())
        .filter((item) => item !== "")
        .join("\n\n")
    if (systemText !== "") {
        messages.push({ role: "system", content: systemText })
    }

    messages.push(...toChatMessages(session.events), { role: "user", content: input })

    const hostSession = getSession(session.meta.id)
    hostSession?.begin()
    const maxSteps = params.maxSteps ?? Number.POSITIVE_INFINITY
    let stepsExecuted = 0
    const pluginTools = ctx.agentTools.list()
    const toolDefinitions = pluginTools.map((record) => pluginToolSchema(record.tool))
    // 插件可以自己提供同名工具覆盖内置 ask
    const askToolBuiltin = ctx.agentTools.get(ASK_TOOL_NAME) === undefined
    if (askToolBuiltin) {
        toolDefinitions.push(ASK_TOOL_SCHEMA)
    }
    let finalText = ""
    let printedStepText = ""
    let finalModel = model
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    const streamed = display && stream
    const markdownEnabled = display && process.stdout.isTTY === true

    const fail = async (code: string): Promise<Result<TurnData>> => {
        events.push({
            type: "turn/end",
            seq: seq++,
            time: Date.now(),
            data: { turn, reason: { kind: "failed", code } },
        })
        await store.appendTurn(session, events)
        hostSession?.end()
        await emitAfterTurn({
            sessionId: session.meta.id,
            mode: "run",
            turn,
            reason: "failed",
            code,
        })
        if (streamed) {
            ctx.elog.line()
        }
        return Result.error<TurnData>(code)
    }

    const runAskTool = async (
        rawArguments: string,
        askStep: number,
    ): Promise<{ content: string; ok: boolean }> => {
        const args = parseToolArguments(rawArguments)
        const rawQuestion = args["question"]
        const question =
            typeof rawQuestion === "string" ? rawQuestion.trim().slice(0, ASK_QUESTION_LIMIT) : ""
        if (question === "") {
            return { content: "ask 工具缺少 question 参数", ok: false }
        }
        const options: string[] = []
        if (Array.isArray(args["options"])) {
            for (const item of args["options"]) {
                if (typeof item !== "string") {
                    continue
                }
                const value = item.trim()
                if (value === "") {
                    continue
                }
                options.push(value.slice(0, 200))
                if (options.length >= ASK_OPTION_LIMIT) {
                    break
                }
            }
        }
        const askId = createAskId()
        const request: HostAgentAskRequest = {
            askId,
            question,
            ...(options.length === 0 ? {} : { options }),
        }
        const waiting =
            params.askUser === undefined ? waitForAsk({ askId, sessionId: session.meta.id }) : null
        try {
            await emitAgentAsk({
                sessionId: session.meta.id,
                askId,
                turn,
                step: askStep,
                question,
                ...(options.length === 0 ? {} : { options }),
            })
            try {
                params.onAsk?.(request)
            } catch {
                return { content: "提问没有送达用户，已跳过。", ok: false }
            }
            const answer =
                params.askUser === undefined ? await waiting! : await params.askUser(request)
            if (answer !== null) {
                await emitUserAnswer({
                    sessionId: session.meta.id,
                    askId,
                    answer: answer.slice(0, ASK_ANSWER_LIMIT),
                })
            }
            if (answer === null) {
                return {
                    content: "用户没有回答问题。请根据已有信息继续，或说明还需要哪些信息。",
                    ok: false,
                }
            }
            const trimmed = answer.trim().slice(0, ASK_ANSWER_LIMIT)
            if (trimmed === "") {
                return { content: "用户跳过了这个问题。", ok: true }
            }
            return { content: `用户回答：${trimmed}`, ok: true }
        } finally {
            cancelAsk(askId)
        }
    }

    for (let step = 1; step <= maxSteps; step += 1) {
        stepsExecuted = step
        params.onStep?.({ turn, step })
        events.push({ type: "step/start", seq: seq++, time: Date.now(), data: { turn, step } })
        await emitBeforeStep({
            sessionId: session.meta.id,
            mode: "run",
            turn,
            step,
            input,
        })
        if (display && process.stdout.isTTY === true) {
            ctx.elog.step(step, Number.isFinite(maxSteps) ? maxSteps : undefined)
        }

        const injected = hostSession?.take() ?? []
        for (const message of injected) {
            const text = message.content.join("")
            messages.push({ role: "user", content: text })
            events.push({
                type: "user/message",
                seq: seq++,
                time: Date.now(),
                data: {
                    turn,
                    message: {
                        role: "user",
                        content: [{ type: "text", text }],
                        source: { kind: "plugin", type: message.type },
                        id: randomUUID(),
                    },
                },
            })
        }

        let agentStarted = false
        let markdownWrote = false
        let markdown: MarkdownStream | null = null
        const writeMarkdown = (output: string): void => {
            if (output === "") {
                return
            }
            const text = markdownWrote ? output : output.replace(/^\n+/, "")
            if (text === "") {
                return
            }
            markdownWrote = true
            ctx.elog.stream(text)
        }
        const endAgent = (): void => {
            if (!streamed || !agentStarted) {
                return
            }
            if (markdown !== null) {
                writeMarkdown(markdown.finish().replace(/\n+$/, ""))
            }
            ctx.elog.line()
        }
        const streamResult = await client.chatStream(messages, {
            model,
            reasoning: params.reasoning,
            tools: toolDefinitions,
            toolChoice: "auto",
            onReasoning: (text) => {
                params.onReasoning?.(text)
            },
            onText: (text) => {
                params.onDelta?.(text)
                if (!streamed) {
                    return
                }
                if (!agentStarted) {
                    ctx.elog.agentStart()
                    agentStarted = true
                    if (markdownEnabled) {
                        markdown = createMarkdownStream()
                    }
                }
                if (markdown !== null) {
                    writeMarkdown(markdown.push(text))
                } else {
                    ctx.elog.stream(text)
                }
            },
        })
        if (!streamResult.isSuccess()) {
            return await fail(streamResult.getCode() ?? "openai.request-failed")
        }

        const data = streamResult.getData()
        if (data === null) {
            return await fail("openai.request-failed")
        }
        finalModel = data.reply.model
        if (data.reply.text !== "") {
            finalText = data.reply.text
        }
        if (data.reply.inputTokens !== null) {
            inputTokens = (inputTokens ?? 0) + data.reply.inputTokens
        }
        if (data.reply.outputTokens !== null) {
            outputTokens = (outputTokens ?? 0) + data.reply.outputTokens
        }

        const parts: ContentPart[] = []
        if (data.reasoning !== "") {
            parts.push({ type: "reasoning", text: data.reasoning })
        }
        if (data.reply.text !== "") {
            parts.push({ type: "text", text: data.reply.text })
        }
        parts.push(...toolCallParts(data.toolCalls))
        const assistant: SessionMessageRecord = {
            role: "assistant",
            content: parts,
            source: { kind: "model", provider: "openai", model: data.reply.model },
            id: data.reply.id,
        }
        events.push({
            type: "assistant/message",
            seq: seq++,
            time: Date.now(),
            data: {
                turn,
                step,
                message: assistant,
                usage: {
                    inputTokens: data.reply.inputTokens,
                    outputTokens: data.reply.outputTokens,
                },
                stream: data.chunks,
            },
        })

        if (data.reply.text !== "") {
            await emitOnMessage({
                sessionId: session.meta.id,
                mode: "run",
                turn,
                role: "assistant",
                phase: "after",
                content: data.reply.text,
                prompt,
            })
        }
        endAgent()
        // 非流式（管道/--no-stream）也按步打印模型输出，让工具调用和消息交替出现（参考 Harness）
        if (display && !streamed && data.reply.text !== "") {
            ctx.elog.agent(markdownEnabled ? renderMarkdown(data.reply.text) : data.reply.text)
            printedStepText = data.reply.text
        }

        if (data.toolCalls.length === 0) {
            await emitAfterStep({
                sessionId: session.meta.id,
                mode: "run",
                turn,
                step,
                reply: data.reply.text,
            })
            break
        }

        const assistantForApi: ChatCompletionMessageParam = {
            role: "assistant",
            content: data.reply.text === "" ? null : data.reply.text,
            tool_calls: data.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.arguments },
            })),
        }
        messages.push(assistantForApi)

        for (const call of data.toolCalls) {
            events.push({
                type: "tool/call",
                seq: seq++,
                time: Date.now(),
                data: {
                    turn,
                    step,
                    callId: call.id,
                    name: call.name,
                    arguments: call.arguments,
                },
            })
            await emitAgentCallTool({
                sessionId: session.meta.id,
                turn,
                step,
                callId: call.id,
                name: call.name,
                arguments: call.arguments,
            })
            params.onTool?.({
                id: call.id,
                name: call.name,
                phase: "start",
                arguments: call.arguments,
            })

            const args = parseToolArguments(call.arguments)
            ctx.elog.toolCall(toolLabel(call.name), toolSummary(call.name, args))
            let toolContent = ""
            let toolOk = false
            if (askToolBuiltin && call.name === ASK_TOOL_NAME) {
                const outcome = await runAskTool(call.arguments, step)
                toolContent = outcome.content
                toolOk = outcome.ok
            } else if (ctx.agentTools.get(call.name) !== undefined) {
                const record = ctx.agentTools.get(call.name)
                if (record === undefined) {
                    toolContent = `未知工具：${call.name}`
                } else {
                    try {
                        const result = await withAgentToolContext(
                            {
                                sessionId: session.meta.id,
                                turn,
                                step,
                                workspaceDir: session.meta.workspace ?? session.meta.cwd,
                                permission: params.permission ?? ctx.settings.sandbox.access,
                                allowExec: params.allowExec === true,
                                approveExec:
                                    params.approveExec === undefined
                                        ? undefined
                                        : async (request) =>
                                              await params.approveExec!({
                                                  ...request,
                                                  sessionId: session.meta.id,
                                                  turn,
                                                  step,
                                              }),
                                elog: ctx.elog,
                            },
                            async () => await record.tool.call(args),
                        )
                        toolContent =
                            typeof result.data["content"] === "string"
                                ? result.data["content"]
                                : result.success
                                  ? JSON.stringify(result.data)
                                  : `工具失败：${JSON.stringify(result.data)}`
                        toolOk = result.success
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        toolContent = `工具执行失败：${message}`
                    }
                }
            } else {
                toolContent = `未知工具：${call.name}`
            }

            if (!toolOk) {
                const firstLine = toolContent.split("\n")[0] ?? ""
                ctx.elog.toolResult(`失败：${firstLine.slice(0, 160)}`)
            }
            const toolEvent = toolEventResult(toolContent)
            params.onTool?.({
                id: call.id,
                name: call.name,
                phase: "end",
                ok: toolOk,
                result: toolEvent.result,
                ...(toolEvent.truncated ? { truncated: true } : {}),
            })
            events.push({
                type: "tool/result",
                seq: seq++,
                time: Date.now(),
                data: {
                    turn,
                    step,
                    callId: call.id,
                    name: call.name,
                    content: toolContent,
                },
            })
            messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: toolContent,
            })
        }

        await emitAfterStep({
            sessionId: session.meta.id,
            mode: "run",
            turn,
            step,
            reply: data.reply.text,
        })
        events.push({
            type: "step/end",
            seq: seq++,
            time: Date.now(),
            data: { turn, step, reason: "completed" },
        })
    }

    if (finalText === "") {
        finalText = "（达到最大步数，未生成最终回答）"
    }

    hostSession?.end()
    await emitAgentSubmit({
        sessionId: session.meta.id,
        result: finalText,
    })
    events.push({
        type: "turn/end",
        seq: seq++,
        time: Date.now(),
        data: { turn, reason: { kind: "completed" } },
    })
    await store.appendTurn(session, events)
    await emitAfterTurn({
        sessionId: session.meta.id,
        mode: "run",
        turn,
        reason: "completed",
        code: null,
    })

    if (!streamed && display && finalText !== printedStepText) {
        // 只有兜底文案（例如达到最大步数）或最后一步没有正文时才需要补打
        ctx.elog.agent(markdownEnabled ? renderMarkdown(finalText) : finalText)
    }

    return Result.successWithData<TurnData>({
        sessionId: session.meta.id,
        mode: "run",
        turn,
        steps: stepsExecuted,
        reply: finalText,
        model: finalModel,
        usage: inputTokens === null && outputTokens === null ? null : { inputTokens, outputTokens },
    })
}
