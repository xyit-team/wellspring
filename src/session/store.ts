/*
 * 会话存储。
 * 路径：<dataDir>/sessions/<cwd桶>/<sessionId>/
 *   session.json       元信息
 *   .lock              写入锁
 *   turns/NNNN.jsonl.zstd   每轮一个 zstd 段
 * last.json 存在 cwd 桶目录下，记录该 cwd 的最近会话。
 */

import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { readdir, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

import {
    ensureDir,
    readBytesIfExists,
    readJsonIfExists,
    removePath,
    statIfExists,
    writeBytesAtomic,
    writeJsonAtomic,
} from "../platform/file.ts"
import { getPaths } from "../platform/path.ts"
import { decodeEvents, encodeEvents } from "./compress.ts"
import { groupTurns } from "./replay.ts"
import type { SessionEvent, SessionHeader, SessionMeta, SessionTurn } from "./types.ts"

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const SEGMENT = /^(\d+)\.jsonl\.zstd$/
const LOCK_STALE_MS = 10 * 60 * 1000
const APP_NAME = "wellspring"
const APP_VERSION = "1.0.0"

export class SessionNotFoundError extends Error {
    constructor(id: string) {
        super(`会话不存在：${id}`)
        this.name = "SessionNotFoundError"
    }
}

export class SessionAmbiguousError extends Error {
    constructor(id: string) {
        super(`会话 id 在多个 cwd 桶中重复：${id}`)
        this.name = "SessionAmbiguousError"
    }
}

export class SessionLockedError extends Error {
    constructor(id: string) {
        super(`会话正在被其他进程写入：${id}`)
        this.name = "SessionLockedError"
    }
}

export interface SessionData {
    readonly meta: SessionMeta
    readonly header: SessionHeader
    readonly dir: string
    events: SessionEvent[]
    turns: SessionTurn[]
}

export interface SessionSummary {
    readonly id: string
    readonly cwd: string
    readonly dir: string
    readonly turns: number
    readonly updatedAt: number
    readonly last: boolean
}

export interface CreateSessionOptions {
    readonly cwd: string
    readonly workspace?: string
    readonly model: string
    readonly id?: string
    readonly type?: string
    readonly metadata?: Record<string, unknown>
}

export interface ListSessionsOptions {
    readonly cwd: string
    readonly all?: boolean
    readonly limit?: number
}

export function isValidSessionId(id: string): boolean {
    return SESSION_ID.test(id)
}

export function newSessionId(date = new Date()): string {
    const pad = (value: number): string => String(value).padStart(2, "0")
    const stamp =
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    const suffix = Math.floor(Math.random() * 0xffff)
        .toString(16)
        .padStart(4, "0")
    return `${stamp}-${suffix}`
}

function slugOf(name: string): string {
    const cleaned = name
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "")
    return (cleaned === "" ? "root" : cleaned).slice(0, 32)
}

/** cwd → 桶目录名：<slug>-<sha256 前 8 位> */
export function sessionBucket(cwd: string): string {
    let canonical = cwd
    try {
        canonical = realpathSync(cwd)
    } catch {
        canonical = resolve(cwd)
    }
    const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8)
    return `${slugOf(basename(canonical))}-${hash}`
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

export class SessionStore {
    readonly root: string

    constructor(root = join(getPaths().dataDir, "sessions")) {
        this.root = root
    }

    bucketDir(cwd: string): string {
        return join(this.root, sessionBucket(cwd))
    }

    async lastId(cwd: string): Promise<string | null> {
        const last = await readJsonIfExists<{ id?: unknown }>(
            join(this.bucketDir(cwd), "last.json"),
        )
        return typeof last?.id === "string" ? last.id : null
    }

    async create(options: CreateSessionOptions): Promise<SessionData> {
        const id = options.id ?? newSessionId()
        if (!isValidSessionId(id)) {
            throw new Error(`会话 id 不合法：${id}`)
        }
        const dir = join(this.bucketDir(options.cwd), id)
        const existing = await this.open(id, options.cwd).catch(() => null)
        if (existing !== null) {
            return existing
        }

        const workspace = resolve(options.workspace ?? options.cwd)
        const type = options.type ?? "session"
        const metadata = options.metadata ?? {}
        const meta: SessionMeta = {
            type,
            version: 1,
            id,
            createdAt: Date.now(),
            cwd: options.cwd,
            workspace,
            metadata,
            app: APP_NAME,
            appVersion: APP_VERSION,
            model: options.model,
        }
        const header: SessionHeader = { type, metadata, workspace }
        await ensureDir(join(dir, "turns"))
        await writeBytesAtomic(
            join(dir, "turns", "0000.jsonl.zstd"),
            encodeEvents([
                {
                    type: "session/header",
                    seq: 0,
                    time: meta.createdAt,
                    data: { ...header },
                },
            ]),
        )
        await writeJsonAtomic(join(dir, "session.json"), meta)
        await this.#writeLast(options.cwd, id)
        return { meta, header, dir, events: [], turns: [] }
    }

    /** 打开当前 cwd 桶优先，其次其他桶；不存在抛 SessionNotFoundError */
    async open(id: string, cwd?: string): Promise<SessionData> {
        const dir = await this.#findDir(id, cwd)
        const stored = await readJsonIfExists<SessionMeta>(join(dir, "session.json"))
        if (stored === null || typeof stored.type !== "string" || stored.version !== 1) {
            throw new Error(`会话元信息损坏：${id}`)
        }
        const header = (await this.#readHeader(dir)) ?? {
            type: stored.type,
            metadata: stored.metadata ?? {},
            workspace: stored.workspace ?? stored.cwd,
        }
        const meta: SessionMeta = {
            ...stored,
            type: header.type,
            metadata: header.metadata,
            workspace:
                header.workspace === "" ? (stored.workspace ?? stored.cwd) : header.workspace,
        }
        const events = await this.#readEvents(dir)
        return { meta, header, dir, events, turns: groupTurns(events) }
    }

    /** 取最近一次会话；没有则创建 */
    async openLastOrCreate(cwd: string, model: string): Promise<SessionData> {
        const last = await this.lastId(cwd)
        if (last !== null) {
            try {
                return await this.open(last, cwd)
            } catch {
                return await this.create({ cwd, model })
            }
        }
        return await this.create({ cwd, model })
    }

    async appendTurn(session: SessionData, events: readonly SessionEvent[]): Promise<number> {
        if (events.length === 0) {
            return session.turns.length
        }
        const release = await this.#acquireLock(session.dir, session.meta.id)
        try {
            const turnsDir = join(session.dir, "turns")
            await ensureDir(turnsDir)
            const names = await readdir(turnsDir)
            let max = 0
            for (const name of names) {
                const match = SEGMENT.exec(name)
                if (match !== null) {
                    const index = Number(match[1])
                    if (index > max) {
                        max = index
                    }
                }
            }
            const next = max + 1
            const file = join(turnsDir, `${String(next).padStart(4, "0")}.jsonl.zstd`)
            await writeBytesAtomic(file, encodeEvents(events))
            await this.#writeLast(session.meta.cwd, session.meta.id)
            session.events = [...session.events, ...events]
            session.turns = groupTurns(session.events)
            return next
        } finally {
            await release()
        }
    }

    async list(options: ListSessionsOptions): Promise<SessionSummary[]> {
        const buckets =
            options.all === true ? await this.#bucketDirs() : [this.bucketDir(options.cwd)]
        const summaries: SessionSummary[] = []

        for (const bucket of buckets) {
            const last = await readJsonIfExists<{ id?: unknown }>(join(bucket, "last.json"))
            const lastId = typeof last?.id === "string" ? last.id : null
            let names: string[]
            try {
                names = await readdir(bucket)
            } catch {
                continue
            }
            for (const name of names) {
                if (!isValidSessionId(name)) {
                    continue
                }
                const dir = join(bucket, name)
                const meta = await readJsonIfExists<SessionMeta>(join(dir, "session.json"))
                if (meta === null) {
                    continue
                }
                const segments = await this.#turnFiles(dir)
                const lastFile =
                    segments.length === 0
                        ? null
                        : await statIfExists(
                              join(dir, "turns", segments[segments.length - 1] ?? ""),
                          )
                summaries.push({
                    id: meta.id,
                    cwd: meta.cwd,
                    dir,
                    turns: segments.length,
                    updatedAt: lastFile?.mtimeMs ?? meta.createdAt,
                    last: lastId === meta.id,
                })
            }
        }

        summaries.sort((left, right) => right.updatedAt - left.updatedAt)
        return options.limit === undefined ? summaries : summaries.slice(0, options.limit)
    }

    async remove(id: string): Promise<void> {
        const dir = await this.#findDir(id)
        const meta = await readJsonIfExists<SessionMeta>(join(dir, "session.json"))
        await removePath(dir)
        if (meta !== null) {
            const last = await this.lastId(meta.cwd)
            if (last === id) {
                await removePath(join(this.bucketDir(meta.cwd), "last.json"))
            }
        }
    }

    async removeAll(cwd: string): Promise<number> {
        const bucket = this.bucketDir(cwd)
        let names: string[]
        try {
            names = await readdir(bucket)
        } catch {
            return 0
        }
        let removed = 0
        for (const name of names) {
            if (!isValidSessionId(name)) {
                continue
            }
            await removePath(join(bucket, name))
            removed += 1
        }
        await removePath(join(bucket, "last.json"))
        return removed
    }

    async #findDir(id: string, cwd?: string): Promise<string> {
        if (!isValidSessionId(id)) {
            throw new Error(`会话 id 不合法：${id}`)
        }
        const candidates: string[] = []
        if (cwd !== undefined) {
            candidates.push(this.bucketDir(cwd))
        }
        for (const bucket of await this.#bucketDirs()) {
            if (!candidates.includes(bucket)) {
                candidates.push(bucket)
            }
        }

        const matches: string[] = []
        for (const bucket of candidates) {
            const dir = join(bucket, id)
            if ((await statIfExists(dir)) !== null) {
                matches.push(dir)
            }
        }
        if (matches.length === 0) {
            throw new SessionNotFoundError(id)
        }
        if (matches.length > 1) {
            throw new SessionAmbiguousError(id)
        }
        return matches[0]!
    }

    async #bucketDirs(): Promise<string[]> {
        let names: string[]
        try {
            names = await readdir(this.root, { withFileTypes: true }).then((entries) =>
                entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
            )
        } catch {
            return []
        }
        return names.sort().map((name) => join(this.root, name))
    }

    async #turnFiles(dir: string): Promise<string[]> {
        try {
            const names = await readdir(join(dir, "turns"))
            return names
                .filter((name) => SEGMENT.test(name) && name !== "0000.jsonl.zstd")
                .sort(
                    (left, right) =>
                        Number(SEGMENT.exec(left)?.[1]) - Number(SEGMENT.exec(right)?.[1]),
                )
        } catch {
            return []
        }
    }

    async #readHeader(dir: string): Promise<SessionHeader | null> {
        const data = await readBytesIfExists(join(dir, "turns", "0000.jsonl.zstd"))
        if (data === null) {
            return null
        }
        const event = decodeEvents(data).find((item) => item.type === "session/header")
        if (event === undefined) {
            return null
        }
        const type = event.data["type"]
        const metadata = event.data["metadata"]
        const workspace = event.data["workspace"]
        return {
            type: typeof type === "string" ? type : "session",
            metadata:
                typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
                    ? (metadata as Record<string, unknown>)
                    : {},
            workspace: typeof workspace === "string" ? workspace : "",
        }
    }

    async #readEvents(dir: string): Promise<SessionEvent[]> {
        const files = await this.#turnFiles(dir)
        const events: SessionEvent[] = []
        for (const name of files) {
            const data = await readBytesIfExists(join(dir, "turns", name))
            if (data === null) {
                continue
            }
            events.push(...decodeEvents(data))
        }
        return events
    }

    async #writeLast(cwd: string, id: string): Promise<void> {
        await writeJsonAtomic(join(this.bucketDir(cwd), "last.json"), {
            id,
            updatedAt: Date.now(),
        })
    }

    async #acquireLock(dir: string, id: string): Promise<() => Promise<void>> {
        const lock = join(dir, ".lock")
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                await writeFile(
                    lock,
                    JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
                    { flag: "wx", mode: 0o600 },
                )
                return async () => {
                    await removePath(lock)
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                    throw error
                }
                const info = await statIfExists(lock)
                if (info === null) {
                    continue
                }
                const content = await readJsonIfExists<{ pid?: unknown }>(lock)
                const pid = typeof content?.pid === "number" ? content.pid : null
                const stale =
                    Date.now() - info.mtimeMs > LOCK_STALE_MS || pid === null || !isPidAlive(pid)
                if (!stale) {
                    throw new SessionLockedError(id)
                }
                await removePath(lock)
            }
        }
        throw new SessionLockedError(id)
    }
}
