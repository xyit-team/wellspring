/*
 * 监听地址解析：默认只绑回环；非回环地址要么显式 allowRemote，要么已经设置访问密码。
 * 纯函数，便于单测（不碰插件 API 与网络）。
 */

export const DEFAULT_HOST = "127.0.0.1"
export const DEFAULT_PORT = 8788

export interface TlsSettings {
    readonly cert: string
    readonly key: string
    readonly ca?: string
}

export interface ListenConfig {
    readonly host: string
    readonly port: number
    readonly tls: TlsSettings | null
    /** 需要写进启动日志的提醒 */
    readonly warnings: readonly string[]
}

export function isLoopbackHost(host: string): boolean {
    return (
        host === "127.0.0.1" ||
        host === "localhost" ||
        host === "::1" ||
        host === "[::1]" ||
        host.startsWith("127.")
    )
}

/** 请求来源是否是本机：IPv4 回环、IPv6 回环以及 IPv4-mapped 形式 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
    if (typeof address !== "string" || address === "") {
        return false
    }
    const value = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address
    return value === "::1" || value === "127.0.0.1" || value.startsWith("127.")
}

function parseTls(raw: unknown): TlsSettings | null {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return null
    }
    const record = raw as Record<string, unknown>
    const cert = record["cert"]
    const key = record["key"]
    const ca = record["ca"]
    if (typeof cert !== "string" || cert.trim() === "") {
        return null
    }
    if (typeof key !== "string" || key.trim() === "") {
        return null
    }
    return typeof ca === "string" && ca.trim() !== "" ? { cert, key, ca } : { cert, key }
}

export function resolveListenConfig(input: {
    readonly host?: unknown
    readonly port?: unknown
    readonly allowRemote?: unknown
    readonly tls?: unknown
    readonly authConfigured: boolean
}): ListenConfig {
    const warnings: string[] = []
    let host =
        typeof input.host === "string" && input.host.trim() !== ""
            ? input.host.trim()
            : DEFAULT_HOST
    const portRaw = input.port
    const port =
        typeof portRaw === "number" &&
        Number.isInteger(portRaw) &&
        portRaw >= 0 &&
        portRaw <= 65_535
            ? portRaw
            : DEFAULT_PORT
    const tls = parseTls(input.tls)
    if (input.tls !== undefined && input.tls !== null && tls === null) {
        warnings.push("tls 配置不完整（需要 cert 与 key PEM），按 HTTP 启动")
    }
    const allowRemote = input.allowRemote === true
    if (!isLoopbackHost(host)) {
        if (!allowRemote && !input.authConfigured) {
            warnings.push(
                `拒绝在非回环地址启动：请先在本机设置访问密码，或在插件配置里设置 allowRemote: true（当前回退到 ${DEFAULT_HOST}）`,
            )
            host = DEFAULT_HOST
        } else if (!input.authConfigured) {
            warnings.push(
                "监听非回环地址但还没有设置访问密码：远程请求会被拒绝，请先在本机设置密码",
            )
        }
    }
    return { host, port, tls, warnings }
}
