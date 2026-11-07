/*
 * Sandbox RPC v1 帧协议
 *
 * 帧 = 4 字节大端长度 + UTF-8 JSON
 * 宿主 ↔ 插件 sandbox、agent-code 控制通道复用
 */

export const SANDBOX_PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

export interface RpcErrorPayload {
    readonly code: string
    readonly message: string
    readonly retryable?: boolean
}

export interface RpcRequest {
    readonly v: 1
    readonly type: "request"
    readonly id: string
    readonly method: string
    readonly params?: unknown
    readonly timeoutMs?: number
    /**
     * Agent 工具调用身份（宿主侧注册表的 key）
     *
     * 宿主在 plugin.agentTool 上下发，插件在这条调用期间发出的 host 请求原样回填
     * 不带表示由插件自身发起（命令 / 钩子 / 界面）
     * 已注销的 id 由宿主拒绝，无回落
     */
    readonly contextId?: string
}

export interface RpcResponse {
    readonly v: 1
    readonly type: "response"
    readonly id: string
    readonly ok: boolean
    readonly result?: unknown
    readonly error?: RpcErrorPayload
}

export interface RpcEvent {
    readonly v: 1
    readonly type: "event"
    readonly method: string
    readonly params: unknown
}

export type RpcMessage = RpcRequest | RpcResponse | RpcEvent

export class SandboxProtocolError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.name = "SandboxProtocolError"
        this.code = code
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateMessage(value: unknown): RpcMessage {
    if (!isObject(value)) {
        throw new SandboxProtocolError("sandbox.protocol", "消息不是对象")
    }
    if (value["v"] !== SANDBOX_PROTOCOL_VERSION) {
        throw new SandboxProtocolError("sandbox.protocol-mismatch", "协议版本不一致")
    }
    const type = value["type"]
    if (type === "request") {
        if (typeof value["id"] !== "string" || typeof value["method"] !== "string") {
            throw new SandboxProtocolError("sandbox.protocol", "request 缺少 id/method")
        }
        if (value["contextId"] !== undefined && typeof value["contextId"] !== "string") {
            throw new SandboxProtocolError("sandbox.protocol", "contextId 不是字符串")
        }
        return value as unknown as RpcRequest
    }
    if (type === "response") {
        if (typeof value["id"] !== "string" || typeof value["ok"] !== "boolean") {
            throw new SandboxProtocolError("sandbox.protocol", "response 缺少 id/ok")
        }
        return value as unknown as RpcResponse
    }
    if (type === "event") {
        if (typeof value["method"] !== "string") {
            throw new SandboxProtocolError("sandbox.protocol", "event 缺少 method")
        }
        return value as unknown as RpcEvent
    }
    throw new SandboxProtocolError("sandbox.protocol", "未知消息类型")
}

export function encodeMessage(message: RpcMessage): Buffer {
    const payload = Buffer.from(JSON.stringify(message), "utf8")
    if (payload.length > MAX_FRAME_BYTES) {
        throw new SandboxProtocolError("sandbox.protocol-limit", "帧超过上限")
    }
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    return frame
}

/** 流式解码器；支持任意 chunk 切分 */
export class FrameDecoder {
    #buffer: Buffer = Buffer.alloc(0)
    readonly #maxFrameBytes: number

    constructor(maxFrameBytes = MAX_FRAME_BYTES) {
        this.#maxFrameBytes = maxFrameBytes
    }

    push(chunk: Buffer): RpcMessage[] {
        this.#buffer = Buffer.concat([this.#buffer, chunk])
        const messages: RpcMessage[] = []
        while (this.#buffer.length >= 4) {
            const length = this.#buffer.readUInt32BE(0)
            if (length > this.#maxFrameBytes) {
                throw new SandboxProtocolError("sandbox.protocol-limit", "帧超过上限")
            }
            if (this.#buffer.length < 4 + length) {
                break
            }
            const payload = this.#buffer.subarray(4, 4 + length)
            this.#buffer = this.#buffer.subarray(4 + length)
            let parsed: unknown
            try {
                parsed = JSON.parse(payload.toString("utf8"))
            } catch (error) {
                throw new SandboxProtocolError(
                    "sandbox.protocol",
                    `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
                )
            }
            messages.push(validateMessage(parsed))
        }
        return messages
    }

    get bufferedBytes(): number {
        return this.#buffer.length
    }
}

let requestCounter = 0

export function nextRequestId(prefix = "req"): string {
    requestCounter += 1
    return `${prefix}-${Date.now().toString(36)}-${requestCounter}`
}
