# Wellspring 源泉 —— 聚合式 Agent 平台

## 运行要求

- Node.js >= 24

## 依赖

- Pino（结构化日志，写文件）
- OpenAI SDK（模型调用）
- undici（HTTP/HTTPS 代理）

## 快速开始

```bash
npm start                     # 无子命令，打印帮助
node src/index.ts help
node src/index.ts version
node src/index.ts config path
node src/index.ts doctor

OPENAI_API_KEY=sk-... node src/index.ts chat "解释一下 EventBus"
echo "总结这个目录" | node src/index.ts chat
node src/index.ts run "读取 package.json 并总结依赖"
node src/index.ts run "用 execute_code 运行 node 打印当前时间"        # 默认 read-only
node src/index.ts run --permission workspace-write "修改文件"          # workspace 可写
node src/index.ts run --allow-exec "..."                              # 跳过越界审批
node src/index.ts start        # 以服务进程启动，Ctrl+C / wellspring stop / 插件 shutdown() 退出
node src/index.ts stop         # 停止正在运行的服务

# 指定会话；不指定时使用当前 cwd 的最近一次会话
node src/index.ts chat --session-id 20261021-173000-ab12 "继续"

# TTY 下不带 context 进入交互式会话，提示符为 <会话名> > 或 <会话名> [run] >
node src/index.ts chat
```

Agent 文本与操作请求分块显示：

```text
[Agent] Agent请求执行命令
  command node -e console.log('hi')
  工作目录 .
是否允许？[允许] [拒绝]  ←/→ 切换 · Enter 确认

[操作] execute_code 已允许
[操作] execute_code 已完成 exit=0

[Agent] hi
```

- `[Agent]` 前缀只用于 Agent 文本
- TTY 下 Agent / chat 文本按 Markdown 渲染（标题、列表、表格、代码块、语法高亮）
- 图片显示为 `图片：alt（url）`，`<details>` 展开为普通文本，任务列表显示 `☑` / `☐`
- 脚注与数学公式保留原文（终端渲染器不支持）
- 非 TTY 与 `--json` 保持纯文本
- 操作请求、审批、执行状态使用独立块
- 无颜色终端用 `>` 标记当前选项
- 普通命令在当前权限内直接执行，不弹审批
- 请求更宽权限时显示审批块，`--allow-exec` 跳过

`--json` 输出与内部 `Result` 对齐的 envelope：

```json
{ "success": true, "code": null, "data": { "sessionId": "...", "reply": "..." } }
{ "success": false, "code": "openai.missing-api-key", "data": null }
```

## 命令

| 命令                                                 | 说明                      |
| ---------------------------------------------------- | ------------------------- |
| `chat [context...]`                                  | 对话模式，单轮或交互式    |
| `run [context...]`                                   | Agent 模式，单轮或交互式  |
| `start` / `stop`                                     | 服务进程启动 / 跨进程停止 |
| `session list/show/delete`                           | 会话列表、回放、删除      |
| `config path/show/get/set`                           | 配置路径、查看、读写      |
| `plugin list/new/install/link/enable/disable/remove` | 插件管理                  |
| `doctor`                                             | 环境诊断                  |
| `version` / `help`                                   | 版本与帮助                |

全局参数：`-c/--config`、`--home`、`-l/--log-level`、`--json`、`-q/--quiet`、`-h/--help`、`-v/--version`。

## wellspring-core 插件

Agent 工具实现已抽到 [`plugins/wellspring-core`](plugins/wellspring-core)：

- `read`
- `execute_code`（支持 `background` / `network`）
- `web_search`
- `web_fetch`
- `query_task`
- `stop_task`

所有插件都由用户手动安装或链接，平台不会自动安装插件：

```bash
wellspring plugin link plugins/wellspring-core
```

平台本体不再包含 Agent 工具实现；工具全部由该插件注册。core 插件未加载时 Agent 只保留会话循环，没有工具。

插件通过 `api.capabilities` 调用宿主能力：

```ts
await api.capabilities.executeCode({ command: "node", argv: ["-e", "1"] })
await api.capabilities.webSearch("query")
await api.capabilities.webFetch("https://example.com")
```

`executeCode` 在 Agent 工具调用上下文中执行，继承当前权限与越界审批；不在 Agent 调用中会拒绝。

- `background: true` 后台执行，返回 `taskId`
- `query_task` 查询后台任务状态与输出
- `stop_task` 用 `ctrl_c` 发 SIGINT，`kill` 发 SIGKILL
- `network: true` 给 bwrap 加 `--share-net`

`capabilities` 由 sandbox 插件经 `host.capabilities.*` RPC 调用。

## Agent 工具

`run` 模式提供：

- `read`：读取 workspace 内 UTF-8 文本，带行号，支持 offset/limit
- `execute_code`：sandbox 内执行命令；默认 `read-only`，普通命令不弹审批；模型请求 `workspace-write` / `danger-full-access` 时才审批
- `web_search`：调用 DeepSeek Search API 搜索网页
- `web_fetch`：调用 DeepSeek Fetch API 抓取网页 Markdown 正文

工具 schemas 随每次模型请求的 `tools` 字段下发；能力边界写在工具 description 里，不额外注入系统提示。网络工具使用 `openai.baseUrl`（DeepSeek）与 `OPENAI_API_KEY`，走 `network.proxy` 代理配置。`web_fetch` 对 408/429/5xx 重试一次，并清理 Markdown 转义。DeepSeek 官方接口：

- `POST https://api.deepseek.com/v1/tools/search`
- `POST https://api.deepseek.com/v1/tools/fetch`

## 配置文件

默认路径由 platform 层决定，首次运行会自动创建。示例见 `config/app-setting-demo.json`：

```json
{
    "logger": { "level": "info" },
    "openai": {
        "baseUrl": null,
        "model": "gpt-4o-mini",
        "timeoutMs": 60000,
        "maxRetries": 2
    },
    "network": {
        "proxy": {
            "type": "http",
            "url": "http://127.0.0.1:7890",
            "noProxy": ["localhost", "127.0.0.1"]
        }
    }
}
```

- `openai.baseUrl` 为 `null` 时使用 SDK 默认值或 `OPENAI_BASE_URL`
- `network.proxy` 为 `null` 时直连；一期只支持 HTTP/HTTPS 代理
- `sandbox.mode`：`off` / `strict` / `best-effort`；`strict` 找不到 OS 后端时拒绝 Agent 代码执行，`best-effort` 才降级
- `sandbox.access`：`read-only` / `workspace-write` / `danger-full-access`；默认 `read-only`
- `--permission <mode>`：单轮覆盖 `sandbox.access`；REPL 里 `/permission [mode]`
- `sandbox.backend`：`auto` / `bwrap` / `nsjail`
- `sandbox.defaultTimeoutMs`、`defaultMemoryMB`、`outputLimitBytes`：Agent 代码执行的默认限制
- API key 只从 `OPENAI_API_KEY` 读取，不写入配置文件

## 插件数据互访

依赖链上的插件可以互访 data 目录，无依赖关系的插件不能：

```ts
const other = await api.pluginData("other-plugin")
if (other) {
    await other.writeText("shared.json", "{}")
}
```

- 依赖关系无向：A 依赖 B，双方都可访问对方 data
- 非依赖链返回 `null`
- sandbox 插件通过 `host.pluginData` bridge 访问，宿主侧同样校验依赖图

## 插件与钩子

### 开发与安装

```bash
node src/index.ts plugin new hello-plugin --dir ./plugins
node src/index.ts plugin link ./plugins/hello-plugin      # 开发时链接
node src/index.ts plugin install ./plugins/hello-plugin    # 或目录 / zip
node src/index.ts plugin list
```

仓库自带示例：[plugins/hello-plugin](plugins/hello-plugin/index.ts)。

### 入口与生命周期

```ts
import { onMessage, onInit, onShutdown } from "wellspring/api/host/index.ts"
import type { Logger, PluginApi } from "wellspring/api/host/index.ts"

// 钩子可以放在模块顶层，也可以放在 setup() 里
onMessage(({ phase, prompt }) => {
    if (phase === "before") {
        prompt.push("你是一个运行在 Wellspring 里的助手")
    }
})

export function setup() {
    return {
        id: "hello-plugin",
        name: "Hello Plugin",
        version: "0.1.0",
        status: "ok",
        init: (api: PluginApi) => {
            api.logger.info({ dataDir: api.pluginDataDir }, "plugin ready")
        },
        commands: [
            {
                name: "hello",
                summary: "示例命令",
                run: (ctx) => {
                    ctx.output.info(`argv=${ctx.argv.join(",")}`)
                    ctx.logger.info({ config: ctx.pluginConfig }, "command run")
                    return 0
                },
            },
        ],
    }
}

onInit(() => {
    /* wellspring start 启动 */
})
onShutdown(() => {
    /* 服务关闭 */
})
```

- `setup()` 返回对象必须包含 `status: "ok" | "failed"`；`failed` 时端会跳过命令注册
- `init(api)` 在每次加载插件时都会执行；`onInit` 只由 `wellspring start` 触发，`run` / `chat` / `plugin list` 等命令不会触发
- 插件配置：`<configDir>/plugins/<id>.json`，通过 `api.pluginConfig` / `ctx.pluginConfig` 读取
- 插件数据：`<dataDir>/plugin-data/<id>/`，通过 `api.pluginDataDir` / `ctx.pluginDataDir` 使用
- `deps` 声明插件依赖，加载器会按依赖拓扑排序；缺失依赖或循环依赖会标记失败
- `plugin disable <name>` / `plugin enable <name>` 会把状态写到 `<dataDir>/plugins-state.json`，下次运行生效
- 插件里的 `console.*` 会被拦截，输出用 `ctx.logger` / `ctx.output` / `api.logger`

### PluginApi 能力

`setup()` 的 `init(api: PluginApi)` 暴露以下能力。

| 成员                       | 说明                                                     |
| -------------------------- | -------------------------------------------------------- |
| `apiVersion`               | 宿主 API 版本                                            |
| `plugin`                   | `{ id, name, version }`                                  |
| `paths`                    | 配置、数据、缓存、日志根目录                             |
| `config`                   | 全局配置 `AppSetting`                                    |
| `logger`                   | pino Logger                                              |
| `output`                   | `info` / `warn` / `error` / `print`，走终端渲染          |
| `pluginDataDir`            | 插件数据目录，已创建                                     |
| `pluginConfig`             | `<configDir>/plugins/<id>.json` 内容                     |
| `fs`                       | 插件数据目录内的文件 API                                 |
| `workspaceFs`              | 当前工作目录的文件 API，需 `fs.read` 声明 `${workspace}` |
| `registerCommand(command)` | 运行时注册命令                                           |
| `registerAgentTool(tool)`  | 运行时注册 Agent 工具                                    |
| `pluginData(pluginId)`     | 读取依赖插件的数据目录，无权限返回 `null`                |
| `capabilities`             | 代码执行与网络能力                                       |
| `http`                     | 宿主 HTTP/HTTPS/SSE/WebSocket 服务                       |

#### capabilities

| 方法                         | 说明                                             |
| ---------------------------- | ------------------------------------------------ |
| `executeCode(input)`         | 在 sandbox 执行命令，仅 Agent 工具调用上下文可用 |
| `startBackgroundCode(input)` | 启动后台任务，返回 `{ taskId, sandboxId }`       |
| `queryTask(taskId?)`         | 查询任务状态与实时 stdout/stderr                 |
| `stopTask(taskId, mode)`     | 停止任务，`ctrl_c` 或 `kill`                     |
| `webSearch(query, count?)`   | DeepSeek 网页搜索                                |
| `webFetch(url)`              | 抓取网页并转 Markdown                            |

#### fs / workspaceFs

`HostFileApi` 提供：

```text
readText / readBytes / readJson
writeText / writeBytes / writeJson
list / stat / mkdir / remove / exists
```

路径必须是相对路径；`..`、绝对路径和越界符号链接会被拒绝。

#### 命令上下文

`run(ctx)` 可以访问：

| 字段                             | 说明               |
| -------------------------------- | ------------------ |
| `argv` / `cwd` / `env` / `json`  | 命令参数与运行环境 |
| `paths` / `config`               | 与 `api` 相同      |
| `logger` / `output`              | 日志与终端输出     |
| `pluginDataDir` / `pluginConfig` | 插件数据与配置     |
| `fs` / `workspaceFs`             | 同 `api`           |
| `stdin` / `stdout` / `stderr`    | 标准流             |

#### 其他宿主导出

`wellspring/api/host/index.ts` 还导出：

- `getHost()`：宿主状态、OS、路径、插件列表
- `eventBus` / `EventEntity`：事件总线
- `getSession(id)`：获取活跃会话；`Session` / `SessionMessage` / `Workspace`
- `onInit` / `onShutdown` / `onMessage` 等钩子
- 全部 `PluginApi`、`PluginCommand`、`AgentTool`、`HttpServerHandle` 等类型

### 钩子

`onInit`、`onShutdown`、`onMessage`、`beforeTurn`、`beforeStep`、`afterStep`、`afterTurn`、`onAgentRunSync`、`onAgentRunAsync`、`onAgentAsyncTaskComplete`、`onAgentCallTool`、`onAgentAsk`、`onAgentRead`、`onAgentQueryTask`、`onAgentSubmit`、`onAgentSetTasks`、`onAgentSetGoal`、`onAgentRequestPermission`、`onUserAnswer`。

- `onMessage` 取代原来的 `beforeMessage` / `afterMessage`：`phase: "before" | "after"`，before 阶段可修改 `prompt`
- `onAgentSetTasks` 取代 `onAgentSetTask`
- `onAgentRunSync` 在 `run` 模式开始前触发
- `onAgentRunAsync` 在 Agent 创建异步任务之前触发，`onAgentAsyncTaskComplete` 在异步任务完成后触发（当前还没有异步任务实现，钩子已暴露，暂不触发）
- `beforeTurn` / `beforeStep` / `afterStep` / `afterTurn` 已接入 chat/run
- 所有钩子入参都是 `XxxEvent` 类，例如 `SessionMessageEvent`、`BeforeTurnEvent`、`AgentCallToolEvent`
- `onAgentCallTool`、`onAgentRead`、`onAgentQueryTask`、`onAgentSubmit`、`onAgentSetTasks`、`onAgentSetGoal`、`onAgentRequestPermission`、`onUserAnswer` 已在 Agent 循环里触发
- `onInit` / `onShutdown` 在 `wellspring start` 中触发

### 类型检查（编辑器 / tsc）

运行时不需要 wellspring 包：平台加载插件时会解析 `wellspring/api/host/index.ts`。

仓库内的插件不要 `pnpm link` 根目录，否则 `node_modules/wellspring` 会指向仓库根并造成目录循环。用插件自己的 `tsconfig.json` 做类型解析：

```json
{
    "extends": "../../tsconfig.json",
    "compilerOptions": {
        "paths": {
            "wellspring/api/host": ["../../src/api/host/index.ts"],
            "wellspring/api/host/index.ts": ["../../src/api/host/index.ts"],
            "wellspring/*": ["../../src/*"]
        }
    },
    "include": ["index.ts", "src/**/*.ts"]
}
```

```bash
cd plugins/wellspring-web
pnpm exec tsc --noEmit
```

仓库外的独立插件仍可以用 `pnpm link /path/to/Wellspring`。

### 文件访问与访问守卫

插件不要直接 `import "node:fs"`；平台在插件加载、命令执行和钩子执行期间会拦截这些模块：

| 被拦截                                                            | 替代                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `node:fs` / `fs` / `fs/promises`                                  | `ctx.fs` / `api.fs`、`ctx.workspaceFs` / `api.workspaceFs` |
| `node:child_process`                                              | 目前无替代（需要执行命令时请走宿主 API 扩展）              |
| `node:worker_threads`、`node:vm`、`node:module`、`node:inspector` | 禁止                                                       |

```ts
const text = await ctx.fs.readText("state.json")
await ctx.fs.writeJson("state.json", { ok: true })
const files = await ctx.workspaceFs.list("src")
```

- `fs` 的根是插件数据目录 `<dataDir>/plugin-data/<id>/`
- `workspaceFs` 的根是当前工作目录
- 路径必须是相对路径，`..`、绝对路径会被拒绝
- 也可以从 `api.fs` / `api.workspaceFs` 使用（`init(api)` 与钩子之后）

所有插件强制运行在独立 sandbox 子进程内，平台不再提供进程内插件模式。插件只能通过 RPC bridge 使用宿主 API，不能直接访问宿主文件系统。

### OS 级 sandbox

所有插件都在 sandbox 内运行；`package.json` 的 `sandbox` 块只用于声明权限，不能关闭 sandbox：

```json
{
    "wellspring": {
        "apiVersion": 1,
        "sandbox": {
            "profile": "plugin",
            "hostApi": ["logger", "fs", "event", "getHost"],
            "fs": {
                "read": ["${pluginDir}", "${workspace}"],
                "write": ["${dataDir}/my-plugin"]
            },
            "network": false,
            "process": false
        }
    }
}
```

- 插件在独立子进程运行，通过 RPC bridge 访问宿主 API；命令、钩子、日志、event、getHost 都经宿主代理
- `hostApi` 默认包含 `logger` / `fs` / `event` / `getHost` / `shutdown`；`workspaceFs` 仍需在 `fs.read` 里声明 `${workspace}`
- `${workspace}` 默认只读，写 workspace 需放进 `fs.write`
- 没有可用 OS 后端时插件加载失败；插件不做 direct 降级
- `sandbox.mode: off` 时插件全部拒绝加载
- Linux 后端为 `bwrap`；当前环境若不允许非特权 user namespace，strict 会拒绝加载

### 插件的 HTTP 服务

sandbox 插件不能直接 `listen()`，通过宿主能力创建 HTTP 服务。`host` 允许绑定广域网地址（例如 `0.0.0.0`）：

```ts
import { onInit, onShutdown } from "wellspring/api/host/index.ts"

let api
let server

export function setup() {
    return {
        // ...
        init(value) {
            api = value
        },
    }
}

onInit(async () => {
    server = await api.http.createServer({ host: "127.0.0.1", port: 8787 }, (request) => ({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: `hello ${request.url}`,
    }))
})

onShutdown(async () => {
    await server?.close()
})
```

- 宿主监听端口，请求通过 RPC 交给插件 handler
- `host` 可以是 loopback（默认 `127.0.0.1`），也可以是 `0.0.0.0` / `::` / 指定网卡地址
- `port: 0` 使用随机端口，返回 `server.port`
- 请求体以 base64 传入，响应可返回 `utf8` 或 `base64`
- `hostApi` 需要声明 `http`（默认 hostApi 已包含）

HTTPS：

```ts
const cert = await api.fs.readText("cert.pem")
const key = await api.fs.readText("key.pem")
server = await api.http.createServer({ host: "127.0.0.1", port: 8443, tls: { cert, key } }, handler)
```

证书放在插件 data 目录，通过 `api.fs` 读取；sandbox 插件不能直接读宿主任意路径。

SSE：

```ts
server = await api.http.createServer({ port: 8787 }, (request, stream) => {
    stream.write("data: hello\n\n")
    setTimeout(() => {
        stream.write("data: world\n\n")
        stream.end()
    }, 100)
    return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        stream: true,
    }
})
```

WebSocket：

```ts
server = await api.http.createServer(
    {
        port: 8787,
        websocket: (socket) => {
            socket.onMessage((data) => {
                void socket.send(`echo: ${data}`)
            })
            socket.onClose((code, reason) => {
                // 连接关闭
            })
        },
    },
    () => ({ status: 404 }),
)
```

- SSE 通过 `stream: true` 保持连接，`stream.write` / `stream.end`
- WebSocket 使用 `ws` 宿主侧实现，消息通过 RPC 转发

### 宿主信息

```ts
import { getHost } from "wellspring/api/host/index.ts"

getHost().getStatus() // starting | running | stopping | stopped
getHost().getOS() // platform / arch / release / node / cwd
getHost().getPaths() // 四类根目录
getHost().getPlugins() // 插件列表，每项有 getStatus()
```

类似 Bukkit 的 PluginManager：`getHost().getPlugins()[0]?.getStatus()` 返回 `ok` / `failed` / `disabled`。

### 事件总线

```ts
import { EventEntity, eventBus } from "wellspring/api/host/index.ts"

const off = eventBus.subscribe("demo/ping", (payload) => {
    console.log(payload.getData())
})
eventBus.publish("demo/ping", EventEntity.create({ msg: "hi" }))
off()
```

### 服务进程

`wellspring start` 会写 `<dataDir>/service.json`；用户 Ctrl+C、`wellspring stop`（SIGTERM）或插件调用 `shutdown()` 都会触发 `onShutdown` 后优雅退出。

插件是原生 TS，类型导入必须写 `import type { Logger, PluginApi }`；Node 只擦除类型标注，不会擦除普通 import。

## 目录

- 配置：`<configDir>/app-setting.json`
- 会话：`<dataDir>/sessions/<cwd桶>/<sessionId>/`，每轮一个 `turns/NNNN.jsonl.zstd`
- 插件：`<dataDir>/plugins/<name>/`，入口导出 `setup(): WellspringPlugin`；支持 `plugin install <zip|目录>`
- 插件配置/数据：`<configDir>/plugins/<id>.json`、`<dataDir>/plugin-data/<id>/`
- 服务状态：`<dataDir>/service.json`
- 日志：`<logDir>/app.log`；human 模式 Pino 只写文件，终端输出走 `elog4js`

设计细节见 [`working/cli-design.md`](working/cli-design.md)；Sandbox/OS 级隔离与 Agent 代码执行设计见 [`working/sandbox/README.md`](working/sandbox/README.md)。

## 环境变量

- `OPENAI_API_KEY`：OpenAI API 密钥
- `OPENAI_BASE_URL`：兼容网关地址
- `WELLSPRING_HOME`：便携模式根目录；`WELLSPRING_{CONFIG,DATA,CACHE,LOG}_DIR`：覆盖各目录

## 开发

- `npm test` 运行测试
- `npm run typecheck` 类型检查
- `npm run format` 格式化代码，`npm run format:check` 只校验
