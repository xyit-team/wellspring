/*
 * wellspring-http：平台里唯一持有 hostApi.http 的插件。
 *
 * 其它插件通过事件总线把「要监听的地址」交给这里；它负责：
 *   - 校验注册参数、避免重名与端口冲突
 *   - 真正创建 HTTP / HTTPS 服务器（含 WebSocket 升级）
 *   - 把请求转发到 `wellspring-http:request:<name>`，把响应/流式分片写回宿主的连接
 *   - 注销、插件关闭时统一释放端口
 *
 * 协议定义在 `wellspring/api/plugin/http-protocol.ts`，消费者侧 helper 在
 * `wellspring/api/plugin/http-client.ts`。
 */

import type {
    HttpRequest,
    HttpResponse,
    HttpServerHandle,
    HttpStreamContext,
    PluginWebSocket,
    PluginApi,
} from "wellspring/api/host/index.ts"
import { EventEntity, eventBus, onShutdown } from "wellspring/api/host/index.ts"
import type {
    HttpBusClientEvent,
    HttpBusErrorEvent,
    HttpBusRegisterRequest,
    HttpBusServerEvent,
    HttpBusServerInfo,
    HttpBusUnregisterRequest,
} from "wellspring/api/plugin/http-protocol.ts"
import {
    HTTP_BUS_MAX_BODY_BYTES,
    HTTP_BUS_REGISTER,
    HTTP_BUS_SERVERS,
    HTTP_BUS_UNREGISTER,
    HTTP_BUS_WEBSOCKET_ACCEPT_TIMEOUT_MS,
    base64ByteLength,
    httpRequestChannel,
    httpResponseChannel,
    isValidHttpServerName,
} from "wellspring/api/plugin/http-protocol.ts"

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

interface PendingRequest {
    readonly resolve: (response: HttpResponse) => void
    /** 宿主侧的真实流；响应是 stream:true 时才往这里写分片 */
    readonly hostStream: HttpStreamContext
    started: boolean
    ended: boolean
    readonly buffered: string[]
    timer: ReturnType<typeof setTimeout>
}

interface WebSocketConnection {
    readonly socket: PluginWebSocket
    accepted: boolean
    readonly timer: ReturnType<typeof setTimeout>
}

interface ServerEntry {
    readonly name: string
    host: string
    port: number
    readonly secure: boolean
    readonly websocket: boolean
    readonly requestTimeoutMs: number
    readonly pending: Map<string, PendingRequest>
    readonly connections: Map<string, WebSocketConnection>
    handle: HttpServerHandle
    responseUnsubscribe: () => void
    closing: boolean
}

let api: PluginApi | null = null
const servers = new Map<string, ServerEntry>()
const subscriptions: Array<() => void> = []

function logger(): PluginApi["logger"] | null {
    return api?.logger ?? null
}

function errorMessageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function textResponse(status: number, body: string): HttpResponse {
    return {
        status,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body,
    }
}

function publishRequestEvent(name: string, event: HttpBusServerEvent): void {
    eventBus.publish(httpRequestChannel(name), EventEntity.create(event))
}

function publishResponseEvent(name: string, event: HttpBusClientEvent): void {
    eventBus.publish(httpResponseChannel(name), EventEntity.create(event))
}

function publishError(name: string, code: string, message: string): void {
    const event: HttpBusErrorEvent = { type: "error", name, code, message }
    publishRequestEvent(name, event)
    logger()?.warn({ name, code }, message)
}

function publishStopped(name: string): void {
    publishRequestEvent(name, { type: "stopped", name })
}

function publishServerList(): void {
    const infos: HttpBusServerInfo[] = [...servers.values()].map((entry) => ({
        name: entry.name,
        host: entry.host,
        port: entry.port,
        secure: entry.secure,
        websocket: entry.websocket,
    }))
    eventBus.publish(HTTP_BUS_SERVERS, EventEntity.create({ servers: infos }))
}

/** 把 createServer 的原始异常映射成稳定的 code，方便消费者分支处理 */
function listenErrorCode(error: unknown): string {
    const message = errorMessageOf(error)
    if (message.includes("EADDRINUSE")) {
        return "port-in-use"
    }
    if (message.includes("EACCES")) {
        return "permission-denied"
    }
    if (message.includes("EADDRNOTAVAIL") || message.includes("ENOTFOUND")) {
        return "address-unavailable"
    }
    return "listen-failed"
}

function parseRegisterRequest(data: unknown): HttpBusRegisterRequest | string {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return "注册负载必须是对象"
    }
    const input = data as Record<string, unknown>
    const name = input["name"]
    if (typeof name !== "string" || !isValidHttpServerName(name)) {
        return `服务器名不合法：${String(name)}`
    }
    const host = input["host"]
    if (host !== undefined && (typeof host !== "string" || host.trim() === "" || /\s/.test(host))) {
        return `非法监听地址：${String(host)}`
    }
    const port = input["port"]
    if (
        port !== undefined &&
        (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535)
    ) {
        return `非法端口：${String(port)}`
    }
    const tls = input["tls"]
    if (tls !== undefined) {
        if (typeof tls !== "object" || tls === null || Array.isArray(tls)) {
            return "TLS 配置必须是对象"
        }
        const record = tls as Record<string, unknown>
        if (
            typeof record["cert"] !== "string" ||
            record["cert"].trim() === "" ||
            typeof record["key"] !== "string" ||
            record["key"].trim() === ""
        ) {
            return "TLS 需要 cert 与 key PEM"
        }
        if (record["ca"] !== undefined && typeof record["ca"] !== "string") {
            return "TLS ca 必须是 PEM 字符串"
        }
    }
    const websocket = input["websocket"]
    if (websocket !== undefined && typeof websocket !== "boolean") {
        return "websocket 必须是布尔值"
    }
    const timeout = input["requestTimeoutMs"]
    if (
        timeout !== undefined &&
        (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0)
    ) {
        return "requestTimeoutMs 必须是正整数"
    }
    return input as unknown as HttpBusRegisterRequest
}

function makeHttpHandler(entry: ServerEntry) {
    return (request: HttpRequest, stream: HttpStreamContext): Promise<HttpResponse> => {
        if (request.body !== "" && base64ByteLength(request.body) > HTTP_BUS_MAX_BODY_BYTES) {
            return Promise.resolve(
                textResponse(
                    413,
                    `请求体超过 wellspring-http 事件转发上限（${HTTP_BUS_MAX_BODY_BYTES} 字节）`,
                ),
            )
        }
        return new Promise<HttpResponse>((resolve) => {
            const requestId = `${entry.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
            const pending: PendingRequest = {
                resolve,
                hostStream: stream,
                started: false,
                ended: false,
                buffered: [],
                timer: setTimeout(() => {
                    if (!entry.pending.delete(requestId)) {
                        return
                    }
                    publishRequestEvent(entry.name, {
                        type: "http-abort",
                        name: entry.name,
                        requestId,
                        message: "请求超时",
                    })
                    resolve(textResponse(504, "wellspring-http：处理请求超时"))
                }, entry.requestTimeoutMs),
            }
            pending.timer.unref()
            entry.pending.set(requestId, pending)
            publishRequestEvent(entry.name, {
                type: "http-request",
                name: entry.name,
                requestId,
                request,
            })
        })
    }
}

function makeWebSocketHandler(entry: ServerEntry) {
    return (socket: PluginWebSocket, request: HttpRequest): void => {
        const connectionId = socket.connectionId
        const timer = setTimeout(() => {
            const connection = entry.connections.get(connectionId)
            if (connection !== undefined && !connection.accepted) {
                entry.connections.delete(connectionId)
                void socket
                    .close(1008, "wellspring-http：没有处理函数接管连接")
                    .catch(() => undefined)
            }
        }, HTTP_BUS_WEBSOCKET_ACCEPT_TIMEOUT_MS)
        timer.unref()
        entry.connections.set(connectionId, { socket, accepted: false, timer })
        socket.onMessage((data) => {
            if (!entry.connections.has(connectionId)) {
                return
            }
            publishRequestEvent(entry.name, {
                type: "websocket-message",
                name: entry.name,
                connectionId,
                data,
            })
        })
        socket.onClose((code, reason) => {
            const connection = entry.connections.get(connectionId)
            if (connection === undefined) {
                return
            }
            entry.connections.delete(connectionId)
            clearTimeout(connection.timer)
            publishRequestEvent(entry.name, {
                type: "websocket-close",
                name: entry.name,
                connectionId,
                code,
                reason,
            })
        })
        publishRequestEvent(entry.name, {
            type: "websocket-open",
            name: entry.name,
            connectionId,
            request,
        })
    }
}

function closeWebSocketConnections(entry: ServerEntry): void {
    for (const [connectionId, connection] of [...entry.connections]) {
        entry.connections.delete(connectionId)
        clearTimeout(connection.timer)
        void connection.socket.close(1001, "服务器已关闭").catch(() => undefined)
    }
}

function rejectPending(entry: ServerEntry): void {
    for (const pending of [...entry.pending.values()]) {
        clearTimeout(pending.timer)
        pending.resolve(textResponse(503, "wellspring-http：服务器已关闭"))
    }
    entry.pending.clear()
}

async function handleRegister(data: unknown): Promise<void> {
    const parsed = parseRegisterRequest(data)
    if (typeof parsed === "string") {
        const name =
            typeof data === "object" && data !== null
                ? String((data as Record<string, unknown>)["name"] ?? "")
                : ""
        if (isValidHttpServerName(name)) {
            publishError(name, "invalid-register", parsed)
        } else {
            logger()?.warn({ error: parsed }, "wellspring-http 收到非法注册请求")
        }
        return
    }
    const request = parsed
    const name = request.name
    if (servers.has(name)) {
        publishError(name, "duplicate-name", `服务器名已被占用：${name}`)
        return
    }
    const host = request.host ?? "127.0.0.1"
    const port = request.port ?? 0
    const tls = request.tls
    const websocket = request.websocket === true
    const requestTimeoutMs = request.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const responseUnsubscribe = eventBus.subscribe<HttpBusClientEvent>(
        httpResponseChannel(name),
        (event) => handleClientEvent(name, event.getData()),
    )
    const entry: ServerEntry = {
        name,
        host,
        port,
        secure: tls !== undefined,
        websocket,
        requestTimeoutMs,
        pending: new Map(),
        connections: new Map(),
        handle: null as unknown as HttpServerHandle,
        responseUnsubscribe,
        closing: false,
    }
    try {
        const handle = await (api as PluginApi).http.createServer(
            {
                host,
                port,
                ...(tls === undefined ? {} : { tls }),
                ...(websocket ? { websocket: makeWebSocketHandler(entry) } : {}),
            },
            makeHttpHandler(entry),
        )
        entry.handle = handle
        entry.host = handle.host
        entry.port = handle.port
        servers.set(name, entry)
        logger()?.info(
            { name, host: handle.host, port: handle.port },
            "wellspring-http 服务器已启动",
        )
        publishRequestEvent(name, {
            type: "ready",
            name,
            host: handle.host,
            port: handle.port,
            secure: entry.secure,
        })
        publishServerList()
    } catch (error) {
        responseUnsubscribe()
        publishError(name, listenErrorCode(error), `监听失败：${errorMessageOf(error)}`)
    }
}

async function handleUnregister(data: unknown): Promise<void> {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return
    }
    const request = data as HttpBusUnregisterRequest
    const name = typeof request.name === "string" ? request.name : ""
    const entry = servers.get(name)
    if (entry === undefined) {
        return
    }
    entry.closing = true
    servers.delete(name)
    entry.responseUnsubscribe()
    rejectPending(entry)
    closeWebSocketConnections(entry)
    try {
        await entry.handle.close()
    } catch (error) {
        logger()?.warn({ name, error: errorMessageOf(error) }, "wellspring-http 关闭服务器失败")
    }
    logger()?.info({ name }, "wellspring-http 服务器已关闭")
    publishStopped(name)
    publishServerList()
}

function sanitizeResponse(value: unknown): HttpResponse {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return textResponse(500, "wellspring-http：响应格式不合法")
    }
    const input = value as Record<string, unknown>
    const status = input["status"]
    const headers: Record<string, string> = {}
    if (typeof input["headers"] === "object" && input["headers"] !== null) {
        for (const [key, headerValue] of Object.entries(
            input["headers"] as Record<string, unknown>,
        )) {
            if (typeof headerValue === "string") {
                headers[key] = headerValue
            }
        }
    }
    const body = typeof input["body"] === "string" ? input["body"] : undefined
    const bodyEncoding = input["bodyEncoding"] === "base64" ? "base64" : "utf8"
    const bytes =
        body === undefined
            ? 0
            : bodyEncoding === "base64"
              ? base64ByteLength(body)
              : Buffer.byteLength(body, "utf8")
    if (bytes > HTTP_BUS_MAX_BODY_BYTES) {
        return textResponse(502, "wellspring-http：响应体超过事件转发上限")
    }
    return {
        status:
            typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
                ? status
                : 200,
        headers,
        ...(body === undefined ? {} : { body, bodyEncoding }),
        ...(input["stream"] === true ? { stream: true } : {}),
    }
}

function writePendingChunk(pending: PendingRequest, chunk: string): void {
    try {
        pending.hostStream.write(chunk)
    } catch {
        /* 客户端可能已断开 */
    }
}

function endPendingStream(pending: PendingRequest): void {
    try {
        pending.hostStream.end()
    } catch {
        /* 客户端可能已断开 */
    }
}

function flushPendingStream(pending: PendingRequest): void {
    for (const chunk of pending.buffered.splice(0)) {
        writePendingChunk(pending, chunk)
    }
    if (pending.ended) {
        endPendingStream(pending)
    }
}

function handleClientEvent(name: string, event: HttpBusClientEvent): void {
    const entry = servers.get(name)
    if (entry === undefined || entry.closing) {
        return
    }
    if (typeof event !== "object" || event === null) {
        return
    }
    switch (event.type) {
        case "http-response": {
            const pending = entry.pending.get(event.requestId)
            if (pending === undefined || pending.started) {
                return
            }
            clearTimeout(pending.timer)
            const response = sanitizeResponse(event.response)
            if (response.stream === true) {
                pending.started = true
                pending.resolve(response)
                flushPendingStream(pending)
                if (pending.ended) {
                    entry.pending.delete(event.requestId)
                }
                return
            }
            entry.pending.delete(event.requestId)
            pending.resolve(response)
            return
        }
        case "http-chunk": {
            const pending = entry.pending.get(event.requestId)
            if (pending === undefined) {
                return
            }
            if (!pending.started) {
                pending.buffered.push(event.chunk)
                return
            }
            writePendingChunk(pending, event.chunk)
            return
        }
        case "http-end": {
            const pending = entry.pending.get(event.requestId)
            if (pending === undefined) {
                return
            }
            if (!pending.started) {
                pending.ended = true
                return
            }
            entry.pending.delete(event.requestId)
            endPendingStream(pending)
            return
        }
        case "http-abort": {
            const pending = entry.pending.get(event.requestId)
            if (pending === undefined) {
                return
            }
            entry.pending.delete(event.requestId)
            clearTimeout(pending.timer)
            pending.resolve(textResponse(502, event.message ?? "wellspring-http：请求被放弃"))
            return
        }
        case "websocket-accept": {
            const connection = entry.connections.get(event.connectionId)
            if (connection === undefined) {
                return
            }
            connection.accepted = true
            clearTimeout(connection.timer)
            return
        }
        case "websocket-reject": {
            const connection = entry.connections.get(event.connectionId)
            if (connection === undefined) {
                return
            }
            entry.connections.delete(event.connectionId)
            clearTimeout(connection.timer)
            void connection.socket
                .close(event.code ?? 1008, event.message ?? "连接被拒绝")
                .catch(() => undefined)
            return
        }
        case "websocket-send": {
            const connection = entry.connections.get(event.connectionId)
            if (connection === undefined) {
                return
            }
            void connection.socket.send(event.data).catch(() => {
                entry.connections.delete(event.connectionId)
            })
            return
        }
        case "websocket-close": {
            const connection = entry.connections.get(event.connectionId)
            if (connection === undefined) {
                return
            }
            entry.connections.delete(event.connectionId)
            clearTimeout(connection.timer)
            void connection.socket
                .close(event.code ?? 1000, event.reason ?? "")
                .catch(() => undefined)
            return
        }
    }
}

/** 当前托管中的服务器（诊断/命令用） */
export function listHttpServers(): HttpBusServerInfo[] {
    return [...servers.values()].map((entry) => ({
        name: entry.name,
        host: entry.host,
        port: entry.port,
        secure: entry.secure,
        websocket: entry.websocket,
    }))
}

export async function configureHttpBus(current: PluginApi): Promise<void> {
    api = current
    subscriptions.push(
        eventBus.subscribe<HttpBusRegisterRequest>(HTTP_BUS_REGISTER, (event) => {
            void handleRegister(event.getData()).catch((error) => {
                const name =
                    typeof event.getData() === "object" && event.getData() !== null
                        ? String(
                              (event.getData() as unknown as Record<string, unknown>)["name"] ?? "",
                          )
                        : ""
                if (isValidHttpServerName(name)) {
                    publishError(name, "internal-error", errorMessageOf(error))
                }
                logger()?.error({ error: errorMessageOf(error) }, "wellspring-http 注册失败")
            })
        }),
        eventBus.subscribe<HttpBusUnregisterRequest>(HTTP_BUS_UNREGISTER, (event) => {
            void handleUnregister(event.getData()).catch((error) => {
                logger()?.error({ error: errorMessageOf(error) }, "wellspring-http 注销失败")
            })
        }),
    )
    onShutdown(async () => {
        for (const subscription of subscriptions.splice(0)) {
            subscription()
        }
        for (const entry of [...servers.values()]) {
            await handleUnregister({ name: entry.name })
        }
        api = null
    })
    logger()?.info("wellspring-http 已就绪：统一管理平台内的 HTTP/HTTPS 服务器")
}
