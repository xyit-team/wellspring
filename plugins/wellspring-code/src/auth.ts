/*
 * 单用户访问密码：scrypt 哈希存插件数据目录的 auth.json，浏览器会话 token 只在进程内存。
 * 只在设置了密码后才启用认证；回环地址默认不设密码也能用。
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

const AUTH_FILE = "auth.json"
const COOKIE_NAME = "wellspring_code_session"
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_SESSIONS = 32
export const MIN_PASSWORD_CHARS = 6
export const MAX_PASSWORD_CHARS = 200

interface StoredAuth {
    readonly salt: string
    readonly hash: string
}

export interface BrowserSession {
    readonly token: string
    readonly expiresAt: number
}

export interface RequestLike {
    readonly headers: Record<string, string>
}

/** 只声明用到的文件能力，HostFileApi 在结构上满足 */
export interface AuthFileApi {
    readJson<T = unknown>(path: string): Promise<T | null>
    writeJson(path: string, value: unknown): Promise<void>
}

/** 只解析本插件关心的那一个 cookie；名字大小写按原样匹配 */
export function parseCookies(header: string | undefined): Record<string, string> {
    const cookies: Record<string, string> = {}
    if (typeof header !== "string" || header === "") {
        return cookies
    }
    for (const part of header.split(";")) {
        const index = part.indexOf("=")
        if (index <= 0) continue
        const name = part.slice(0, index).trim()
        if (name === "") continue
        cookies[name] = part.slice(index + 1).trim()
    }
    return cookies
}

function hashPassword(password: string, salt: string): string {
    return scryptSync(password, salt, 64).toString("hex")
}

export class CodeAuthStore {
    readonly #fs: AuthFileApi
    readonly #sessions = new Map<string, number>()
    #stored: StoredAuth | null = null
    #secure = false

    constructor(fs: AuthFileApi) {
        this.#fs = fs
    }

    get configured(): boolean {
        return this.#stored !== null
    }

    get secure(): boolean {
        return this.#secure
    }

    /** HTTPS 下 cookie 带 Secure；HTTP 下不能带，否则浏览器直接丢弃 */
    setSecure(value: boolean): void {
        this.#secure = value
    }

    async load(): Promise<void> {
        try {
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
        } catch {
            // 文件损坏时按未设置密码处理，用户可以在本机重新设置
            this.#stored = null
        }
    }

    async setPassword(password: string): Promise<void> {
        const stored = { salt: randomBytes(16).toString("hex"), hash: "" }
        const value = { salt: stored.salt, hash: hashPassword(password, stored.salt) }
        await this.#fs.writeJson(AUTH_FILE, value)
        this.#stored = value
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
        this.#prune()
        const token = randomBytes(32).toString("hex")
        const expiresAt = Date.now() + SESSION_TTL_MS
        this.#sessions.set(token, expiresAt)
        return { token, expiresAt }
    }

    #prune(): void {
        const now = Date.now()
        for (const [token, expiresAt] of this.#sessions) {
            if (expiresAt <= now) {
                this.#sessions.delete(token)
            }
        }
        while (this.#sessions.size >= MAX_SESSIONS) {
            const oldest = this.#sessions.keys().next().value
            if (oldest === undefined) {
                break
            }
            this.#sessions.delete(oldest)
        }
    }

    authenticated(request: RequestLike): boolean {
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

    /** 改密码后让所有已登录设备重新登录 */
    clearSessions(): void {
        this.#sessions.clear()
    }

    logout(request: RequestLike): void {
        const token = parseCookies(request.headers["cookie"])[COOKIE_NAME]
        if (token !== undefined) {
            this.#sessions.delete(token)
        }
    }

    cookie(session: BrowserSession): string {
        const maxAge = Math.floor(SESSION_TTL_MS / 1000)
        const secure = this.#secure ? "; Secure" : ""
        return `${COOKIE_NAME}=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
    }

    clearCookie(): string {
        const secure = this.#secure ? "; Secure" : ""
        return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
    }
}

interface AttemptState {
    failures: number
    lastAt: number
    blockedUntil: number
}

const MAX_ATTEMPTS = 5
const FAILURE_WINDOW_MS = 10 * 60 * 1000
const LOCKOUT_MS = 60 * 1000

/** 登录失败按来源地址计数，5 次后锁定 60 秒 */
export class LoginThrottle {
    readonly #attempts = new Map<string, AttemptState>()

    status(key: string): { readonly blocked: boolean; readonly retryAfter: number } {
        const state = this.#attempts.get(key)
        if (state === undefined || state.blockedUntil <= Date.now()) {
            return { blocked: false, retryAfter: 0 }
        }
        return {
            blocked: true,
            retryAfter: Math.max(1, Math.ceil((state.blockedUntil - Date.now()) / 1000)),
        }
    }

    recordFailure(key: string): void {
        const now = Date.now()
        const state = this.#attempts.get(key) ?? { failures: 0, lastAt: now, blockedUntil: 0 }
        if (now - state.lastAt > FAILURE_WINDOW_MS) {
            state.failures = 0
        }
        state.failures += 1
        state.lastAt = now
        if (state.failures >= MAX_ATTEMPTS) {
            state.blockedUntil = now + LOCKOUT_MS
            state.failures = 0
        }
        this.#attempts.set(key, state)
        this.#prune(now)
    }

    /** 登录成功清零失败次数；锁定期内不清除锁定 */
    reset(key: string): void {
        const state = this.#attempts.get(key)
        if (state !== undefined && state.blockedUntil > Date.now()) {
            state.failures = 0
            return
        }
        this.#attempts.delete(key)
    }

    #prune(now: number): void {
        if (this.#attempts.size < 256) {
            return
        }
        for (const [key, state] of this.#attempts) {
            if (state.blockedUntil <= now && now - state.lastAt > FAILURE_WINDOW_MS) {
                this.#attempts.delete(key)
            }
        }
    }
}
