# Wellspring 源泉 —— 聚合式 Agent 平台

## 安装

```bash
npm install -g @xyit/wellspring
wellspring version
```

npm 包只包含**宿主与 CLI**，不包含 `plugins/` 下的自带插件。Agent 工具、网页端等能力都由插件提供，
需要另行获取官方插件（仓库里的 `plugins/wellspring-core`、`plugins/wellspring-web` 等）后安装：

```bash
wellspring plugin link ./plugins/wellspring-core
wellspring plugin link ./plugins/wellspring-web
```

只安装 npm 包时 CLI 与宿主可以运行，但 Agent 没有工具，网页端也不会启动。

## 运行要求

- Node.js >= 24

## 依赖

- Pino（结构化日志，写文件）
- OpenAI SDK（模型调用）
- undici（HTTP/HTTPS 代理）
- node-pty（可选，宿主 PTY 后端；装不上时终端自动退回 python3 的 pty）

```bash
pnpm install
```

`node-pty` 没有 linux 预编译包，安装时会走 node-gyp；在设置了 HTTP(S)_PROXY 的环境里
node-gyp 下载 Node 头文件可能失败（`gyp ERR! InvalidArgumentError: invalid onError method`），
所以它放在 `optionalDependencies`：**安装不会因为它的原生构建失败而中断**，终端会自动
用内置的 python3 pty 后端。想用原生后端时执行一次：

```bash
pnpm pty:build   # 用本机 Node 自带的 include/node 头文件编译，跳过 node-gyp 的下载
```

## 快速开始

```bash
npm start                     # 无子命令，打印帮助
node src/index.ts help
node src/index.ts version
node src/index.ts config path
node src/index.ts doctor

node src/index.ts key set       # 交互式输入（不回显）；也可 echo sk-... | node src/index.ts key set
node src/index.ts key status    # 来源 + 掩码
node src/index.ts key test      # 连通性测试（拉一次模型列表）

node src/index.ts config set models.activeProvider deepseek   # 切换供应商（网页里可加自定义供应商）
node src/index.ts config set models.activeModel deepseek-chat # 切换模型
node src/index.ts config set models.activeReasoning high      # 推理等级 off/low/high/max
node src/index.ts config set network.proxy http://127.0.0.1:7890  # 出站 HTTP 代理；none 恢复直连
node src/index.ts config set network.noProxy "localhost,127.0.0.1" # 不走代理的主机（逗号/空格分隔）
node src/index.ts config set plugins.wellspring-web.host 0.0.0.0  # 插件私有配置（重启生效）

OPENAI_API_KEY=sk-... node src/index.ts chat "解释一下 EventBus"   # 也可以只用环境变量
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

Agent 消息与工具调用交替显示，工具调用单独占一行：

```text
[Agent]
好的，我将调用一次工具

执行命令  node -e "console.log('hi')"

[Agent]
hi
```

需要提权时先显示审批块（普通命令在当前权限内直接执行，不弹审批）：

```text
请求执行命令
  command node
  参数 1 -e
  参数 2 console.log('hi')
  工作目录 .
  权限 read-only → workspace-write
是否允许？[允许] [拒绝]  ←/→ 切换 · Enter 确认
  已允许提权
```

- `[Agent]` 前缀只用于 Agent 文本；非流式（管道）也会按步打印消息，和工具调用交替
- 工具调用显示为「中文动作名 + 参数摘要」：`执行命令`、`读取文件`、`搜索网页`、`抓取网页`、`询问用户` 等，与网页工具行一致
- 工具失败时在调用行下面缩进一行「失败：…」；成功不额外打状态
- TTY 下 Agent / chat 文本按 Markdown 渲染（标题、列表、表格、代码块、语法高亮）
- 图片显示为 `图片：alt（url）`，`<details>` 展开为普通文本，任务列表显示 `☑` / `☐`
- 脚注与数学公式保留原文（终端渲染器不支持）
- 非 TTY 与 `--json` 保持纯文本
- 无颜色终端用 `>` 标记当前选项
- 请求更宽权限时显示审批块：命令、每个参数、工作目录、权限变化，以及联网 / 后台 / 超时 / 标准输入等本次调用参数；`--allow-exec` 跳过

`--json` 输出与内部 `Result` 对齐的 envelope：

```json
{ "success": true, "code": null, "data": { "sessionId": "...", "reply": "..." } }
{ "success": false, "code": "openai.missing-api-key", "data": null }
```

## 命令

| 命令                                                 | 说明                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `chat [context...]`                                  | 对话模式，单轮或交互式                                     |
| `run [context...]`                                   | Agent 模式，单轮或交互式                                   |
| `start` / `stop`                                     | 服务进程启动 / 跨进程停止                                  |
| `session list/show/delete`                           | 会话列表、回放、删除                                       |
| `config path/show/get/set`                           | 配置路径、查看、读写（含 models.* / plugins.<id>.<field>） |
| `key status/set/clear/test/path`                     | 默认供应商 Key 查看、保存、清除、连通性测试                |
| `plugin list/new/install/link/enable/disable/remove` | 插件管理                                                   |
| `doctor`                                             | 环境诊断                                                   |
| `version` / `help`                                   | 版本与帮助                                                 |

全局参数：`-c/--config`、`--home`、`-l/--log-level`、`--json`、`-q/--quiet`、`-h/--help`、`-v/--version`。

## wellspring-core 插件

Agent 工具实现已抽到 [`plugins/wellspring-core`](plugins/wellspring-core)：

- `read`
- `delete_file`（把工作区文件/目录移入回收站；目录需 `recursive:true`，read-only 权限下拒绝）
- `execute_code`（支持 `background` / `network`）
- `web_search`
- `web_fetch`
- `query_task`
- `stop_task`
- `skill_list` / `skill_read` / `skill_install` / `skill_modify`（通用 SKILL.md 规范）
- `onSessionStart`：新会话第一轮向 system prompt 注入运行环境（OS / Node / 工作目录 / 时间 / 模型 / 沙箱权限）
  与本轮可用工具列表（名称 + 一行描述）

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
- `delete_file`：把 workspace 内文件或目录移入插件数据目录的回收站（`<dataDir>/plugin-data/wellspring-core/trash/<时间戳>/files/<原路径>`），不会永久删除；`path` 为工作区相对路径，目录要 `recursive:true`；工作区根目录与 `..` 路径拒绝，只读权限下不允许调用。回收站保留最近 200 次删除，恢复时把 `files/` 里的条目移回原路径即可
- `execute_code`：sandbox 内执行命令；默认 `read-only`，普通命令不弹审批；模型请求 `workspace-write` / `danger-full-access` 时才审批。
  沙箱把当前 Node 安装前缀挂到 `/opt/wellspring`（`node` / `npm` / `npx` 都在 PATH 上）；`HOME=/scratch`，
  `/tmp` 与 `/scratch` 都是单次调用生命周期，跨调用持久保留的只有 workspace 与显式导出的 artifact
- `web_search`：调用 DeepSeek Search API 搜索网页
- `web_fetch`：调用 DeepSeek Fetch API 抓取网页 Markdown 正文
- `ask`：平台内置，向用户提问并等待回答（等待上限 5 分钟）。问题触发 `onAgentAsk`；回答后触发 `onUserAnswer`，答案作为工具结果回到模型。终端里直接在命令行回答（回车跳过）；网页在输入框上方显示「Agent 提问」卡片（编号选项、推荐标记、自定义答案、跳过/收起）；网页没有应答时按未回答继续

工具 schemas 随每次模型请求的 `tools` 字段下发；能力边界写在工具 description 里，不额外注入系统提示。网络工具使用
`openai.baseUrl`（DeepSeek）与默认供应商的 Key（`OPENAI_API_KEY` 优先，其次 `<configDir>/credentials.json`），
走 `network.proxy` 代理配置；缺 Key 时直接报 `web.missing-api-key`，不会静默返回空结果。`web_fetch` 对 408/429/5xx 重试一次，并清理 Markdown 转义。DeepSeek 官方接口：

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
- `network.proxy` 为 `null` 时直连；只支持 HTTP/HTTPS 代理。可以用 CLI（`config set network.proxy <url>`、`network.noProxy`）
  或网页「网络代理」页修改；模型调用每轮重新读取配置，保存后下一轮生效，不需要重启服务
- `sandbox.mode`：`off` / `strict` / `best-effort`；`strict` 找不到 OS 后端时拒绝 Agent 代码执行，`best-effort` 才降级
- `sandbox.access`：`read-only` / `workspace-write` / `danger-full-access`；默认 `read-only`
- `--permission <mode>`：单轮覆盖 `sandbox.access`；REPL 里 `/permission [mode]`
- `sandbox.backend`：`auto` / `bwrap` / `nsjail`
- Windows / macOS 没有 bwrap：插件使用 Node permission model 作为受限 sandbox（只限制文件读写，不隔离网络与进程）；
  Agent 的 `execute_code` 仍需要 Linux bwrap，非 Linux 上请把 `sandbox.mode` 设为 `best-effort`（会降级为 direct）
- `sandbox.defaultTimeoutMs`、`defaultMemoryMB`、`outputLimitBytes`：Agent 代码执行的默认限制。
  `defaultTimeoutMs` 是唯一的超时来源（宿主 timer 杀进程，不再用 RLIMIT_CPU）；`defaultMemoryMB` 是物理内存上限，
  通过 systemd user scope 的 cgroup v2 `memory.max`（并关闭 swap）实施；宿主没有 systemd user manager 时
  降级为只限制 V8 堆。不再设置 RLIMIT_AS（它会直接打死 V8 / JVM / Go）
- 插件私有配置在 `<configDir>/plugins/<id>.json`，可用 `wellspring config get/set plugins.<id>.<field> <value>` 读写：

    ```bash
    wellspring config set plugins.wellspring-web.host 0.0.0.0
    wellspring config set plugins.wellspring-web.port 8787   # 数字会存成 number
    wellspring config get plugins.wellspring-web              # 打印整份插件配置
    ```

    值先按 JSON 解析（数字/布尔/null/对象），解析失败按裸字符串；插件配置在服务重启后生效。

    自定义供应商（OpenAI 兼容接口）与当前模型在 `app-setting.json` 的 `models` 节：

```json
{
    "models": {
        "providers": [
            {
                "id": "deepseek",
                "name": "DeepSeek",
                "baseUrl": "https://api.deepseek.com/v1",
                "models": ["deepseek-chat", "deepseek-reasoner"],
                "defaultModel": "deepseek-chat",
                "apiKeyEnv": "DEEPSEEK_API_KEY"
            }
        ],
        "activeProvider": "deepseek",
        "activeModel": "deepseek-reasoner",
        "activeReasoning": "high"
    }
}
```

- 内置供应商 id 固定为 `openai`，由 `openai.baseUrl` / `openai.model` / `OPENAI_API_KEY` 描述，不能删除
- 每个供应商的 Key 分槽存在 `credentials.json` 的 `providers` 下；`apiKeyEnv` 指定的环境变量优先
- CLI 用 `config set models.activeProvider|models.activeModel|models.activeReasoning` 切换，
  `config set network.proxy|network.noProxy` 配置出站代理；网页在「模型与供应商」里增删供应商、切换模型，
  在「网络代理」页配置代理
- 推理等级 `activeReasoning`：`off` / `low` / `high` / `max`（参考 Harness）；`off` 不发参数，
  其它按 `reasoning_effort` 发给模型接口。单轮可用 `--reasoning <level>` 覆盖

- API Key 不写进 `app-setting.json`：`wellspring key set`（或网页「供应商」里按供应商保存）保存在
  `<configDir>/credentials.json`（0600）。解析顺序：显式参数 > 环境变量 `OPENAI_API_KEY` > 本地凭据；
  CLI 输出与网页界面只展示掩码，明文不会进入日志

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
node src/index.ts plugin new my-plugin --dir ./plugins
node src/index.ts plugin link ./plugins/my-plugin      # 开发时链接（只改文件，不启动插件）
node src/index.ts plugin install ./plugins/my-plugin    # 目录或 zip；有依赖会按 packageManager 自动安装
node src/index.ts plugin remove <name>                     # 被依赖时拒绝；加 --ignore 强制删除
node src/index.ts plugin list
```

仓库自带官方插件：[plugins/wellspring-core](plugins/wellspring-core)、[plugins/wellspring-web](plugins/wellspring-web)、[plugins/wellspring-http](plugins/wellspring-http)、[plugins/wellspring-code](plugins/wellspring-code)。

### 插件依赖与 zip 分发

插件自己的 `package.json` 用标准 `packageManager` 字段声明包管理器，并正常写 `dependencies`：

```json
{
    "name": "my-plugin",
    "version": "0.1.0",
    "packageManager": "npm@11.20.0",
    "dependencies": {
        "some-package": "^1.0.0"
    }
}
```

- `plugin install` 安装目录或 zip 时，如果声明了 `dependencies` / `optionalDependencies`，会按
  `packageManager` 自动执行 `npm install` / `pnpm install` / `yarn install` / `bun install`；
- 没写 `packageManager` 时按目录里的 `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lock` 推断，
  仍无法确定则拒绝安装，避免在错误的插件目录里跑错包管理器；
- 版本号（如 `npm@11.20.0`）只作声明，实际使用 PATH 中的同名命令，不经过 corepack；
- 自动安装会执行依赖包的生命周期脚本，只安装可信来源的插件；
- 网页 `/plugins` 上传 zip 走同一条安装逻辑，单个 zip 上限 10 MB；安装依赖需要网络，耗时取决于依赖大小。

### 发版产物

推 `v*` 标签会触发两个工作流：

- `publish-npm.yml`：类型检查、全量测试、构建、tarball 冒烟后发布 npm；
- `release.yml`：把 `plugins/*/` 打包成 `<插件名>-<版本>.zip`（不含 `node_modules`，附带根 LICENSE），
  连同 `SHA256SUMS` 一起附到同名 GitHub Release。

Release 里的插件 zip 可以直接用 `wellspring plugin install <zip>` 或网页「插件管理」上传安装；
依赖会按插件 `package.json` 的 `packageManager` 在安装端自动安装。

### 入口与生命周期

```ts
import { onMessage, onSessionStart, onInit, onShutdown } from "wellspring/api/host/index.ts"
import type { Logger, PluginApi } from "wellspring/api/host/index.ts"

// 钩子可以放在模块顶层，也可以放在 setup() 里
onMessage(({ phase, prompt }) => {
    if (phase === "before") {
        prompt.push("你是一个运行在 Wellspring 里的助手")
    }
})

// 每个会话只触发一次：新会话的第一轮开始前注入一次性 system prompt
onSessionStart(({ prompt, cwd }) => {
    prompt.push(`你当前的工作区是 ${cwd}`)
})

export function setup() {
    return {
        id: "my-plugin",
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

| 成员                       | 说明                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `apiVersion`               | 宿主 API 版本                                                 |
| `plugin`                   | `{ id, name, version }`                                       |
| `paths`                    | 配置、数据、缓存、日志根目录                                  |
| `config`                   | 全局配置 `AppSetting`                                         |
| `logger`                   | pino Logger                                                   |
| `output`                   | `info` / `warn` / `error` / `print`，走终端渲染               |
| `pluginDataDir`            | 插件数据目录，已创建                                          |
| `pluginConfig`             | `<configDir>/plugins/<id>.json` 内容                          |
| `fs`                       | 插件数据目录内的文件 API                                      |
| `workspaceFs`              | 当前工作目录的文件 API，需 `fs.read` 声明 `${workspace}`      |
| `registerCommand(command)` | 运行时注册命令                                                |
| `registerAgentTool(tool)`  | 运行时注册 Agent 工具                                         |
| `pluginData(pluginId)`     | 读取依赖插件的数据目录，无权限返回 `null`                     |
| `capabilities`             | 代码执行与网络能力                                            |
| `http`                     | 宿主 HTTP/HTTPS/SSE/WebSocket 服务（只给 wellspring-http 用） |
| `workspaces`               | 宿主级工作区注册表：列表 / 添加 / 移除 / 重命名 / touch       |
| `fileRoots`                | 按绝对目录打开文件 API，需 `hostApi: fileRoots`（可信插件）   |
| `agent`                    | 与 Agent 会话交互，`chat({ message, sessionId? })`            |
| `network`                  | 出站代理配置：`state()` / `saveProxy({ url, noProxy? })`      |

#### capabilities

| 方法                         | 说明                                             |
| ---------------------------- | ------------------------------------------------ |
| `executeCode(input)`         | 在 sandbox 执行命令，仅 Agent 工具调用上下文可用 |
| `startBackgroundCode(input)` | 启动后台任务，返回 `{ taskId, sandboxId }`       |
| `queryTask(taskId?)`         | 查询任务状态与实时 stdout/stderr                 |
| `stopTask(taskId, mode)`     | 停止任务，`ctrl_c` 或 `kill`                     |
| `webSearch(query, count?)`   | DeepSeek 网页搜索                                |
| `webFetch(url)`              | 抓取网页并转 Markdown                            |

#### agent

| 方法                                                                                   | 说明                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `agent.chat({ message, sessionId?, model?, system?, cwd?, references?, permission? })` | 执行一轮 Agent 对话，返回 `{ sessionId, turn, steps, reply, model, usage }`                                   |
| `agent.stream(input, onEvent)`                                                         | 同上，通过 `onEvent` 推送 `delta` / `reasoning` / `tool` / `ask` / `step` / `approval` 事件；RPC 不设超时上限 |
| `agent.respondAsk(askId, answer)`                                                      | 回答 `ask` 工具的提问，返回是否命中等待中的问题                                                               |
| `agent.validateWorkspace(path)`                                                        | 校验目录存在且是目录，返回 `{ ok, root, name, error? }`                                                       |
| `agent.pickDirectory()`                                                                | 打开宿主系统的原生文件夹对话框，返回选中的目录                                                                |

事件类型：`delta`（正文增量）、`reasoning`（模型思考增量 `reasoning_content`）、`tool`（工具调用开始 / 结束，
带 `phase`、参数、结果与 `ok`）、`ask`（Agent 提问，带 `askId`、`question`、`options?`）、`step`（进入第几步）、
`approval`（提权审批）。
不传 `sessionId` 时创建新会话；传入上一次返回的 `sessionId` 可继续对话。会话写入正常的 Wellspring 会话存储。
`permission` 可以按轮覆盖 `sandbox.access`（`read-only` / `workspace-write` / `danger-full-access`），
不传时用宿主配置；覆盖会写一条 WARN 日志。
`cwd` 用于让这次会话在指定目录下运行；会话按 cwd 分桶存储，因此同一 `sessionId` 需要搭配同一 `cwd`。

流式执行中，如果 `execute_code` 请求比当前权限更宽的 access，宿主会发出 `{ type: "approval", request }` 并等待
`agent.respondApproval(request.approvalId, approved)`；超时（120s）按拒绝处理。

#### workspaces

工作区（用户手动添加的目录）是**宿主级**概念，注册表存在 `<dataDir>/workspaces.json`，
插件通过 `api.workspaces` 读写，不再解析其它插件的数据目录。需要 `hostApi: workspaces` 权限。

| 方法                              | 说明                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| `workspaces.list()`               | `{ workspaces: [{ id, name, root, createdAt, lastSeenAt }] }`       |
| `workspaces.add({ root, name? })` | 添加已存在的绝对路径目录；重复添加返回已有记录（`duplicate: true`） |
| `workspaces.rename(id, name)`     | 重命名；不存在返回 `null`                                           |
| `workspaces.touch(id)`            | 刷新 `lastSeenAt`；不存在返回 `null`                                |
| `workspaces.remove(id)`           | 只从注册表移除，不动目录本身                                        |

```ts
const { workspaces } = await api.workspaces.list()
const added = await api.workspaces.add({ root: "/home/me/project", name: "项目" })
```

- 工作区 id 由目录路径派生（名称片段 + 路径哈希），同一目录重复添加不会产生重复条目
- 最多 40 个工作区；名称 1–60 字符；注册表损坏会备份成 `workspaces.json.broken` 后按空表启动
- 首次加载会兼容迁移旧版 `wellspring-web` 插件数据目录里的工作区索引（只读 id / 名称 / 路径 / 时间）

#### fileRoots

编辑器这类需要让用户选择任意目录的插件，可以用 `api.fileRoots.open(root)` 打开以绝对目录为根的
`HostFileApi`。需要 `hostApi: fileRoots` 权限；只授予可信插件（当前只有 `wellspring-code`）。

```ts
const fs = await api.fileRoots.open("/home/me/project")
const entries = await fs.list("src")
```

返回的 API 路径仍然只能是相对路径，宿主会再次检查越界；`open` 只接受已存在的绝对目录。

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
- `onInit` / `onShutdown` / `onMessage` / `onSessionStart` 等钩子
- 全部 `PluginApi`、`PluginCommand`、`AgentTool`、`HttpServerHandle` 等类型

### 钩子

`onInit`、`onShutdown`、`onMessage`、`onSessionStart`、`beforeTurn`、`beforeStep`、`afterStep`、`afterTurn`、`onAgentRunSync`、`onAgentRunAsync`、`onAgentAsyncTaskComplete`、`onAgentCallTool`、`onAgentAsk`、`onAgentRead`、`onAgentQueryTask`、`onAgentSubmit`、`onAgentSetTasks`、`onAgentSetGoal`、`onAgentRequestPermission`、`onUserAnswer`。

- `onMessage` 取代原来的 `beforeMessage` / `afterMessage`：`phase: "before" | "after"`，before 阶段可修改 `prompt`
- `onSessionStart` 只在**会话第一轮**开始前触发一次（新会话的第一次对话；chat 和 run 都会触发），
  入参是 `SessionStartEvent`（`input` / `cwd` / `time` / `timeZone` / `model` / `permission` / `tools`），
  可以往 `prompt` 里追加一次性 system 提示；`tools` 是本轮可调用的工具（名称 + 描述，含内置 `ask`）。
  第二轮起再注入请用 `onMessage`。core 插件已用这个钩子注入运行环境与工具清单
- `onAgentSetTasks` 取代 `onAgentSetTask`
- `onAgentRunSync` 在 `run` 模式开始前触发
- `onAgentRunAsync` 在 Agent 创建异步任务之前触发，`onAgentAsyncTaskComplete` 在异步任务完成后触发（当前还没有异步任务实现，钩子已暴露，暂不触发）
- `beforeTurn` / `beforeStep` / `afterStep` / `afterTurn` 已接入 chat/run
- 所有钩子入参都是 `XxxEvent` 类，例如 `SessionMessageEvent`、`BeforeTurnEvent`、`AgentCallToolEvent`
- `onAgentCallTool`、`onAgentAsk`、`onAgentRead`、`onAgentQueryTask`、`onAgentSubmit`、`onAgentSetTasks`、`onAgentSetGoal`、`onAgentRequestPermission`、`onUserAnswer` 已在 Agent 循环里触发
- `onAgentAsk` 带 `askId`、`turn`、`step`、`question`、`options?`；用户回答后 `onUserAnswer` 带同一个 `askId` 与 `answer`。网页通过 `agent.respondAsk(askId, answer)` 交答案
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
- bridge 请求默认 30 秒超时；`agent.stream` 不设上限（一轮对话的时长由模型与工具步骤决定，不能按固定秒数掐断），
  `agent.chat` 为 180 秒
- `hostApi` 默认包含 `logger` / `fs` / `event` / `getHost` / `shutdown`；`workspaceFs` 仍需在 `fs.read` 里声明 `${workspace}`
- `models` / `plugins` / `workspaces` / `fileRoots` / `http` / `exec` / `pty` / `capabilities` 需要在 `hostApi` 中显式声明；
  `http` 只保留给 `wellspring-http`，普通插件请走上面的 `wellspring/api/plugin/http-client.ts`
- `hostApi: "plugins"` 提供 `api.plugins.list/install/remove/enable/disable`：安装只接受 zip（≤10MB）；
  启用/禁用与禁用后的卸载即时生效，安装与禁用 `wellspring-web` 重启后生效；卸载 `wellspring-web` 被拒绝
- `${workspace}` 默认只读，写 workspace 需放进 `fs.write`
- 没有可用 OS 后端时插件加载失败；插件不做 direct 降级
- `sandbox.mode: off` 时插件全部拒绝加载
- Linux 后端为 `bwrap`；当前环境若不允许非特权 user namespace，strict 会拒绝加载

### 插件的 HTTP 服务

平台里只有 `wellspring-http` 插件持有 `hostApi.http`；所有监听端口都由它创建。其它插件在
`setup().deps` 里声明 `wellspring-http`，然后用事件总线注册服务器（消费者 helper：
`wellspring/api/plugin/http-client.ts`，协议：
`wellspring/api/plugin/http-protocol.ts`）：

```ts
import type { HttpRequest, HttpResponse } from "wellspring/api/host/index.ts"
import { eventBus } from "wellspring/api/host/index.ts"
import { registerHttpServer } from "wellspring/api/plugin/http-client.ts"

export function setup() {
    return {
        // ...
        deps: ["wellspring-http"],
        init: async (api) => {
            const server = await registerHttpServer(
                eventBus,
                { name: "my-app", host: "127.0.0.1", port: 8787 },
                async (request: HttpRequest, stream): Promise<HttpResponse> => ({
                    status: 200,
                    headers: { "content-type": "text/plain" },
                    body: `hello ${request.url}`,
                }),
            )
            api.output.info(`listening on http://${server.host}:${server.port}`)
        },
    }
}
```

- `host` 可以是 loopback（默认 `127.0.0.1`），也可以是 `0.0.0.0` / `::` / 指定网卡地址
- `port: 0` 使用随机端口，实际端口在返回的 `server.port` 里
- HTTPS 传 `tls: { cert, key, ca? }`（PEM 字符串）；证书可以放在插件 data 目录用 `api.fs` 读
- 请求体以 base64 传入、响应可返回 `utf8` 或 `base64`；`stream: true` + `stream.write/end` 支持 SSE；
  `websocket: (socket, request) => void` 支持 WebSocket 升级（不传则升级请求返回 1008）
- 请求/响应经事件总线转发，**单个体上限 2.5 MiB**（sandbox 单帧 4 MiB）；超限请求返回 `413`，
  超限响应返回 `502`。需要传大文件请按分片接口设计
- 启动失败（端口占用 / 重名 / TLS 不合法）会让 `registerHttpServer` reject，可以按失败插件处理
- 插件 `onShutdown` 里 `await server.close()`；wellspring-http 关闭时所有托管服务器一起关闭
- 细节、完整事件表与错误码见 [`plugins/wellspring-http/README.md`](plugins/wellspring-http/README.md)

因为 `deps` 是硬依赖，没链接 `wellspring-http`（或它被禁用）时依赖方会以「依赖不存在 / 依赖被禁用」失败。
`package.json` 里也不再需要 `hostApi: ["http"]`——`api.http` 只剩 wellspring-http 自己使用。

前端可以自由选择框架。`wellspring-web` 使用 **Vue 3 + Vite**：前端源码在 `plugins/wellspring-web/frontend/`，
构建产物打包成插件内 TS 资源，由插件自己的 HTTP 服务同源下发（严格 CSP，无 `unsafe-eval`、无外部 CDN）。
改前端后执行 `node plugins/wellspring-web/scripts/build-ui.mjs` 再重启服务。

### wellspring-http 插件

`plugins/wellspring-http` 是平台里唯一的 HTTP 服务器管理器：校验注册参数、创建 HTTP/HTTPS/WebSocket
服务器、把请求转发给注册方、注销与关闭时统一释放端口，并广播 `wellspring-http:servers` 列表。

```bash
wellspring plugin link plugins/wellspring-http
```

- 事件频道：`wellspring-http:register` / `wellspring-http:unregister`，每个服务器的
  `wellspring-http:request:<name>` / `wellspring-http:response:<name>`
- 错误码：`port-in-use`、`permission-denied`、`address-unavailable`、`invalid-register`、
  `duplicate-name`、`listen-failed`
- 测试：`node --test test/http-plugin.test.ts`（fixture 消费者覆盖请求、SSE、错误、超时、重名、
  端口占用与 WebSocket）

### Web 插件

`plugins/wellspring-web` 提供网页聊天界面，依赖 `wellspring-http`：

```bash
wellspring plugin link plugins/wellspring-http
wellspring plugin link plugins/wellspring-web
wellspring start
```

打开 `http://127.0.0.1:8787`。

- 第一次访问设置密码，密码以 scrypt 哈希保存在 `<dataDir>/plugin-data/wellspring-web/auth.json`
- 侧栏「修改密码」：校验当前密码后更新哈希并让其他设备重新登录；密码至少 6 位、最多 200 位
- 之后访问需要登录；登录 token 只保存在服务进程内存，重启后需要重新登录
- 聊天通过 `/api/chat/stream` SSE 调用 `api.agent.stream`，会话保存到标准会话存储；流开始时先收到会话 id，
  回复中途刷新页面会自动接续这一轮（`/api/chat/resume` 重放并继续接收），之后发消息仍续同一个 Agent 会话。
  本轮开始、每步结束和收尾都会落盘：服务重启或进程被停掉时，已经开始的一轮不会从会话里消失。
  刷新时浏览器中断 SSE 读取不算回复失败：那一轮只在服务端跑完或续接失败时才落到错误态
- 所有界面都是路由（`/`、`/c/<id>`、`/providers`、`/network`、`/plugins`、`/password`、`/status`、`/extensions`、`/ext/<id>`，其它地址进 404），
  侧栏入口是链接、当前页高亮，刷新或直达任意深层地址都能打开；未登录时重定向到 `/login` 并在登录后回到原地址
- 每个会话有自己的地址 `/c/<id>`（发出第一条消息后写入），浏览器前进后退、刷新都停在这个会话；
  在设置页面点侧栏里的会话直接回到对话，不需要先点右上角返回按钮
- 回复中可以插话：消息在 Agent 下一次模型调用前注入同一轮，作为过程行显示在回复里；没赶上本轮结束就按下一轮排队
- 长会话默认只渲染最近 30 条消息，顶部「加载更早」按页补回更早的记录并保持阅读位置；保存与导出不受影响
- 网络代理（`/network`）：配置出站 HTTP/HTTPS 代理与 `noProxy`，写入宿主 `app-setting.json`；
  保存后下一轮模型调用、拉取模型列表与 `web_search` / `web_fetch` 生效，无需重启服务
- 模型上下文窗口可配置（`128K` / `1M` 写法），模型菜单显示配置值；输入框下方的一行统计显示当前会话的上下文占用，
  优先用最近一次请求的真实 prompt tokens，旧会话才回退到按字符数估算
- Token 统计：输入框下方常显「上下文占用 · 会话用量 · 缓存命中率」，点开是完整明细
  （未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 推理 / 合计）；每条回复下方的「用量」按钮显示本轮用量与缓存命中，
  点开看该轮明细。缓存命中来自供应商返回的 `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`，
  供应商不返回缓存用量时只显示输入与输出
- 网页端插件管理（`/plugins`）：列表、启用/禁用、卸载（先禁用后即时生效）、上传 zip 安装
  （按插件 `packageManager` 自动安装依赖；重启生效）；
  禁用 `wellspring-web` 需二次确认且重启后生效
- 思考链与工具调用：Agent 的思考内容默认折叠成一行「思考」（只显示摘要，流式时跟随最后一个完成段落），
  工具调用折叠成一行「读取文件 / 执行命令 …」（参数摘要 + 运行中 / 完成 / 失败）；点开看完整内容。
  正文、思考、工具行按发生顺序穿插，和 Harness 一致；随会话保存（含正文偏移），刷新后顺序不变
- 侧栏「关闭 Wellspring」：二次确认后优雅关闭服务（等价于 `wellspring stop`），先执行插件 onShutdown
  再清理服务记录；会话与工作区数据保留，需要时重新 `wellspring start`
- 字体与字号沿用 code 插件的设计 token：界面与代码统一使用系统等宽字体
  （Windows Consolas、macOS Menlo/Monaco、Linux DejaVu Sans Mono / Ubuntu Mono、Android Droid Sans Mono），
  `--font-size-xs: 1rem` … `--font-size-8xl: 3.7rem`
  的 rem 阶梯，根字号默认 `1rem`
- 输入框左侧有 Agent 权限切换器（只读 / 工作区可写 / 完全访问），每个会话独立保存；切到「完全访问」会二次确认，
  并常驻红色警告条；新会话默认沿用最近一次选择。权限随每次聊天请求传给宿主
- 侧栏「供应商」里按供应商管理 Key（内置 openai 也在其中，支持保存 / 清除 / 拉取模型）；
  保存后下一轮对话立即生效，不需要重启服务。聊天失败会提示去「供应商」里补 Key
- 输入框左侧的模型按钮是轻量「切换模型」下拉：按供应商分组列出模型，点一下即切换，只影响当前会话（对之后的回合生效）；
  同一菜单顶部可切推理等级（off / low / high / max），按钮上显示「模型 · 等级」。模型、推理等级、权限都按会话保存，
  切会话会恢复那个会话自己的设置；新会话的模型/推理等级沿用**全局默认**——在侧栏「供应商」里点模型按钮设置，
  只影响之后新建的会话，已有会话保持自己的模型
- 侧栏「供应商」是独立页面（`/providers`）：接入任意 OpenAI 兼容供应商（Base URL + Key + 模型列表，可一键拉取模型），
  按供应商分别保存 / 清除 Key、删除自定义供应商；切换模型后网页会把 provider/model 一起发给宿主
- 页面、样式和脚本由插件以静态资源提供，HTML 不含内联脚本，因此可以下发严格 CSP
- 主题（跟随系统 / 浅色 / 深色）写进 cookie，服务端渲染 `data-theme`，首屏不闪
- 工作区由用户在页面里手动添加：调用宿主系统的原生文件夹对话框，Agent 在该目录下运行；
  工作区注册表由**宿主**统一维护（`api.workspaces`），Web 插件只保存每个工作区的会话；
  侧边栏显示工作区列表，可切换；移除工作区后会话进入「未分组」继续保留
- 输入框支持 `/` 指令菜单与 `@` 工作区文件引用：文件名 / 路径段 / 子序列模糊匹配并排序（文件名前缀优先，忽略大小写），
  `assets/app` 这类多段路径按段命中，深层文件与中文文件名可搜，目录可逐级下钻；`@` 可紧跟汉字或中文标点，
  菜单里的命中片段与输入框里的引用文本都会高亮（带空格的路径用 `@"…"` 引号形式）；
  相对路径在发送时附给 Agent，Agent 可按路径读取
- Agent 请求提权时网页弹出审批框：完整命令行、逐个参数、工作目录、权限变化，以及联网 / 后台 / 超时 / 标准输入与理由；批准后仅本次命令生效，超时按拒绝处理
- Agent 用 `ask` 工具提问时，网页在输入框上方显示「Agent 提问」卡片（参考 Harness）：问题标题、
  编号选项（标签带「（推荐）」时显示「推荐」徽标）、自定义答案输入行、跳过/收起/关闭；
  回答写到 `/api/asks/<askId>`，Agent 拿到答案继续本轮。停止生成时自动按跳过释放等待
- 工作区索引在 `<dataDir>/workspaces.json`（宿主级，插件通过 `api.workspaces` 访问）；
  会话仍按工作区保存在 `<dataDir>/plugin-data/wellspring-web/workspaces/`，未分组会话在 `ungrouped/`；
  首次启动会把旧版插件数据目录里的 `workspaces.json` 自动迁移到宿主注册表
- 工作区注册表由宿主维护（`<dataDir>/workspaces.json`），插件通过 `api.workspaces` 访问，需要 `workspaces` 权限；
  添加工作区时由宿主校验目录（原生对话框走 `agent` 权限）；系统状态页面（`/status`）与工作区目录展示需要 `getHost` 权限
- 登录失败按来源地址限流（5 次后锁定 60 秒）；写接口要求 JSON 且校验同源 `Origin`
- 其它插件可通过事件总线注册 `wellspring-web:addon:register`（`nav-bottom`），网页在侧栏底部实时显示链接
- 默认监听 `127.0.0.1:8787`，可在 `<configDir>/plugins/wellspring-web.json` 覆盖，或用
  `wellspring config set plugins.wellspring-web.host 0.0.0.0`（改完重启服务）：

```json
{ "host": "0.0.0.0", "port": 8787 }
```

路由、配置与设计说明见 [`plugins/wellspring-web/README.md`](plugins/wellspring-web/README.md)。

### Code 插件（VS Code 风格）

`plugins/wellspring-code` 提供浏览器里的 VS Code 风格代码编辑器，只依赖 `wellspring-http`
（Web 插件是可选搭配：装了就多一个侧栏入口）：

```bash
wellspring plugin link plugins/wellspring-http
wellspring plugin link plugins/wellspring-code
# 可选：网页聊天界面
wellspring plugin link plugins/wellspring-web
wellspring start
```

打开 `http://127.0.0.1:8788`（与 Web 插件默认的 `8787` 不冲突）。

- 工作区由 code 插件自己管理（`<dataDir>/plugin-data/wellspring-code/workspaces.json`），
  在切换面板里可以添加机器上任意绝对目录；不依赖宿主工作区注册表，也不依赖 `wellspring-web`
- 装了 Web 插件时，会通过事件总线注册 `nav-bottom` 扩展，在网页侧栏底部显示「代码编辑器」入口
  （指向本服务地址）；没装 Web 也不影响使用
- 文件能力来自 `api.fileRoots.open(root)`，不受服务进程 cwd 限制；
  添加与切换需要 `hostApi` 的 `fileRoots` 与 `agent`（系统目录选择）权限
- 包含资源管理器、标签页、语法高亮、自动补全、语法诊断、括号配对高亮、缩进参考线、文件/工作区符号搜索与转到定义、
  行号、缩略图、查找替换、全文搜索、命令面板、Git 面板（改动列表 / 暂存 / 并排 diff 窗口 / 树标记）、状态栏、
  Markdown 与图片预览、深浅主题；标签 / 最近打开 / 展开状态按工作区隔离
- 长文件（>1200 行或 60KB）按 400 行分片着色；组合输入期间暂停镜像层 / 缩略图 / 诊断重算；
  按工作区 + 文件路径记住滚动与光标位置，刷新、重新打开或切回标签时恢复
- 可选的单用户访问密码：设置后所有 API 要登录，支持登录页、退出与改密；可监听 `0.0.0.0` 并内置 TLS，
  也可以放在 TLS 反代后远程访问
- 移动端可用：侧栏抽屉选中文件后自动收起、编辑器触摸滚动、控制台点击唤起软键盘，
  高度跟随可视视口（`visualViewport`）
- 前端为 Vue 3（Vite 构建产物打包成插件内 TS 资源），页面只含挂载点与 SPRITE；
  严格 CSP，HTML 不含内联脚本/样式，也不需要 `unsafe-eval`
- 图标来自 Lucide（ISC License），内联 SVG 精灵，不请求外部 CDN；Wellspring logo 保持自有
- 写接口校验 JSON、请求体大小与同源 `Origin`；带 `baseMtimeMs` 的保存会检测磁盘冲突
- 默认只监听 `127.0.0.1:8788`，可在 `<configDir>/plugins/wellspring-code.json` 覆盖：

```json
{ "host": "127.0.0.1", "port": 8788, "readOnly": false }
```

- 没有 LSP：自动补全只用当前语言的关键字 / 类型 / 字面量与文件内标识符做前缀匹配，
  语法高亮由插件自带的词法着色实现；语法诊断只做括号/字符串/注释/JSON 的结构检查，不做语义分析；
  转到定义只查当前文件与已打开标签里的符号名；工作区符号索引按行级正则扫描文本文件，不做类型解析

路由、快捷键与设计说明见 [`plugins/wellspring-code/README.md`](plugins/wellspring-code/README.md)。

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

关闭不会因为浏览器的 SSE / 长连接而卡住：HTTP 服务器先等 800ms 让请求收尾，然后强制断开剩余连接；
插件 `onShutdown` 超过 10 秒会强制退出。第一次 Ctrl+C 走优雅关闭，再按一次立即退出。

插件是原生 TS，类型导入必须写 `import type { Logger, PluginApi }`；Node 只擦除类型标注，不会擦除普通 import。

## 目录

- 配置：`<configDir>/app-setting.json`；API Key：`<configDir>/credentials.json`（0600，与环境变量分开）
- 会话：`<dataDir>/sessions/<cwd桶>/<sessionId>/`，`turns/NNNN.jsonl.zstd` 是事件段；一轮会在开始、每步结束和收尾时各落一段，中断后已产生的部分可回放
- 插件：`<dataDir>/plugins/<name>/`，入口导出 `setup(): WellspringPlugin`；支持 `plugin install <zip|目录>`
- 工作区注册表：`<dataDir>/workspaces.json`（宿主级，`wellspring-web` 通过 `api.workspaces` 访问）；
  `wellspring-code` 使用自己的 `<dataDir>/plugin-data/wellspring-code/workspaces.json`
- 插件配置/数据：`<configDir>/plugins/<id>.json`、`<dataDir>/plugin-data/<id>/`
- 服务状态：`<dataDir>/service.json`
- 日志：`<logDir>/app.log`；human 模式 Pino 只写文件，终端输出走 `elog4js`

设计细节见 [`working/cli-design.md`](working/cli-design.md)；Sandbox/OS 级隔离与 Agent 代码执行设计见 [`working/sandbox/README.md`](working/sandbox/README.md)。

## 环境变量

- `OPENAI_API_KEY`：OpenAI API 密钥；设置时优先于 `<configDir>/credentials.json`，便于 CI / 临时覆盖
- `OPENAI_BASE_URL`：兼容网关地址
- `WELLSPRING_HOME`：便携模式根目录；`WELLSPRING_{CONFIG,DATA,CACHE,LOG}_DIR`：覆盖各目录

## 开发

- `npm test` 运行测试
- `npm run typecheck` 类型检查
- `npm run format` 格式化代码，`npm run format:check` 只校验
