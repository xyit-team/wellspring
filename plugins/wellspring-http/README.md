# wellspring-http

平台里**唯一**持有 `hostApi.http` 的插件：所有 HTTP / HTTPS / WebSocket 服务器都由它创建，
其它插件通过事件总线把「监听地址 + 请求处理函数」交给它，不再各自 `api.http.createServer`。

- 端口、TLS、WebSocket 升级只在这一个地方管理，便于审计与统一关闭
- 依赖它的插件（`wellspring-web`、`wellspring-code`）从 `wellspring/api/host` 的 eventBus 通信，
  sandbox 内会自动桥接到宿主事件总线
- 消费者侧 helper：`wellspring/api/plugin/http-client.ts`；协议定义：`wellspring/api/plugin/http-protocol.ts`

## 加载

```bash
wellspring plugin link plugins/wellspring-http
wellspring plugin link plugins/wellspring-web      # 依赖它
wellspring plugin link plugins/wellspring-code     # 依赖它
wellspring start
```

`wellspring-web` / `wellspring-code` 的 `setup().deps` 里声明了 `wellspring-http`，加载器保证
HTTP 插件先初始化；如果没有链接（或它被禁用），这两个插件会以「依赖不存在 / 依赖被禁用」失败，
这是有意为之——平台里不应再有第二个直接监听端口的插件。

## 消费者用法

```ts
import type { HttpRequest, HttpResponse, PluginApi } from "wellspring/api/host/index.ts"
import { eventBus } from "wellspring/api/host/index.ts"
import { registerHttpServer } from "wellspring/api/plugin/http-client.ts"

export function setup() {
    return {
        id: "my-app",
        // ...
        deps: ["wellspring-http"],
        init: async (api: PluginApi) => {
            const server = await registerHttpServer(
                eventBus,
                { name: "my-app", host: "127.0.0.1", port: 8787 },
                async (request: HttpRequest, stream): Promise<HttpResponse> => {
                    if (request.url === "/sse") {
                        // 流式响应：先返回 stream:true，再异步写分片
                        setTimeout(() => {
                            stream.write("data: hello\n\n")
                            stream.end()
                        }, 10)
                        return {
                            status: 200,
                            headers: { "content-type": "text/event-stream" },
                            stream: true,
                            body: "",
                        }
                    }
                    return {
                        status: 200,
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ url: request.url }),
                    }
                },
            )
            api.output.info(`my-app listening on http://${server.host}:${server.port}`)
        },
    }
}
```

`registerHttpServer` 返回的句柄：

| 字段     | 说明                                             |
| -------- | ------------------------------------------------ |
| `name`   | 注册时的服务器名                                 |
| `host`   | 实际监听地址                                     |
| `port`   | 实际端口（注册时传 `0` 会由系统分配）            |
| `secure` | 是否 HTTPS                                       |
| `close()`| 注销并关闭服务器（插件 `onShutdown` 里调用）     |

注销示例：

```ts
import { onShutdown } from "wellspring/api/host/index.ts"

let server = null
onShutdown(async () => {
    await server?.close()
    server = null
})
```

### 参数

| 字段               | 默认        | 说明                                                       |
| ------------------ | ----------- | ---------------------------------------------------------- |
| `name`             | 必填        | 服务器名，`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，不能重复      |
| `host`             | `127.0.0.1` | 监听地址，可写 `0.0.0.0` / `::`                            |
| `port`             | `0`         | `0` 表示随机端口，用返回的 `server.port`                   |
| `tls`              | 无          | `{ cert, key, ca? }` PEM；提供时启动 HTTPS                |
| `websocket`        | 无          | 处理函数 `(socket, request) => void`，提供时启用 WS 升级   |
| `requestTimeoutMs` | `120000`    | 单次请求等待消费者响应的上限，超时回 `504`                 |
| `registerTimeoutMs`| `10000`     | 等 wellspring-http 回 `ready` 的上限（主要给测试用）       |
| `onError`          | 无          | 启动成功后的运行期错误（流超时、超大响应等）回调           |

### WebSocket

```ts
const server = await registerHttpServer(
    eventBus,
    {
        name: "my-app",
        port: 8788,
        websocket: (socket, request) => {
            socket.onMessage((data) => socket.send(`echo:${data}`))
            socket.onClose((code, reason) => {
                /* 连接关闭 */
            })
        },
    },
    httpHandler,
)
```

helper 收到升级请求后自动 `websocket-accept`，然后回调处理函数；`socket.send/close` 会转成事件发给
wellspring-http。消费者没有提供 `websocket` 处理函数时，升级请求会被 `1008` 拒绝。

## 事件协议

消费者可以完全不用 helper、直接走事件总线（例如非 TypeScript 的插件）。协议版本随插件发布，
定义见 `src/api/plugin/http-protocol.ts`。

| 方向             | 频道                                | 事件                                                                 |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------- |
| 消费者 → 管理器  | `wellspring-http:register`          | `{ name, host?, port?, tls?, websocket?, requestTimeoutMs? }`        |
| 消费者 → 管理器  | `wellspring-http:unregister`        | `{ name }`                                                           |
| 管理器 → 消费者  | `wellspring-http:request:<name>`    | `ready` / `error` / `stopped` / `http-request` / `http-abort` / WS 三类 |
| 消费者 → 管理器  | `wellspring-http:response:<name>`   | `http-response` / `http-chunk` / `http-end` / `http-abort` / WS 四类  |
| 管理器 → 所有    | `wellspring-http:servers`           | `{ servers: [{ name, host, port, secure, websocket }] }`             |

关键事件：

```ts
// 管理器 → 消费者：启动结果与请求
{ type: "ready", name, host, port, secure }
{ type: "error", name, code, message }           // code: port-in-use / permission-denied / invalid-register / duplicate-name / listen-failed …
{ type: "stopped", name }
{ type: "http-request", name, requestId, request: HttpRequest }
{ type: "http-abort", name, requestId, message? } // 请求超时：消费者可以停手

// 消费者 → 管理器：响应
{ type: "http-response", name, requestId, response: HttpResponse }
{ type: "http-chunk", name, requestId, chunk }    // 仅 stream:true 的响应
{ type: "http-end", name, requestId }
{ type: "http-abort", name, requestId, message? }  // 消费者放弃请求 → 502
```

`HttpRequest` / `HttpResponse` 与宿主 `hostApi.http` 的类型完全一致：请求体是 base64，
响应可返回 utf8 或 base64；`stream: true` + `http-chunk` / `http-end` 对应 SSE 等长连接。

## 限制与错误

- **单次转发体上限 2.5 MiB（原始字节）**：事件走 sandbox RPC，单帧上限 4 MiB；超限的请求返回 `413`，
  超限的响应由 helper 换成 `502`，不会把超大帧塞进事件总线。需要传大文件请改用分片接口
  （例如 wellspring-code 的写文件接口按 2 MiB 以内分块/限制）。
- **启动失败**：`ready` 之前管理器会向请求频道发 `error`，helper 让 `registerHttpServer` reject，
  插件 `init` 抛错 → 插件以失败状态出现在插件列表里。
- **重名**：后注册方收到 `duplicate-name`；先注册的服务器不受影响。
- **消费者挂掉**：服务器仍在管理器里，直到消费者注销或 wellspring-http 关闭；请求会等到超时后回 `504`。
  插件 `onShutdown` 里注销可以避免这一点。
- **管理器关闭**：所有托管服务器一起关闭，并给消费者发 `stopped`。

## 测试

```bash
node --test test/http-plugin.test.ts   # fixture 消费者：请求/流/错误/超时/重名/端口占用/WebSocket
```

`test-fixtures/http-consumer` 是测试用消费者插件（用 helper 注册一个可配置的服务器）。
