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

## 目录

- 配置：`<configDir>/app-setting.json`
- 会话：`<dataDir>/sessions/<cwd桶>/<sessionId>/`，每轮一个 `turns/NNNN.jsonl.zstd`
- 插件：`<dataDir>/plugins/<name>/`，入口默认导出 `register(api)`
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
