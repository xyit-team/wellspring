import assert from "node:assert/strict"
import { test } from "node:test"

import { WEB_CODES, createDeepSeekWebClient } from "../src/network/web.ts"

interface Captured {
    url: string
    body: unknown
    authorization: string | null
}

function fakeFetch(captured: Captured[], response: unknown, status = 200): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        captured.push({
            url: String(input),
            body: JSON.parse(String(init?.body ?? "{}")),
            authorization: new Headers(init?.headers).get("authorization"),
        })
        return new Response(JSON.stringify(response), {
            status,
            headers: { "content-type": "application/json" },
        })
    }) as typeof fetch
}

test("DeepSeek search 请求与解析", async () => {
    const captured: Captured[] = []
    const client = createDeepSeekWebClient({
        baseUrl: "https://api.deepseek.com",
        apiKey: "key",
        fetch: fakeFetch(captured, {
            results: [
                {
                    title: "标题",
                    url: "https://example.com/a",
                    snippet: "摘要",
                    summary: "长摘要",
                    content: "",
                    site_name: "Example",
                    date: "2026-01-01T00:00:00+00:00",
                    authority: 3,
                },
            ],
        }),
    })
    const result = await client.search("DeepSeek V4", 3)
    assert.equal(result.isSuccess(), true)
    assert.deepEqual(result.getData(), [
        {
            title: "标题",
            url: "https://example.com/a",
            snippet: "摘要",
            summary: "长摘要",
            content: "",
            siteName: "Example",
            date: "2026-01-01T00:00:00+00:00",
            authority: 3,
        },
    ])
    assert.equal(captured[0]?.url, "https://api.deepseek.com/v1/tools/search")
    assert.equal(captured[0]?.authorization, "Bearer key")
    assert.deepEqual(captured[0]?.body, { query: "DeepSeek V4", count: 3, need_content: false })
})

test("DeepSeek fetch 请求与 URL 校验", async () => {
    const captured: Captured[] = []
    const client = createDeepSeekWebClient({
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "key",
        fetch: fakeFetch(captured, { title: "页面", content: "# 正文" }),
    })
    const fetched = await client.fetch("https://example.com/a")
    assert.equal(fetched.isSuccess(), true)
    assert.deepEqual(fetched.getData(), { title: "页面", content: "# 正文" })
    assert.equal(captured[0]?.url, "https://api.deepseek.com/v1/tools/fetch")
    assert.deepEqual(captured[0]?.body, { url: "https://example.com/a" })

    const invalid = await client.fetch("file:///etc/passwd")
    assert.equal(invalid.getCode(), WEB_CODES.invalidUrl)
})

test("DeepSeek web 错误映射", async () => {
    const noKey = createDeepSeekWebClient({
        baseUrl: "https://api.deepseek.com",
        apiKey: "",
    })
    assert.equal((await noKey.search("x")).getCode(), WEB_CODES.missingApiKey)

    const httpError = createDeepSeekWebClient({
        baseUrl: "https://api.deepseek.com",
        apiKey: "key",
        fetch: fakeFetch([], { error: { message: "bad" } }, 429),
    })
    assert.equal((await httpError.search("x")).getCode(), "web.http-429")
})

test("web 请求对 5xx 重试一次", async () => {
    let calls = 0
    const fetchImpl = (async () => {
        calls += 1
        if (calls === 1) {
            return new Response("{}", { status: 504 })
        }
        return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
        })
    }) as typeof fetch
    const client = createDeepSeekWebClient({
        baseUrl: "https://api.deepseek.com",
        apiKey: "key",
        fetch: fetchImpl,
        timeoutMs: 1000,
    })
    const result = await client.search("x")
    assert.equal(result.isSuccess(), true)
    assert.equal(calls, 2)
})

test("web Markdown 转义清理", async () => {
    const client = createDeepSeekWebClient({
        baseUrl: "https://api.deepseek.com",
        apiKey: "key",
        fetch: fakeFetch([], {
            title: "\\# 标题",
            content: "\\# 标题\\: 值\\(x\\)",
        }),
    })
    const result = await client.fetch("https://example.com/a")
    assert.equal(result.isSuccess(), true)
    assert.deepEqual(result.getData(), { title: "# 标题", content: "# 标题: 值(x)" })
})
