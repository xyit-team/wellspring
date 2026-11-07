/*
 * session 命令：list / show / delete
 */

import { Result } from "../api/result/result.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { booleanValue, parseCommandArgs, stringValue } from "../input/parse-options.ts"
import { contentText } from "../session/replay.ts"
import { SessionStore, type SessionData } from "../session/store.ts"
import type { SessionEvent } from "../session/types.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

function truncate(text: string, full: boolean): string {
    if (full || text.length <= 200) {
        return text
    }
    return `${text.slice(0, 200)}…`
}

function eventText(event: SessionEvent): string {
    const message = event.data["message"]
    if (typeof message !== "object" || message === null) {
        return ""
    }
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) {
        return ""
    }
    return contentText(content as never)
}

function printSession(session: SessionData, full: boolean, ctx: CommandContext): void {
    ctx.elog.print(`${session.meta.id}  ${session.meta.cwd}`)
    for (const turn of session.turns) {
        const mode = turn.mode ?? "chat"
        ctx.elog.print(`#${turn.turn} [${mode}]`)
        for (const event of turn.events) {
            if (event.type === "user/message") {
                ctx.elog.print(`  > ${truncate(eventText(event), full)}`)
            } else if (event.type === "assistant/message") {
                ctx.elog.print(`  ${truncate(eventText(event), full)}`)
            } else if (event.type === "tool/call") {
                const name = event.data["name"]
                ctx.elog.print(`  [tool] ${String(name ?? "")}`)
            } else if (event.type === "turn/end") {
                const reason = event.data["reason"]
                const kind =
                    typeof reason === "object" && reason !== null
                        ? ((reason as { kind?: unknown }).kind ?? "")
                        : ""
                ctx.elog.print(`  -- ${String(kind)}`)
            }
        }
    }
}

async function handleList(ctx: CommandContext, args: readonly string[]): Promise<CommandOutcome> {
    const parsed = parseCommandArgs(args, {
        all: { type: "boolean" },
        limit: { type: "string" },
    })
    if (!parsed.isSuccess()) {
        return { result: Result.error<unknown>(parsed.getCode() ?? USAGE_CODES.invalidValue) }
    }
    const line = parsed.getData()
    if (line === null) {
        return failure(USAGE_CODES.invalidValue)
    }
    const rawLimit = stringValue(line.values, "limit")
    let limit = 20
    if (rawLimit !== undefined) {
        const value = Number(rawLimit)
        if (!Number.isInteger(value) || value <= 0) {
            return failure(`${USAGE_CODES.invalidValue}:--limit`)
        }
        limit = value
    }

    const list = await new SessionStore().list({
        cwd: process.cwd(),
        all: booleanValue(line.values, "all"),
        limit,
    })
    for (const item of list) {
        ctx.elog.print(`${item.id}${item.last ? " *" : ""}  turns=${item.turns}  ${item.cwd}`)
    }
    return success(list.map((item) => ({ ...item, dir: undefined })))
}

async function handleShow(ctx: CommandContext, args: readonly string[]): Promise<CommandOutcome> {
    const parsed = parseCommandArgs(args, {
        full: { type: "boolean" },
    })
    if (!parsed.isSuccess()) {
        return { result: Result.error<unknown>(parsed.getCode() ?? USAGE_CODES.invalidValue) }
    }
    const line = parsed.getData()
    const id = line?.positionals[0]
    if (id === undefined) {
        return failure(`${USAGE_CODES.missingValue}:session-id`)
    }
    const session = await new SessionStore().open(id, process.cwd())
    printSession(session, line !== null && booleanValue(line.values, "full"), ctx)
    return success({ meta: session.meta, turns: session.turns })
}

async function handleDelete(ctx: CommandContext, args: readonly string[]): Promise<CommandOutcome> {
    const parsed = parseCommandArgs(args, {
        all: { type: "boolean" },
        yes: { type: "boolean" },
    })
    if (!parsed.isSuccess()) {
        return { result: Result.error<unknown>(parsed.getCode() ?? USAGE_CODES.invalidValue) }
    }
    const line = parsed.getData()
    if (line === null) {
        return failure(USAGE_CODES.invalidValue)
    }
    const all = booleanValue(line.values, "all")
    const yes = booleanValue(line.values, "yes")
    const store = new SessionStore()

    if (all) {
        if (!yes) {
            return failure(USAGE_CODES.missingConfirmation)
        }
        const removed = await store.removeAll(process.cwd())
        ctx.elog.info(`已删除 ${removed} 个会话`)
        return success({ removed })
    }

    if (line.positionals.length === 0) {
        return failure(`${USAGE_CODES.missingValue}:session-id`)
    }
    for (const id of line.positionals) {
        await store.remove(id)
        ctx.elog.info(`已删除 ${id}`)
    }
    return success({ removed: line.positionals })
}

export async function runSessionCommand(
    ctx: CommandContext,
    argv: readonly string[],
): Promise<CommandOutcome> {
    const [subcommand, ...rest] = argv
    try {
        switch (subcommand) {
            case "list":
                return await handleList(ctx, rest)
            case "show":
                return await handleShow(ctx, rest)
            case "delete":
                return await handleDelete(ctx, rest)
            default:
                return failure(`${USAGE_CODES.unknownSubcommand}:session ${subcommand ?? ""}`)
        }
    } catch (error) {
        return failure(sessionErrorCode(error))
    }
}

function sessionErrorCode(error: unknown): string {
    if (error instanceof Error) {
        if (error.name === "SessionNotFoundError") {
            return "session.not-found"
        }
        if (error.name === "SessionAmbiguousError") {
            return "session.ambiguous-id"
        }
        if (error.name === "SessionLockedError") {
            return "session.locked"
        }
        if (error.message.includes("会话 id 不合法")) {
            return USAGE_CODES.invalidSessionId
        }
    }
    return "session.corrupted"
}
