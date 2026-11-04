# Windows 受限 token 沙盒方案（与 DSH 对齐）

> **日期**：2026-11-04
> **状态**：核心已实现（native launcher + TS 后端 + manager 异步准备 + Web 准备状态事件/UI +
> ACL 清理 + 网络盘/reparse point 拒绝）；WFP/网络围栏与大 workspace 压测仍待做
> **关联**：
> - [2026-11-02 讨论全记录](./2026-11-02-discussion-record.md)
> - [2026-11-03 决策摘要](./2026-11-03-decision-summary.md)（VM 主路径已降级为远期可选）

---

## 1. 决策

放弃 VM 主路径，Windows 沙盒改为**用户态受限 token**，行为对齐 DSH：

- 读：**全局放开**（不做读隔离）；
- 写：用受限 token + NTFS ACL 把写边界限制在 workspace 与 scratch；
- 进程/资源：Job Object 限制；
- 工作区准备异步化，前端显示“正在准备工作区”，命令在 READY 前**排队**，失败 fail-closed；
- 网络隔离本期不做（`enforcementNotes` 如实说明）。

Linux / macOS 同步对齐：默认读全局放开（只读不再等于“只能读工作区”）。

---

## 2. 目标与非目标

### 目标

1. Windows 上 Agent `execute_code` 有可验证的文件写边界，不依赖管理员、不装驱动、不建本地账户；
2. 读行为与 DSH 一致：宿主文件默认可读，不限制读；
3. 工作区准备不影响 `wellspring start` 启动，用异步状态 + 前端进度呈现；
4. 保留现有 `SandboxBackend` 抽象、探针矩阵与 `enforcement` 自报机制；
5. 后续可平滑接入网络围栏/VM 强化档，不推翻接口。

### 非目标

- 内核级隔离（VM/hypervisor）、防内核漏洞；
- 网络隔离（无管理员时做不到）；
- 读隔离/密钥保密（读全局放开是明确产品选择）；
- 多租户/敌对租户隔离；
- 驱动、UEFI、ASM、自研 hypervisor。

---

## 3. 跨平台读策略（与 DSH 对齐）

| 平台 | 实现 | 说明 |
|---|---|---|
| Linux | 宿主顶层目录 `--ro-bind-try` 只读绑定 | `/proc`、`/dev`、`/tmp` 由 bwrap 重新挂载；不再只挂工作区 |
| macOS | SBPL `(allow file-read*)` | 本来就全局放行，补文档与测试期望 |
| Windows | 受限 token 不限制读 | 写边界由 ACL 决定；读全开 |

**语义变化**：`read-only` / `workspace-write` 只描述**写/网络/进程**约束，不再隐含“读收敛”。需要读隔离的场景不提供，并在 `enforcementNotes` 与 README 中写明。

已同步修改：

- `src/sandbox/backends/bwrap.ts`：agent 启动改为顶层只读绑定 + 宿主 node 路径；
- `src/sandbox/backends/seatbelt.ts`：缺口说明改为“读全局放开（DSH 对齐）”；
- `scripts/sandbox-matrix.ts`、`scripts/verify-sandbox.ts`、`test/*`、`README.md`：`read:outside` 期望改为 allow。

---

## 4. 总体架构

```
Wellspring 控制面（TS）
├─ SandboxManager
│   ├─ WorkspacePreparer（异步准备、状态机、事件）
│   ├─ WinRestrictedBackend（token/ACL/Job Object 的 TS 侧）
│   └─ 其他后端（bwrap/seatbelt/direct）不变
├─ native/win-sandbox（C/C++ 或 Rust，单 exe）
│   ├─ token 工厂：CreateRestrictedToken（WRITE_RESTRICTED + DISABLE_MAX_PRIVILEGE）
│   ├─ ACL 工具：授予/校验/回收继承 ACE（句柄式、可回滚）
│   ├─ 进程启动：Job Object + 句柄白名单 + argv-only
│   └─ 自检：token 能否读、写边界是否符合预期
└─ 事件总线 → Web UI（“正在准备工作区”）
```

TS 侧负责策略与状态；native 侧只做 Win32 原语，便于测试与替换。

---

## 5. 身份与 token 设计

不建本地账户。每个 workspace 生成一组稳定 SID（持久化，随 workspace 复用）：

| SID | 用途 |
|---|---|
| `SID_R` | 读 + 执行 workspace/scratch；用于 read-only token |
| `SID_W` | workspace/scratch 的写权限；用于 workspace-write token |

**ACL（一次授予，避免每命令改 ACL）**：

- `workspace` 根：两条可继承 ACE
  - `SID_R`：`READ | EXECUTE`
  - `SID_W`：`MODIFY`（含 `DELETE`；是否给 `FILE_DELETE_CHILD` 待定，先不给）
- `scratch`：`SID_R`、`SID_W` 均 `MODIFY`（scratch 在两种 access 下都可写）
- 只追加显式 ACE，不重写/替换已有安全描述符；记录账本以便回收
- 不授予 `WRITE_DAC` / `WRITE_OWNER`，防止沙箱改 ACL

**两个 token（创建后缓存）**：

| token | 标志 | restricting SIDs | 效果 |
|---|---|---|---|
| read-only | `DISABLE_MAX_PRIVILEGE` + `WRITE_RESTRICTED` | `SID_R` + `RESTRICTED` + `Everyone` | 写检查只能匹配这些 SID 的 ACE；workspace 只有 `SID_R` 读 ACE → 写拒绝；scratch 可写 |
| workspace-write | `DISABLE_MAX_PRIVILEGE` + `WRITE_RESTRICTED` | `SID_W` + `RESTRICTED` + `Everyone` | 写检查只能匹配这些 SID 的 ACE；workspace/scratch 可写；其他位置通常拒绝 |

实现说明：

- `WRITE_RESTRICTED` 只影响写访问，**读不受影响**（这就是读全局放开）；
- `RESTRICTED` 与 `Everyone` 是为了让 node / PowerShell 等进程能完成 DLL 初始化/对象创建；
  不带它们时这些进程会以 `0xC0000142` 失败，cmd 却可能正常——兼容性测试发现的坑；
- 因此写边界是“workspace/scratch 可写 + Everyone 显式可写位置可能例外”，
  `enforcementNotes` 会如实写出这一点；
- `DISABLE_MAX_PRIVILEGE` 去掉 `SeBackup`/`SeRestore`/`SeTakeOwnership`/`SeDebug` 等；保留 `SeChangeNotifyPrivilege`（目录遍历必需）；
- 子进程用 `bInheritHandles=TRUE` + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 只放 stdin/stdout/stderr；
  句柄列表为空或不可继承时 fail-closed；
- token 句柄用后关闭。

**SID 生成**：随机子授权，持久化到 `dataDir/sandbox/win/<workspace-hash>.json`；同一 workspace 跨进程复用，
避免 ACL 里堆积旧 SID。

---

## 6. 工作区准备（异步）

> 说明：`CreateRestrictedToken` 本身是毫秒级同步操作，不需要异步化。真正耗时的是
> workspace 的 ACL 授予/校验与目录扫描（文件多、网络盘、继承被阻断时尤其明显），
> 所以异步 + 前端进度都花在“准备工作区”上；token 在准备完成后按 access 选用即可。

### 状态机

```
IDLE → PREPARING → READY
         ├→ FAILED（可重试）
         └→ CANCELLED（回收已加 ACE）
READY → RUNNING → IDLE
```

### 阶段与进度

| 阶段 | 动作 | 进度 |
|---|---|---|
| `validate` | workspace 绝对路径、本地 NTFS、可写、非 UNC/网络盘（v1 拒绝网络盘与 OneDrive 占位） | 0–10% |
| `identity` | 读取/生成 SID_R、SID_W | 10–20% |
| `acl` | 授予 workspace/scratch 继承 ACE；对“继承被关闭”的子目录逐个补 ACE | 20–80% |
| `verify` | 以 read-only/write token 各做一次读写探针（scratch 建删临时文件、workspace 写探针） | 80–95% |
| `ready` | 持久化状态、发事件 | 100% |

### 关键规则

1. **fail-closed**：`execute_code` 在未 READY 时排队等待，不提前执行；失败返回明确错误；
2. **可取消**：取消后回滚本次新增 ACE，释放临时文件；
3. **幂等**：重复准备直接返回 READY；校验 ACE 是否被外部改动，漂移则修复；
4. **不阻塞 start**：`wellspring start` 后台触发准备；前端订阅事件；
5. **持久化**：状态落盘（SID、ACL 版本、workspace File ID）；崩溃后启动校验/续做；
6. **清理**：workspace 删除/卸载时回收 ACE；提供 `wellspring sandbox cleanup`；
7. **并发**：同一 workspace 单准备任务；不同 workspace 可并行；命令按 workspace 排队。

### 事件协议（经现有事件总线）

| 事件 | 字段 |
|---|---|
| `sandbox.workspace.prepare.started` | workspaceId, workspacePath, startedAt |
| `sandbox.workspace.prepare.progress` | phase, processed, total, message, elapsedMs |
| `sandbox.workspace.prepare.completed` | workspaceId, elapsedMs |
| `sandbox.workspace.prepare.failed` | workspaceId, phase, code, message |
| `sandbox.workspace.prepare.cancelled` | workspaceId |

### 前端 UX

- 超过 300ms 才显示“正在准备工作区”，避免闪烁；
- 显示阶段、已处理目录数、已用时、取消按钮；
- 失败显示可操作原因（权限不足/路径不可写/继承被阻断/网络盘不支持）；
- READY 后自动继续排队的命令，无需用户重发；
- 同一 workspace 后续命令不再显示（已缓存）。

---

## 7. 一次 execute_code 的流程

1. 请求进入 `SandboxManager.startAgentCode`；
2. `WorkspacePreparer.ensure(workspaceDir)` → READY（或排队/报错）；
3. 按 `access` 选择 token（read-only / workspace-write）；
4. native 启动器：
   - 创建 Job Object（内存提交上限、活跃进程数、kill-on-close、禁止 breakaway）；
   - 创建进程（token、cwd 在 workspace 内、argv-only、stdio 管道、env 白名单）；
   - `TEMP`/`TMP`/`HOME` 指向 scratch；
5. supervisor 收集 stdout/stderr、超时 kill Job；
6. 返回 `AgentCodeResult`：`backend=win-restricted`、`enforcement=partial`、notes 说明读全开/网络未隔离；
7. 不回收 ACL（token 切换即可）；scratch 按会话清理。

`enforcementNotes`（示例）：

- `network: 不隔离（无管理员，未安装 WFP 围栏）`
- `fs: 读全局放开（与 DSH 对齐），写边界由受限 token + ACL 强制`
- `process: Job Object 限制，但无 PID namespace`

---

## 8. 文件/路径安全

- workspace 必须是绝对路径、固定本地卷；拒绝 UNC、映射网络盘、OneDrive 占位目录（v1）；
- 路径一律句柄优先：`CreateFileW` + `GetFinalPathNameByHandleW`，拒绝 reparse point/junction/ADS；
- 只允许 workspace 内的 cwd；argv 不做 shell 拼接；
- 子进程句柄白名单，仅 stdio；
- ACL 操作使用 `SetEntriesInAclW`/`SetNamedSecurityInfoW`，失败即回滚；
- 禁止 `WRITE_DAC`/`WRITE_OWNER`；
- 环境变量白名单（PATH/SystemRoot/TEMP/TMP/HOME/LANG 等），不透传敏感变量。

---

## 9. 接口与实现清单

### native/win-sandbox

- `--prepare-acl <workspace> <scratch> <sidR> <sidW>`：授予并校验，输出 JSON；
- `--revoke-acl ...`：回收；
- `--exec --access read-only|workspace-write --workspace ... --scratch ... --cwd ... -- <cmd> [args]`：创建 token + Job Object + 启动；
- `--self-test`：token 创建、读写探针、Job 限制；
- 退出码区分用法/权限/准备失败/exec 失败。

### TS

- `src/sandbox/backends/win-restricted.ts`：`SandboxBackend` 实现（`pathStyle="host"`、`memoryLimit=false`、`enforcement=partial`）；
- `src/sandbox/workspace-prepare.ts`：状态机、事件、持久化、并发锁；
- `SandboxManager`：`startAgentCode` 前 await prepare；暴露 `prepareWorkspace`/`getStatus`；
- `src/config/types.ts`：`SandboxBackend` 联合类型加 `"win-restricted"`（或 `"windows"`）；
- Web：订阅事件、显示状态。

---

## 10. 测试与验收

### 单元/集成（Windows CI）

- token 构造：read-only 写 workspace 被拒、write 可写、scratch 两者可写、外部写被拒；
- 读：workspace 外文件可读（与 DSH 对齐）；
- Job Object：超时杀进程树、内存/进程数限制；
- 句柄：宿主打开的句柄不被继承；
- 路径：junction/reparse/ADS/8.3/长路径/`..` 拒绝；
- 准备：幂等、取消回滚、崩溃恢复、外部 ACL 漂移修复；
- 提权调用者：DISABLE_MAX_PRIVILEGE + restricting SID 已去掉危险特权与管理员组写权限；
  后续可评估 linked filtered token。

### 探针矩阵

扩展 Windows 版 `verify-sandbox`：

- `read:outside` → allow；
- `write:workspace` 按 access；
- `write:outside` → deny；
- `read:system` → allow；
- `write:scratch` → allow；
- `write:devnull` → allow；
- `net:egress` → v1 按 `resolveNetwork` 策略（read-only 拒绝，其他允许；无强制围栏，仅依赖默认网络策略）；
- `link:hardlink` 需单独定义（Windows 下 NTFS 硬链接在 workspace 内可能允许，外部 deny）。

### 性能验收

- 准备：1k/10k/100k 文件耗时；目标是 O(目录数) 而非 O(文件数)；
- 每命令延迟 p50/p95（不含命令本身）；
- 内存/句柄占用。

---

## 11. 里程碑

| 阶段 | 内容 |
|---|---|
| M0（1–2 周） | native skeleton：token + Job Object + exec + self-test；TS backend 直连 |
| M1（2–3 周） | ACL 授予/校验/回收 + 双 token；单元/集成测试；探针矩阵 |
| M2（2 周） | 异步准备状态机 + 事件 + 前端“正在准备工作区” + 取消/重试/恢复 |
| M3（1–2 周） | 性能、崩溃恢复、路径对抗测试、README/运维文档 |

总计约 6–9 周（1–2 人），不含网络围栏与 VM 强化档。

---

## 12. 风险与待决

| 风险/待决 | 处理 |
|---|---|
| 提权调用者 | 受限 token 已去掉危险特权与管理员组写权限；后续评估 linked filtered token |
| ACL 持久化污染用户 workspace | 提供 `wellspring sandbox cleanup` 递归清理；删除工作区前运行 |
| 继承被关闭的子目录 | 根 ACE 会传播到已有子项（已实测）；继承被显式关闭的子项仍需后续扫描处理 |
| 网络盘/OneDrive | `--prepare` 拒绝网络映射盘与 reparse point（junction / OneDrive 占位目录） |
| 句柄/路径绕过 | 句柄列表 + cwd/路径校验 + 对抗性测试 |
| 无网络隔离 | `enforcementNotes` 如实说明；网络围栏作为后续可选 |
| 长期 ACL 漂移 | 启动/每次准备校验；修复或报错 |
| 与 DSH 行为差异 | 读全开、写 workspace/scratch；探针矩阵对齐 |

---

## 13. 实现进度（2026-11-04）

**已完成**

- `native/win-sandbox/src/main.cpp`
  - `--prepare`：先拒绝网络映射盘 / reparse point（junction、OneDrive 占位目录），
    再给 workspace/scratch 写入可继承 ACE（已有子项会继承，已实测）；
  - `--cleanup`：递归删除 workspace/scratch 里本沙盒的 SID ACE；
  - `--exec`：`CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED)` + Job Object
    （kill-on-close / ActiveProcess / JobMemory）+ 句柄白名单 + stdio 继承；
  - `--self-test`：真实创建 token、Job、启动 `cmd /c exit 0`；
  - restricting SIDs：业务 SID + `RESTRICTED` + `Everyone`（兼容 node/PowerShell，避免 0xC0000142）。
- `src/sandbox/backends/win-restricted.ts`：SID 生成/持久化、异步 `prepare`/`cleanup`、token 选择、
  环境构造、probe、`enforcement/notes`。
- `src/sandbox/manager.ts`：Windows auto 选 `win-restricted`；启动前 `await backend.prepare()`；fail-closed；
  通过 `sandbox.workspace.prepare` 事件发布 started/completed/failed（含 sessionId）；
  提供 `cleanupWorkspace()` 清理历史 ACL。
- `src/plugin/capabilities.ts`：把 `sessionId` 带进 `AgentCodeRequest`，供事件关联会话。
- CLI：`wellspring sandbox cleanup [--workspace <path>]`（删除工作区前清理 SID ACE）。
- Web：`plugins/wellspring-web` 订阅准备事件并写入对话 SSE；前端 `sandbox-prepare` 事件渲染
  “准备工作区”过程行（完成后移除，失败保留错误）。
- `src/sandbox/supervisor.ts`：Windows 不再使用 `detached:true`（否则受限 token 子进程 0xC0000142）。
- 配置/插件：`sandbox.backend` 增加 `win-restricted`；插件仍走 node-permission。
- 测试：
  - `test/win-restricted-backend.test.ts`（launch spec / probe / candidate / SID）；
  - `test/win-restricted.e2e.test.ts`（读全局、写 workspace/scratch、写外部拒绝、超时 kill、
    cleanup 后写 token 被拒、auto probe）；
  - `test/sandbox.test.ts` 增加准备事件 started/completed 与 prepare 失败 fail-closed；
  - 矩阵测试的 Windows 系统文件/NUL 探针修正。
- 构建：`scripts/build-win-sandbox.mjs` + `pnpm win-sandbox:build`，产出 `bin/win32-<arch>/win-sandbox.exe`；
- CI：`.github/workflows/sandbox-windows.yml`（构建、单测、e2e、探针矩阵）；
- 真机验证：`node scripts/verify-sandbox.ts --backend win-restricted` 18/18 探针符合预期
  （读全局、写 workspace/scratch、read-only 拒写、写外部拒、NUL 重定向、超时 kill、auto 选择）。

**待做**

- WFP/网络围栏（可选）；
- 大 workspace 性能压测与准备取消/重试/崩溃恢复。

---

## 14. 与旧方案的关系

- VM + guest 本地 workspace + 同步（2026-11-03 决策摘要）降级为**远期可选强化档**，不作为默认路径；
- 若未来需要网络隔离或内核级隔离，在 `SandboxBackend` 抽象下新增 VM 后端，不推翻本方案；
- Linux/macOS 读策略本次已统一为“读全局放开”，与 Windows 对齐。
