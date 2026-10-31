/*
 * wellspring-http 的消费者侧客户端。
 *
 * 依赖 wellspring-http 插件的插件用它注册服务器：
 *
 *   const server = await registerHttpServer(eventBus, { name: "my-app", port: 8787 }, handler)
 *
 * helper 负责：订阅请求频道、发布注册请求、等待 ready/error、把每个请求派发给 handler、
 * 把 handler 的响应 / 流式分片 / WebSocket 消息发回 wellspring-http。
 * 使用者只需要处理 HttpRequest / HttpResponse，不需要关心事件总线细节。
 *
 * 注意：helper 与插件使用同一个 eventBus 实例（`wellspring/api/host` 导出的那个；
 * sandbox 内自动桥接到宿主事件总线，跨插件投递）。
 */

import type { EventBus } from "../host/events.ts"
import { EventEntity } from "../host/events.ts"
import type {
    HttpHandler,
    HttpRequest,
    HttpResponse,
    HttpStreamContext,
    HttpTlsOptions,
} from "../host/http.ts"
import {
    HTTP_BUS_MAX_BODY_BYTES,
    HTTP_BUS_REGISTER,
    HTTP_BUS_REGISTER_TIMEOUT_MS,
    HTTP_BUS_UNREGISTER,
    base64ByteLength,
    httpRequestChannel,
    httpResponseChannel,
    isValidHttpServerName,
    type HttpBusClientEvent,
    type HttpBusReadyEvent,
    type HttpBusRegisterRequest,
    type HttpBusServerEvent,
    type HttpBusUnregisterRequest,
} from "./http-protocol.ts"

export interface BusWebSocket {
    readonly connectionId: string
    send(data: string): void
    close(code?: number, reason?: string): void
    onMessage(handler: (data: string) => void): void
    onClose(handler: (code: number, reason: string) => void): void
}

export type BusWebSocketHandler = (
    socket: BusWebSocket,
    request: HttpRequest,
) => void | Promise<void>

export interface RegisterHttpServerOptions {
    /** 服务器名：请求/响应频道都用它做后缀，必须唯一且符合插件 id 规则 */
    readonly name: string
    /** 默认 127.0.0.1 */
    readonly host?: string
    /** 默认 0（随机端口） */
    readonly port?: number
    readonly tls?: HttpTlsOptions
    /** 启用 WebSocket 转发；提供时才会在升级请求上回调 */
    readonly websocket?: BusWebSocketHandler
    /** 单次请求等待上限，默认 120s */
    readonly requestTimeoutMs?: number
    /** 等待 wellspring-http 回 ready 的上限，默认 10s */
    readonly registerTimeoutMs?: number
    /** 启动成功后的运行期错误回调 */
    readonly onError?: (error: { readonly code: string; readonly message: string }) => void
}

export interface HttpServerBusHandle {
    readonly name: string
    readonly host: string
    readonly port: number
    readonly secure: boolean
    close(): Promise<void>
}

interface StreamState {
    readonly requestId: string
    published: boolean
    ended: boolean
    readonly buffered: string[]
    timer: ReturnType<typeof setTimeout> | null
}

interface SocketState {
    readonly connectionId: string
    readonly messageHandlers: Array<(data: string) => void>
    readonly closeHandlers: Array<(code: number, reason: string) => void>
    closed: boolean
}

interface ServerRuntime {
    readonly bus: EventBus
    readonly options: RegisterHttpServerOptions
    readonly handler: HttpHandler
    readonly requestChannel: string
    readonly responseChannel: string
    readonly streams: Map<string, StreamState>
    readonly sockets: Map<string, SocketState>
    readonly timeoutMs: number
    ready: boolean
    closed: boolean
    readyResolve?: (event: HttpBusReadyEvent) => void
    readyReject?: (error: Error) => void
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

function errorMessageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function responseBodyBytes(response: HttpResponse): number {
    const body = response.body
    if (body === undefined) {
        return 0
    }
    if (response.bodyEncoding === "base64") {
        return base64ByteLength(body)
    }
    return Buffer.byteLength(body, "utf8")
}

/**
 * 注册一个由 wellspring-http 托管的 HTTP(S) 服务器。
 * 返回的 handle 带真实 host/port（port 传 0 时由系统分配）。
 */
export async function registerHttpServer(
    bus: EventBus,
    options: RegisterHttpServerOptions,
    handler: HttpHandler,
): Promise<HttpServerBusHandle> {
    const name = options.name
    if (!isValidHttpServerName(name)) {
        throw new Error(`HTTP 服务器名不合法：${name}`)
    }
    if (options.host !== undefined && (options.host.trim() === "" || /\s/.test(options.host))) {
        throw new Error(`非法监听地址：${options.host}`)
    }
    if (
        options.port !== undefined &&
        (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)
    ) {
        throw new Error(`非法端口：${String(options.port)}`)
    }

    const runtime: ServerRuntime = {
        bus,
        options,
        handler,
        requestChannel: httpRequestChannel(name),
        responseChannel: httpResponseChannel(name),
        streams: new Map(),
        sockets: new Map(),
        timeoutMs:
            typeof options.requestTimeoutMs === "number" &&
            Number.isInteger(options.requestTimeoutMs) &&
            options.requestTimeoutMs > 0
                ? options.requestTimeoutMs
                : DEFAULT_REQUEST_TIMEOUT_MS,
        ready: false,
        closed: false,
    }

    const unsubscribe = bus.subscribe<HttpBusServerEvent>(runtime.requestChannel, (event) => {
        dispatch(runtime, event.getData())
    })

    const registerTimeoutMs =
        typeof options.registerTimeoutMs === "number" &&
        Number.isInteger(options.registerTimeoutMs) &&
        options.registerTimeoutMs > 0
            ? options.registerTimeoutMs
            : HTTP_BUS_REGISTER_TIMEOUT_MS
    const ready = new Promise<HttpBusReadyEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(
                new Error(
                    `wellspring-http 注册超时（${registerTimeoutMs}ms）：${name}；请确认 wellspring-http 插件已启用`,
                ),
            )
        }, registerTimeoutMs)
        timer.unref()
        runtime.readyResolve = (event) => {
            clearTimeout(timer)
            resolve(event)
        }
        runtime.readyReject = (error) => {
            clearTimeout(timer)
            reject(error)
        }
    })

    const request: HttpBusRegisterRequest = {
        name,
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.tls === undefined ? {} : { tls: options.tls }),
        ...(options.websocket === undefined ? {} : { websocket: true }),
        ...(options.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: options.requestTimeoutMs }),
    }
    bus.publish(HTTP_BUS_REGISTER, EventEntity.create(request))

    let started: HttpBusReadyEvent
    try {
        started = await ready
    } catch (error) {
        unsubscribe()
        throw error
    }
    runtime.ready = true

    return {
        name,
        host: started.host,
        port: started.port,
        secure: started.secure,
        close: async () => {
            if (runtime.closed) {
                return
            }
            runtime.closed = true
            const unregister: HttpBusUnregisterRequest = { name }
            bus.publish(HTTP_BUS_UNREGISTER, EventEntity.create(unregister))
            unsubscribe()
            for (const state of runtime.streams.values()) {
                if (state.timer !== null) {
                    clearTimeout(state.timer)
                }
            }
            runtime.streams.clear()
            runtime.sockets.clear()
        },
    }
}

function publishResponse(runtime: ServerRuntime, event: HttpBusClientEvent): void {
    runtime.bus.publish(runtime.responseChannel, EventEntity.create(event))
}

function dispatch(runtime: ServerRuntime, event: HttpBusServerEvent): void {
    switch (event.type) {
        case "ready":
            runtime.readyResolve?.(event)
            return
        case "error":
            if (!runtime.ready) {
                runtime.readyReject?.(new Error(`${event.code}: ${event.message}`))
            } else {
                runtime.options.onError?.({ code: event.code, message: event.message })
            }
            return
        case "stopped":
            return
        case "http-request":
            void runRequest(runtime, event.requestId, event.request)
            return
        case "http-abort": {
            const state = runtime.streams.get(event.requestId)
            if (state === undefined) {
                return
            }
            state.ended = true
            finishStream(runtime, state)
            return
        }
        case "websocket-open":
            void runSocket(runtime, event.connectionId, event.request)
            return
        case "websocket-message": {
            const socket = runtime.sockets.get(event.connectionId)
            if (socket === undefined || socket.closed) {
                return
            }
            for (const handler of socket.messageHandlers.slice()) {
                handler(event.data)
            }
            return
        }
        case "websocket-close": {
            const socket = runtime.sockets.get(event.connectionId)
            if (socket === undefined || socket.closed) {
                return
            }
            runtime.sockets.delete(event.connectionId)
            socket.closed = true
            for (const handler of socket.closeHandlers.slice()) {
                handler(event.code, event.reason)
            }
            return
        }
    }
}

async function runRequest(
    runtime: ServerRuntime,
    requestId: string,
    request: HttpRequest,
): Promise<void> {
    const name = runtime.options.name
    if (request.body !== "" && base64ByteLength(request.body) > HTTP_BUS_MAX_BODY_BYTES) {
        publishResponse(runtime, {
            type: "http-response",
            name,
            requestId,
            response: {
                status: 413,
                headers: { "content-type": "text/plain; charset=utf-8" },
                body: `请求体超过 wellspring-http 事件转发上限（${HTTP_BUS_MAX_BODY_BYTES} 字节）`,
            },
        })
        return
    }

    const state: StreamState = {
        requestId,
        published: false,
        ended: false,
        buffered: [],
        timer: null,
    }
    runtime.streams.set(requestId, state)
    const stream: HttpStreamContext = {
        write(chunk: string) {
            if (state.ended) {
                return
            }
            if (state.published) {
                publishResponse(runtime, { type: "http-chunk", name, requestId, chunk })
                touchStream(runtime, state)
            } else {
                state.buffered.push(chunk)
            }
        },
        end() {
            if (state.ended) {
                return
            }
            state.ended = true
            if (state.published) {
                publishResponse(runtime, { type: "http-end", name, requestId })
                finishStream(runtime, state)
            }
        },
    }

    let response: HttpResponse
    try {
        response = await runtime.handler(request, stream)
    } catch (error) {
        finishStream(runtime, state)
        publishResponse(runtime, {
            type: "http-response",
            name,
            requestId,
            response: {
                status: 500,
                headers: { "content-type": "text/plain; charset=utf-8" },
                body: errorMessageOf(error),
            },
        })
        return
    }

    const bytes = responseBodyBytes(response)
    if (bytes > HTTP_BUS_MAX_BODY_BYTES) {
        finishStream(runtime, state)
        runtime.options.onError?.({
            code: "response-too-large",
            message: `响应体 ${bytes} 字节超过事件转发上限 ${HTTP_BUS_MAX_BODY_BYTES}`,
        })
        publishResponse(runtime, {
            type: "http-response",
            name,
            requestId,
            response: {
                status: 502,
                headers: { "content-type": "text/plain; charset=utf-8" },
                body: "wellspring-http：响应体超过事件转发上限",
            },
        })
        return
    }

    if (response.stream !== true) {
        finishStream(runtime, state)
        publishResponse(runtime, { type: "http-response", name, requestId, response })
        return
    }

    state.published = true
    publishResponse(runtime, { type: "http-response", name, requestId, response })
    touchStream(runtime, state)
    for (const chunk of state.buffered.splice(0)) {
        publishResponse(runtime, { type: "http-chunk", name, requestId, chunk })
    }
    if (state.ended) {
        publishResponse(runtime, { type: "http-end", name, requestId })
        finishStream(runtime, state)
    }
}

/** 流式响应超过上限没有新分片就主动放弃，避免事件总线里留下永远挂着的请求 */
function touchStream(runtime: ServerRuntime, state: StreamState): void {
    if (state.timer !== null) {
        clearTimeout(state.timer)
    }
    state.timer = setTimeout(() => {
        if (state.ended) {
            return
        }
        state.ended = true
        publishResponse(runtime, {
            type: "http-abort",
            name: runtime.options.name,
            requestId: state.requestId,
            message: "流式响应超时",
        })
        finishStream(runtime, state)
    }, runtime.timeoutMs)
    state.timer.unref()
}

function finishStream(runtime: ServerRuntime, state: StreamState): void {
    if (state.timer !== null) {
        clearTimeout(state.timer)
        state.timer = null
    }
    runtime.streams.delete(state.requestId)
}

async function runSocket(
    runtime: ServerRuntime,
    connectionId: string,
    request: HttpRequest,
): Promise<void> {
    const name = runtime.options.name
    const handler = runtime.options.websocket
    if (handler === undefined) {
        publishResponse(runtime, {
            type: "websocket-reject",
            name,
            connectionId,
            code: 1008,
            message: "插件没有注册 WebSocket 处理函数",
        })
        return
    }

    const socketState: SocketState = {
        connectionId,
        messageHandlers: [],
        closeHandlers: [],
        closed: false,
    }
    runtime.sockets.set(connectionId, socketState)
    const socket: BusWebSocket = {
        connectionId,
        send(data: string) {
            if (socketState.closed) {
                return
            }
            publishResponse(runtime, { type: "websocket-send", name, connectionId, data })
        },
        close(code = 1000, reason = "") {
            if (socketState.closed) {
                return
            }
            socketState.closed = true
            runtime.sockets.delete(connectionId)
            publishResponse(runtime, { type: "websocket-close", name, connectionId, code, reason })
        },
        onMessage(handler) {
            socketState.messageHandlers.push(handler)
        },
        onClose(handler) {
            socketState.closeHandlers.push(handler)
        },
    }
    publishResponse(runtime, { type: "websocket-accept", name, connectionId })
    try {
        await handler(socket, request)
    } catch (error) {
        runtime.options.onError?.({ code: "websocket-handler", message: errorMessageOf(error) })
        socket.close(1011, "handler error")
    }
}
