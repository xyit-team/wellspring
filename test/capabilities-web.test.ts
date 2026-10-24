import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { createHostCapabilities } from "../src/plugin/capabilities.ts"

let root = ""
let server: Server | null = null
let baseUrl = ""
const requests: Array<{ path: string; authorization: string | null }> = []
const savedKey = process.env["OPENAI_API_KEY"]

function paths(): ResolvedPaths {
    return {
        configDir: join(root, "config"),
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        logDir: join(root, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
}

async function writeCredentials(apiKey: string): Promise<void> {
    await mkdir(join(root, "config"), { recursive: true })
    await writeFile(
        join(root, "config", "credentials.json"),
        JSON.stringify({ version: 1, openai: { apiKey } }),
        "utf8",
    )
}

function capabilities() {
    return createHostCapabilities({
        config: {
            ...DEFAULT_SETTINGS,
            openai: { ...DEFAULT_SETTINGS.openai, baseUrl },
        },
        paths: paths(),
        logger: pino({ level: "silent" }),
    })
}

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-capabilities-web-"))
    server = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
            const path = request.url ?? ""
            requests.push({
                path,
                authorization: request.headers.authorization ?? null,
            })
            response.statusCode = 200
            response.setHeader("content-type", "application/json")
            if (path.endsWith("/tools/search")) {
                response.end(
                    JSON.stringify({
                        results: [
                            {
                                title: "结果",
                                url: "https://example.com/a",
                                snippet: "摘要",
                                summary: "",
                                content: "",
                                site_name: "Example",
                                date: null,
                                authority: 1,
                            },
                        ],
                    }),
                )
                return
            }
            response.end(JSON.stringify({ title: "页面", content: "正文" }))
        })
    })
    await new Promise<void>((resolvePromise) => {
        server?.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const address = server.address()
    if (address === null || typeof address === "string") {
        throw new Error("测试服务器没有端口")
    }
    baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
    if (savedKey === undefined) delete process.env["OPENAI_API_KEY"]
    else process.env["OPENAI_API_KEY"] = savedKey
    await new Promise<void>((resolvePromise) => server?.close(() => resolvePromise()))
    await rm(root, { recursive: true, force: true })
})

test("web 能力：环境变量 Key 优先，搜索/抓取请求带 Authorization", async () => {
    process.env["OPENAI_API_KEY"] = "env-key"
    await rm(join(root, "config", "credentials.json"), { force: true })
    requests.length = 0
    const caps = capabilities()
    const results = await caps.webSearch("DeepSeek", 3)
    assert.equal(results.length, 1)
    assert.equal(results[0]?.url, "https://example.com/a")
    const page = await caps.webFetch("https://example.com/a")
    assert.equal(page.content, "正文")
    assert.deepEqual(
        requests.map((item) => [item.path, item.authorization]),
        [
            ["/v1/tools/search", "Bearer env-key"],
            ["/v1/tools/fetch", "Bearer env-key"],
        ],
    )
})

test("web 能力：没有环境变量时使用 credentials.json 里的 Key", async () => {
    delete process.env["OPENAI_API_KEY"]
    await writeCredentials("stored-key")
    requests.length = 0
    const caps = capabilities()
    const results = await caps.webSearch("DeepSeek")
    assert.equal(results.length, 1)
    await caps.webFetch("https://example.com/a")
    assert.deepEqual(
        requests.map((item) => item.authorization),
        ["Bearer stored-key", "Bearer stored-key"],
    )
})

test("web 能力：没有 Key 时明确报错，不再静默返回空结果", async () => {
    delete process.env["OPENAI_API_KEY"]
    await rm(join(root, "config", "credentials.json"), { force: true })
    requests.length = 0
    const caps = capabilities()
    await assert.rejects(
        () => caps.webSearch("DeepSeek"),
        (error: unknown) =>
            error instanceof Error &&
            /web\.missing-api-key/.test(error.message) &&
            /API Key/.test(error.message),
    )
    await assert.rejects(
        () => caps.webFetch("https://example.com/a"),
        (error: unknown) => error instanceof Error && /web\.missing-api-key/.test(error.message),
    )
    assert.equal(requests.length, 0, "缺 Key 时不应该发网络请求")
})
