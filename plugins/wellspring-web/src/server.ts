import type {
    HttpRequest,
    HttpResponse,
    HttpServerHandle,
    PluginApi,
} from "wellspring/api/host/index.ts"
import { onInit, onShutdown } from "wellspring/api/host/index.ts"

let api: PluginApi | null = null
let server: HttpServerHandle | null = null

export function configureServer(value: PluginApi): void {
    api = value
}

export function getApi(): PluginApi {
    if (api === null) {
        throw new Error("wellspring-web 尚未初始化")
    }
    return api
}

export function onHttpRequest(request: HttpRequest): HttpResponse {
    return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: `hello ${request.url}\n from wellspring-web server`,
    }
}

onInit(async () => {
    const currentApi = getApi()
    server = await currentApi.http.createServer({ host: "127.0.0.1", port: 8787 }, onHttpRequest)
})

onShutdown(async () => {
    await server?.close()
    server = null
})
