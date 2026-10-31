import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
    APIConnectionError,
    APIConnectionTimeoutError,
    APIError,
    APIUserAbortError,
    AuthenticationError,
    BadRequestError,
    InternalServerError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
} from "openai"

import type { OpenAISetting } from "../src/config/types.ts"
import {
    initOpenAIClient,
    getOpenAIClient,
    mapOpenAIError,
    OPENAI_CODES,
    OpenAIClient,
    resetOpenAIClient,
    type CreateOpenAIClientOptions,
} from "../src/network/openai.ts"

const settings: OpenAISetting = {
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    timeoutMs: 1000,
    maxRetries: 0,
}

type FetchImpl = NonNullable<CreateOpenAIClientOptions["fetch"]>

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    })
}

test("mapOpenAIError 归一化 SDK 异常", () => {
    assert.equal(mapOpenAIError(new APIUserAbortError()), OPENAI_CODES.aborted)
    assert.equal(mapOpenAIError(new APIConnectionTimeoutError()), OPENAI_CODES.timeout)
    assert.equal(mapOpenAIError(new APIConnectionError({})), OPENAI_CODES.connectionFailed)
    assert.equal(
        mapOpenAIError(new AuthenticationError(401, {}, "unauthorized", new Headers())),
        OPENAI_CODES.unauthorized,
    )
    assert.equal(
        mapOpenAIError(new PermissionDeniedError(403, {}, "forbidden", new Headers())),
        OPENAI_CODES.forbidden,
    )
    assert.equal(
        mapOpenAIError(new NotFoundError(404, {}, "not found", new Headers())),
        OPENAI_CODES.notFound,
    )
    assert.equal(
        mapOpenAIError(new RateLimitError(429, {}, "rate limited", new Headers())),
        OPENAI_CODES.rateLimited,
    )
    assert.equal(
        mapOpenAIError(new BadRequestError(400, {}, "bad request", new Headers())),
        OPENAI_CODES.badRequest,
    )
    assert.equal(
        mapOpenAIError(new InternalServerError(500, {}, "server error", new Headers())),
        OPENAI_CODES.serverError,
    )
    assert.equal(
        mapOpenAIError(new APIError(418, {}, "teapot", new Headers())),
        `${OPENAI_CODES.apiError}:418`,
    )
    assert.equal(mapOpenAIError(new Error("boom")), OPENAI_CODES.requestFailed)
})

test("chatStream 按推理强度发送 reasoning_effort，off 不发", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const sse =
        'data: {"id":"c1","object":"chat.completion.chunk","model":"test-model","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
        "data: [DONE]\n\n"
    const fetchImpl: FetchImpl = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const created = OpenAIClient.create({ apiKey: "test-key", settings, fetch: fetchImpl })
    const client = created.getData()
    assert.ok(client !== null)

    const high = await client.chatStream([{ role: "user", content: "hi" }], {
        model: "test-model",
        reasoning: "high",
    })
    assert.equal(high.isSuccess(), true)
    assert.equal(bodies[0]?.["reasoning_effort"], "high")

    const max = await client.chatStream([{ role: "user", content: "hi" }], {
        model: "test-model",
        reasoning: "max",
    })
    assert.equal(max.isSuccess(), true)
    assert.equal(bodies[1]?.["reasoning_effort"], "max")

    const off = await client.chatStream([{ role: "user", content: "hi" }], {
        model: "test-model",
        reasoning: "off",
    })
    assert.equal(off.isSuccess(), true)
    assert.equal("reasoning_effort" in (bodies[2] ?? {}), false)
})

test("chatStream 捕获 reasoning_content 并逐段回调", async () => {
    const sse =
        'data: {"id":"c1","object":"chat.completion.chunk","model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"先看"},"finish_reason":null}]}\n\n' +
        'data: {"id":"c1","object":"chat.completion.chunk","model":"test-model","choices":[{"index":0,"delta":{"reasoning_content":"再算"},"finish_reason":null}]}\n\n' +
        'data: {"id":"c1","object":"chat.completion.chunk","model":"test-model","choices":[{"index":0,"delta":{"content":"答案"},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n"
    const fetchImpl: FetchImpl = async () =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
    const client = OpenAIClient.create({ apiKey: "test-key", settings, fetch: fetchImpl }).getData()
    assert.ok(client !== null)

    const reasoning: string[] = []
    const result = await client.chatStream([{ role: "user", content: "hi" }], {
        model: "test-model",
        onReasoning: (text) => reasoning.push(text),
    })
    assert.equal(result.isSuccess(), true)
    const data = result.getData()
    assert.ok(data !== null)
    assert.equal(data.reasoning, "先看再算")
    assert.deepEqual(reasoning, ["先看", "再算"])
    assert.equal(data.reply.text, "答案")
    assert.equal(
        data.chunks.some(
            (record) => record.type === "chunk" && record.chunk["type"] === "reasoning-delta",
        ),
        true,
        "原始 chunk 里应记录 reasoning-delta",
    )
})

test("chatStream 兼容网关的 delta.reasoning 字段", async () => {
    const sse =
        'data: {"id":"c2","object":"chat.completion.chunk","model":"test-model","choices":[{"index":0,"delta":{"reasoning":"思考"},"finish_reason":null}]}\n\n' +
        'data: {"id":"c2","object":"chat.completion.chunk","model":"test-model","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n"
    const fetchImpl: FetchImpl = async () =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
    const client = OpenAIClient.create({ apiKey: "test-key", settings, fetch: fetchImpl }).getData()
    assert.ok(client !== null)
    const result = await client.chatStream([{ role: "user", content: "hi" }], {
        model: "test-model",
    })
    assert.equal(result.isSuccess(), true)
    assert.equal(result.getData()?.reasoning, "思考")
})

test("缺少 API key 时创建失败", () => {
    const saved = process.env["OPENAI_API_KEY"]
    delete process.env["OPENAI_API_KEY"]
    try {
        // 指定一个不存在的凭据文件，避免读到开发机上的真实 credentials.json
        const result = OpenAIClient.create({
            settings,
            credentialsFile: join(tmpdir(), "wellspring-missing-credentials.json"),
        })
        assert.equal(result.isSuccess(), false)
        assert.equal(result.getCode(), OPENAI_CODES.missingApiKey)
        assert.equal(result.getData(), null)
    } finally {
        if (saved !== undefined) {
            process.env["OPENAI_API_KEY"] = saved
        }
    }
})

test("respond 走 Responses API 并解析文本与用量", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = []
    const fetchImpl: FetchImpl = async (input, init) => {
        const headers = new Headers(init?.headers)
        requests.push({
            url: String(input),
            authorization: headers.get("authorization"),
            body: JSON.parse(String(init?.body)),
        })
        return jsonResponse({
            id: "resp_1",
            object: "response",
            model: "test-model",
            output: [
                {
                    type: "message",
                    id: "msg_1",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "hello", annotations: [] }],
                },
            ],
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        })
    }

    const created = OpenAIClient.create({ apiKey: "test-key", settings, fetch: fetchImpl })
    assert.equal(created.isSuccess(), true)
    const client = created.getData()
    assert.ok(client !== null)

    const result = await client.respond("hi", { instructions: "be nice" })
    assert.equal(result.isSuccess(), true)
    assert.deepEqual(result.getData(), {
        text: "hello",
        model: "test-model",
        id: "resp_1",
        inputTokens: 3,
        outputTokens: 2,
    })

    assert.equal(requests.length, 1)
    assert.ok(requests[0]?.url.endsWith("/responses"))
    assert.equal(requests[0]?.authorization, "Bearer test-key")
    const body = requests[0]?.body as Record<string, unknown>
    assert.equal(body["model"], "test-model")
    assert.equal(body["input"], "hi")
    assert.equal(body["instructions"], "be nice")
})

test("respond 空输出返回 emptyOutput", async () => {
    const fetchImpl: FetchImpl = async () =>
        jsonResponse({
            id: "resp_1",
            object: "response",
            model: "test-model",
            output: [],
        })

    const client = OpenAIClient.create({ apiKey: "test-key", settings, fetch: fetchImpl }).getData()
    assert.ok(client !== null)
    const result = await client.respond("hi")
    assert.equal(result.isSuccess(), false)
    assert.equal(result.getCode(), OPENAI_CODES.emptyOutput)
})

test("429 归一化为 rateLimited 错误码", async () => {
    const fetchImpl: FetchImpl = async () =>
        jsonResponse({ error: { message: "slow down", type: "rate_limit_error" } }, 429)

    const client = OpenAIClient.create({ apiKey: "test-key", settings, fetch: fetchImpl }).getData()
    assert.ok(client !== null)
    const result = await client.respond("hi")
    assert.equal(result.isSuccess(), false)
    assert.equal(result.getCode(), OPENAI_CODES.rateLimited)
})

test("chat 走 Chat Completions API", async () => {
    const fetchImpl: FetchImpl = async (input, init) => {
        assert.ok(String(input).endsWith("/chat/completions"))
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        assert.equal(body["model"], "test-model")
        return jsonResponse({
            id: "chatcmpl_1",
            object: "chat.completion",
            created: 0,
            model: "test-model",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: "pong" },
                    finish_reason: "stop",
                },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
    }

    const client = OpenAIClient.create({ apiKey: "test-key", settings, fetch: fetchImpl }).getData()
    assert.ok(client !== null)
    const result = await client.chat([{ role: "user", content: "ping" }])
    assert.equal(result.isSuccess(), true)
    assert.deepEqual(result.getData(), {
        text: "pong",
        model: "test-model",
        id: "chatcmpl_1",
        inputTokens: 1,
        outputTokens: 1,
    })
})

test("chat 解析缓存命中与推理 token", async () => {
    const fetchImpl: FetchImpl = async () =>
        jsonResponse({
            id: "chatcmpl_cache",
            object: "chat.completion",
            created: 0,
            model: "test-model",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: "pong" },
                    finish_reason: "stop",
                },
            ],
            usage: {
                prompt_tokens: 120,
                completion_tokens: 30,
                total_tokens: 150,
                prompt_tokens_details: { cached_tokens: 96 },
                completion_tokens_details: { reasoning_tokens: 12 },
            },
        })

    const client = OpenAIClient.create({ apiKey: "test-key", settings, fetch: fetchImpl }).getData()
    assert.ok(client !== null)
    const result = await client.chat([{ role: "user", content: "ping" }])
    assert.equal(result.isSuccess(), true)
    assert.deepEqual(result.getData(), {
        text: "pong",
        model: "test-model",
        id: "chatcmpl_cache",
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 96,
        reasoningTokens: 12,
    })
})

test("chatStream 解析 usage 里的缓存命中", async () => {
    const sse =
        'data: {"id":"c1","object":"chat.completion.chunk","model":"test-model","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
        'data: {"id":"c1","object":"chat.completion.chunk","model":"test-model","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,"prompt_cache_hit_tokens":80}}\n\n' +
        "data: [DONE]\n\n"
    const fetchImpl: FetchImpl = async () =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
    const client = OpenAIClient.create({ apiKey: "test-key", settings, fetch: fetchImpl }).getData()
    assert.ok(client !== null)

    const result = await client.chatStream([{ role: "user", content: "hi" }])
    assert.equal(result.isSuccess(), true)
    const data = result.getData()
    assert.ok(data !== null)
    assert.equal(data.reply.inputTokens, 100)
    assert.equal(data.reply.outputTokens, 5)
    assert.equal(data.reply.cacheReadTokens, 80)
    const usageChunk = data.chunks.find(
        (record) => record.type === "chunk" && record.chunk["type"] === "usage",
    )
    assert.deepEqual(
        (usageChunk?.chunk["usage"] as { cacheReadTokens?: number } | undefined)?.cacheReadTokens,
        80,
    )
})

test("chat 内容为空返回 emptyOutput", async () => {
    const fetchImpl: FetchImpl = async () =>
        jsonResponse({
            id: "chatcmpl_1",
            object: "chat.completion",
            created: 0,
            model: "test-model",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: null },
                    finish_reason: "stop",
                },
            ],
        })

    const client = OpenAIClient.create({ apiKey: "test-key", settings, fetch: fetchImpl }).getData()
    assert.ok(client !== null)
    const result = await client.chat([{ role: "user", content: "ping" }])
    assert.equal(result.isSuccess(), false)
    assert.equal(result.getCode(), OPENAI_CODES.emptyOutput)
})

test("全局客户端初始化与重置", () => {
    resetOpenAIClient()
    assert.throws(() => getOpenAIClient(), /尚未初始化/)

    const created = initOpenAIClient({ apiKey: "test-key", settings })
    assert.equal(created.isSuccess(), true)
    assert.equal(getOpenAIClient(), created.getData())

    const again = initOpenAIClient({ apiKey: "another-key", settings })
    assert.equal(again.getData(), created.getData())

    resetOpenAIClient()
    assert.throws(() => getOpenAIClient(), /尚未初始化/)
})
