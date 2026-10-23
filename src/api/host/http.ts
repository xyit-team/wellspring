/*
 * 插件 HTTP 宿主能力。
 * 插件在 sandbox 内，宿主负责监听端口，请求通过 RPC 交给插件 handler。
 */

export interface HttpRequest {
    readonly method: string
    readonly url: string
    readonly headers: Record<string, string>
    /** base64 编码的请求体 */
    readonly body: string
    readonly remoteAddress: string | null
}

export interface HttpResponse {
    readonly status?: number
    readonly headers?: Record<string, string>
    /** utf8 或 base64；默认 utf8 */
    readonly body?: string
    readonly bodyEncoding?: "utf8" | "base64"
    /** true 时保持连接，后续通过 stream 写出 */
    readonly stream?: boolean
}

export interface HttpStreamContext {
    write(chunk: string): void
    end(): void
}

export type HttpHandler = (
    request: HttpRequest,
    stream: HttpStreamContext,
) => HttpResponse | Promise<HttpResponse>

export interface PluginWebSocket {
    readonly connectionId: string
    send(data: string): Promise<void>
    close(code?: number, reason?: string): Promise<void>
    onMessage(handler: (data: string) => void): void
    onClose(handler: (code: number, reason: string) => void): void
}

export type WebSocketHandler = (
    socket: PluginWebSocket,
    request: HttpRequest,
) => void | Promise<void>

export interface HttpTlsOptions {
    /** PEM 格式证书 */
    readonly cert: string
    /** PEM 格式私钥 */
    readonly key: string
    /** 可选 CA 链 */
    readonly ca?: string
}

export interface HttpServerOptions {
    /** 默认 127.0.0.1 */
    readonly host?: string
    /** 默认 0（随机端口） */
    readonly port?: number
    /** 提供时启动 HTTPS */
    readonly tls?: HttpTlsOptions
    /** 提供时启用 WebSocket */
    readonly websocket?: WebSocketHandler
}

export interface HttpServerHandle {
    readonly serverId: string
    readonly host: string
    readonly port: number
    close(): Promise<void>
}

export interface HostHttpApi {
    createServer(options: HttpServerOptions, handler: HttpHandler): Promise<HttpServerHandle>
}

export const HTTP_MAX_BODY_BYTES = 4 * 1024 * 1024
