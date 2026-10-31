/*
 * 测试用消费者插件：用 wellspring/api/plugin/http-client.ts 向 wellspring-http 注册服务器。
 * 只用于测试，不参与产品运行；行为由插件配置控制。
 */

import type { HttpRequest, HttpResponse, PluginApi } from "wellspring/api/host/index.ts"
import { eventBus, onShutdown } from "wellspring/api/host/index.ts"
import type { BusWebSocket } from "wellspring/api/plugin/http-client.ts"
import { registerHttpServer, type HttpServerBusHandle } from "wellspring/api/plugin/http-client.ts"

interface FixtureConfig {
    readonly name?: string
    readonly host?: string
    readonly port?: number
    readonly mode?: "normal" | "silent" | "no-register"
    readonly requestTimeoutMs?: number
    readonly registerTimeoutMs?: number
    readonly websocket?: boolean
}

let handle: HttpServerBusHandle | null = null
let config: FixtureConfig = {}

function json(status: number, data: unknown): HttpResponse {
    return {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(data),
    }
}

function text(status: number, body: string): HttpResponse {
    return { status, headers: { "content-type": "text/plain; charset=utf-8" }, body }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function base64Bytes(value: string): number {
    if (value === "") {
        return 0
    }
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
    return Math.floor((value.length * 3) / 4) - padding
}

async function route(request: HttpRequest): Promise<HttpResponse> {
    const url = new URL(request.url, "http://localhost")
    switch (url.pathname) {
        case "/hello":
            return json(200, { hello: true })
        case "/info":
            return json(200, {
                method: request.method,
                url: request.url,
                headers: request.headers,
                remoteAddress: request.remoteAddress,
                bodyBytes: base64Bytes(request.body),
            })
        case "/echo":
            return {
                status: 201,
                headers: {
                    "content-type": request.headers["content-type"] ?? "application/octet-stream",
                },
                body: request.body,
                bodyEncoding: "base64",
            }
        case "/delay": {
            const ms = Number(url.searchParams.get("ms") ?? "50")
            await delay(ms)
            return text(200, `delayed:${ms}`)
        }
        case "/hang":
            return await new Promise<HttpResponse>(() => undefined)
        case "/error":
            throw new Error("fixture boom")
        case "/big": {
            const size = Number(url.searchParams.get("size") ?? String(3 * 1024 * 1024))
            return text(200, "x".repeat(size))
        }
        case "/big-request":
            return json(200, { bodyBytes: base64Bytes(request.body) })
        default:
            return text(404, "not found")
    }
}

async function httpHandler(
    request: HttpRequest,
    stream: { write(chunk: string): void; end(): void },
): Promise<HttpResponse> {
    if (config.mode === "silent") {
        return await new Promise<HttpResponse>(() => undefined)
    }
    const url = new URL(request.url, "http://localhost")
    if (url.pathname === "/stream") {
        const count = Number(url.searchParams.get("count") ?? "3")
        for (let index = 0; index < count; index += 1) {
            stream.write(`chunk-${index};`)
        }
        stream.end()
        return {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
            stream: true,
            body: "",
        }
    }
    if (url.pathname === "/stream-async") {
        const count = Number(url.searchParams.get("count") ?? "3")
        let index = 0
        const tick = (): void => {
            if (index >= count) {
                stream.end()
                return
            }
            stream.write(`chunk-${index};`)
            index += 1
            setTimeout(tick, 5)
        }
        setTimeout(tick, 5)
        return {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
            stream: true,
            body: "",
        }
    }
    if (url.pathname === "/stream-pre") {
        // 返回 response 之前就写分片：helper 要缓冲到 response 发布之后
        stream.write("pre-0;")
        stream.write("pre-1;")
        stream.end()
        return {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
            stream: true,
            body: "",
        }
    }
    return await route(request)
}

function websocketHandler(socket: BusWebSocket): void {
    socket.onMessage((data: string) => {
        if (data === "close") {
            socket.close(1000, "bye")
            return
        }
        socket.send(`echo:${data}`)
    })
}

export function setup() {
    onShutdown(async () => {
        const current = handle
        handle = null
        await current?.close()
    })
    return {
        id: "http-consumer",
        name: "HTTP Consumer Fixture",
        version: "1.0.0",
        status: "ok" as const,
        deps: ["wellspring-http"],
        init: async (api: PluginApi) => {
            config = (api.pluginConfig ?? {}) as FixtureConfig
            if (config.mode === "no-register") {
                return
            }
            handle = await registerHttpServer(
                eventBus,
                {
                    name: config.name ?? "fixture-http",
                    host: config.host ?? "127.0.0.1",
                    port: config.port ?? 0,
                    ...(config.requestTimeoutMs === undefined
                        ? {}
                        : { requestTimeoutMs: config.requestTimeoutMs }),
                    ...(config.registerTimeoutMs === undefined
                        ? {}
                        : { registerTimeoutMs: config.registerTimeoutMs }),
                    ...(config.websocket === true ? { websocket: websocketHandler } : {}),
                },
                httpHandler,
            )
            api.output.info(`http-consumer listening on ${handle.host}:${handle.port}`)
        },
    }
}
