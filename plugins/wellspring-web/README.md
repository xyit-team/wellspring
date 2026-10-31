# wellspring-web

Wellspring Agent 的网页聊天界面，前端是 **Vue 3 + Vite**（构建产物打包成插件内 TS 资源，
由插件 HTTP 服务同源下发）。不依赖外部 CDN；严格 CSP，不需要 `unsafe-eval`。
前端带 NProgress 顶部进度条与 vue3-toastify 提示，并支持可安装的 **Web 扩展**（`.vue` 单文件组件）。

## 加载

依赖 `wellspring-http`（服务器由它统一创建），两者都要链接：

```bash
wellspring plugin link plugins/wellspring-http
wellspring plugin link plugins/wellspring-web
wellspring start
```

打开 `http://127.0.0.1:8787`。

## 配置

`<configDir>/plugins/wellspring-web.json`：

```json
{ "host": "127.0.0.1", "port": 8787 }
```

`port: 0` 表示随机端口，启动日志里会打印实际地址。

也可以用 CLI 写这个文件（重启服务后生效）：

```bash
wellspring config set plugins.wellspring-web.host 0.0.0.0
wellspring config set plugins.wellspring-web.port 8787
wellspring config get plugins.wellspring-web
```

## 路由

前端使用 Vue Router（history 模式），服务端对所有非 `/api`、非静态资源路径回同一份 Vue 外壳：

| 路径 | 页面 |
| --- | --- |
| `/` | 聊天主界面（新会话） |
| `/c/<id>` | 单个会话（刷新、直达与浏览器前进后退都回到这个会话） |
| `/providers` | 模型与供应商（模型 / Key / 上下文窗口） |
| `/network` | 网络代理（HTTP/HTTPS 代理与 noProxy） |
| `/plugins` | 插件管理（启用/禁用/卸载/上传安装） |
| `/password` | 修改访问密码 |
| `/status` | 系统状态（宿主、运行时、插件列表） |
| `/extensions` | Web 扩展管理（安装/删除/恢复/打开） |
| `/ext/<id>` | 单个扩展页面（页面型接管内容区，面板型套在面板卡片里） |
| `/login` | 登录 / 首次设置密码（未登录时其它路由都重定向到这里，带 `redirect` 参数） |
| `/shutdown` | 服务已关闭提示 |
| 其它 | 404 页面（可进扩展、供应商、状态，或直接点侧栏会话） |

所有页面都是路由，没有整页跳转：侧栏入口是 `RouterLink`，当前页在侧栏里高亮；刷新或直达任意地址
（含 `/c/<id>`、`/ext/<id>`、`/providers` 这类深层地址）都能直接打开对应页面。登录后回到被拦下的原地址。
会话也是路由：每个会话的地址是 `/c/<id>`，发出第一条消息后写入；在设置页面点侧栏里的会话就回到那个会话，
不需要先找右上角的返回按钮（顶部不再有「返回聊天」）。
扩展列表里的「打开」统一进 `/ext/<id>`：页面型扩展接管内容区，面板型渲染成面板卡片，都是独立页面，
不再是浮层。仍留在页面内的浮层只有确认框、提权审批与 Agent 提问。

## 页面覆盖

`<dataDir>/plugin-data/wellspring-web/page.html` 存在且非空时，`GET /` 返回这个文件而不是内置模板，
改完刷新浏览器即生效，不必重启进程。文件里的 `{{theme}}` 替换成主题属性（跟随主题 cookie），
不写占位符则整页原样返回，首屏可能先闪一下主题色。

```bash
curl -s http://127.0.0.1:8787/ > <dataDir>/plugin-data/wellspring-web/page.html
```

文件不存在、为空或读取失败时回退到 `src/pages.ts` 的内置模板。覆盖文件不随插件升级更新，
不需要时删掉即可；页面结构改动后要重新导出，否则内置模板的新内容看不见。

## 路由

| 方法   | 路径                                        | 说明                                                                     |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/`                                         | 页面外壳                                                                 |
| GET    | `/assets/app.css`                           | 样式表                                                                   |
| GET    | `/assets/app-vue.js`                        | Vue 客户端脚本（ESM 构建产物）                                           |
| GET    | `/assets/app-vue.css`                       | 前端样式（NProgress / Toastify / 扩展）                                  |
| GET    | `/api/extensions`                           | 已安装的 Web 扩展列表                                                    |
| POST   | `/api/extensions/install`                   | 上传安装 `.vue` 扩展（base64）                                           |
| DELETE | `/api/extensions/<id>`                      | 删除网页安装的扩展                                                       |
| GET    | `/extensions/<id>.js`                       | 扩展编译后的 ES 模块                                                     |
| GET    | `/extensions/<id>.css`                      | 扩展编译后的样式                                                         |
| GET    | `/favicon.svg`                              | 图标                                                                     |
| GET    | `/api/state`                                | 是否已设置密码、当前是否已登录、版本号                                   |
| POST   | `/api/auth/setup`                           | 首次设置密码，成功后直接建立会话                                         |
| POST   | `/api/auth/login`                           | 登录                                                                     |
| POST   | `/api/auth/logout`                          | 退出登录                                                                 |
| POST   | `/api/shutdown`                             | 优雅关闭 Wellspring 服务（需要登录）                                     |
| GET    | `/api/host`                                 | 宿主状态、OS、路径与插件列表（需要登录）                                 |
| POST   | `/api/auth/password`                        | 修改访问密码 `{ currentPassword, newPassword }`                          |
| GET    | `/api/models`                               | 供应商列表、Key 状态（掩码）、当前供应商与模型                           |
| POST   | `/api/models/active`                        | 切换当前供应商/模型/推理 `{ providerId, model, reasoning }`              |
| POST   | `/api/models/provider`                      | 新增/更新自定义供应商（可带 `apiKey`）                                   |
| POST   | `/api/models/provider/remove`               | 删除自定义供应商 `{ id }`                                                |
| POST   | `/api/models/fetch`                         | 拉取供应商模型列表 `{ id, apiKey? }`                                     |
| POST   | `/api/models/key`                           | 保存供应商 Key `{ id, apiKey }`                                          |
| POST   | `/api/models/key/clear`                     | 清除供应商本地 Key `{ id }`                                              |
| GET    | `/api/models/context`                       | 读取各 provider/model 的上下文窗口配置                                   |
| POST   | `/api/models/context`                       | 批量保存/清除上下文窗口（`items: [{ provider, model, contextWindow }]`） |
| GET    | `/api/network`                              | 读取宿主代理配置 `{ proxy: null \| { type, url, noProxy } }`             |
| POST   | `/api/network`                              | 保存代理 `{ url, noProxy? }`；`url` 为 null 表示直连                     |
| GET    | `/api/plugins`                              | 已安装插件列表（含禁用 / 加载失败 / 未加载）                             |
| POST   | `/api/plugins/install`                      | 上传 zip 安装 `{ filename, dataBase64, force? }`                         |
| POST   | `/api/plugins/remove`                       | 卸载插件 `{ id }`；`wellspring-web` 与仍被依赖的插件会被拒绝             |
| POST   | `/api/plugins/enable`                       | 启用插件 `{ id }`，重启后生效                                            |
| POST   | `/api/plugins/disable`                      | 禁用插件 `{ id }`，重启后生效；`wellspring-web` 也允许禁用               |
| GET    | `/api/addons`                               | 侧栏扩展链接快照（需要登录）                                             |
| GET    | `/api/addons/stream`                        | 侧栏扩展 SSE，注册新链接时实时推送                                       |
| GET    | `/api/workspaces`                           | 已添加的工作区列表与未分组会话数                                         |
| POST   | `/api/workspaces`                           | 添加工作区 `{ root, name? }`                                             |
| DELETE | `/api/workspaces/<id>`                      | 移除工作区，会话转入未分组                                               |
| GET    | `/api/files`                                | 工作区文件搜索（`workspaceId` 或 `workspaceRoot`，加 `q`）               |
| POST   | `/api/picker`                               | 打开宿主系统的原生文件夹对话框                                           |
| GET    | `/api/ungrouped/conversations`              | 未分组会话，含 `activeId`                                                |
| PUT    | `/api/ungrouped/conversations/<cid>`        | 保存未分组会话                                                           |
| DELETE | `/api/ungrouped/conversations/<cid>`        | 删除未分组会话                                                           |
| POST   | `/api/ungrouped/conversations/active`       | 记住未分组里选中的会话                                                   |
| GET    | `/api/workspaces/<id>/conversations`        | 该工作区的会话，含 `activeId`                                            |
| GET    | `/api/workspaces/<id>/conversations/<cid>`  | 单个会话的完整消息                                                       |
| PUT    | `/api/workspaces/<id>/conversations/<cid>`  | 新增或覆盖会话                                                           |
| DELETE | `/api/workspaces/<id>/conversations/<cid>`  | 删除会话                                                                 |
| POST   | `/api/workspaces/<id>/conversations/active` | 记住当前选中的会话                                                       |
| POST   | `/api/chat`                                 | 一次性对话（`workspaceId` 或未分组的 `workspaceRoot`）                   |
| POST   | `/api/chat/stream`                          | SSE 流式对话（同上，可带 `conversationId` 供续接）                       |
| GET    | `/api/chat/resume`                          | 重连续接正在进行的回复（`conversationId`，可选 `since` / `peek`）        |
| POST   | `/api/chat/interject`                       | 向运行中的回合插话（`conversationId` + `message`）                       |
| POST   | `/api/chat/stop`                            | 停止正在跑的一轮（`conversationId`），转成 `api.agent.stop`              |
| GET    | `/api/chat/running`                         | 正在跑的会话与它们的工作区（侧栏「运行中」提示）                          |
| POST   | `/api/asks/<askId>`                         | 回复 Agent 的提问（`answer` 字符串，空串表示跳过）                       |
| POST   | `/api/approvals/<id>`                       | 回复提权审批（`approved` 布尔值）                                        |

静态资源返回 `ETag`，客户端带 `If-None-Match` 时返回 `304`；页面本身 `no-store`。

写接口要求同源，并且**带请求体时**必须是 `application/json`（让浏览器先发 preflight）；
`DELETE` 这类没有请求体的写请求不再因为缺 content-type 被拒。

`POST /api/chat` 与 `POST /api/chat/stream` 的请求体可以带
`permission: "read-only" | "workspace-write" | "danger-full-access"`，缺省时用宿主的
`sandbox.access`；服务端按白名单校验后原样转给 `api.agent.chat/stream`。
网页自己总是显式发送当前选择（首次默认「工作区可写」），所以网页不受宿主 `sandbox.access` 影响。

## 侧栏扩展（addon）

其它插件通过宿主事件总线注册界面片段，目前在侧边栏最下方追加 `<a>`：

```ts
import { eventBus, EventEntity } from "wellspring/api/host/index.ts"

eventBus.publish(
    "wellspring-web:addon:register",
    EventEntity.create({
        type: "nav-bottom",
        meta: {
            // 可选；缺省用 to 作为去重 id
            id: "wellspring-code",
            label: "打开 Wellspring Code",
            to: "http://127.0.0.1:8788",
        },
    }),
)
```

- 只支持 `type: "nav-bottom"`
- `label` 为 1–80 字符；`to` 只允许站内相对路径（`/` 开头）、`http(s)` 绝对地址，
  或省略协议的 `host:port`（会补成 `http://`）；`javascript:` 等伪协议会被丢弃
- 绝对地址在前端用新标签页打开（`target="_blank"` + `rel="noopener noreferrer"`）
- 最多保留 8 条，按注册顺序展示；同 `id` 重复注册会覆盖原条目
- 网页登录后通过 `/api/addons/stream`（SSE）接收快照与增量；不支持 SSE 时退回
  `GET /api/addons` 一次性拉取
- web 插件需要在 `package.json` 的 `hostApi` 中声明 `event` 权限

## 工作区

工作区由用户手动添加，不会根据启动目录自动创建。点击「添加工作区」会调用宿主系统的原生文件夹对话框
（Linux: zenity / kdialog；macOS: osascript；Windows: FolderBrowserDialog），宿主校验后返回规范化路径；
`Agent` 之后就在该目录下读写文件、执行命令。浏览器本身拿不到原生对话框的绝对路径，所以由宿主弹出。

```text
<dataDir>/workspaces.json                          工作区注册表（宿主级，由宿主维护）
<dataDir>/plugin-data/wellspring-web/
  auth.json                            密码哈希
  workspaces/<id>/conversations.json   该工作区的会话与当前选中项
  ungrouped/conversations.json         移除工作区后保留下来的会话
```

- 工作区注册表由**宿主**统一维护（`api.workspaces`，需要 `package.json` 里声明 `hostApi: workspaces`）；
  Web 插件只保存每个工作区的会话。工作区列表直接显示在侧边栏，点击切换；
  每行右侧的垃圾桶按钮二次确认后移除工作区
- 移除工作区不会删除会话：它的会话转入「未分组」，仍然可以查看、删除并继续对话（使用原目录）
- 工作区 id 由目录路径派生（名称片段 + 路径哈希），同一目录重复添加会返回已有工作区
- 首次启动时，如果宿主注册表还不存在，会自动把旧版插件数据目录里的 `workspaces.json`
  迁移到 `<dataDir>/workspaces.json`（只读 id / 名称 / 路径 / 时间字段，旧文件保留便于回滚）
- 每个工作区最多 40 个会话、每个会话最多保留 600000 字符正文；超出时丢弃较早的消息
- 同一工作区可以在多个浏览器里打开；会话写入带 `updatedAt` 版本比较，旧版本不会覆盖新版本
- 旧版本浏览器 localStorage 里的会话，在选中工作区后会自动迁移过去并删除旧键

## 功能

- 首次访问设置访问密码，之后登录；密码以 scrypt 哈希保存在 `<dataDir>/plugin-data/wellspring-web/auth.json`
- 侧栏「修改密码」（`/password`）：校验当前密码后更新哈希；成功后旧登录凭据全部失效，当前浏览器自动换成新会话，其他设备需要重新登录
- 工作区手动添加/切换/移除（注册表在宿主，会话按工作区保存在插件数据目录，移除后会话进入「未分组」）
- 输入框收起：窄屏且未聚焦、没有草稿时，输入框收成一行、composer 边距收紧；点击（聚焦）后展开并随内容长到 200px，失焦且内容为空时再收起。有草稿时不收，避免藏住已输入的文字
- 侧栏「设置」（底栏功能按钮）可折叠：连接状态在折叠区外，折叠后仍可见；窄屏首次进入默认折叠，偏好存 `wellspring.foot.fold.v1`
- 侧栏「工作区」可折叠：点标题整行切换，折叠后标题右侧显示当前工作区名；没有工作区时保持展开，「添加工作区」始终可达。折叠偏好存在 localStorage（`wellspring.workspaces.fold.v1`），窄屏首次进入默认折叠
- 侧边栏按工作区分组显示会话；未分组里不能新建会话，但可以继续已有会话
- 插件管理（`/plugins`）：可查看插件状态、启用/禁用、卸载、上传 zip 安装；
  其它插件的启用/禁用即时生效；卸载前需先禁用，禁用后的卸载也即时生效；安装与禁用 `wellspring-web` 重启后生效；
  禁用 `wellspring-web` 需要二次确认，卸载被禁止（网页管理依赖它），恢复用
  `wellspring plugin enable wellspring-web`；安装包上限 10MB
- 网络代理（`/network`）：配置出站 HTTP/HTTPS 代理与 `noProxy` 主机后缀，写入宿主的 `app-setting.json`；
  保存后下一轮模型调用、拉取模型列表与 `web_search` / `web_fetch` 生效，不需要重启服务。
  只支持 HTTP/HTTPS 代理；代理地址留空或点「改为直连」清除配置
- 模型上下文窗口：「模型与供应商」页面（`/providers`）里按模型配置上下文长度（tokens，支持 `128K` / `1M` 写法，留空表示不配置），
  配置保存在插件数据目录的 `model-context.json`；模型菜单显示配置值，输入框下方的一行统计按「最近一次请求的真实 prompt tokens / 窗口」
  显示上下文占用百分比（旧会话没有真实用量时按字符数估算）
- Token 统计（参照 Harness）：输入框下方常显「上下文 16% · 会话用量 55.9K tok · 缓存命中 83%」，
  点开是完整明细（未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 推理 / 合计）与上下文占用；
  每条回复下方的「用量」按钮显示本轮用量与缓存命中，点开看该轮明细。缓存命中率 = 缓存读取 tokens / prompt tokens，
  数据来自供应商返回的 `prompt_cache_hit_tokens`、`prompt_tokens_details.cached_tokens` 或
  `cache_read_input_tokens`；供应商不返回缓存用量时只显示输入与输出
- 长会话默认只渲染最近 30 条消息，顶部显示「加载更早（还有 N 条）」；点一次补回 30 条并保持当前阅读位置，
  全部加载后按钮消失。折叠只影响渲染，保存/导出仍是完整会话
- 打开会话、刷新、切换会话都停在最新一条：正文是挂载后再渲染的，所以除了 `nextTick` 还会在之后两帧补滚，
  并用 `ResizeObserver` 跟着内容高度走；用户自己往上翻时不再拽回底部
- 侧栏会标记正在运行的会话（会话行的呼吸点）与有会话在跑的工作区（工作区行的小圆点）：
  `GET /api/chat/running` 每 4 秒轮询一次，本地发起/结束一轮时立即更新
- 思考行不再一直挂着「思考中」：正文或工具调用一到就算思考结束，显示「思考了 N 秒」；
  起止时间戳随会话保存，刷新后仍然显示耗时
- 当前工作区与会话都记在服务端（每个工作区一份 `activeId`），新建会话与发送首条消息时同步更新，
  刷新/重开浏览器回到上次的那一个
- 会话自己记住归属的工作区：保存、删除、发请求都用它而不是「当前选中的工作区」。
  运行中切到别的工作区不会把这一轮存进另一边（并发时两边对话串台就是这个原因）
- 输入框在按下发送时立刻清空，不再等整轮结束；这一轮跑完后也不会清掉用户中途输入的新内容
- 插话作为一条过程行插在回复里（`steer` 事件），摘要只留一行，展开看完整内容
- 回复收尾不用最终 `reply` 覆盖正文：正文是边流边拼的，工具行记的偏移基于它，
  整体覆盖会让偏移失效、总结插进代码调用中间；只有本地还没收到正文时才用 `reply` 兜底
- 工具参数/输出按 JSON 展开成缩进键值，字符串里的换行保留为真实换行（`execute_code` 的 argv 不再显示字面 `\n`）
- 回到前台或网络恢复时自动重连：按服务端 `running` 列表判断这一轮还在不在跑，还在跑就续接、
  已收尾就收掉本地状态并刷新列表；顶部进度条只在实际请求时出现，后台轮询不会让它一直闪
- 网络层中断（挂后台很久、切网、服务重启）不算回复失败：浏览器抛的 `network error` /
  `Failed to fetch` / `Load failed` 不会被写进消息，已收到的内容保留并标成可续接，
  续接本身按 0.6s → 1.2s → 2.4s 退避重试三次，仍不成功就等回到前台、网络恢复或刷新时再补；
  只有服务端明确说这一轮没了（重启/超出缓冲）才提示重试
- SSE 流式回复，可随时停止；失败消息带重试。流开始时服务端先下发 `sessionId`，刷新/断线后再发消息仍续同一个 Agent 会话
- 停止是服务端的：`POST /api/chat/stop` 会让宿主把这一轮标记为停止（`api.agent.stop`），
  同时中止正在进行的那次模型请求（AbortSignal），已收到的正文照常保留，本轮按「已停止」收尾，
  后续不再调用模型或执行工具；等待中的提问与提权请求按跳过 / 拒绝了结。
  只断开浏览器那边的 SSE 不会让宿主停下来，所以界面按钮先请求停止再断开本地流
- **多会话并行**：每个会话各有一套运行状态（`controller` / 队列 / 流式消息 / 停止标记），
  会话内部一轮串行、会话之间互不影响。A 正在回复时可以随时切到 B 发新消息，两条流同时进行；
  切回 A 能看到它已完成的内容。输入框的「插话 / 停止」只反映当前会话，
  侧栏的呼吸点反映所有会话（`localRunning` 本地即时 + `runningIds` 服务端轮询）
- **立即重放（不等这一轮跑完）**：三处一起保证
  - 看门狗：`consumeSse` 每 6s 没有 data 事件就问一次 `GET /api/chat/resume?peek=1`（纯 JSON，不建流）。
    服务端的 `total` 比本地收到的多，说明这条流漏了事件，立刻按 `?since=N` 增量重放并继续接收；
    45s 连注释 ping 都收不到才判定连接已死（服务端每 15s 一条 ping），走重连
  - 流提前结束（工具超时、反代掐长连接）时不退避、不靠定时器，收尾后直接发起续接
  - 续接判定只看**本地**有没有在跑：之前用服务端 `running` 列表判断，而那正是要续的那一轮，
    结果把自己挡在门外，只能等这一轮跑完才补上内容（这就是「仅限轮次结束才同步」的由来）
- 点了停止但界面一个字都没收到（本地正文为空、也没等到收尾事件）时不留在空白「已停止」：
  先补齐服务端已经产生的内容再收尾——那种情况是界面没跟上，不是用户不要了
- 服务端放弃事件缓冲（本轮内容超过上限）会推一条 `truncated` 事件，界面提示「刷新后将无法续接这一轮」，
  不再静默失效；上限默认 4MB（实测一轮 100 步 / 102 次工具调用的事件量接近 2MB）
- 看门狗与停滞恢复都往控制台写一条 `[wellspring]` 警告（漏了几条事件、流停滞），排查时直接看控制台
- `?since=N` 是增量重放：只回放下标 N 之后的事件，正文不重建、不闪烁；越界（缓冲被重置）时退回全量。
  `resume` 标记里带 `from` / `total`，前端据此判断「增量接续」还是「从头重建」
- 回复中途刷新页面不会丢掉这一轮：服务端按会话缓冲本轮事件，页面加载后自动 `GET /api/chat/resume` 重放并继续接收，
  正在跑的那一轮回复会接着显示完整；用户主动停止的回复不会被自动续接
- 是否接管这一轮**以服务端的 `resume.active` 为准**：前端本地的 `interrupted` 标记要靠关页前的 PUT 落盘，
  刷新时那个请求经常被取消，光看本地标记会漏掉续接（正文停在半路）。本地标记只用于兜底提示：
  服务端已收尾而本地内容不完整时，把回复收尾成「已停止」并提示可以重试
- 刷新时浏览器会中断进行中的 SSE 读取（Chrome 抛 `network error`），这属于页面卸载而不是回复失败：
  前端只在 `pagehide` 之后把这一轮标成 `interrupted`，不会记成错误回复；续接拿不到本轮
  （服务重启或超出缓冲保留期）时才退回成失败态并提示重试
- 回复中可以插话：输入框保持可用，发送键变成「插话」，消息由宿主会话排队，在 Agent 下一次模型调用前作为用户消息注入同一轮。
  插话作为一条过程行插在回复里（和思考/工具行共用同一条时间线），随本轮事件一起保存、刷新续接后仍在；
  刚好没赶上这一轮结束时按下一轮排队发出
- 思考链与工具调用提示：Agent 的思考内容（`reasoning_content`）默认折叠成一行「思考」，只显示首行摘要，
  流式时摘要取最后一个完成段落的首行；点开看完整内容。工具调用同样折叠成一行（读取文件 / 执行命令 /
  搜索网页等 + 参数摘要 + 运行中 / 完成 / 失败），点开看参数与结果。**正文、思考、工具行按发生顺序穿插**
  （参考 Harness）：消息先说什么、什么时候调了工具，顺序和实际执行一致；两者随会话保存（含正文偏移），
  刷新后顺序不变，展开状态也保留
- 轮次与步数：回复时输入框上方显示当前 `第 N 轮 · 第 M 步`；完成后消息元信息保留 `第 N 轮 · M 步`，顶栏显示会话累计 `N 轮 · M 步`
- Markdown 渲染：标题、列表、任务列表、引用、表格、代码块（带复制）、链接
- 主题：跟随系统 / 浅色 / 深色。选择写进 cookie，服务端渲染 `data-theme`，避免首屏闪烁
- 系统状态页面（`/status`）：宿主状态 / 平台 / Node / 目录 / 插件列表，顶栏可刷新。插件未声明 `getHost` 权限时显示不可用
- 聊天栏模型按钮：轻量「切换模型」下拉，按供应商分组列出模型，点击即切换；顶部一行切换推理等级
  （off / low / high / max，按钮显示「模型 · 等级」），菜单底部可跳到供应商管理。
  **模型 / 推理等级 / 权限都是会话级设置**：切换只影响当前会话，切会话会恢复该会话自己的值并随会话保存在
  `conversations.json`；新会话的模型与推理等级沿用全局默认，权限沿用最近一次选择。
  供应商弹窗里点模型按钮设置的是**全局默认**（只影响之后新建的会话），不会改动已有会话
- 关闭 Wellspring：侧栏「关闭 Wellspring」按钮，二次确认后调用宿主优雅关闭（onShutdown → 停插件 →
  清服务记录），页面切换到「Wellspring 已关闭」提示。需要 `shutdown` 权限
- 侧栏「供应商」（`/providers`）：接入任意 OpenAI 兼容供应商（名称 / Base URL / Key / 模型列表，
  可点「拉取模型」从供应商的 `/models` 自动填充）；每个供应商的 Key 都在这里保存 / 清除（内置 openai 也是），
  Key 落在宿主 `<configDir>/credentials.json`（0600）。切换后下一轮对话生效，聊天请求会带上
  `provider` 与 `model`。需要 `models` 权限；聊天缺 Key 时会提示到「供应商」里填写
- 导出当前会话为 Markdown
- 页面覆盖：数据目录下的 `page.html` 优先于内置模板，改完刷新即生效，无需重启
- 侧栏扩展：其它插件通过 `eventBus` 注册 `nav-bottom` 条目，网页在侧边栏最下方实时追加 `<a>` 链接
- 提示框：右上角自动关闭，可手动关闭；错误类停留更久，长文本自动换行
- Agent 提权审批：`execute_code` 请求更宽权限时，页面弹出审批框显示命令、目录、权限变化与理由；默认聚焦「拒绝」，超时按拒绝处理
- Agent 提问：`ask` 工具调用时在输入框上方显示「Agent 提问」卡片（布局参考 Harness）：问题标题、
  编号单选选项（选项标签以「（推荐）」结尾时显示徽标）、自定义答案输入行（Enter 提交、Shift+Enter 换行）、
  跳过/收起/关闭；回答后调用宿主 `agent.respondAsk`，Agent 继续本轮。停止生成或本轮结束会释放等待
  （宿主侧 5 分钟超时兜底）。问题与答案作为工具行随会话保存
- Agent 权限切换器：输入框左侧显示当前会话的权限（只读 / 工作区可写 / 完全访问），点开可切换；切到
  「完全访问」会弹二次确认，确认后输入框上方常驻一条红色警告条。权限存在会话上（随会话保存），新会话
  默认沿用最近一次选择；切到「完全访问」的提示条也跟随当前会话。旧版本存在 localStorage 的全局权限
  只作为新会话默认值与老会话回退，不再全局生效
- 输入触发：`/` 打开指令菜单（新建、停止、导出、状态、主题、添加工作区、帮助）；`@` 搜索并引用工作区文件/目录
    - 排序：文件名全等 > 文件名前缀 > 分词前缀/扩展名 > 文件名包含 > 路径段 > 路径包含 > 子序列，忽略大小写
    - 带 `/` 的查询按路径段链式匹配：`assets/app` 命中 `src/assets/app.ts`，前缀目录不必真实存在
    - 目录以 `/` 结尾时只列一层，可逐级下钻；根目录列表与浏览跳过 `node_modules`、`dist` 等目录，显式输入路径仍可进入
    - 扫描按广度优先（浅层优先），上限 20000 条 / 12 层 / 500ms，超出时标题提示继续输入筛选
    - `@` 可以紧跟汉字或中文标点；输入法组合结束后刷新结果；菜单里的命中片段逐段高亮
    - 输入框里的 `@` 引用实时高亮：镜像层与 textarea 同字号同内边距，只画圆角底纹；正文与输入法组合文字仍由原生 textarea 渲染。菜单打开时当前补全段用更实的底纹
    - 带空格的路径按 Harness 语法插入 `@"path with spaces"`；选中文件时记下路径，发送时连同文本里扫到的 `@path` 一起附给 Agent，消息本身仍显示原始引用文本
- 键盘：桌面 `Enter` 换行、`Shift+Enter` 发送（回复中为插话）；触摸设备（`pointer: coarse`）没有 Shift，**`Enter` 直接发送**，`enterkeyhint` 也跟着变成「发送」；`Esc` 关闭菜单/抽屉；回复中**连按两次** `Esc` 才停止（第一次只轻提示，1.6s 内不再按就作废）——单按直接砍掉一整轮代价太大；输入法组合期间不误发
- 触发菜单支持方向键选择、`Enter` 执行、`Esc` 关闭；目录可继续输入 `/` 向下浏览

已知限制：

- 停止回复只中断当前浏览器连接，宿主侧的那一轮仍会跑完，之后的回复会排在这一轮后面
- 续接缓冲只保留最近 5 分钟、最多 8 轮；服务重启后无法续接，页面保留已收到的部分
- 工作区目录在添加时校验；目录之后被删除时，该工作区的对话会报错，需要重新添加或移除工作区
- 原生文件夹对话框需要宿主有可用的系统对话框：Linux 需要 zenity 或 kdialog；无图形会话时 `/api/picker` 返回错误
- 权限切换在下一轮聊天生效；正在回复的回合仍使用开始时的权限
- 插话在步骤边界生效：当前这一步（含工具执行）结束后，Agent 才在下一次模型调用前看到插话
- 文件搜索不读 `.gitignore`，按内置目录黑名单跳过依赖/构建目录；超大仓库超出扫描上限的文件搜不到，标题会提示继续输入筛选
- 带空格的路径插入后是 `@"…"` 引号文本，不再触发文件补全；带空格的目录只能从上一级选入，不能在其中继续下钻
- `page.html` 覆盖是整页替换：内置模板新增的元素不会自动出现在覆盖文件里，需要重新导出

## 安全

- 严格 CSP：`default-src 'none'`，不放行内联脚本与样式
- 认证 cookie `HttpOnly` + `SameSite=Lax`；登录 token 只存进程内存，服务重启后需重新登录
- 写接口要求 `application/json` 且校验同源 `Origin`；提权审批同样需要登录，审批 id 由宿主随机生成
- 登录失败、修改密码时当前密码输错都会按来源地址计数，5 次后锁定 60 秒（`429` + `Retry-After`）
- 修改密码成功后清空所有内存会话，只给发起请求的浏览器换新 cookie；密码至少 6 位、最多 200 位
- 请求体上限 3 MiB，单条聊天消息上限 32000 字符；每个工作区最多 40 个会话、每个会话最多 600000 字符正文
- 工作区与会话接口全部要求登录；添加工作区时由宿主校验目录是否存在；会话内容只写入插件数据目录
- 原生文件夹对话框由宿主进程弹出（zenity/kdialog/osascript/PowerShell），插件本身不读工作区文件
- 权限切换只影响之后的回合；服务端按白名单校验 `permission`，宿主对插件覆盖权限写 WARN 日志
- Markdown 只生成 DOM 节点，不拼接 HTML；链接只放行 `http(s)` / `mailto`
- 第一次设置密码是未认证入口：绑定到非 loopback 地址前先完成设置，并放在 TLS 反向代理之后

## 设计

- 令牌用 CSS 自定义属性，`light-dark()` 同时定义两套配色；不支持时回退到深色值
- 字体与字号阶梯：界面和代码统一用系统自带等宽字体（Windows Consolas、macOS Menlo/Monaco、
  Linux DejaVu Sans Mono / Ubuntu Mono、Android Droid Sans Mono），再挂 Noto Sans Mono CJK SC / 苹方 /
  微软雅黑做中文回退；`--font-size-xs: 1rem` … `--font-size-8xl: 3.7rem`，根字号 `--ui-font-size`
  默认 `1rem`，文字整体可等比缩放；徽标等小字用 rem 与 `em`，不请求外部字体
- 断点：1080 / 860 / 560；860 以下侧边栏变抽屉，触摸设备点击区域 ≥44px
- 手机输入区（560 以下）用两行网格：第一行模型胶囊（左）+ 权限胶囊（右），第二行输入框 + 发送/停止。
  `.composer-bar` 用 `display: contents` 把控件交给 composer 的网格，不再靠 flex 换行；输入框与发送键同一行，
  胶囊 label 再长也挤不掉发送键，拇指也够得到右下角。键盘提示行在手机上只在「先添加工作区」时出现
  （软键盘没有 Shift / Esc，其余提示不成立）。同一套规则下 360×640 的输入区从 198px 降到 120px，
  消息区从 382px 回到 444px
- 侧栏分三段：头部固定、中段（工作区 + 新对话 + 最近会话）共用 `.sidebar-scroll` 滚动区、底栏固定；
  860 以下工作区列表封顶 `min(28vh, 200px)`，折叠后会话列表直接可见
- 窄屏输入条：860 以下 `composer-bar` 允许换行，模型/权限胶囊的 label 收紧并可截断，键盘提示独占一行，
  发送与停止按钮 `flex: none` 靠右；旧版不换行时它们会溢出 composer，被 `.app` 的 `overflow: hidden` 裁掉
- 触摸反馈：交互元素 `touch-action: manipulation`（去掉 300ms 点按延迟）+
  `-webkit-tap-highlight-color: transparent`，改由 `@media (hover: none)` 下的 `:active` 缩放回应；
  反馈只用 `transform` / 颜色，不动布局
- 触摸目标分两档：主入口（发送、胶囊、侧栏行、设置页顶栏、代码复制）44px，密集过程行 `.proc-head` 36px
  （WCAG 2.5.8 的下限是 24px，44 是 iOS/Android 原生建议，这里给密集列表留了密度）
- 手机上的字号下限 12px：侧栏计数、时间、版本、过程状态、代码块语言标签等元信息原先 11px
- 刘海与安全区：`viewport-fit=cover` + `interactive-widget=resizes-content`，顶栏让出
  `env(safe-area-inset-top)`，输入区与弹窗底部让出 `env(safe-area-inset-bottom)`
- 弹窗在手机上贴底成半屏（`88dvh` 上限、上圆角、底部按钮各占一半宽度），按钮仍在拇指区
- 对比度按 WCAG 2.2 AA 校验：正文、次要文字、弱文字 ≥ 4.5:1，控件边框与焦点色 ≥ 3:1
- `prefers-reduced-motion` 关闭动效，`prefers-contrast: more` 增强边框

## Web 扩展

扩展是 Vue 单文件组件，编译后由页面按需 `import()` 挂载（普通 ESM，不需要 `unsafe-eval`）。

- **内置扩展**：把 `plugins/wellspring-web/plugins/xxx.vue` 放进插件目录，重新执行前端构建
  （`node scripts/build-ui.mjs`）即可打进主 bundle；页面「设置 → Web 扩展」里可以打开
- **网页安装**：同一入口点「安装扩展」上传 `.vue` 文件。插件进程用 `@vue/compiler-sfc`
  编译成 `/extensions/<id>.js`，源码与产物保存在 `<dataDir>/plugin-data/wellspring-web/extensions/`
- 扩展可以 `<script setup>`，只能 `import ... from "vue"`（会被重写成 `/assets/app-vue.js`，
  和主界面共用同一个 Vue 实例）；`<style>` 会编译成独立样式文件，暂不支持 `scoped`
- 扩展以页面权限运行（可调用同源 API），只安装可信来源
- **删除扩展**：网页安装的扩展直接删除（源码与产物一并清理）；内置扩展的文件在
  `plugins/wellspring-web/plugins/` 下且运行时只读，网页端「删除」会把它记入隐藏列表
  （`<dataDir>/plugin-data/wellspring-web/extensions/builtin-state.json`），立即从列表/插槽/页面中移除，
  列表底部「已隐藏的内置扩展」可随时恢复；要彻底删除文件仍需删源码并重新构建

### 修改原本的页面

扩展除了在面板里打开，还可以通过命名导出改主界面：

```vue
<!-- 页面模式：默认组件接管右侧主内容区（侧栏保留，顶栏有「退出扩展页面」） -->
<script>
export const meta = { name: "自定义页面", mode: "page" }
</script>

<!-- 挂载点注入：把组件渲染进主界面的固定插槽 -->
<script>
import { h } from "vue"
export const slots = {
    "sidebar.footer": () => h("div", { class: "tip" }, "来自扩展的侧栏提示"),
    "topbar.actions": () => h("button", { class: "btn btn-outline btn-sm" }, "扩展按钮"),
}
</script>
```

- 扩展列表的「打开」都进 `/ext/<id>`：`meta.mode: "page"` 的扩展接管主内容区，其它扩展渲染成面板卡片；
  `host` prop 提供 `version` / `toast` / `close`
- `slots` 支持的挂载点：`sidebar.footer`、`topbar.actions`、`composer.above`
- slots 值和页面组件可以是普通 Vue 组件对象或函数式组件（用 `h()` 渲染；不要用 `template:` 字符串，
  运行时没有模板编译器）
- 命名导出对网页安装的扩展同样有效（编译产物会保留 `meta` / `slots`）

扩展没有内置演示文件；可以直接在网页「Web 扩展」里上传 `.vue`，或把文件放进
`plugins/wellspring-web/plugins/` 后重新构建前端。

## 前端（Vue + Vite）

- 源码：`frontend/src/`（Vue SFC + `logic/` 纯逻辑模块）
- 构建：`node plugins/wellspring-web/scripts/build-ui.mjs`
  1. 在 `frontend/` 跑 `vite build`（lib 模式，IIFE）
  2. 把产物 JS/CSS 生成为 `src/assets/vue-client.ts` 里的字符串常量
- 运行时插件不读文件、不请求 CDN：`src/assets/index.ts` 把字符串注册成 `/assets/app-vue.js`，
  启动时计算 ETag；HTML 只保留 `#vue-app` 与 SPRITE，便于下发严格 CSP
- 依赖装在 `frontend/node_modules`（插件目录独立安装，不污染仓库根依赖）：

```bash
cd plugins/wellspring-web/frontend && npm install   # 首次
cd ../.. && node scripts/build-ui.mjs               # 每次改前端（含 plugins/*.vue）后重新构建
wellspring stop && wellspring start                # 重启加载新资源
```

- 插件运行时要编译网页安装的扩展，因此本插件目录还需要 `npm install`（安装
  `@vue/compiler-sfc`；打包分发时一并带上 `node_modules` 或在目标机安装）
- 前端库：`nprogress`（顶部进度条）、`vue3-toastify`（操作提示）；两者样式都打进
  `app-vue.css`，由页面同源加载。toast 主题跟随页面主题（system → `auto`，light/dark 同步切换）

## 开发

```bash
# 类型检查（插件目录内使用仓库根目录的 tsc）
cd plugins/wellspring-web
../../node_modules/.bin/tsc --noEmit

# 集成测试
cd ../..
node --test test/web-plugin.test.ts test/web-plugin-ui.test.ts test/web-plugin-workspace.test.ts \
  test/web-markdown.test.ts test/web-vue-logic.test.mjs
```
