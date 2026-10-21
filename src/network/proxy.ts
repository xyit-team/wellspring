/*
 * HTTP/HTTPS 代理。
 * 配置来自 app-setting.json 的 network.proxy；通过 undici 的 ProxyAgent 生成自定义 fetch。
 * 只支持 HTTP/HTTPS 代理，SOCKS5 后续再加。
 */

import { ProxyAgent, fetch as undiciFetch } from "undici"

import type { ProxySetting } from "../config/types.ts"

/** 从 fetch 入参中取绝对 URL；取不到时返回 null */
function toUrl(input: string | URL | Request): URL | null {
    if (typeof input === "string") {
        try {
            return new URL(input)
        } catch {
            return null
        }
    }
    if (input instanceof URL) {
        return input
    }
    try {
        return new URL(input.url)
    } catch {
        return null
    }
}

function normalizePattern(pattern: string): string {
    return pattern
        .trim()
        .toLowerCase()
        .replace(/^\*?\./, "")
}

/** 判断 URL 是否命中 noProxy。支持 `*`、`example.com`、`.example.com`、子域后缀 */
export function shouldBypassProxy(url: URL, noProxy: readonly string[]): boolean {
    const host = url.hostname.toLowerCase()
    for (const raw of noProxy) {
        const pattern = normalizePattern(raw)
        if (pattern === "") {
            continue
        }
        if (pattern === "*") {
            return true
        }
        if (host === pattern || host.endsWith(`.${pattern}`)) {
            return true
        }
    }
    return false
}

/**
 * 生成走代理的 fetch；proxy 为 null 时返回 undefined，调用方沿用全局 fetch。
 * OpenAI SDK 接受自定义 fetch，这里是唯一注入点。
 */
export function createProxyFetch(proxy: ProxySetting | null): typeof undiciFetch | undefined {
    if (proxy === null) {
        return undefined
    }

    const agent = new ProxyAgent({ uri: proxy.url })
    const proxyFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = toUrl(input)
        // 命中 noProxy 时用全局 fetch，避免代理自身不可达的主机被绕路
        if (url !== null && shouldBypassProxy(url, proxy.noProxy)) {
            return fetch(input as string, init as RequestInit) as Promise<Response>
        }
        return undiciFetch(
            input as never,
            {
                ...(init as Record<string, unknown>),
                dispatcher: agent,
            } as never,
        ) as Promise<Response>
    }
    return proxyFetch as unknown as typeof undiciFetch
}
