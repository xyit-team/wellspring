/*
 * DeepSeek 网页搜索与抓取 API
 *
 * Search POST /v1/tools/search
 * Fetch  POST /v1/tools/fetch
 */

import { Result } from "../api/result/result.ts"
import { readEnv } from "../platform/os.ts"

export const WEB_CODES = {
    missingApiKey: "web.missing-api-key",
    invalidUrl: "web.invalid-url",
    requestFailed: "web.request-failed",
    searchFailed: "web.search-failed",
    fetchFailed: "web.fetch-failed",
    unsupported: "web.unsupported-provider",
} as const

export interface WebSearchResult {
    readonly title: string
    readonly url: string
    readonly snippet: string
    readonly summary: string
    readonly content: string
    readonly siteName: string | null
    readonly date: string | null
    readonly authority: number
}

export interface WebFetchResult {
    readonly title: string
    readonly content: string
}

export interface WebClient {
    search(query: string, count?: number): Promise<Result<readonly WebSearchResult[]>>
    fetch(url: string): Promise<Result<WebFetchResult>>
}

export interface WebClientOptions {
    readonly baseUrl?: string | null
    readonly apiKey?: string
    readonly fetch?: typeof fetch
    readonly timeoutMs?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function endpoint(baseUrl: string | null | undefined, path: string): string | null {
    const base = (baseUrl ?? "https://api.deepseek.com").trim().replace(/\/+$/, "")
    if (base === "") {
        return null
    }
    const normalized = base.endsWith("/v1") ? base.slice(0, -3) : base
    try {
        return new URL(`${normalized}/v1/tools/${path}`).toString()
    } catch {
        return null
    }
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504])

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postJson(
    url: string,
    apiKey: string,
    body: unknown,
    fetchImpl: typeof fetch,
    timeoutMs: number,
): Promise<Result<unknown>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const response = await fetchImpl(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            })
            if (!response.ok) {
                const code = `web.http-${response.status}`
                if (RETRY_STATUSES.has(response.status) && attempt === 0) {
                    await sleep(300)
                    continue
                }
                return Result.error<unknown>(code)
            }
            return Result.successWithData<unknown>(await response.json())
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const code = `${WEB_CODES.requestFailed}:${message}`
            if (attempt === 0) {
                await sleep(300)
                continue
            }
            return Result.error<unknown>(code)
        }
    }
    return Result.error<unknown>(WEB_CODES.requestFailed)
}

// Markdown 转义清理：DeepSeek Fetch 会把所有 ASCII 标点转义成 `\.` / `\(` 之类
const MARKDOWN_ESCAPES = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g

function unescapeMarkdown(text: string): string {
    return text.replace(MARKDOWN_ESCAPES, "$1")
}

function parseSearchResult(value: unknown): WebSearchResult | null {
    if (!isObject(value) || typeof value["url"] !== "string") {
        return null
    }
    return {
        title: unescapeMarkdown(typeof value["title"] === "string" ? value["title"] : ""),
        url: value["url"],
        snippet: unescapeMarkdown(typeof value["snippet"] === "string" ? value["snippet"] : ""),
        summary: unescapeMarkdown(typeof value["summary"] === "string" ? value["summary"] : ""),
        content: unescapeMarkdown(typeof value["content"] === "string" ? value["content"] : ""),
        siteName: typeof value["site_name"] === "string" ? value["site_name"] : null,
        date: typeof value["date"] === "string" ? value["date"] : null,
        authority: typeof value["authority"] === "number" ? value["authority"] : -1,
    }
}

// HTTP/HTTPS 校验
function validUrl(value: string): boolean {
    try {
        const url = new URL(value)
        return (url.protocol === "http:" || url.protocol === "https:") && url.host !== ""
    } catch {
        return false
    }
}

export function createDeepSeekWebClient(options: WebClientOptions = {}): WebClient {
    const apiKey = options.apiKey ?? readEnv("OPENAI_API_KEY") ?? ""
    const fetchImpl = options.fetch ?? fetch
    const timeoutMs = options.timeoutMs ?? 60_000

    return {
        async search(query, count = 5) {
            if (apiKey === "") {
                return Result.error<readonly WebSearchResult[]>(WEB_CODES.missingApiKey)
            }
            const url = endpoint(options.baseUrl, "search")
            if (url === null) {
                return Result.error<readonly WebSearchResult[]>(WEB_CODES.unsupported)
            }
            const response = await postJson(
                url,
                apiKey,
                { query, count: Math.max(1, Math.min(50, count)), need_content: false },
                fetchImpl,
                timeoutMs,
            )
            if (!response.isSuccess()) {
                return Result.error<readonly WebSearchResult[]>(
                    response.getCode() ?? WEB_CODES.searchFailed,
                )
            }
            const data = response.getData()
            const results = isObject(data) ? data["results"] : undefined
            if (!Array.isArray(results)) {
                return Result.error<readonly WebSearchResult[]>(WEB_CODES.searchFailed)
            }
            return Result.successWithData<readonly WebSearchResult[]>(
                results
                    .map(parseSearchResult)
                    .filter((item): item is WebSearchResult => item !== null),
            )
        },

        async fetch(targetUrl) {
            if (apiKey === "") {
                return Result.error<WebFetchResult>(WEB_CODES.missingApiKey)
            }
            if (!validUrl(targetUrl)) {
                return Result.error<WebFetchResult>(WEB_CODES.invalidUrl)
            }
            const url = endpoint(options.baseUrl, "fetch")
            if (url === null) {
                return Result.error<WebFetchResult>(WEB_CODES.unsupported)
            }
            const response = await postJson(url, apiKey, { url: targetUrl }, fetchImpl, timeoutMs)
            if (!response.isSuccess()) {
                return Result.error<WebFetchResult>(response.getCode() ?? WEB_CODES.fetchFailed)
            }
            const data = response.getData()
            if (!isObject(data) || typeof data["content"] !== "string") {
                return Result.error<WebFetchResult>(WEB_CODES.fetchFailed)
            }
            return Result.successWithData<WebFetchResult>({
                title: unescapeMarkdown(typeof data["title"] === "string" ? data["title"] : ""),
                content: unescapeMarkdown(data["content"]),
            })
        },
    }
}
