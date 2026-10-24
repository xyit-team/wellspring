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
    emitAgentCallTool,
    emitAgentRunSync,
    emitAgentSubmit,
    emitBeforeStep,
    emitBeforeTurn,
    emitOnMessage,
} from "../api/host/hooks.ts"
import type { AgentTool } from "../api/host/plugin.ts"
import type { SandboxAccess } from "../config/types.ts"
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
    readonly system?: string
    readonly stream: boolean
    readonly display: boolean
    readonly allowExec?: boolean
    readonly permission?: SandboxAccess
    readonly maxSteps?: number
    readonly approveExec?: ExecApproval
    readonly onDelta?: (text: string) => void
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
    const pluginTools = ctx.agentTools.list()
    const toolDefinitions = pluginTools.map((record) => pluginToolSchema(record.tool))
    let finalText = ""
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

    for (let step = 1; step <= maxSteps; step += 1) {
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
            tools: toolDefinitions,
            toolChoice: "auto",
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

            let toolContent = ""
            const args = parseToolArguments(call.arguments)
            if (ctx.agentTools.get(call.name) !== undefined) {
                const record = ctx.agentTools.get(call.name)
                if (record === undefined) {
                    toolContent = `未知工具：${call.name}`
                } else {
                    ctx.elog.action("[Agent] Agent调用工具", [{ label: "name", value: call.name }])
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
                        ctx.elog.actionStatus(call.name, result.success ? "完成" : "失败")
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        toolContent = `工具执行失败：${message}`
                        ctx.elog.actionStatus(call.name, "失败")
                    }
                }
            } else {
                toolContent = `未知工具：${call.name}`
            }

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

    if (!streamed && display) {
        ctx.elog.agent(markdownEnabled ? renderMarkdown(finalText) : finalText)
    }

    return Result.successWithData<TurnData>({
        sessionId: session.meta.id,
        mode: "run",
        reply: finalText,
        model: finalModel,
        usage: inputTokens === null && outputTokens === null ? null : { inputTokens, outputTokens },
    })
}
