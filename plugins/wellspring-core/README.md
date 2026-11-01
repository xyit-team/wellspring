# wellspring-core

Agent 基础工具：`read`、`delete_file`、`execute_code`、`web_search`、`web_fetch`、`query_task`、`stop_task`，以及 SKILL 管理。

## 会话环境注入

新会话第一轮通过 `onSessionStart` 往 system prompt 注入一次运行环境与工具清单：

- 操作系统 / 架构 / 内核版本、Node.js 版本；
- 工作目录、当前时间（宿主时区）、会话模式、模型、沙箱权限；
- 本轮可用的工具（名称 + 一行描述，含平台内置 `ask`）。

只在第一轮注入一次；后续轮次需要追加系统提示时用 `onMessage` 的 before 阶段。

## delete_file

把 workspace 内文件或目录**移入回收站**，不直接永久删除：`path` 是工作区相对路径，目录要 `recursive: true`。
工作区根目录、含 `..` 的路径会被拒绝；当前回合权限为 `read-only` 时宿主直接拒绝写工作区。该工具需要插件
声明 `${workspace}` 的 `fs.write` 权限（已包含在 `package.json`）。

回收站放在插件数据目录，保留原相对路径，便于原样移回：

```text
<dataDir>/plugin-data/wellspring-core/trash/
  20261025-102530-1a2b3c/
    meta.json                 # at / path / type / files / bytes
    files/.tmp/old.txt        # 原文件按原相对路径存放
```

- 文件与目录都先复制进回收站，写入 `meta.json` 成功后才会删除工作区里的原条目
- 删除失败（包括 read-only 拒绝）会清掉这次复制，工作区内容与回收站都保持原样
- 回收站最多保留最近 200 次删除，超出后从最旧的条目开始清理
- 恢复：把 `files/` 下的条目移回工作区原路径；`meta.json` 里有原始路径与时间

## SKILL

遵循通用 SKILL 规范：每个技能是一个目录，内含 `SKILL.md`（YAML frontmatter + Markdown 正文），可以带脚本、模板等资源文件：

```markdown
---
name: demo-skill
description: 演示技能，说明它能做什么
whenToUse: 当用户需要演示时
license: MIT
allowed-tools: read, execute_code
metadata:
    owner: me
---

# 步骤

1. 先读文件
2. 再执行命令
```

- `name`：必填，小写字母/数字/连字符，≤64
- `description`：必填，≤1024 字符
- `whenToUse`、`license`、`allowed-tools`、`metadata`：可选
- `disable-model-invocation: true` / `user-invocable: false`：保留通用规范里的调用控制字段
- 其余 frontmatter 字段原样保留

技能保存在插件数据目录：`<dataDir>/plugin-data/wellspring-core/skills/<name>/`。

### 工具

| 工具            | 说明                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `skill_list`    | 列出已安装技能、描述、触发时机与资源文件；无效目录会出现在 `invalid`                                   |
| `skill_read`    | 读取技能正文；`file` 可读取技能目录内的资源文件                                                        |
| `skill_install` | 用 `content` 安装 SKILL.md 全文，或用 `path` 从工作区目录/`.md` 文件安装（含资源复制）                 |
| `skill_modify`  | 整篇替换 SKILL.md，或只改 `description` / `whenToUse` / 正文；标量字段传裸文本，多包一层引号会自动去掉 |

安装时校验 frontmatter、限制单文件与总资源大小、阻止资源路径越界；已存在默认拒绝，传 `overwrite: true` 覆盖。

## 网络工具

`web_search` / `web_fetch` 调 `openai.baseUrl`（DeepSeek）的 `/v1/tools/search`、`/v1/tools/fetch`。
会话 system prompt 要求：网页搜索优先用 `execute_code` 跑 `curl`；确实要用供应商联网搜索时先用 `ask` 征得用户同意。
Key 用默认供应商：`OPENAI_API_KEY` 优先，其次 `<configDir>/credentials.json`（网页「供应商」里可保存）。
缺 Key 时工具直接返回 `web.missing-api-key` 错误，不会静默返回空结果。
