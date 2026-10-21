import assert from "node:assert/strict"
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

test("缺少 API key 时创建失败", () => {
    const saved = process.env["OPENAI_API_KEY"]
    delete process.env["OPENAI_API_KEY"]
    try {
        const result = OpenAIClient.create({ settings })
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
