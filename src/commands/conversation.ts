/*
 * chat / run 命令。
 * 无 context 且 TTY 时进入交互式会话；否则单轮执行。
 * 所有轮次都作为 zstd JSONL 段写入会话，流式 chunk 一并保存。
 */

import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"

import {
    emitAfterMessage,
    emitAfterStep,
    emitAfterTurn,
    emitBeforeMessage,
} from "../api/host/hooks.ts"
import { Result } from "../api/result/result.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { booleanValue, parseCommandArgs, stringValue } from "../input/parse-options.ts"
import type { OpenAIClient, StreamReply } from "../network/openai.ts"
import { lastSeq, lastTurnNumber, toChatMessages } from "../session/replay.ts"
import {
    SessionAmbiguousError,
    SessionLockedError,
    SessionNotFoundError,
    SessionStore,
    isValidSessionId,
    type SessionData,
} from "../session/store.ts"
import type { SessionEvent, SessionMessage, SessionMode } from "../session/types.ts"
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
    readonly system?: string
    readonly agent?: string
    readonly json: boolean
    readonly stream: boolean
    readonly context: readonly string[]
}

interface TurnData {
    readonly sessionId: string
    readonly mode: SessionMode
    readonly reply: string
    readonly model: string
    readonly usage: {
        readonly inputTokens: number | null
        readonly outputTokens: number | null
    } | null
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
        "no-stream": { type: "boolean" },
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

    return Result.successWithData<ConversationOptions>({
        sessionId,
        newSession,
        model: stringValue(values, "model") ?? ctx.settings.openai.model,
        system: stringValue(values, "system"),
        agent: stringValue(values, "agent"),
        json,
        stream,
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
            // 落到新建
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
    readonly system?: string
    readonly stream: boolean
    readonly display: boolean
}): Promise<Result<TurnData>> {
    const { ctx, client, store, session, mode, input, model, system, stream, display } = params
    const turn = lastTurnNumber(session.events) + 1
    let seq = lastSeq(session.events) + 1
    const startedAt = Date.now()

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
                } satisfies SessionMessage,
                surfaceOp: "append",
            },
        },
    ]

    // 钩子可以往 prompt 里追加系统提示
    const prompt: string[] = []
    if (system !== undefined && system.trim() !== "") {
        prompt.push(system)
    }
    await emitBeforeMessage({ input, context: session.meta.cwd, prompt })

    const messages: ChatCompletionMessageParam[] = []
    const systemText = prompt
        .map((item) => item.trim())
        .filter((item) => item !== "")
        .join("\n\n")
    if (systemText !== "") {
        messages.push({ role: "system", content: systemText })
    }
    messages.push(...toChatMessages(session.events), { role: "user", content: input })

    const streamed = display && stream
    const streamResult = await client.chatStream(messages, {
        model,
        onText: streamed
            ? (text) => {
                  ctx.elog.stream(text)
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
        await store.appendTurn(session, events)
        await emitAfterTurn({
            sessionId: session.meta.id,
            mode,
            turn,
            reason: "failed",
            code,
        })
        if (streamed) {
            ctx.elog.line()
        }
        return Result.error<TurnData>(code)
    }

    const data = streamResult.getData() as StreamReply
    const assistant: SessionMessage = {
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
            usage: {
                inputTokens: data.reply.inputTokens,
                outputTokens: data.reply.outputTokens,
            },
            stream: data.chunks,
        },
    })
    events.push({
        type: "turn/end",
        seq,
        time: Date.now(),
        data: { turn, reason: { kind: "completed" } },
    })
    await store.appendTurn(session, events)

    await emitAfterStep({
        sessionId: session.meta.id,
        mode,
        turn,
        step: 1,
        reply: data.reply.text,
        model: data.reply.model,
    })
    await emitAfterMessage({
        sessionId: session.meta.id,
        mode,
        input,
        reply: data.reply.text,
        model: data.reply.model,
        inputTokens: data.reply.inputTokens,
        outputTokens: data.reply.outputTokens,
    })
    await emitAfterTurn({
        sessionId: session.meta.id,
        mode,
        turn,
        reason: "completed",
        code: null,
    })

    if (streamed) {
        ctx.elog.line()
    } else if (display) {
        ctx.elog.print(data.reply.text)
    }

    return Result.successWithData<TurnData>({
        sessionId: session.meta.id,
        mode,
        reply: data.reply.text,
        model: data.reply.model,
        usage:
            data.reply.inputTokens === null && data.reply.outputTokens === null
                ? null
                : {
                      inputTokens: data.reply.inputTokens,
                      outputTokens: data.reply.outputTokens,
                  },
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
    let model = params.options.model

    const refresh = (): void => {
        const name = session.meta.title ?? session.meta.id.slice(-4)
        ctx.elog.setSessionName(name)
        rl.setPrompt(promptText(session, params.mode))
    }
    refresh()
    rl.prompt()
    rl.on("SIGINT", () => {
        rl.close()
    })

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
                    return "continue"
                }
                ctx.elog.print(
                    `${session.meta.id}  turns=${session.turns.length}  ${session.meta.cwd}`,
                )
                return "continue"
            }
            case "/clear":
                ctx.elog.clear()
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

    try {
        for await (const line of rl) {
            const text = line.trim()
            if (text === "") {
                rl.prompt()
                continue
            }
            if (text.startsWith("/") && !text.startsWith("//")) {
                try {
                    const action = await handleSlash(text)
                    if (action === "exit") {
                        break
                    }
                } catch (error) {
                    ctx.elog.error(errorMessage(sessionCode(error)))
                }
                refresh()
                rl.prompt()
                continue
            }

            const input = text.startsWith("//") ? text.slice(1) : text
            rl.pause()
            try {
                const result = await executeTurn({
                    ctx,
                    client: ctx.openai as OpenAIClient,
                    store: params.store,
                    session,
                    mode: params.mode,
                    input,
                    model,
                    system: params.options.system,
                    stream: params.options.stream,
                    display: true,
                })
                if (!result.isSuccess()) {
                    ctx.elog.error(errorMessage(result.getCode() ?? "openai.request-failed"))
                }
            } finally {
                rl.resume()
                refresh()
                rl.prompt()
            }
        }
    } finally {
        rl.close()
    }
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

    const result = await executeTurn({
        ctx,
        client: ctx.openai,
        store,
        session,
        mode,
        input,
        model: options.model,
        system: options.system,
        stream: options.stream,
        display: options.json === false,
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
