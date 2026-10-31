/*
 * wellspring-http 事件协议（插件 ↔ 插件）。
 *
 * 平台里只有 wellspring-http 插件持有 hostApi.http，它是唯一真正监听端口的插件；
 * 其它插件通过事件总线把「注册服务器 / 处理请求」交给它：
 *
 *   1. 消费者先订阅 `wellspring-http:request:<name>`，然后发布 `wellspring-http:register`
 *   2. wellspring-http 启动服务器后向请求频道回 `ready`（或 `error`）
 *   3. 每个 HTTP 请求变成请求频道里的 `http-request`；
 *      消费者把响应发布到 `wellspring-http:response:<name>`
 *   4. 流式响应先回 `http-response`（stream: true），再发 `http-chunk` / `http-end`
 *
 * 负载必须能 JSON 序列化：请求体、响应体都用 base64；单帧上限见 MAX_FORWARD_BODY_BYTES。
 */

import type { HttpRequest, HttpResponse, HttpTlsOptions } from "../host/http.ts"

/** 注册 / 注销频道 */
export const HTTP_BUS_REGISTER = "wellspring-http:register"
export const HTTP_BUS_UNREGISTER = "wellspring-http:unregister"
/** wellspring-http 每次服务器列表变化时广播，便于诊断 */
export const HTTP_BUS_SERVERS = "wellspring-http:servers"

/** 单次请求等待消费者响应的默认上限 */
export const HTTP_BUS_DEFAULT_TIMEOUT_MS = 120_000
/** 注册后等待 wellspring-http 回 ready / error 的上限 */
export const HTTP_BUS_REGISTER_TIMEOUT_MS = 10_000
/** WebSocket 连接等待消费者 accept 的上限 */
export const HTTP_BUS_WEBSOCKET_ACCEPT_TIMEOUT_MS = 10_000
/**
 * 事件负载里请求/响应体的上限（原始字节）。
 * sandbox 帧上限 4 MiB，base64 后约 1.37 倍，这里留出 JSON 包装余量。
 */
export const HTTP_BUS_MAX_BODY_BYTES = 2_621_440

const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isValidHttpServerName(name: string): boolean {
    return SERVER_NAME_PATTERN.test(name)
}

export function httpRequestChannel(name: string): string {
    return `wellspring-http:request:${name}`
}

export function httpResponseChannel(name: string): string {
    return `wellspring-http:response:${name}`
}

/** base64 字符串对应的原始字节数（向上取整） */
export function base64ByteLength(value: string): number {
    if (value === "") {
        return 0
    }
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
    return Math.floor((value.length * 3) / 4) - padding
}

// ── 消费者 → wellspring-http ─────────────────────────────────

export interface HttpBusRegisterRequest {
    /** 服务器名；请求/响应频道都用它做后缀，注册后不能重复 */
    readonly name: string
    /** 默认 127.0.0.1 */
    readonly host?: string
    /** 默认 0（随机端口） */
    readonly port?: number
    /** 提供时启动 HTTPS */
    readonly tls?: HttpTlsOptions
    /** 启用 WebSocket 转发（消费者还需要提供 websocket 处理函数） */
    readonly websocket?: boolean
    /** 单次请求等待上限，默认 HTTP_BUS_DEFAULT_TIMEOUT_MS */
    readonly requestTimeoutMs?: number
}

export interface HttpBusUnregisterRequest {
    readonly name: string
}

// ── wellspring-http → 消费者（请求频道） ─────────────────────

export interface HttpBusReadyEvent {
    readonly type: "ready"
    readonly name: string
    readonly host: string
    readonly port: number
    readonly secure: boolean
}

/** 启动失败 / 运行期致命错误；code 是稳定的机器可读标识 */
export interface HttpBusErrorEvent {
    readonly type: "error"
    readonly name: string
    readonly code: string
    readonly message: string
}

export interface HttpBusStoppedEvent {
    readonly type: "stopped"
    readonly name: string
}

export interface HttpBusRequestEvent {
    readonly type: "http-request"
    readonly name: string
    readonly requestId: string
    readonly request: HttpRequest
}

/** 请求已超时/客户端已断开：消费者可以停下手上的工作 */
export interface HttpBusRequestAbortEvent {
    readonly type: "http-abort"
    readonly name: string
    readonly requestId: string
    readonly message?: string
}

export interface HttpBusWebSocketOpenEvent {
    readonly type: "websocket-open"
    readonly name: string
    readonly connectionId: string
    readonly request: HttpRequest
}

export interface HttpBusWebSocketMessageEvent {
    readonly type: "websocket-message"
    readonly name: string
    readonly connectionId: string
    /** 文本消息 */
    readonly data: string
}

export interface HttpBusWebSocketCloseEvent {
    readonly type: "websocket-close"
    readonly name: string
    readonly connectionId: string
    readonly code: number
    readonly reason: string
}

export type HttpBusServerEvent =
    | HttpBusReadyEvent
    | HttpBusErrorEvent
    | HttpBusStoppedEvent
    | HttpBusRequestEvent
    | HttpBusRequestAbortEvent
    | HttpBusWebSocketOpenEvent
    | HttpBusWebSocketMessageEvent
    | HttpBusWebSocketCloseEvent

// ── 消费者 → wellspring-http（响应频道） ─────────────────────

export interface HttpBusResponseEvent {
    readonly type: "http-response"
    readonly name: string
    readonly requestId: string
    readonly response: HttpResponse
}

export interface HttpBusChunkEvent {
    readonly type: "http-chunk"
    readonly name: string
    readonly requestId: string
    readonly chunk: string
}

export interface HttpBusEndEvent {
    readonly type: "http-end"
    readonly name: string
    readonly requestId: string
}

/** 消费者主动放弃这次请求：wellspring-http 回 502 */
export interface HttpBusAbortEvent {
    readonly type: "http-abort"
    readonly name: string
    readonly requestId: string
    readonly message?: string
}

export interface HttpBusWebSocketAcceptEvent {
    readonly type: "websocket-accept"
    readonly name: string
    readonly connectionId: string
}

export interface HttpBusWebSocketRejectEvent {
    readonly type: "websocket-reject"
    readonly name: string
    readonly connectionId: string
    readonly code?: number
    readonly message?: string
}

export interface HttpBusWebSocketSendEvent {
    readonly type: "websocket-send"
    readonly name: string
    readonly connectionId: string
    readonly data: string
}

export interface HttpBusWebSocketCloseRequest {
    readonly type: "websocket-close"
    readonly name: string
    readonly connectionId: string
    readonly code?: number
    readonly reason?: string
}

export type HttpBusClientEvent =
    | HttpBusResponseEvent
    | HttpBusChunkEvent
    | HttpBusEndEvent
    | HttpBusAbortEvent
    | HttpBusWebSocketAcceptEvent
    | HttpBusWebSocketRejectEvent
    | HttpBusWebSocketSendEvent
    | HttpBusWebSocketCloseRequest

/** wellspring-http 广播的服务器列表 */
export interface HttpBusServerInfo {
    readonly name: string
    readonly host: string
    readonly port: number
    readonly secure: boolean
    readonly websocket: boolean
}

export interface HttpBusServersEvent {
    readonly servers: readonly HttpBusServerInfo[]
}
