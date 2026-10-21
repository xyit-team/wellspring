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
node src/index.ts start        # 以服务进程启动，Ctrl+C 或插件调用 shutdown() 退出

# 指定会话；不指定时使用当前 cwd 的最近一次会话
node src/index.ts chat --session-id 20261021-173000-ab12 "继续"

# TTY 下不带 context 进入交互式会话，提示符为 <会话名> > 或 <会话名> [run] >
node src/index.ts chat
```

`--json` 输出与内部 `Result` 对齐的 envelope：

```json
{ "success": true, "code": null, "data": { "sessionId": "...", "reply": "..." } }
{ "success": false, "code": "openai.missing-api-key", "data": null }
```

## 命令

| 命令                       | 说明                     |
| -------------------------- | ------------------------ |
| `chat [context...]`        | 对话模式，单轮或交互式   |
| `run [context...]`         | Agent 模式，单轮或交互式 |
| `session list/show/delete` | 会话列表、回放、删除     |
| `config path/show/get/set` | 配置路径、查看、读写     |
| `plugin list/link/remove`  | 插件管理                 |
| `doctor`                   | 环境诊断                 |
| `version` / `help`         | 版本与帮助               |

全局参数：`-c/--config`、`--home`、`-l/--log-level`、`--json`、`-q/--quiet`、`-h/--help`、`-v/--version`。

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
- API key 只从 `OPENAI_API_KEY` 读取，不写入配置文件

## 插件与钩子

脚手架：

```bash
node src/index.ts plugin new hello-plugin --dir ./examples
node src/index.ts plugin link ./examples/hello-plugin
```

仓库自带一个可运行示例：[examples/hello-plugin](examples/hello-plugin/index.ts)。

## 插件与钩子

插件本地安装：`node src/index.ts plugin install ./plugin.zip`（也支持目录）。

```ts
// <dataDir>/plugins/wellspring-web/index.ts
import { beforeMessage } from "wellspring/api/host/index.ts"

// 钩子可以放在模块顶层，也可以放在 setup() 里
beforeMessage(({ prompt }) => {
    prompt.push("你是一个运行在 Wellspring 里的助手")
})

export function setup() {
    return {
        id: "wellspring-web",
        name: "Wellspring Web",
        version: "0.1.0",
        commands: [
            {
                name: "web",
                summary: "启动 Web 服务端",
                run: (ctx) => {
                    ctx.output.info(`argv=${ctx.argv.join(",")}`)
                    return 0
                },
            },
        ],
    }
}
```

可用钩子：`onInit`、`onShutdown`、`beforeMessage`、`afterMessage`、`afterStep`、`afterTurn`、`onAgentCallTool`、`onAgentAsk`、`onAgentSetTask`、`onAgentSetGoal`、`onUserAnswer`。`onInit` / `onShutdown` 在 `wellspring start` 中触发；`beforeMessage` 等已接入 chat/run；Agent 相关钩子等 Agent 循环接入后触发。

服务进程里插件可以调用宿主 `shutdown()` 请求优雅关闭；用户 Ctrl+C（SIGINT）/ SIGTERM 也会触发同一关闭流程。

插件是原生 TS，类型导入必须写 `import type { Logger, PluginApi }`；Node 只擦除类型标注，不会擦除普通 import。

## 目录

- 配置：`<configDir>/app-setting.json`
- 会话：`<dataDir>/sessions/<cwd桶>/<sessionId>/`，每轮一个 `turns/NNNN.jsonl.zstd`
- 插件：`<dataDir>/plugins/<name>/`，入口导出 `setup(): WellspringPlugin`；支持 `plugin install <zip|目录>`
- 日志：`<logDir>/app.log`；human 模式 Pino 只写文件，终端输出走 `elog4js`

设计细节见 [`working/cli-design.md`](working/cli-design.md)。

## 环境变量

- `OPENAI_API_KEY`：OpenAI API 密钥
- `OPENAI_BASE_URL`：兼容网关地址
- `WELLSPRING_HOME`：便携模式根目录；`WELLSPRING_{CONFIG,DATA,CACHE,LOG}_DIR`：覆盖各目录

## 开发

- `npm test` 运行测试
- `npm run typecheck` 类型检查
- `npm run format` 格式化代码，`npm run format:check` 只校验
