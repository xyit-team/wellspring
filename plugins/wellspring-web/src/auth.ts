/*
 * 简单的单用户密码认证。
 * 密码哈希存插件 data 目录；登录 token 只保存在进程内存。
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

import type { HostFileApi } from "wellspring/api/host/index.ts"

const AUTH_FILE = "auth.json"
const COOKIE_NAME = "wellspring_web_session"
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface StoredAuth {
    readonly salt: string
    readonly hash: string
}

export interface BrowserSession {
    readonly token: string
    readonly expiresAt: number
}

function hashPassword(password: string, salt: string): string {
    return scryptSync(password, salt, 64).toString("hex")
}

function parseCookies(header: string | undefined): Record<string, string> {
    if (header === undefined) {
        return {}
    }
    const cookies: Record<string, string> = {}
    for (const part of header.split(";")) {
        const index = part.indexOf("=")
        if (index === -1) {
            continue
        }
        const key = part.slice(0, index).trim()
        const value = part.slice(index + 1).trim()
        if (key !== "") {
            cookies[key] = decodeURIComponent(value)
        }
    }
    return cookies
}

export class AuthStore {
    readonly #fs: HostFileApi
    readonly #sessions = new Map<string, number>()
    #stored: StoredAuth | null = null

    constructor(fs: HostFileApi) {
        this.#fs = fs
    }

    get configured(): boolean {
        return this.#stored !== null
    }

    async load(): Promise<void> {
        const value = await this.#fs.readJson<StoredAuth>(AUTH_FILE)
        if (
            value !== null &&
            typeof value.salt === "string" &&
            typeof value.hash === "string" &&
            value.salt !== "" &&
            value.hash !== ""
        ) {
            this.#stored = value
        }
    }

    async setPassword(password: string): Promise<void> {
        if (password.length < 6) {
            throw new Error("密码至少 6 位")
        }
        const salt = randomBytes(16).toString("hex")
        const stored = { salt, hash: hashPassword(password, salt) }
        await this.#fs.writeJson(AUTH_FILE, stored)
        this.#stored = stored
    }

    verifyPassword(password: string): boolean {
        if (this.#stored === null) {
            return false
        }
        const actual = Buffer.from(hashPassword(password, this.#stored.salt), "hex")
        const expected = Buffer.from(this.#stored.hash, "hex")
        return actual.length === expected.length && timingSafeEqual(actual, expected)
    }

    createSession(): BrowserSession {
        const token = randomBytes(32).toString("hex")
        const expiresAt = Date.now() + SESSION_TTL_MS
        this.#sessions.set(token, expiresAt)
        return { token, expiresAt }
    }

    authenticated(request: { readonly headers: Record<string, string> }): boolean {
        const token = parseCookies(request.headers["cookie"])[COOKIE_NAME]
        if (token === undefined) {
            return false
        }
        const expiresAt = this.#sessions.get(token)
        if (expiresAt === undefined) {
            return false
        }
        if (expiresAt <= Date.now()) {
            this.#sessions.delete(token)
            return false
        }
        return true
    }

    logout(request: { readonly headers: Record<string, string> }): void {
        const token = parseCookies(request.headers["cookie"])[COOKIE_NAME]
        if (token !== undefined) {
            this.#sessions.delete(token)
        }
    }

    cookie(session: BrowserSession): string {
        const maxAge = Math.floor(SESSION_TTL_MS / 1000)
        return `${COOKIE_NAME}=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
    }

    clearCookie(): string {
        return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    }
}
