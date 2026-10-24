import type {
    HttpRequest,
    HttpResponse,
    HttpServerHandle,
    HttpStreamContext,
    PluginApi,
} from "wellspring/api/host/index.ts"
import { onInit, onShutdown } from "wellspring/api/host/index.ts"

import { AuthStore } from "./auth.ts"
import { HOME_HTML } from "./pages.ts"

let api: PluginApi | null = null
let server: HttpServerHandle | null = null
let auth: AuthStore | null = null

export function configureServer(value: PluginApi): Promise<void> {
    api = value
    auth = new AuthStore(value.fs)
    return auth.load()
}

function getApi(): PluginApi {
    if (api === null) {
        throw new Error("wellspring-web 尚未初始化")
    }
    return api
}

function getAuth(): AuthStore {
    if (auth === null) {
        throw new Error("wellspring-web 认证尚未初始化")
    }
    return auth
}

function json(status: number, data: unknown, headers: Record<string, string> = {}): HttpResponse {
    return {
        status,
        headers: { "content-type": "application/json; charset=utf-8", ...headers },
        body: JSON.stringify(data),
    }
}

function html(body: string): HttpResponse {
    return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body,
    }
}

function bodyText(request: HttpRequest): string {
    return request.body === "" ? "" : Buffer.from(request.body, "base64").toString("utf8")
}

function parseJson(request: HttpRequest): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(bodyText(request) || "{}")
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {}
    } catch {
        return {}
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

async function route(request: HttpRequest, stream: HttpStreamContext): Promise<HttpResponse> {
    const currentAuth = getAuth()
    const currentApi = getApi()
    const url = new URL(request.url, "http://localhost")
    const path = url.pathname

    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
        return html(HOME_HTML)
    }

    if (request.method === "GET" && path === "/api/state") {
        return json(200, {
            configured: currentAuth.configured,
            authenticated: currentAuth.authenticated(request),
        })
    }

    if (request.method === "POST" && path === "/api/auth/setup") {
        if (currentAuth.configured) {
            return json(409, { error: "密码已经设置过了" })
        }
        const password = String(parseJson(request)["password"] ?? "")
        try {
            await currentAuth.setPassword(password)
        } catch (error) {
            return json(400, { error: errorMessage(error) })
        }
        const session = currentAuth.createSession()
        return json(200, { ok: true }, { "set-cookie": currentAuth.cookie(session) })
    }

    if (request.method === "POST" && path === "/api/auth/login") {
        if (!currentAuth.configured) {
            return json(409, { error: "还没有设置密码" })
        }
        const password = String(parseJson(request)["password"] ?? "")
        if (!currentAuth.verifyPassword(password)) {
            return json(401, { error: "密码错误" })
        }
        const session = currentAuth.createSession()
        return json(200, { ok: true }, { "set-cookie": currentAuth.cookie(session) })
    }

    if (request.method === "POST" && path === "/api/auth/logout") {
        currentAuth.logout(request)
        return json(200, { ok: true }, { "set-cookie": currentAuth.clearCookie() })
    }

    if (!currentAuth.authenticated(request)) {
        return json(401, { error: "未登录" })
    }

    if (request.method === "POST" && path === "/api/chat") {
        const body = parseJson(request)
        const message = String(body["message"] ?? "").trim()
        if (message === "") {
            return json(400, { error: "消息不能为空" })
        }
        const sessionId =
            typeof body["sessionId"] === "string" && body["sessionId"] !== ""
                ? body["sessionId"]
                : undefined
        try {
            const result = await currentApi.agent.chat({ message, sessionId })
            return json(200, result)
        } catch (error) {
            return json(500, { error: errorMessage(error) })
        }
    }

    if (request.method === "POST" && path === "/api/chat/stream") {
        const body = parseJson(request)
        const message = String(body["message"] ?? "").trim()
        if (message === "") {
            return json(400, { error: "消息不能为空" })
        }
        const sessionId =
            typeof body["sessionId"] === "string" && body["sessionId"] !== ""
                ? body["sessionId"]
                : undefined
        const send = (data: unknown): void => {
            stream.write(`data: ${JSON.stringify(data)}\n\n`)
        }
        void currentApi.agent
            .stream({ message, sessionId }, (event) => send(event))
            .then((result) => {
                send({ type: "done", ...result })
            })
            .catch((error: unknown) => {
                send({ type: "error", error: errorMessage(error) })
            })
            .finally(() => stream.end())
        return {
            status: 200,
            headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
                connection: "keep-alive",
            },
            stream: true,
        }
    }

    return json(404, { error: "Not Found" })
}

export async function onHttpRequest(
    request: HttpRequest,
    stream: HttpStreamContext,
): Promise<HttpResponse> {
    try {
        return await route(request, stream)
    } catch (error) {
        return json(500, { error: errorMessage(error) })
    }
}

onInit(async () => {
    const currentApi = getApi()
    const host =
        typeof currentApi.pluginConfig["host"] === "string"
            ? currentApi.pluginConfig["host"]
            : "127.0.0.1"
    const port =
        typeof currentApi.pluginConfig["port"] === "number" ? currentApi.pluginConfig["port"] : 8787
    server = await currentApi.http.createServer({ host, port }, onHttpRequest)
    currentApi.output.info(`wellspring-web listening on http://${server.host}:${server.port}`)
})

onShutdown(async () => {
    await server?.close()
    server = null
})
