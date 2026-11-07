/*
 * chat / run 命令
 *
 * 无 context 且 TTY 时进入交互式会话，其余情况单轮执行
 * 所有轮次作为 zstd JSONL 段写入会话，流式 chunk 一并保存
 */

import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"

import {
    emitAfterStep,
    emitAfterTurn,
    emitBeforeStep,
    emitBeforeTurn,
    emitOnMessage,
    emitSessionStart,
} from "../api/host/hooks.ts"
import { Result } from "../api/result/result.ts"
import { createMarkdownStream, renderMarkdown } from "../display/markdown.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { booleanValue, parseCommandArgs, stringValue } from "../input/parse-options.ts"
import { usageOf, type TokenUsage } from "../agent/usage.ts"
import type { OpenAIClient, StreamReply } from "../network/openai.ts"
import type { SandboxAccess } from "../config/types.ts"
import { registerSession } from "../session/registry.ts"
import { lastSeq, lastTurnNumber, toChatMessages } from "../session/replay.ts"
import { Session } from "../session/session.ts"
import {
    SessionAmbiguousError,
    SessionLockedError,
    SessionNotFoundError,
    SessionStore,
    isValidSessionId,
    type SessionData,
} from "../session/store.ts"
import type { SessionEvent, SessionMessageRecord, SessionMode } from "../session/types.ts"
import type { HostAgentAskRequest, HostAgentToolEvent } from "../api/host/agent.ts"
import { executeAgentTurn, type ExecApprovalRequest } from "./agent-turn.ts"
import { promptAgentAsk } from "./ask-prompt.ts"
import { promptExecApproval } from "./exec-approval.ts"
import {
    errorMessage,
    failure,
    success,
    type CommandContext,
    type CommandOutcome,
} from "./shared.ts"

interface ConversationOptions {
    readonly sessionId?: string
    readonly newSession: boolean
    readonly model: string
    readonly reasoning?: string
    readonly system?: string
    readonly agent?: string
    readonly json: boolean
    readonly stream: boolean
    readonly allowExec: boolean
    readonly permission: SandboxAccess
    readonly maxSteps?: number
    readonly context: readonly string[]
}

export interface TurnData {
    readonly sessionId: string
    readonly mode: SessionMode
    /** 会话内第几轮 */
    readonly turn: number
    /** 本轮执行的步数 */
    readonly steps: number
    readonly reply: string
    readonly model: string
    /** 本轮 token 用量；供应商没有报告时为 null */
    readonly usage: TokenUsage | null
}

function parseConversationOptions(
    ctx: CommandContext,
    argv: readonly string[],
): Result<ConversationOptions> {
    const parsed = parseCommandArgs(argv, {
        "session-id": { type: "string" },
        new: { type: "boolean" },
        model: { type: "string" },
        system: { type: "string" },
        agent: { type: "string" },
        json: { type: "boolean" },
        stream: { type: "boolean" },
        "allow-exec": { type: "boolean" },
        permission: { type: "string" },
        "max-steps": { type: "string" },
        "no-stream": { type: "boolean" },
        reasoning: { type: "string" },
    })
    if (!parsed.isSuccess()) {
        return Result.error<ConversationOptions>(parsed.getCode() ?? USAGE_CODES.invalidValue)
    }

    const line = parsed.getData()
    if (line === null) {
        return Result.error<ConversationOptions>(USAGE_CODES.invalidValue)
    }
    const { values, positionals } = line

    const sessionId = stringValue(values, "session-id")
    const newSession = booleanValue(values, "new")
    if (sessionId !== undefined && newSession) {
        return Result.error<ConversationOptions>(USAGE_CODES.conflictingOptions)
    }
    if (sessionId !== undefined && !isValidSessionId(sessionId)) {
        return Result.error<ConversationOptions>(USAGE_CODES.invalidSessionId)
    }
    const streamFlag = booleanValue(values, "stream")
    const noStream = booleanValue(values, "no-stream")
    if (streamFlag && noStream) {
        return Result.error<ConversationOptions>(USAGE_CODES.conflictingOptions)
    }

    const json = ctx.global.json || booleanValue(values, "json")
    const stream =
        streamFlag || noStream ? streamFlag : json === false && process.stdout.isTTY === true

    const rawPermission = stringValue(values, "permission")
    let permission = ctx.settings.sandbox.access
    if (rawPermission !== undefined) {
        if (
            rawPermission !== "read-only" &&
            rawPermission !== "workspace-write" &&
            rawPermission !== "danger-full-access"
        ) {
            return Result.error<ConversationOptions>(USAGE_CODES.invalidValue)
        }
        permission = rawPermission
    }

    const rawMaxSteps = stringValue(values, "max-steps")
    let maxSteps: number | undefined
    if (rawMaxSteps !== undefined) {
        const parsedSteps = Number(rawMaxSteps)
        if (!Number.isInteger(parsedSteps) || parsedSteps < 1 || parsedSteps > 32) {
            return Result.error<ConversationOptions>(USAGE_CODES.invalidValue)
        }
        maxSteps = parsedSteps
    }

    return Result.successWithData<ConversationOptions>({
        sessionId,
        newSession,
        model: stringValue(values, "model") ?? ctx.activeModel ?? ctx.settings.openai.model,
        system: stringValue(values, "system"),
        agent: stringValue(values, "agent"),
        json,
        stream,
        allowExec: booleanValue(values, "allow-exec"),
        permission,
        maxSteps,
        reasoning: stringValue(values, "reasoning") ?? ctx.activeReasoning,
        context: positionals,
    })
}

function sessionCode(error: unknown): string {
    if (error instanceof SessionAmbiguousError) {
        return "session.ambiguous-id"
    }
    if (error instanceof SessionNotFoundError) {
        return "session.not-found"
    }
    if (error instanceof SessionLockedError) {
        return "session.locked"
    }
    if (error instanceof Error && error.message.includes("会话 id 不合法")) {
        return USAGE_CODES.invalidSessionId
    }
    return "session.corrupted"
}

async function resolveSession(
    store: SessionStore,
    cwd: string,
    options: ConversationOptions,
): Promise<{ session: SessionData; created: boolean }> {
    if (options.newSession) {
        return { session: await store.create({ cwd, model: options.model }), created: true }
    }

    if (options.sessionId !== undefined) {
        try {
            return { session: await store.open(options.sessionId, cwd), created: false }
        } catch (error) {
            if (error instanceof SessionNotFoundError) {
                return {
                    session: await store.create({
                        cwd,
                        model: options.model,
                        id: options.sessionId,
                    }),
                    created: true,
                }
            }
            throw error
        }
    }

    const last = await store.lastId(cwd)
    if (last !== null) {
        try {
            return { session: await store.open(last, cwd), created: false }
        } catch {
            // 回退到新建会话
        }
    }
    return { session: await store.create({ cwd, model: options.model }), created: true }
}

async function readStdin(): Promise<string> {
    process.stdin.setEncoding("utf8")
    let text = ""
    for await (const chunk of process.stdin) {
        text += String(chunk)
    }
    return text
}

/** 执行一轮对话并写入会话；失败也会提交 failed 轮次 */
export async function executeTurn(params: {
    readonly ctx: CommandContext
    readonly client: OpenAIClient
    readonly store: SessionStore
    readonly session: SessionData
    readonly mode: SessionMode
    readonly input: string
    readonly model: string
    readonly reasoning?: string
    readonly system?: string
    readonly stream: boolean
    readonly display: boolean
    readonly allowExec?: boolean
    readonly permission?: SandboxAccess
    readonly maxSteps?: number
    readonly approveExec?: (request: ExecApprovalRequest) => Promise<boolean>
    readonly onDelta?: (text: string) => void
    readonly onReasoning?: (text: string) => void
    readonly onTool?: (event: HostAgentToolEvent) => void
    readonly onAsk?: (request: HostAgentAskRequest) => void
    readonly askUser?: (request: HostAgentAskRequest) => Promise<string | null>
    readonly onStep?: (event: { readonly turn: number; readonly step: number }) => void
    /** 中断信号：用户停止时打断在途的模型调用（只对 run 模式有效） */
    readonly signal?: AbortSignal
}): Promise<Result<TurnData>> {
    const { ctx, client, store, session, mode, input, model, system, stream, display } = params
    if (mode === "run") {
        return await executeAgentTurn({
            ctx,
            client,
            store,
            session,
            input,
            model,
            reasoning: params.reasoning,
            system,
            stream,
            display,
            allowExec: params.allowExec,
            permission: params.permission,
            maxSteps: params.maxSteps,
            approveExec: params.approveExec,
            onDelta: params.onDelta,
            onReasoning: params.onReasoning,
            onTool: params.onTool,
            onAsk: params.onAsk,
            askUser: params.askUser,
            onStep: params.onStep,
            signal: params.signal,
        })
    }
    const turn = lastTurnNumber(session.events) + 1
    let seq = lastSeq(session.events) + 1
    const startedAt = Date.now()

    await emitBeforeTurn({
        sessionId: session.meta.id,
        mode,
        turn,
        input,
        cwd: session.meta.workspace ?? session.meta.cwd,
    })
    const events: SessionEvent[] = [
        { type: "turn/start", seq: seq++, time: startedAt, data: { turn, mode } },
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

    /*
     * 用户消息先落盘：模型流式过程中进程退出时，本轮提问仍留在会话里
     */
    let persisted = 0
    const persistPending = async (): Promise<void> => {
        if (events.length <= persisted) {
            return
        }
        await store.appendTurn(session, events.slice(persisted))
        persisted = events.length
    }

    // onSessionStart 仅新会话第一轮触发；onMessage 的 before 阶段每轮都能追加系统提示
    const prompt: string[] = []
    if (system !== undefined && system.trim() !== "") {
        prompt.push(system)
    }
    if (turn === 1) {
        await emitSessionStart({
            sessionId: session.meta.id,
            mode,
            turn,
            input,
            cwd: session.meta.workspace ?? session.meta.cwd,
            time: startedAt,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            model,
            permission: params.permission ?? ctx.settings.sandbox.access,
            // chat 模式没有工具循环
            tools: [],
            prompt,
        })
    }
    await emitOnMessage({
        sessionId: session.meta.id,
        mode,
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

    // 模型入参确定后写入开头事件，本轮用户消息不重复计入历史
    await persistPending()

    await emitBeforeStep({
        sessionId: session.meta.id,
        mode,
        turn,
        step: 1,
        input,
    })

    const streamed = display && stream
    const markdownEnabled = display && process.stdout.isTTY === true
    const markdown = markdownEnabled && streamed ? createMarkdownStream() : null
    const streamResult = await client.chatStream(messages, {
        model,
        reasoning: params.reasoning,
        onText: streamed
            ? (text) => {
                  ctx.elog.stream(markdown === null ? text : markdown.push(text))
              }
            : undefined,
    })

    if (!streamResult.isSuccess()) {
        const code = streamResult.getCode() ?? "openai.request-failed"
        events.push({
            type: "turn/end",
            seq: seq++,
            time: Date.now(),
            data: { turn, reason: { kind: "failed", code } },
        })
        await persistPending()
        await emitAfterTurn({
            sessionId: session.meta.id,
            mode,
            turn,
            reason: "failed",
            code,
        })
        if (streamed) {
            if (markdown !== null) {
                const tail = markdown.finish().replace(/\n+$/, "")
                if (tail !== "") {
                    ctx.elog.stream(tail)
                }
            }
            ctx.elog.line()
        }
        return Result.error<TurnData>(code)
    }

    const data = streamResult.getData() as StreamReply
    const assistant: SessionMessageRecord = {
        role: "assistant",
        content: [{ type: "text", text: data.reply.text }],
        source: { kind: "model", provider: "openai", model: data.reply.model },
        id: data.reply.id,
    }
    events.push({
        type: "assistant/message",
        seq: seq++,
        time: Date.now(),
        data: {
            turn,
            step: 1,
            message: assistant,
            usage: { ...usageOf(data.reply) },
            stream: data.chunks,
        },
    })
    events.push({
        type: "turn/end",
        seq,
        time: Date.now(),
        data: { turn, reason: { kind: "completed" } },
    })
    await persistPending()

    await emitOnMessage({
        sessionId: session.meta.id,
        mode,
        turn,
        role: "assistant",
        phase: "after",
        content: data.reply.text,
        prompt,
    })
    await emitAfterStep({
        sessionId: session.meta.id,
        mode,
        turn,
        step: 1,
        reply: data.reply.text,
    })
    await emitAfterTurn({
        sessionId: session.meta.id,
        mode,
        turn,
        reason: "completed",
        code: null,
    })

    if (streamed) {
        if (markdown !== null) {
            const tail = markdown.finish().replace(/\n+$/, "")
            if (tail !== "") {
                ctx.elog.stream(tail)
            }
        }
        ctx.elog.line()
    } else if (display) {
        ctx.elog.print(markdownEnabled ? renderMarkdown(data.reply.text) : data.reply.text)
    }

    return Result.successWithData<TurnData>({
        sessionId: session.meta.id,
        mode,
        turn,
        steps: 1,
        reply: data.reply.text,
        model: data.reply.model,
        usage:
            data.reply.inputTokens === null &&
            data.reply.outputTokens === null &&
            data.reply.cacheReadTokens === undefined &&
            data.reply.cacheWriteTokens === undefined
                ? null
                : usageOf(data.reply),
    })
}

function promptText(session: SessionData, mode: SessionMode): string {
    const name = session.meta.title ?? session.meta.id.slice(-4)
    return `${name}${mode === "run" ? " [run]" : ""} > `
}

async function runRepl(
    ctx: CommandContext,
    params: {
        readonly store: SessionStore
        readonly session: SessionData
        readonly mode: SessionMode
        readonly options: ConversationOptions
    },
): Promise<CommandOutcome> {
    const cwd = process.cwd()
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: process.stdin.isTTY === true,
        historySize: 100,
    })
    let session = params.session
    registerSession(new Session(session, params.store))
    let model = params.options.model
    let permission = params.options.permission
    let closed = false

    const refresh = (): void => {
        const name = session.meta.title ?? session.meta.id.slice(-4)
        ctx.elog.setSessionName(name)
    }
    refresh()

    // 逐次审批
    const approveExec = async (request: ExecApprovalRequest): Promise<boolean> => {
        rl.pause()
        try {
            return await promptExecApproval(request)
        } finally {
            rl.resume()
        }
    }

    // ask 工具在当前终端提问
    const askUser = async (request: HostAgentAskRequest): Promise<string | null> => {
        rl.pause()
        try {
            return await promptAgentAsk(request)
        } finally {
            rl.resume()
        }
    }

    const handleSlash = async (line: string): Promise<"exit" | "continue"> => {
        const [command, ...args] = line.split(/\s+/)
        switch (command) {
            case "/exit":
            case "/quit":
                return "exit"
            case "/help":
                ctx.elog.info("命令：/exit /help /new /session [/list|id] /clear /model <name>")
                return "continue"
            case "/new":
                session = await params.store.create({ cwd, model })
                registerSession(new Session(session, params.store))
                ctx.elog.notice(`session: ${session.meta.id}`)
                return "continue"
            case "/session": {
                if (args[0] === "list") {
                    const list = await params.store.list({ cwd, limit: 20 })
                    for (const item of list) {
                        ctx.elog.print(
                            `${item.id}${item.last ? " *" : ""}  turns=${item.turns}  ${item.cwd}`,
                        )
                    }
                    return "continue"
                }
                if (args[0] !== undefined) {
                    session = await params.store.open(args[0], cwd)
                    registerSession(new Session(session, params.store))
                    return "continue"
                }
                ctx.elog.print(
                    `${session.meta.id}  turns=${session.turns.length}  ${session.meta.workspace ?? session.meta.cwd}`,
                )
                return "continue"
            }
            case "/clear":
                ctx.elog.clear()
                return "continue"
            case "/permission":
                if (args[0] !== undefined) {
                    if (
                        args[0] !== "read-only" &&
                        args[0] !== "workspace-write" &&
                        args[0] !== "danger-full-access"
                    ) {
                        ctx.elog.error(
                            "用法：/permission read-only|workspace-write|danger-full-access",
                        )
                        return "continue"
                    }
                    permission = args[0]
                }
                ctx.elog.info(`permission: ${permission}`)
                return "continue"
            case "/model":
                if (args[0] !== undefined && args[0].trim() !== "") {
                    model = args[0].trim()
                    ctx.elog.info(`model: ${model}`)
                } else {
                    ctx.elog.error("用法：/model <name>")
                }
                return "continue"
            default:
                ctx.elog.error(`未知命令：${command ?? ""}`)
                return "continue"
        }
    }

    const ask = (): void => {
        rl.question(promptText(session, params.mode), (line) => {
            void handleLine(line)
        })
    }

    const handleLine = async (line: string): Promise<void> => {
        if (closed) {
            return
        }
        const text = line.trim()
        if (text === "") {
            ask()
            return
        }
        if (text.startsWith("/") && !text.startsWith("//")) {
            try {
                if ((await handleSlash(text)) === "exit") {
                    rl.close()
                    return
                }
            } catch (error) {
                ctx.elog.error(errorMessage(sessionCode(error)))
            }
            refresh()
            ask()
            return
        }

        const input = text.startsWith("//") ? text.slice(1) : text
        try {
            const result = await executeTurn({
                ctx,
                client: ctx.openai as OpenAIClient,
                store: params.store,
                session,
                mode: params.mode,
                input,
                model,
                reasoning: params.options.reasoning,
                system: params.options.system,
                stream: params.options.stream,
                display: true,
                allowExec: params.options.allowExec,
                permission,
                maxSteps: params.options.maxSteps,
                approveExec,
                askUser,
            })
            if (!result.isSuccess()) {
                ctx.elog.error(errorMessage(result.getCode() ?? "openai.request-failed"))
            }
        } catch (error) {
            ctx.elog.error(errorMessage(sessionCode(error)))
        }
        refresh()
        ask()
    }

    rl.on("SIGINT", () => {
        rl.close()
    })
    rl.on("close", () => {
        closed = true
    })
    ask()
    await new Promise<void>((resolve) => rl.once("close", resolve))
    return success(null)
}

export async function runConversationCommand(
    ctx: CommandContext,
    argv: readonly string[],
    mode: SessionMode,
): Promise<CommandOutcome> {
    if (ctx.openai === null) {
        return failure("openai.missing-api-key")
    }

    const parsed = parseConversationOptions(ctx, argv)
    if (!parsed.isSuccess()) {
        return { result: Result.error<unknown>(parsed.getCode() ?? USAGE_CODES.invalidValue) }
    }
    const options = parsed.getData()
    if (options === null) {
        return failure(USAGE_CODES.invalidValue)
    }

    const store = new SessionStore()
    const cwd = process.cwd()
    let session: SessionData
    let created = false
    try {
        const resolved = await resolveSession(store, cwd, options)
        session = resolved.session
        created = resolved.created
    } catch (error) {
        return failure(sessionCode(error))
    }

    const interactive =
        options.json === false &&
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true &&
        options.context.length === 0

    if (interactive) {
        if (created) {
            ctx.elog.notice(`session: ${session.meta.id}`)
        }
        return await runRepl(ctx, { store, session, mode, options })
    }

    let input = options.context.join(" ").trim()
    if (input === "") {
        if (process.stdin.isTTY === true) {
            return failure(USAGE_CODES.missingContext)
        }
        input = (await readStdin()).trim()
    }
    if (input === "") {
        return failure(USAGE_CODES.missingContext)
    }

    if (created) {
        ctx.elog.notice(`session: ${session.meta.id}`)
    }
    registerSession(new Session(session, store))

    const result = await executeTurn({
        ctx,
        client: ctx.openai,
        store,
        session,
        mode,
        input,
        model: options.model,
        reasoning: options.reasoning,
        system: options.system,
        stream: options.stream,
        display: options.json === false,
        allowExec: options.allowExec,
        permission: options.permission,
        maxSteps: options.maxSteps,
        approveExec:
            options.json === false && process.stdin.isTTY === true && process.stdout.isTTY === true
                ? promptExecApproval
                : undefined,
        askUser:
            options.json === false && process.stdin.isTTY === true && process.stdout.isTTY === true
                ? promptAgentAsk
                : async () => null,
    })
    if (!result.isSuccess()) {
        return { result: Result.error<unknown>(result.getCode() ?? "openai.request-failed") }
    }
    const data = result.getData()
    return success({
        sessionId: data?.sessionId,
        mode,
        reply: data?.reply,
        model: data?.model,
        usage: data?.usage,
    })
}
