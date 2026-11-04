# Wellspring Windows 沙盒方案讨论全记录

> **记录日期**：2026-11-02（Asia/Shanghai）
> **参与者**：用户（项目负责人） / DeepSeek Harness AI（Team Lead）
> **工作区**：`D:\wellspring`（Wellspring：插件式 Agent 平台与 CLI，MIT 许可）
> **记录性质**：用户发言保留原文；助手回复按轮次整理为技术记录，保留结论、对比表、关键数据与代码路径，非逐字转录。
> **讨论中引用的仓库位置**：`src/sandbox/`（`types.ts`、`manager.ts`、`backends/`）、`native/seatbelt-run/src/main.c`、`scripts/verify-sandbox.ts`、`scripts/sandbox-matrix.ts`、`.github/workflows/sandbox-macos.yml`、`README.md`。

## 目录

- [0. 一页摘要](#0-一页摘要)
- [1. 背景与初始约束](#1-背景与初始约束)
- [2. 逐轮记录](#2-逐轮记录)
    - [2.1 第 1 轮：是否自研 Windows 沙盒](#21-第-1-轮是否自研-windows-沙盒)
    - [2.2 第 2 轮：Windows Sandbox 的版本与性能](#22-第-2-轮windows-sandbox-的版本与性能)
    - [2.3 第 3 轮：专用本地账户 + WFP 的原理](#23-第-3-轮专用本地账户--wfp-的原理)
    - [2.4 第 4 轮：fork VBox/VMware 还是自研](#24-第-4-轮fork-vboxvmware-还是自研)
    - [2.5 第 5 轮：能不能从 0 写 sandbox](#25-第-5-轮能不能从-0-写-sandbox)
    - [2.6 第 6 轮：语言选择与方案 A 的已知缺陷](#26-第-6-轮语言选择与方案-a-的已知缺陷)
    - [2.7 第 7 轮：Sandboxie 的实现原理](#27-第-7-轮sandboxie-的实现原理)
    - [2.8 第 8 轮：Sandboxie 是否开源、能否复用](#28-第-8-轮sandboxie-是否开源能否复用)
    - [2.9 第 9 轮：QEMU + Windows VM + 内层账户/WFP 的初始评估](#29-第-9-轮qemu--windows-vm--内层账户wfp-的初始评估)
    - [2.10 第 10 轮：用户纠正——wellspring start 长驻、VM 长生命周期](#210-第-10-轮用户纠正wellspring-start-长驻vm-长生命周期)
    - [2.11 第 11 轮：可插拔 VM 底座 + Windows 专用文件逻辑 + 共享文件夹](#211-第-11-轮可插拔-vm-底座--windows-专用文件逻辑--共享文件夹)
    - [2.12 第 12 轮：把宿主 workspace 映射为网络驱动器](#212-第-12-轮把宿主-workspace-映射为网络驱动器)
    - [2.13 第 13 轮：为什么专用账户 + WFP 能做到颗粒度控制](#213-第-13-轮为什么专用账户--wfp-能做到颗粒度控制)
    - [2.14 第 14 轮：VM 本地 NTFS 磁盘能否与宿主实时同步](#214-第-14-轮vm-本地-ntfs-磁盘能否与宿主实时同步)
    - [2.15 第 15 轮：方案 A 详解](#215-第-15-轮方案-a-详解)
- [3. 方案对比总表](#3-方案对比总表)
- [4. 最终参考架构](#4-最终参考架构)
- [5. 待定决策清单](#5-待定决策清单)
- [6. 风险登记](#6-风险登记)
- [7. 术语表](#7-术语表)
- [8. 参考链接](#8-参考链接)
- [9. 时间线](#9-时间线)

---

## 0. 一页摘要

### 0.1 讨论起点

用户提出：Windows 没有自带的沙盒，项目打算自己编写并维护一套沙盒代码，询问可行性与方案。讨论从“用户态沙箱”逐步升级到“VM + 内层账户/WFP”的架构，中途评估了 Windows Sandbox、srt/Codex、fork VirtualBox/VMware、Sandboxie、从零实现、QEMU/Hyper-V 底座、共享文件夹与网络驱动器、VHDX 与宿主实时同步等方案。

### 0.2 讨论演进（简版）

1. **第 1 轮**：先确认“自研沙盒”的方向，指出 Windows 有安全原语但没有 `sandbox-exec`/`bwrap` 式现成工具；建议分层做用户态后端，网络围栏单独考虑。
2. **第 2 轮**：Windows Sandbox 仅 Pro/Enterprise/Education，默认关闭、需重启，10–20 秒启动、单实例、GUI 会话，不适合 per-command。
3. **第 3 轮**：拆解 srt/Codex 的“专用本地账户 + 写受限 token + NTFS ACL + WFP”原理，给出完整命令生命周期与已知缺口。
4. **第 4 轮**：否决 fork VMware（无源码）与 fork VBox（GPLv3、驱动签名、CVE、维护成本）；给出“编排而非 fork”和 HCS/WHPX 的替代路线。
5. **第 5 轮**：把“从 0 写”拆成三层：用户态沙箱（可行）、会话级 VM/容器（可选）、自研 hypervisor（不建议）；给出用户态从 0 的设计与里程碑。
6. **第 6 轮**：用户明确用 C/C++/ASM/UEFI；记录“方案 A（用户态从 0）”的已知缺陷清单（同内核、无网络围栏、服务代理、路径/DACL 生命周期、兼容性、TCB 内存安全、UEFI 属于另一层等）。
7. **第 7 轮**：Sandboxie 的透明虚拟化架构（SbieDrv、SbieSvc、SbieDll、LowLevel、Start/SandMan），token/文件/注册表/IPC/网络五层机制与边界。
8. **第 8 轮**：Sandboxie 开源但“混合许可”：核心 GPLv3，Plus 组件自定义许可（非商业免费、商业需证书、自编译分发受限），给出“依赖 / fork / 重写”三条复用路径。
9. **第 9 轮**：QEMU + Windows VM + 内层账户/WFP 的初始评估（当时按“每次调用起 VM”估算，结论偏保守）。
10. **第 10 轮**：用户纠正：`wellspring start` 长驻，VM 与进程同生命周期，冷启动几十秒可接受；据此改判方案可行，列出 6 个待定设计点。
11. **第 11 轮**：用户提出“setup 时让用户选 VM、Wellspring 只提供下载不随分发”“Windows 专用文件逻辑 + 共享文件夹挂载 workspace”；评估底座可插拔的收益/成本，并指出“共享文件夹 + 内层 ACL”互斥。
12. **第 12 轮**：网络驱动器（SMB）方案：解决了实时一致，但权限链变成宿主 SMB 凭据 + 宿主 ACL，guest 账户不参与；给出 SMB 方案的安全前提与代价。
13. **第 13 轮**：解释颗粒度的来源——可识别身份（SID）× 内核逐请求判定 × 对象/流级规则；为什么独立账户是 WFP 可定位的前提。
14. **第 14 轮**：VM 本地 NTFS 与宿主实时双向同步在块设备层不可行（VHDX 独占、NTFS 非多写者），给出文件级同步/共享/任务边界三种模型。
15. **第 15 轮**：详细展开“方案 A”：guest 本地 VHDX + 宿主镜像 + 双向同步 + 单写者 lease + VHDX/ACL/安全/性能/失败恢复/里程碑。

### 0.3 截至记录时的核心结论（TL;DR）

1. **Windows 沙盒不是“有没有”的问题，而是“哪一层”的问题**：用户态（token/ACL/Job）、内核辅助（driver/注入，Sandboxie 式）、VM（HCS/QEMU/WSB/WSL2）三层各有边界。
2. **要“防手滑/防模型乱来”**：用户态 per-command 沙箱性价比最高（毫秒级、全版本、零安装），能如实报 `partial`。
3. **要“内核级隔离/不可信代码”**：必须 VM/hypervisor；Windows 上优先 HCS/Hyper-V 或 WSL2，QEMU 只在需要跨平台统一时选。
4. **“专用本地账户 + WFP”的颗粒度来自**：NTFS ACL 的每对象判定 + WFP 的每连接判定 + 代理的域名规则；独立账户是 WFP 能只拦沙箱的前提。
5. **共享文件夹/网络驱动器 + 内层 ACL 互斥**：共享文件系统不携带 guest NTFS 安全描述符，权限由宿主共享/凭据决定；要内层 ACL 就 guest 本地盘。
6. **VM 本地 NTFS 无法宿主实时共享**：虚拟磁盘独占 + NTFS 非多写者；只能文件级同步（近实时）或共享/任务边界。
7. **最终推荐形态**（若做 Windows 专用档）：`wellspring start` 起长驻 Windows VM；workspace 在 guest 本地 VHDX（NTFS，沙箱账户 ACL 生效）；宿主镜像 + 双向同步 + 单写者 lease；控制通道只给 SYSTEM；网络强制在宿主侧，guest WFP 作纵深；底座优先 HCS，跨平台统一才用 QEMU。
8. **不建议**：fork VMware（无源码）、fork VBox（GPLv3 + 驱动签名 + CVE + 1–2 人年）、自研 hypervisor、把 Windows Sandbox 当 per-command 后端、同一 VHDX 双挂载。
9. **必须先解决的法务/产品问题**：Windows 客户机授权与镜像分发（尤其商业分发）、VM 软件是否随包分发、VMM 支持矩阵与安全责任划分。
10. **工程上最容易被低估的成本**：ACL 生命周期、路径语义（junction/8.3/ADS/长路径）、同步引擎（rename/delete/并发/冲突）、Windows 更新兼容、驱动签名与兼容性长尾。

---

## 1. 背景与初始约束

### 1.1 项目背景

- Wellspring 是插件式 Agent 平台与 CLI（MIT），已有 `src/sandbox/` 后端抽象：
    - `SandboxBackend` 接口：`probe()`、`buildAgentLaunch()`、`buildPluginLaunch()`、`enforcement()`、`enforcementNotes()`、`pathStyle`、`memoryLimit`。
    - 现有后端：`bwrap`（Linux）、`seatbelt`（macOS，含 `native/seatbelt-run` C launcher）、`node-permission`（Windows/macOS 插件用）、`direct`（降级）。
    - 已验证机制：`scripts/verify-sandbox.ts` + `sandbox-matrix.ts` 探针矩阵，要求“自报的 `full` 必须被实测支撑”。
- 当前 Windows 状况（讨论开始时）：
    - 插件使用 Node permission model（只限制文件读写，不隔离网络/进程）；
    - Agent 的 `execute_code` 在 Windows 无 OS 隔离，`README` 建议 `sandbox.mode=best-effort` 降级为 `direct`；
    - `manager.baseEnv()` 是 POSIX 环境；`candidateBackends` 只映射 bwrap/seatbelt；无 Windows CI。

### 1.2 讨论中的硬约束（逐步明确）

- 用户使用方式：绝大多数时间使用 **`wellspring start`**（长驻服务），不是每次命令起一个进程。
- VM 生命周期：与 Wellspring 进程同生命周期，`wellspring` 退出时才关闭；冷启动几十秒可接受。
- 底座可插拔：setup（Windows 专用安装程序）时让用户选择 VM，后续可修改；Wellspring 只提供下载服务，不随包分发 VM/Windows 镜像。
- 沙盒实现语言：C/C++/ASM（UEFI 被视为可能的技术方向之一）。
- 产品目标（讨论中反复对齐）：既要“防手滑”，也要能向“不可信代码/内核级隔离”演进。

---

## 2. 逐轮记录

### 2.1 第 1 轮：是否自研 Windows 沙盒

**用户原文**：

> 为了解决Windows没有自带的沙盒，我们打算自己编写并维护一套沙盒代码。你有什么看法

**助手回复（整理）**：

**判断**：方向对，但要按“安全边界项目”立项，而不是“给仓库加一个 backend”。核心是把问题拆成两层——**per-command 的隔离**（最小延迟、全版本可用）和 **per-session/内核级隔离**（VM/容器），不要用一层方案同时承诺两件事。

**前提校正**：

- Windows 不是“没有沙盒”，而是有原语（AppContainer、MIC/完整性级别、restricted token、Job Object、WFP、WDAC）和 Hyper-V 的 Windows Sandbox，但**缺少 `sandbox-exec`/`bwrap` 那种“包一条命令”的现成工具**；Windows Sandbox 是整机级、Pro+、单实例、GUI 会话，按命令调用不现实。
- “自己写”实际是“把原语拼装成 launcher + ACL 生命周期 + 安装/回收”，属于安全边界代码，不是普通功能代码。

**同行（讨论时掌握的情况）**：

- Anthropic `sandbox-runtime`（srt）：Windows 支持为 alpha；`srt-sandbox` 专用本地账户 + 按 SID 的 WFP 出网围栏 + write-restricted token + 显式 ACE；一次提权安装；公开承认 Schannel 不可用、ACL 生命周期等缺口；Apache-2.0，`srt-win.exe` 随包。
- OpenAI Codex：先做“无提权 ACL + 合成 SID + write-restricted token”，后改为“提权安装 + 专用本地用户（CodexSandboxOffline/Online）+ 防火墙规则”的多进程架构；公开复盘说明 AppContainer、Windows Sandbox、MIC 都试过、都不适合作为主方案。

**仓库现状（讨论时）**：

| 项                 | 状态                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------- |
| 后端抽象           | `src/sandbox/types.ts` 的 `SandboxBackend` 设计合理，`enforcement` + `notes` 如实自报 |
| 验证机制           | `scripts/verify-sandbox.ts` + `sandbox-matrix.ts` 探针矩阵，要求自报 full 被实测支撑  |
| Windows 插件       | `node-permission` 只限制文件读写，不隔离网络/进程                                     |
| Windows Agent 命令 | 无 OS 隔离，建议 `best-effort` 降级为 direct                                          |
| 平台相关硬编码     | `manager.baseEnv()` 是 POSIX；`candidateBackends` 只有 bwrap/seatbelt                 |
| CI                 | 只有 macOS 沙箱 workflow，没有 Windows runner                                         |

**当时给出的路线对比**（后续轮次逐步细化）：

| 路线                                     | 文件写边界 | 读边界     | 网络隔离 | 需管理员 | 维护成本       | 结论                |
| ---------------------------------------- | ---------- | ---------- | -------- | -------- | -------------- | ------------------- |
| Node permission model                    | 插件进程内 | 部分       | 无       | 否       | 低             | 兜底，不是边界      |
| 受限 token + 合成 SID + ACL + Job Object | ✅         | 开放       | 无       | 否       | 中             | 推荐做 v1           |
| 专用账户 + WFP                           | ✅         | 可做       | ✅       | 一次提权 | 高             | 二期或集成 srt-win  |
| WSL2 + bwrap                             | ✅         | ✅         | ✅       | 需装 WSL | 中             | 已有 WSL 的团队可用 |
| Windows Sandbox                          | ✅         | ✅         | ✅       | 是       | 低但不可脚本化 | 不适合按命令调用    |
| AppContainer                             | 视 profile | 视 profile | 能力控制 | 视情况   | 中高           | 不建议作主路线      |

**建议的实施顺序（当时版本）**：

- Phase 1（2–4 周）：无提权 restricted token + 合成 SID + ACL + Job Object；`enforcement=partial`，notes 如实写“读未收敛、网络不隔离”；strict 继续 fail-closed；探针矩阵加 Windows 探针；Windows CI。
- Phase 2：网络围栏（WFP 或防火墙 + 专用账户）作为 opt-in；优先集成 srt-win，而不是自研 WFP/安装器。
- Phase 3：威胁模型文档、ARM64、EDR 兼容、ACL 回收/崩溃恢复、路径归一化 fuzz。

**维护风险**：

- ACL 生命周期（继承/回收慢、junction/reparse、8.3、长路径、UNC、ADS、大小写）；
- restricted token 的 Schannel/TLS 副作用（npm/dotnet/git 的 TLS 路径可能挂）；
- 安装/卸载/UAC/机器级状态/崩溃恢复；
- 杀软/EDR、Windows 版本差异、ARM64；
- “读开放”“网络不隔离”是产品承诺问题，不是实现细节。

**本轮结论**：值得做，但按“半年期的安全边界项目”立项；先做无提权 partial 后端，网络/VM 层作为可选的第二层；如果目标只是“插件别乱写文件”，优先级应低于功能。

---

### 2.2 第 2 轮：Windows Sandbox 的版本与性能

**用户原文**：

> Windows Sandbox 是每个系统都自带吗，还是需要在控制面板中打开？性能开销如何

**助手回复（整理）**：

**版本与许可**（微软官方文档）：

- 支持：Windows Pro、Enterprise、Pro Education/SE、Education；许可证对应 Pro / Enterprise E3/E5 / Education A3/A5。
- **Windows Home 明确不支持**；Server 不是它面向的 SKU。
- 是“随 Windows 提供”（不需要单独下载 VM 镜像/虚拟化软件），但**默认关闭**，属于可选功能：
    - 控制面板 → 程序 → 启用或关闭 Windows 功能 → 勾选 Windows Sandbox；
    - 或管理员 PowerShell：`Enable-WindowsOptionalFeature -FeatureName "Containers-DisposableClientVM" -All -Online`；
    - 之后需要重启。
- 硬件/固件前提：BIOS 开虚拟化（VT-x/AMD-V，含 SLAT）；≥4 GB 内存（推荐 8 GB）、≥2 核、≥1 GB 空闲磁盘；在 VM 里需要嵌套虚拟化；Windows 10 1903+ / Windows 11；Arm64 需 Win11 22H2+。
- 副作用：启用等于启用 Hyper-V 虚拟机监控器，第三方虚拟化（VMware/VirtualBox）的性能/兼容性可能受影响。

**性能与形态**：

| 维度         | 情况                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 架构         | Hyper-V 隔离的一次性 VM/容器，独立内核；每次启动全新系统，关闭即销毁                                                                                                                                                |
| 启动         | 官方说法“几秒”；SSD 上实际冷启动通常 10–20 秒，首次/低配可到 30 秒以上；对比 bwrap/seatbelt 差 2–3 个数量级                                                                                                         |
| 内存         | 默认上限 4 GB；`.wsb` 的 `<MemoryInMB>` 可调，不够启动时自动抬到 2048 MB；实际常驻约 2–4 GB，另加宿主 HCS/vmmem 开销                                                                                                |
| CPU          | CPU-bound 接近原生；vGPU 默认开启（非 Arm64），关掉用 WARP 软件渲染；磁盘 I/O 有明显虚拟化开销                                                                                                                      |
| 磁盘         | 差分盘，写多少涨多少，关闭后释放                                                                                                                                                                                    |
| 并发         | 一次只能跑一个实例                                                                                                                                                                                                  |
| 自动化       | 没有真正的 headless 模式，需要交互式桌面；较新的 Win11（24H2+）提供 `wsb start/list/connect/stop` CLI 管理常驻实例，但驱动命令/传文件要靠 guest agent（微软自己的 winapp CLI 就是这种模式，并要求主机会话保持解锁） |
| 默认安全配置 | 并不默认安全：网络默认开启、剪贴板默认开启、映射目录默认可写（`ReadOnly` 默认 `false`），默认用户 `WDAGUtilityAccount`                                                                                              |
| 其他         | “One Sandbox is one shared environment”：复用常驻实例能省启动时间，但命令之间共享用户/注册表/运行时/网络；24H2 起沙箱内缺 Calculator/Photos/Notepad/Terminal 等 inbox 应用                                          |

**对 Wellspring 的含义**：不能当 `execute_code` 的默认后端（Home 不可用、管理员+重启+BIOS、每命令 10–20 秒、单实例、GUI 依赖、默认网络/剪贴板/可写映射是洞）。它适合“整轮任务丢进一次性环境”的强化模式、不可信 GUI 程序、打包/兼容性测试，与“按命令”的用户态沙箱是两种形态。

**本轮结论**：Windows Sandbox 不是 per-command 工具；如果做 Windows 强化档，它可以作为可选的“会话级/整机级”方案，但不能替代默认后端。

---

### 2.3 第 3 轮：专用本地账户 + WFP 的原理

**用户原文**：

> 详细解释 专用本地账户 + WFP（srt / Codex 现行） 的原理

**助手回复（整理）**：

**一句话原理**：把“沙箱”从“给进程套一层”换成“换一个身份运行 + 按身份做访问控制”——文件靠 NTFS DACL（外加写受限 token），网络靠 WFP 在内核里按账户 SID 闸门；两者共用同一个身份，所以即使子进程通过 Task Scheduler、COM、BITS 这类“代理派生（surrogate spawn）”绕出去，新进程仍带着沙箱账户的 SID，两个边界都还在。

**为什么需要这套**：Windows 没有 mount/PID/net namespace；只有身份、文件、网络、资源原语。专用账户 + WFP 是把它们拼成“账户级沙箱”。

#### 平面一：身份——专用本地账户

安装时（一次 UAC）创建：

- 本地账户（srt：`srt-sandbox`；Codex：`CodexSandboxOffline` / `CodexSandboxOnline`，区分断网/联网）；
- 本地组（srt：`sandbox-runtime-users`），把需要跑沙箱的宿主用户加进去；
- 随机密码，DPAPI 加密存到 `HKLM\SOFTWARE\sandbox-runtime`（机器级，SYSTEM/批量部署可读）；
- 机器级 WFP 过滤器集合。

作用：

1. **文件权限天然隔离**：账户对调用者 profile 没有 ACE，默认读不到写不了；放行处显式加 ACE。
2. **网络过滤可按 SID 命中**：WFP 的 `ALE_AUTH_CONNECT` 层按“连接建立时令牌的用户身份”匹配，只有沙箱账户的 connect 被 BLOCK，机器上其他进程不受影响。写受限 token 不改变用户 SID，所以**没法**只针对“沙箱子进程”过滤而不误伤调用者——这是必须换账户、而不是只换 token 的关键原因。
3. **封死代理派生**：Task Scheduler、`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` 指到 broker、BITS、`RunAs="Interactive User"` 的 out-of-process COM……无论怎么“借壳”拉进程，新进程仍带沙箱 SID，WFP 与文件权限继续生效。

启动方式（srt 的 `srt-win.exe`）是“两跳”：

```
broker（调用者身份）
  └─ CreateProcessWithLogonW(srt-sandbox) ← 加载沙箱账户独立 profile（%USERPROFILE%、%TEMP%、HKCU）
       runner（srt-sandbox 身份）
         └─ CreateRestrictedToken + Job Object → target（任意命令）
```

#### 平面二：文件——NTFS DACL + 写受限 token

- **默认拒绝**：沙箱账户对用户文件没有权限，`.ssh`、`.aws`、浏览器 profile 默认读不到（除非做 profile grant）。
- **放行用加性 ACE**：srt 在 `allowWrite` 根上写**可继承的显式 ALLOW ACE**（MODIFY，含 READ|WRITE|EXECUTE|DELETE，但不给 `FILE_DELETE_CHILD`）；`allowRead` 写 READ|EXECUTE；`denyRead`/`denyWrite` 写可继承 DENY，并在父目录补 `FILE_DELETE_CHILD` DENY，防止通过重命名父目录绕过。原则是**只追加、从不重写/替换已有安全描述符**，reset 只回收自己加的 ACE。
- **写受限 token**：沙箱账户是 `BUILTIN\Users` 成员，普通 token 能在 `C:\`、数据盘、PATH 目录等 Users 可写处写；所以 target 再套 `CreateRestrictedToken`，restricting SIDs 包含：沙箱账户、`Everyone`、`RESTRICTED`，以及**每个 allowWrite 根一个标识符 SID**。限制 token 里“组权限”失效，只留显式授予该会话的根、账户自己的 profile、Everyone 可写的位置；读不受影响。
- **profile grant（可选，兼容性）**：npm/pip/git 要读用户目录配置，所以 srt 在提权安装后，以用户身份、不提权给沙箱组加“读+执行”ACE，逐个目录授予，排除 `.ssh`、`.aws`、浏览器数据、凭据缓存等；junction/symlink 不穿透。代价：大 profile 首次几分钟；新文件要 refresh 才可读；机器级，同机其他沙箱会话也能读这些被授予的根（只读）。
- **ACL 生命周期**是真正的工程量：递归写继承 ACE 慢、回收慢；并发引用计数；崩溃恢复；kept grant 跨会话保留；卸载清理；ACL 写不进去的对象只能报 `unprotected`/`unverifiable`/`staleAllow`。

#### 平面三：网络——WFP 过滤 + 代理唯一出口

安装时在 `FWPM_LAYER_ALE_AUTH_CONNECT_V4` / `V6` 加机器级、持久化 filter：

- **PERMIT**：loopback 到代理端口范围（srt 默认 `60080–60089`）；
- **BLOCK**：任何“令牌为 srt-sandbox 账户”的 connect（包括在该账户下启动的 AppContainer 进程）；
- 可选 **PERMIT**：`--allow-loopback` 的本地回环变体（留一个端口永久 BLOCK 用于自检）。

沙箱进程只能连宿主代理，代理按域名 allowlist 转发；进程即使清空代理 env 直接连 IP 也会被内核拦。**自检（fail-closed）**：`initialize()` 以沙箱账户做真实 connect 探针（本体 token、降低完整性级别的副本、不同 token 顺序、匿名/deny-only token），确认该拦的都拦住，否则拒绝启动。

**公开承认的缺口**：

- 过滤器按 **socket 创建时**的 token 归属匹配；沙箱进程在“建 socket 之前”把别的 token 临时放到线程上，就不被识别；
- 由系统服务代传的流量（如 DNS Client 服务）不匹配这些条件；
- 匿名 token、deny-only token 的探针只报告、不拒绝（残余风险）；
- 网络授权是“建连时裁决”，已建立的连接不受新过滤器影响。

#### 平面四：进程与资源

- Job Object：内存上限、活跃进程数、kill-on-close；
- 固定环境：只保留 broker 的 `PATH` 和生成的代理变量；
- 独立 profile：`%USERPROFILE%`、`%TEMP%`、`HKCU` 都是沙箱账户自己的。

#### 一次命令的完整路径

1. 会话开始：确保 workspace 的 ACE 已授予沙箱 SID（增量、可继承）。
2. broker → CreateProcessWithLogonW 起 runner（srt-sandbox 身份）。
3. runner → write-restricted token + Job Object + 固定 env（代理指向 loopback 端口）。
4. target 文件 I/O → NTFS DACL 裁决（默认拒，allowWrite 根放行）。
5. target connect → WFP ALE_AUTH_CONNECT 裁决（默认 BLOCK，仅代理端口 PERMIT）。
6. 代理 → 域名 allowlist 判定（可选 TLS 终止做凭据隔离/日志）→ Internet。
7. 退出：回收 token/job；回收本次 ACE（或保留 keep grant）；写会话记录/refcount。

#### 与“无专用账户：restricted token + ACL”的区别

|              | 受限 token + ACL            | 专用账户 + WFP                                   |
| ------------ | --------------------------- | ------------------------------------------------ |
| 文件写边界   | ✅ 靠 restricting SID + ACL | ✅ 更强，靠“另一个用户”                          |
| 文件读边界   | 开放                        | 默认关闭，按需 grant                             |
| 网络边界     | ❌ 没有可归属的 SID 可过滤  | ✅ WFP 按账户 SID 拦                             |
| 代理派生逃逸 | 有风险                      | 结构性关闭                                       |
| 需要管理员   | 否                          | 是（一次 UAC）                                   |
| 机器级状态   | 无                          | 账户、组、WFP filters、HKLM 密码、setup 版本     |
| 兼容性       | 好（同用户/会话）           | 差一些（独立 profile/登录会话、Schannel 失效等） |
| 维护成本     | 中                          | 高（安装/升级/卸载/共享机器/ACL 回收）           |

**现实坑**：Schannel/TLS 在写受限 token 下失效（curl.exe、Invoke-WebRequest、.NET HttpClient、winget、dotnet restore 直接挂；Node/Python/Java/Go/OpenSSL 版 git 才能用，srt 文档说“没有变通办法”）；ACL 生命周期；路径语义（junction/8.3/UNC/ADS/长路径）；安装/升级/卸载（setup version 不匹配必须拒绝运行；旧版本 keep grant 有提权窗口）；这不是 hypervisor 边界，内核漏洞/系统服务代传/管理员安装组件不在保护范围内。

**本轮结论**：srt/Codex 的核心不是“账户”或“WFP”单点，而是“身份 + ACL + WFP + 代理 + 生命周期”的组合；它能做到颗粒度，但代价是管理员安装、机器级状态、兼容性与长期维护。

---

### 2.4 第 4 轮：fork VBox/VMware 还是自研

**用户原文**：

> 我们自己开一条新路。目前已有思路：
> 1：修改VBox或者VMWare（商业可能受限制），做出来一个专用版本
> 2：自己实现一套sandbox

**助手回复（整理）**：

**结论**：方案 1（fork VMware）不可行；方案 1（fork VBox）法律上能做、工程上是陷阱；方案 2 是正确方向，但要拆成“用户态”和“会话级/VM”两层，否则会滑向“自己写 hypervisor”。

#### VMware：直接排除

没有公开源码，反编译/修改违反 EULA；只有 OEM/合作方协议（拿不到、也改不了内核）。

#### VirtualBox：法律可以，工程不建议

**法律事实**（VirtualBox Licensing FAQ）：

- 7.1 起基础包是 **GPLv3**（更早是 GPLv2）：可改、可分发，但修改必须同样以 GPLv3 发布；
- **Extension Pack 是 PUEL**：个人/教育免费，**不允许再分发**（USB 3、VRDP、磁盘加密等在其中），商业分发要单独授权；
- **“VirtualBox”是 Oracle 商标**，改过的版本不能叫这个名字；
- 如果产品是 MIT/闭源商业版，fork 出的 VMM 要么独立成 GPLv3 组件，要么整个产品被 GPL 传染。

**工程事实**：

1. **内核驱动**：`VBoxDrv.sys`（ring-0 VMM）、`VBoxNetAdp`/`VBoxNetFlt`、`VBoxUSBMon`；改完要自己签名（EV 证书 + Microsoft attestation/WHQL，Secure Boot 必须过；企业 WDAC/AppLocker 可能直接拦）。
2. **与 Hyper-V/VBS 共存**：VBox 依赖自己的 ring-0 组件和 VT-x，和 Hyper-V、VBS/HVCI 共存一直是部署痛点；企业机器默认开 VBS 时更明显。
3. **CVE 归属**：VBox 的历史 CVE 大量集中在设备模拟、NAT、共享文件夹、3D 加速；fork 之后这些攻击面是你们的，未来每个 CVE 都归你们 triage、修补、发版。
4. **真正要的东西 VBox 大多不提供**：headless 控制、快照池化、受控文件通道（不是共享文件夹）、按任务网络策略、guest agent、镜像更新、安装/卸载/升级状态机——全要自己造，还要先裁掉 GUI/USB/3D/剪贴板/共享文件夹。
5. **工作量**：1–2 名有 Windows 内核/虚拟化经验的人，做到“能当产品用”是 **1–2 人年起步**，之后还要养安全响应团队。

**如果确实要 VM 底座，正确做法不是 fork，而是“编排”**：

- 用未修改的 VBox/VMware 当可替换依赖，通过 `VBoxManage`/SDK 或 `vmrun` 编排（“专用版本”体现在镜像、策略、生命周期和 UX，而不是改内核）；缺点仍是驱动/GPL/共存问题，只适合内部或对交付形态不敏感的场景。
- 或用 Windows 自带 hypervisor API：**HCS（Host Compute System）** 创建/启动/停止 VM 和容器，JSON 配置、进程内交互、快照/暂停/恢复，驱动/设备模型由微软维护；**WHPX（Windows Hypervisor Platform）** 给第三方 VMM 用的用户态 API（Win10 1803+），不用自己写 ring-0 驱动，但设备模型/启动协议仍要自己做（或基于 QEMU 的 WHPX 后端）。

**路线 2 的正确拆法（下一轮展开）**：用户态（可行）、会话级 VM/容器（可选）、自研 hypervisor（不建议）。

**本轮结论**：不要 fork VBox/VMware，也不自研 hypervisor；如果做 VM 层，用 HCS/WHPX 做底座、写控制面和 agent。

---

### 2.5 第 5 轮：能不能从 0 写 sandbox

**用户原文**：

> 我对这些都不满意。能不能自己从0写sandbox

**助手回复（整理）**：

**结论**：能，但要先定义“从 0”的层次。

| 层次                              | 含义                                                                    | 可行性                  | 代价                                                                  |
| --------------------------------- | ----------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------- |
| **A. 从 0 写用户态 Windows 沙箱** | 不用 srt/Codex/WSB/VBox 的代码，只把 Windows 安全原语按自己的设计拼起来 | ✅ 可行，是真正的新路   | 1–2 人、3–6 人月到可用                                                |
| **B. 连 Windows 安全原语也不用**  | 自己实现隔离机制，不依赖内核 access check                               | ❌ 用户态不可能         | —                                                                     |
| **C. 从 0 写 hypervisor**         | VT-x/EPT、设备模型、guest、启动协议全自己来                             | ⚠️ 只有靠这个才能突破 B | 2–3 名资深虚拟化工程师、1–2 年起步（Linux guest）；Windows guest 更久 |

关键事实：所有沙箱都是“操作系统原语的组合”（bwrap 用 namespace，seatbelt 用内核 MAC，Firecracker 用 KVM）；“从 0”只能从组合方式、策略模型、生命周期、代码所有权层面从 0，不可能从隔离机制层面从 0（那等于从 0 写内核）。

#### 层次 A 的组件与设计（当时给出的蓝图）

```
TS 侧：src/sandbox/backends/win-native.ts
  └─ spawn bin/win32-<arch>/ws-sandbox.exe（自己的 native core）
       ├─ policy compiler：策略 JSON → enforcement plan
       ├─ identity：每个沙箱一个随机 SID（不建账户、不落 HKLM）
       ├─ fs：DACL 账本（grant / deny / 回收 / 崩溃恢复）
       ├─ proc：restricted token + Job Object + argv-only + env 白名单
       ├─ io：stdin/stdout/stderr 管道 + 产物同步
       ├─ audit：JSONL 事件
       └─ net：v1 明确不做（partial）；v2 可选 fence service（admin + WFP）
```

**设计上的差异点**：

1. **无账户的瞬时身份**：每命令生成随机 SID 作为 restricted token 的 restricting SID + DACL 主体；不建账户、不写注册表、不需要管理员、没有机器级残留；代价是做不了网络围栏（WFP 按用户 SID 匹配），也做不了跨命令持久权限。
2. **能力账本**：不是硬编码三种模式，而是每次执行生成一组 capability（路径 + 操作 + TTL），编译成 ACE 集合，执行完回收；策略可审计、可 diff、可测试。
3. **句柄优先**：先 open 拿 handle，再用 `GetFinalPathNameByHandle` 规范化后判定，消除字符串路径 TOCTOU；拒绝 reparse point 穿越、8.3、ADS、长路径/UNC 歧义。
4. **argv-only、无 shell**：不经过 cmd/powershell 字符串拼接；env 白名单；stdio 管道；Job Object 管内存/进程数/kill-on-close；禁止 breakaway。
5. **失败即拒绝**：任何 ACL/句柄/自检失败都 fail-closed；`enforcement` 自报必须被探针矩阵支撑。
6. **双模**：per-command（毫秒级）与 per-session（可选 VM/WSL 层）共用同一策略语言。

**必须接受的边界**：

- 同内核：挡不住内核漏洞、驱动攻击、管理员级对手；不是多租户隔离；
- 无管理员 = 无网络围栏（WFP/防火墙都要提权）；
- 兼容性坑：restricted token 下 Schannel 可能失效；包含 `RESTRICTED` SID 会限制凭据访问，不含又可能读到用户凭据（零和取舍）；
- 维护成本不会因为“从 0”而降低，反而更高：路径/ACL/句柄/超时/崩溃恢复的边界全是自己的责任。

**里程碑（1–2 人估算）**：

| 阶段           | 内容                                                  | 验收标准                                           |
| -------------- | ----------------------------------------------------- | -------------------------------------------------- |
| M0（2 周）     | native skeleton、stdio/exit/timeout、Windows CI       | 跑通 `node -e`、`cmd /c`、超时被杀                 |
| M1（1–1.5 月） | 随机 SID + restricted token + Job Object              | 写 workspace 成功、写外部/系统目录被拒、子进程被杀 |
| M2（1 月）     | DACL 账本 + 敏感路径 deny + 回收/恢复                 | 读不到 `.ssh` 等；崩溃后无残留 ACE                 |
| M3（1 月）     | 路径硬化：junction/8.3/ADS/长路径/硬链接              | 对抗性探针全过                                     |
| M4（1–2 月）   | 可选：网络 fence service（admin+WFP）或 VM/WSL 会话层 | fail-closed 自检；安装/卸载/升级状态机             |
| M5（持续）     | 红队、EDR 兼容、ARM64、文档                           | 每个版本的能力矩阵与实测一致                       |

**从 0 也写不出来的东西**：比“同内核 access check”更强的边界（只能 VM 或独立机器）；多租户/敌对租户隔离（必须 hypervisor）；无管理员的网络隔离（做不到，除非 AppContainer，但兼容性会碎一地）。

**本轮结论**：先做 A（用户态从 0），网络围栏和 VM 会话层作为明确的“可选第二层”；不要从 VBox fork 或自研 hypervisor 开始。

---

### 2.6 第 6 轮：语言选择与方案 A 的已知缺陷

**用户原文**：

> 首先沙盒我们打算用其他语言（C/Cpp/ASM/UEFI）编写。其次列出方案A的已知缺陷

**助手回复（整理）**：

**语言先放位**：

| 技术栈            | 对应的层                           | 说明                                |
| ----------------- | ---------------------------------- | ----------------------------------- |
| C/C++ 用户态 exe  | A（用户态沙箱）                    | ✅ 可行，TCB 内存安全责任全在你们   |
| C/C++ 内核驱动    | 仍是同内核，只是换了执行位置       | ⚠️ 要驱动签名，且不提供内核隔离     |
| ASM               | 只能是 syscall stub / CPU 特性探测 | ❌ 不该承载策略逻辑                 |
| UEFI / hypervisor | C 层（VM/虚拟化）                  | 是另一个量级的产品，不是 A 的一部分 |

UEFI 意味着想要的可能是“在 Windows 之下执行”的隔离，那已经不是 A 了：UEFI 只负责加载/持久化，真正做隔离的还必须是 hypervisor（VT-x/EPT/设备模型），并带来 Secure Boot 签名、固件兼容、变砖、BitLocker/测量启动冲突、反作弊/EDR 冲突、卸载困难等整套问题。

**方案 A 的缺陷清单（按能否在 A 内消除分组）**：

#### 一、A 内无法消除的边界性缺陷（最要命的三条 + 结构性）

1. **同内核，没有内核隔离**（致命）：共享内核，内核漏洞、恶意驱动、rootkit 可穿透；A 能挡“用户态的不当/恶意命令”，不是“有内核能力的攻击者”；无解，只能 VM/独立机器。
2. **无管理员 = 没有网络隔离**（致命，如果承诺含“不能出网”）：token/ACL/Job 都管不了网络；WFP/防火墙需要提权；代理 env 只是建议；系统服务代传流量（如 DNS Client）不在用户态沙箱管辖内。
3. **多租户/敌对租户不成立**（高）：共享内核+共享桌面；DoS、侧信道、内核攻击都成立。
4. **同一会话/桌面带来的主机干扰面**（高）：同一 window station/desktop，剪贴板、窗口消息、UI 自动化、COM 到宿主应用、截图、会话内命名对象都可触及；可做 DoS、社工、干扰宿主程序。缓解：`CreateDesktop` + 独立 window station，或独立 logon session（要账户/管理员）；命名对象仍在同一 session。
5. **代理派生/系统服务代劳**（高）：Task Scheduler、WMI、BITS、Print Spooler、out-of-process COM 激活、Windows Installer 等以服务自身身份执行，不受沙箱 token 限制；Job Object 只管自己派生的子进程；无完全解法。
6. **管理员/高完整性调用者会显著削弱沙箱**（高）：管理员 token 带管理员组；`SeBackup`/`SeRestore`/`SeTakeOwnership`/`SeDebug` 任一没去掉都能绕过 ACL。正确做法：linked filtered token + `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)` + 移除管理员 SID，并拒绝在提权会话里降级运行；`DISABLE_MAX_PRIVILEGE` 会保留 `SeChangeNotifyPrivilege`（目录遍历必需）。
7. **资源耗尽（DoS）**（中）：CPU/磁盘/句柄/GDI/USER 对象/共享内存/网络带宽；Job Object 能限进程数/提交内存/kill-on-close，但限不住全部。
8. **“沙箱产物二传手”**（中）：沙箱写进 workspace 的代码/二进制，之后可能被宿主用户、dev server、构建脚本、网页“打开”按钮执行；沙箱只覆盖“沙箱内执行”。
9. **不防提示注入/模型决策错误**（中）：模型被注入后执行“合法但危险”的操作，沙箱按策略放行；这是策略/审批 UX 的问题。

#### 二、A 内可缓解、但从 0 必须自己扛的实现缺陷

10. **路径规范化与链接**（高）：junction/symlink/reparse、8.3、ADS、UNC、长路径、尾随点/空格、设备名、大小写不敏感；字符串比较必漏；检查与使用之间有 TOCTOU。正解：句柄优先（`CreateFile` + `GetFinalPathNameByHandle`）、`FILE_FLAG_OPEN_REPARSE_POINT`、禁止创建链接、fuzz 路径。
11. **DACL 生命周期**（高）：授权/回收递归写继承 ACE，大目录慢；崩溃留 ACE；并发要引用计数；不是自己拥有的对象可能写不了 ACL。缓解：日志式账本、幂等 grant、TTL、启动校验/清理；残余：硬崩溃后可能残留。
12. **读边界粗粒度且与兼容性零和**（高）：写受限 token（`WRITE_RESTRICTED`）只限写，读默认全开；想拦 `.ssh`/浏览器数据就得 deny ACE 或独立账户；想跑 npm/pip/git 又得读 `~/.npmrc`/`~/.gitconfig`（可能含 token）。缓解：显式配置文件白名单 + 凭据黑名单，接受取舍并写入文档。
13. **兼容性长尾**（高）：Schannel/TLS 可能失效；HKLM/HKCU 写、服务、COM、安装器、全局包管理器、VS/MSBuild、WSL、Docker、GUI 应用各有 `ACCESS_DENIED`。缓解：逐工具 shim/配置，文档写清“哪些工具必须在沙箱外跑”。
14. **句柄继承泄漏**（高）：launcher 必须 `bInheritHandles=FALSE` + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 只给 stdio；否则宿主已打开的句柄会被沙箱继承，直接绕过 ACL。
15. **TCB 内存安全（C/C++ 特有）**（高）：路径/策略/ACL 解析器是攻击面；一个缓冲区/整数/UB bug 就可能把“沙箱内”变成“调用者权限”；如果 v2 fence service 是提权进程，这个 bug 直接是提权漏洞。缓解：策略/解析用 Rust 或加固 C++（禁 STL 容器进热路径、禁异常、ASan、fuzz、CFG/CET、代码审查）；TCB 控制在万行以内；ASM 不碰策略。
16. **环境与 PATH 注入**（中）：PATH、DLL 搜索顺序、`NODE_OPTIONS`、COM 劫持；如果 workspace 在宿主 PATH 上，沙箱写入的 DLL 可能被宿主后续加载。固定 env + 不放 workspace 到 PATH + safe DLL search。
17. **诊断与归因**（中）：用户看到随机 `ACCESS_DENIED`，没有解释；需要审计事件、ETW、探针。
18. **测试/CI**（中）：user-mode 测试在 GitHub `windows-latest` 就能跑（不需要嵌套虚拟化），但 Windows 版本/ARM64/EDR/企业策略矩阵大；必须做对抗性探针。
19. **AV/EDR 冲突**（中）：Defender ASR、第三方 EDR 可能拦截 token/ACL/进程操作或标记 launcher；企业环境不可控。
20. **签名、分发、更新**（中）：Authenticode/SmartScreen、自动更新、版本兼容、回滚；沙箱代码与策略版本不匹配时行为不可预期（需要版本化 + fail-closed）。

#### 三、语言/技术栈带来的额外缺陷

21. **C++**：UB、Win32 API 误用、异常/RAII、路径拼接的整数与编码问题；需要编码规范 + 静态分析 + fuzz。
22. **ASM**：可审计性/可移植性差；只适合 syscall stub、CPU 特性探测、hypervisor 的 VMX 入口；不要用它写策略。
23. **UEFI**：不属于 A；解决“低于 OS 的持久化/隔离”，代价是 Secure Boot 签名链、固件兼容、变砖风险、BitLocker/测量启动、反作弊冲突、更新/卸载困难；且它本身不做隔离，隔离仍要 hypervisor（C 层）。

#### 四、组织/合规

24. 自研核心没有历史 CVE/社区测试/红队积累，你们是第一响应人；需要安全响应流程、SLA、漏洞披露。
25. 一旦引入内核驱动/hypervisor：驱动签名（EV + attestation）、WHQL、Windows 更新回归、CVE 响应团队、保险都是持续成本。
26. 与 OS 版本强绑定：Win10 已 EOL、Win11 每年更新、ARM64、Server/Home 差异；每个版本都要重跑矩阵。

**三条“不能靠 A 解决”的底线**：承诺“不能出网/不能读密钥”→ 需要管理员 fence 或 VM；承诺“不能危害宿主内核”→ 需要 VM/独立机器；承诺“多个敌对租户共用机器”→ 需要 hypervisor。

**如果坚持 A，最低防御清单**：

1. 拒绝提权调用者，或强制 linked filtered token + `DISABLE_MAX_PRIVILEGE` + 移除管理员组；
2. 写边界用 `WRITE_RESTRICTED` token + 随机会话 SID + 每命令 DACL 账本（TTL/恢复）；
3. 读边界用显式白名单 + 凭据黑名单，别承诺“读全隔离”；
4. `bInheritHandles=FALSE` + handle list；argv-only；env 白名单；TEMP/HOME 重定向到 scratch；
5. Job Object：kill-on-close、进程数、提交内存、超时；禁止 breakaway；
6. 路径全程句柄优先，链接/8.3/ADS/长路径/UNC 列为必测项；
7. 可选：独立 desktop/window station，削掉 UI/剪贴板/COM 面；
8. 每次执行输出 `enforcement` + `notes`，探针矩阵在 Windows CI 上跑，自报必须被实测支撑；
9. fail-closed；任何 ACL/句柄/自检失败就拒绝执行；
10. 把 workspace 产物当不可信输入对待（宿主侧不要自动执行）。

**本轮结论**：C/C++ 可以写 A 的 native core，但 ASM/UEFI 属于 C 层；A 的缺陷里“同内核、无网络、服务代理”三条是产品承诺级的，必须用第二层（VM/提权 fence）补，不能靠实现技巧掩盖。

---

### 2.7 第 7 轮：Sandboxie 的实现原理

**用户原文**：

> Sandboxie是怎么做的

**助手回复（整理）**：

**一句话**：Sandboxie 是“**内核驱动 + 注入 DLL + 受限 token**”的透明虚拟化沙箱：应用照常看到 `C:\...`、注册表照常可读，但写操作被重定向进沙箱目录，读操作在“沙箱副本优先、否则回落宿主”的 merged view 里进行。它既不是 VM（无独立内核），也不是 srt/Codex 那种“换账户 + ACL + WFP”，而是介于用户态沙箱和 VM 之间的**内核辅助遏制层**——原生速度、高兼容，代价是内核驱动进入 TCB、维护巨大的兼容性矩阵。

代码开源（`sandboxie-plus/Sandboxie`，**GPLv3**），C++ 为主、注入器有一部分汇编。

#### 组件

```
SbieDrv.sys（内核驱动，TCB 核心）
 ├─ PsSetCreateProcessNotifyRoutine：进程创建通知，判断是否入沙、阻断/挂起
 ├─ syscall stub 重定向：把选定 ntdll 系统调用交给驱动判定后执行
 ├─ 进程/对象访问过滤：沙箱进程不能碰宿主进程与沙箱外对象
 └─ 可选 WFP callout：内核态网络规则（NetworkEnableWFP=y 时）
SbieSvc.exe（SYSTEM 服务）
 ├─ 注入 loader、提供特权辅助操作、箱体/配置管理
SbieDll.dll（注入到每个沙箱进程）
 ├─ hook ntdll 系统调用 stub + 大量 Win32 API
 ├─ 文件 / 注册表虚拟化（用户态实现 merged view + 重定向）
 └─ 兼容性 shim（按程序名/模板做例外）
LowLevel.dll（注入用 shellcode，部分汇编、位置无关）
 └─ 覆盖 ntdll!LdrInitializeThunk 触发 SbieDll 加载
Start.exe / SandMan / SbieIni（启动器、GUI、配置 sandboxie.ini）
```

#### 一次“入沙”的流程

1. 用 `Start.exe`（或右键“Run Sandboxed”、或父进程已在沙箱内）启动目标程序。
2. 驱动收到进程创建通知，决定该进程属于哪个 box：阻止创建并让 SbieSvc 注入 loader，或者先挂起进程、由驱动打上沙箱标记后再恢复。
3. 注入器用 shellcode 覆盖 `ntdll!LdrInitializeThunk`，把 `SbieDll.dll` 加载进目标进程。
4. SbieDll 初始化：hook 系统调用 stub、Win32 API、装载兼容性模板、挂载该 box 的注册表 hive。
5. 之后每次文件/注册表/IPC 访问都先经过 SbieDll 的路径改写和规则判定；绕过 hook 的部分由驱动和受限 token 兜底。

#### 五层隔离机制

**1）Token 层：先让进程“几乎什么都干不了”**

- 进程以高度受限的 primary token 创建；Sandboxie Plus 1.14.1 之后默认走“新建 token”路径（`UseCreateToken`），历史路径是用未文档化的内核例程 `SepFilterToken` 做过滤；
- 削减权限、普通组转 deny-only、应用 low/untrusted 完整性级别；
- 沙箱身份：共享组 `S-1-5-100-0`（`Sandboxie\All Sandboxes`），`SandboxieLogon` 提供 per-box 身份；
- Hook 被绕过、直接 `syscall` 时，调用仍在这个受限 token 下，受 Windows access check 约束。

**2）文件虚拟化：写重定向 + copy-on-write**

- 文件虚拟化在用户态 SbieDll 里实现（驱动负责兜底和部分 syscall 判定）；
- 写 `C:\NEW.TXT` → `FileRootPath\drive\C\NEW.TXT`；写 `C:\Users\joe\Documents\NEW.TXT` → `FileRootPath\user\current\Documents\NEW.TXT`；网络共享 → `share\server\share`；
- 读：沙箱里有副本就读副本；没有副本且不要求写，就只读读宿主原文件（首次修改才 copy-on-write 进沙箱）；
- `OpenFilePath`/`ReadFilePath`/`ClosedFilePath` 控制放行、只读、禁止；
- 如果虚拟化被绕过，结果是 ACCESS_DENIED（token 权限本身不够），不是“悄悄写到宿主”。

**3）注册表虚拟化：RegHive**

- 沙箱注册表存在 `FileRootPath\RegHive` 这个 hive 文件里；
- 挂载到 `HKEY_USERS\Sandbox_<user>_<box>`（`KeyRootPath` 默认）；
- 写 HKLM → `machine\...`；写 HKCU → `user\current\...`；读时按需合并沙箱与宿主；
- `OpenKeyPath`/`ReadKeyPath`/`ClosedKeyPath` 控制例外。

**4）IPC / 对象命名空间：直接隔离，连读都不许**

- 沙箱程序创建的命名对象（事件、互斥体、section、命名管道、RPC 端点）重定向到 `\Sandbox\<user>\<box>\Session_<n>\BaseNamedObjects\...`、`\RPC Control\...`；
- 官方明确：沙箱程序永远不允许访问沙箱外的 IPC 对象，即使只读；驱动阻止沙箱进程打开宿主进程句柄；
- `OpenIpcPath` 为兼容性开口（内置一堆，第三方软件还会追加）。

**5）网络：规则引擎 + 可选 WFP**

- `NetworkAccess` 规则按进程、地址、端口、协议匹配；默认没命中就放行（默认拒绝要写 `NetworkAccess=*,Block` 再放行）；
- 默认实现是 SbieDll 在用户态 hook Winsock（connect/WSAConnect/sendto/WSASendTo 等）；
- 官方承认用户态 hook 能被绕过，所以提供 `NetworkEnableWFP=y`，用内核 WFP callout 在 outbound connect 和 inbound receive/accept 层执行同一套规则。

#### 为什么它又快又兼容

没有 VM（无独立内核、无 boot、无 guest 驱动）；没有独立账户（不需要创建账户/改 ACL/走另一登录会话）；应用无感（路径/注册表名字不变，只是写入落点被换）；清理简单（box 是一个目录 + 一个 hive 文件，删掉即回滚）。

#### 它到底是什么安全边界

1. **默认是“遏制”不是“保密”**：读宿主文件默认允许（只有 `ClosedFilePath`/`ClosedKeyPath` 才拦）；要防读密钥必须显式配规则并维护。
2. **同内核**：驱动 + 注入器在 TCB，驱动有 CVE 历史；挡不住内核漏洞/恶意驱动；不是多租户隔离。
3. **Hook 绕过是设计内的问题**：直接 syscall 绕开用户态 stub，但仍在受限 token 下，且驱动对部分 syscall 有独立检查——是“纵深”，不是“单点不可破”。
4. **兼容性长尾是真正成本**：官方 Known Conflicts 列出 Microsoft Store 应用不支持、Office 2021 无法在沙箱内安装、BITS 服务被 WMI 阻断、反作弊游戏、第三方安全软件冲突、Win11 麦克风/摄像头不可用等。
5. **对恶意代码不是“安全边界”**：定位是“装可疑软件不污染系统”，不是“防定向逃逸/APT”。

#### 对“从 0 写”的启示

- 如果目标是“agent 能跑任意 Windows 命令/安装器/GUI，且要原生速度”，Sandboxie 式架构是唯一达标的形态；
- 但“从 0 写”等于同时做文件系统/注册表虚拟化、注入器、NT 对象隔离、网络规则、WFP 可选层、驱动签名、Windows 更新兼容测试，以及几十条 Known Conflicts 的兼容性团队；
- Sandboxie 从 2004 年前后开始，2020 年开源，今天还在跟 Windows 版本搏斗——这份兼容性债是最值钱也最难复制的部分。

**本轮结论**：Sandboxie = 内核辅助的透明虚拟化；它证明了“原生速度 + 高兼容”可行，但代价是驱动 TCB 与长期兼容性维护；它仍是同内核，不是 VM 级边界。

---

### 2.8 第 8 轮：Sandboxie 是否开源、能否复用

**用户原文**：

> Sandboxie开源吗？能否复用

**助手回复（整理）**：

**结论**：开源，但“开源”不等于“随便用”——**混合许可**：

| 组件                                                           | 许可                 | 能做什么                                                                   |
| -------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------- |
| Sandboxie 核心（SbieDrv 驱动、SbieDll、SbieSvc、Start.exe 等） | GPLv3                | 可改、可编译、可分发，但衍生作品必须 GPLv3，分发要提供源码                 |
| Sandboxie-Plus 外壳（SandMan UI、安装器、Plus 发行包）         | 自定义许可（非 GPL） | 非商业免费；商业使用需 xanasoft 的商业证书；自编译二进制公开分发有附加条件 |
| QSbieAPI（控制 API 的独立 IPC 实现）                           | LGPL                 | 动态链接可被专有程序使用，但要满足 LGPL 义务                               |
| MiscHelpers、Qt                                                | LGPL                 | 同上                                                                       |

Plus 许可（原文要点）：

- 非商业随意用；商业使用必须买 business certificate（3 台机器内可短期评估）；
- 原版未修改二进制可免费再分发；
- 改源码可以，但仅限私有非商业用途；
- 自编译二进制公开分发必须：全部源码（含修改）公开、不得改名、不得移除作者/版权信息，且原作者保留按其判断禁止分发非官方二进制的权利；
- 自编译二进制用于商业，必须有商业证书。

因此“fork 一份改吧改吧做成我们自己的商业产品”——Plus 这条路基本被许可堵死；GPLv3 的核心可以 fork，但要开源整个衍生部分，且不能把 Plus 的 UI/包装按自己的品牌发。具体务必找法务确认，以上不是法律意见。

#### “复用”的三种姿势

| 方式                        | 做法                                                                                                         | 工作量               | 许可风险                                                  | 维护                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------- | --------------------------------------------------------- | ---------------------------------- |
| A. 当外部依赖用（不改代码） | 安装官方 Sandboxie-Plus，用 `Start.exe /box:<Box> /wait <cmd>` 跑命令，`SbieIni` 建箱、`delete_sandbox` 清理 | 低（几天到几周集成） | GPLv3 聚合 + Plus 商业证书；改名/分发受限                 | 跟官方版本走                       |
| B. Fork 做“专用版本”        | 拿核心 GPLv3 代码改，自己编译驱动、改控制面/策略                                                             | 极高                 | GPLv3 传染；Plus 组件不能改名/去署名/随意分发；商用要授权 | 自己跟 Windows 更新、CVE、驱动签名 |
| C. 只借架构/思路重写        | 照设计自己写（C/C++/ASM）                                                                                    | 很高（但可控）       | 无许可问题                                                | 自己养兼容性团队                   |

#### 技术层面

**能用的**：

- `Start.exe` CLI 控制面：`/box:`、`/wait`、`/terminate`、`/listpids`、`delete_sandbox`、`/reload` 等；但官方文档列了坑——Start.exe 是 Win32 程序不是控制台程序，stdio 管道继承、`/wait` 只等直接子进程（不等整个进程树）、退出码在部分路径不传递；`delete_sandbox` 是异步两阶段删除，返回 0 不代表删干净；`/terminate` 不保证立即终止；`/reload` 返回 0 不代表重载成功。
- QSbieAPI（LGPL）：官方把 Sandboxie API 用 IPC 重新实现成独立库，可以程序化建箱/控箱/查询；LGPL 对专有宿主相对友好，但仍要走法务。
- 架构与配置模型：文件/注册表/IPC 布局、Open/Closed/Read 规则、box 概念、sandboxie.ini 格式——可免费借鉴，重写时不碰代码没有 GPL 传染。

**不能直接用的**：

- SbieDrv / SbieDll / SbieSvc 不是库：通过驱动设备 IOCTL、服务协议、注入协议紧耦合，没有“drop-in 嵌入”接口；复用就得整套接手。
- 驱动签名：官方二进制是项目方签的；自己编译/修改的驱动必须自己签（EV + 微软 attestation）；开发可用 test signing，但不能给用户装。
- 兼容性矩阵：Known Conflicts 里那些 shim 是二十多年攒的，fork 后变成你的债。

**本轮结论**：Sandboxie 的代码能读、能学、能在 GPLv3 内改；但“Plus 发行形态”不能贴牌做商业专用版。真正能复用的是架构和设计，不是二进制。

---

### 2.9 第 9 轮：QEMU + Windows VM + 内层账户/WFP 的初始评估

**用户原文**：

> 那我这样做：wellspring启动的时候用QEMU启动一个WindowsVM，然后再在VM里用“专用本地账户 + WFP”，你觉得如何

**助手回复（整理，注意：本轮基于“每次调用起 VM”的错误假设，下一轮已修正）**：

**结论**：方向是对的，但组合不是最优；VM 内再套账户 + WFP 在安全分层上成立（VM 提供内核级边界，内层负责命令级文件/网络策略），但 **QEMU 不是 Windows 上的好底座**，**WFP 不该当主强制点**（guest 管理员可绕过），**Windows 客户机授权/镜像分发是第一道闸**。

**当时列出的四个硬问题**：

1. **Windows 客户机授权与镜像分发（最大，非技术）**：分发的是一份 Windows 镜像；客户机虚拟化/多实例权利、VDA/订阅、镜像再分发有专门条款；自己打包分发通常需要额外授权，不能推定“用户在 Pro 上就能免费跑”；让用户自备 ISO/license 做 sysprep 有 UX/激活/合规问题；用 Windows Sandbox 可蹭宿主镜像但 Pro+、单实例、GUI、10–20 秒。
2. **QEMU 在 Windows 上的底座不理想**：硬件加速必须走 WHPX（启用 Windows Hypervisor Platform，管理员，Win10 2004+/Win11；否则 TCG 慢到不可用）；QEMU Windows 宿主支持是社区级（virtiofs/vsock 支持有限，常用 9p/端口转发；9p 直接挂宿主目录是新的攻击面/性能坑）；QEMU 设备模型（USB/网络/9p/音频）攻击面大，guest→host 逃逸主要从这里来；QEMU 是 GPLv2，随产品分发要履行源码义务。更合适的底座：HCS/Hyper-V（微软维护 hypervisor/设备模型）、WSL2（Linux guest，省授权但无 Windows 命令）。
3. **启动与生命周期成本（当时按每次启动估算）**：Windows guest 冷启动 20–60 秒、内存 4–8 GB、镜像 15–30 GB；加 virtio 驱动、激活、sysprep，Win11 guest 还要 vTPM + Secure Boot；“wellspring 启动时拉一个 VM”对常驻服务可接受，对一次性 CLI 不可接受（当时假设）；需要懒启动、常驻 daemon、空闲回收、多实例协调、热池/快照。
4. **内层“账户 + WFP”与 VM 边界的职责问题**：guest 管理员可绕过内层（禁用 WFP、改 ACL）；真正的强制点应放宿主侧（VM 不直连网络、共享目录只读/不共享、宿主代理/防火墙）；共享一个 VM 不等于隔离租户/命令；更干净的是每会话一个 VM/克隆，或长期复用 + 每任务快照回滚。

**当时给出的建议架构**（部分被后续修正）：

- 底座优先 HCS（备选 WHPX+QEMU 最小设备集）；
- 网络：VM 无直连出口 → 宿主代理/防火墙；guest WFP 当纵深；
- 文件：不挂 9p/SMB 可写目录 → guest agent 做 push/pull；
- 生命周期：每会话一个 VM 克隆 / 每任务快照回滚；
- guest 内预建低权账户 + workspace ACL 模板 + 预装 WFP（纵深）。

**当时对比表**：

| 方案                            | 内核隔离    | Windows 命令     | 启动           | 授权/分发        | 复杂度             |
| ------------------------------- | ----------- | ---------------- | -------------- | ---------------- | ------------------ |
| 用户态 Tier 1                   | ❌          | ✅               | ms             | 无               | 低                 |
| QEMU + Win guest + 内层账户/WFP | ✅          | ✅               | 20–60s         | Windows 镜像授权 | 极高               |
| HCS/Hyper-V + Win guest         | ✅          | ✅               | 秒级（热池）   | Windows 镜像授权 | 高，但底座微软维护 |
| WSL2 + bwrap                    | ✅（Linux） | ❌（关 interop） | 秒级           | 无 Windows 授权  | 中                 |
| Windows Sandbox                 | ✅          | ✅               | 10–20s，单实例 | 宿主镜像，Pro+   | 中，但不可脚本化   |

**本轮结论（当时）**：默认用户态 Tier 1；VM 作为可选高安全档，但底座选 HCS 或 WSL2，不默认 QEMU；网络/文件通道放宿主侧；先解决授权/镜像问题。

**事后修正**：本轮按“每次调用起 VM”估算，用户下一轮纠正为 `wellspring start` 长驻、VM 长生命周期，冷启动摊薄后结论改为“可行且合理”（见第 10 轮）。

---

### 2.10 第 10 轮：用户纠正——wellspring start 长驻、VM 长生命周期

**用户原文**：

> 我觉得你没有了解wellspring的工作机制，wellspring用户绝大多数时间使用wellspring start。vm保持长生命周期，只在wellspring退出后关闭。冷启动几十秒可以接受

**助手回复（整理）**：

**承认修正**：上一轮按“每次命令起一个 VM / 每次 CLI 调一次”算账，那是错的。长驻 VM 后，VM 启动成本只付一次，内层沙箱才是每命令的路径——**这个方案可行性明显上升，结论改判：可行，而且合理**。

**修订后的判断**：`wellspring start` 起一个常驻 Windows VM，VM 就是“一台专用 Windows 执行机”：

- 冷启动 20–60 秒只在 start 时付一次，可接受（甚至可后台预热，命令排队等 ready）；
- 之后每条命令成本 = 进程创建 + 内层账户/ACL/WFP 判定，毫秒到百毫秒级；
- guest 是受控镜像：账户、ACL 模板、WFP 过滤器、代理 env 可在打镜像时预配置；
- 内核级隔离由 VM 提供，命令级策略由内层提供，分层清晰。

**但还有 6 个设计点必须先定**：

1. **workspace 放哪（最重要）**：内层“专用账户 + NTFS ACL”只在 guest 本地盘有效。一旦 workspace 通过宿主共享（9p/SMB/virtiofs）挂进来：
    - 9p：没有 Windows ACL 语义，访问控制由 QEMU 9p server 按宿主进程权限做；guest 沙箱账户 ACL 管不到；
    - SMB：权限由宿主共享凭据决定，同一 guest 所有命令共用同一凭据，内层账户 ACL 同样管不到；
    - 结论：共享挂载时内层 ACL 是摆设，边界变成“VM + 宿主共享 ACL/凭据”；read-only/workspace-write 也做不干净。
    - 三种可选模型：A. guest 本地副本 + 同步（内层 ACL 有效，宿主不直接碰 FS，同步延迟/一致性）；B. 宿主共享可写（实时一致，内层 ACL 失效）；C. 只读输入 + 产出回收。
    - 关键约束：agent 文件工具在宿主跑、`execute_code` 在 VM 跑时，两边会看到不同内容——必须统一工作区语义（文件工具也走 guest agent / 每命令后同步 / 接受 B 的弱内层边界）。

2. **控制通道不能暴露给沙箱命令**：guest agent 大概率以 SYSTEM 服务运行（qemu-ga 默认 SYSTEM，`guest-exec` 也以 SYSTEM 执行）；如果沙箱命令能打开 agent 的 virtio-serial 设备或命名管道，它就能让 agent 以 SYSTEM 执行任意命令——内层沙箱报废。设备/管道 ACL 必须只允许 SYSTEM/Administrators；最好自建 agent，不用 qemu-ga 的 `guest-exec`。

3. **网络：guest WFP 只能当纵深，硬边界在宿主侧**：guest 命令一旦本地提权成功，可以禁用 guest WFP；真正可信的是宿主侧：VM 不给 NIC，或只给 host-only 网络 + 宿主代理；宿主防火墙阻断该虚拟网络的外部转发；guest WFP 做“除了代理端口一律拒绝”的纵深。

4. **多会话/多命令共享同一个 guest 的隔离**：VM 边界保护宿主，不保护 guest 内的会话 A/B；同一 guest、同一沙箱账户，A 的 workspace 只要 ACL 授给了这个账户，B 就能读。选项：每会话一个账户、每会话一个 VM 克隆/快照、或只允许单会话。

5. **生命周期、崩溃与镜像维护**：start 懒启动或后台预热；stop/Ctrl+C 走 ACPI 优雅关机 → 等同步完成 → 超时强杀；崩溃后孤儿 QEMU、磁盘锁、下次启动检测清理；常驻内存 4–8 GB、磁盘 GB 级；多实例翻倍；guest 镜像补丁/驱动/激活/sysprep。

6. **授权与镜像分发（如果对外）**：自己打包/分发 Windows 镜像和“用户在 Pro 上本地跑 VM”是两回事；VDA/订阅/再分发条款要先过法务；内部/自用先用自己镜像跑原型。

**QEMU 还是 HCS（长驻形态下）**：

- Windows-only：HCS/Hyper-V 更顺（微软维护 hypervisor/设备模型，不背 QEMU 设备 CVE；hvsocket 做 agent 通道；没有 WHPX 特性依赖的额外坑）；
- 跨平台统一（Win/macOS/Linux 宿主都用同一个 Windows VM 后端）：QEMU 合理（HVF/KVM/WHPX 都能加速，一套镜像/agent/协议复用），代价是 Windows 上必须启用 Windows Hypervisor Platform，否则 TCG 慢到不可用；设备模型最小化；QEMU GPLv2 分发义务。

**一次命令的延迟预算（长驻 VM 下）**：

| 环节                             | 量级                                        |
| -------------------------------- | ------------------------------------------- |
| VM 冷启动（仅 start 一次）       | 20–60s                                      |
| guest agent 连接/健康检查        | 已连接则 <10ms                              |
| 内层身份/ACL 准备（每命令）      | 10–100ms（预建账户 + per-command ACL 更快） |
| 进程创建 + stdio 流式            | 10–50ms                                     |
| workspace 同步（模型 A，每任务） | 秒级（大仓库十秒级，建议增量）              |
| 命令本身                         | VM 磁盘 I/O 比原生慢 1.5–3×（构建类明显）   |

**建议的 1–2 周 spike**：

1. QEMU + WHPX 起 Windows guest，装 virtio 驱动、自建 agent（SYSTEM 服务，设备 ACL 只给 SYSTEM）；
2. guest 里预建沙箱账户 + WFP 过滤器；agent 以沙箱账户跑命令，验证 stdout/exit/timeout/进程树 kill；
3. 测每命令端到端延迟 p50/p95、workspace 同步耗时、stop/重启/崩溃恢复；
4. 同时定“workspace 模型 A/B/C”和“多会话隔离”，再决定 QEMU 还是 HCS。

**本轮结论**：在 `wellspring start` 长驻前提下改判方案可行；难点从“VM 启动太慢”转移到 **workspace 语义、控制通道安全、宿主侧网络边界、多会话隔离** 四件事。

---

### 2.11 第 11 轮：可插拔 VM 底座 + Windows 专用文件逻辑 + 共享文件夹

> 备注：该条用户消息在会话中重复出现三次（可能是客户端重试），此处合并记录一次。

**用户原文**：

> 1：底座不一定用用QEMU，我们可以在setup（专为windows提供的安装程序）时让用户选择一个vm，后续再修改。并且明确声明wellspring只提供下载服务，不随分发
>
> 2：可以为Windows专门写一个file操作逻辑，agent在VM内修改（VM内通过“专用本地账户 + WFP”决定文件修改的权限），VM与宿主使用共享文件夹（把用户选择的一个workspace按照绝对路径挂载到VM中）

**助手回复（整理）**：

**结论**：两点方向都对（第 1 点解决“被单一 VMM/许可绑死”，第 2 点解决“文件到底在哪、谁在改”的一致性问题），但第 2 点有一个必须先纠正的技术矛盾：**“共享文件夹挂载 workspace” + “VM 内专用账户 + NTFS ACL 决定文件权限”互斥**——共享文件夹让内层 ACL 失效。

#### 第 1 点：setup 让用户选 VM——可行，但要定义支持矩阵和信任链

**好处**：解耦 VMM、避开 GPL/驱动打包问题、用户可复用已装的 Hyper-V/VirtualBox/VMware/WSL；后续可换。

**要补四件事**：

1. **明确“支持”和“不支持”的边界**：不同 VMM 的共享文件夹实现、快照、网络、agent 通道、CVE 历史完全不同；“用户选任意 VM”不能变成“任意 VM 都保证同等安全”。setup 只列 2–3 个官方支持后端（如 Hyper-V + QEMU/WHPX，或 Hyper-V + VirtualBox），其余标记“实验/不保证”，做 capability probe（版本、WHPX/Hyper-V 可用性、共享通道、快照能力）。
2. **定义 VM Adapter 接口**：`provision()` / `start()` / `stop()` / `health()` / `exec(argv, stdio, timeout, killTree)` / `file sync` / `snapshot/reset` / `network mode` / `capabilities()`；安全语义（`enforcement` + `notes`）按后端如实上报。
3. **信任链要写清楚**：VMM 是用户安装的，Wellspring 不为它的漏洞负责；宿主侧网络/同步控制才是兜底边界；setup 提示版本过低/共享文件夹不安全等风险，明显不满足时 fail-closed。
4. **“只提供下载服务，不随分发”** 是好方向，但法律上要看形态：
    - 只链接官方下载页、用户自行安装 → 最干净；
    - 托管/镜像二进制或安装器 → 很多许可证下仍算分发（QEMU GPLv2、VirtualBox GPLv3 + Extension Pack 限制），要履行源码/通知义务；
    - Windows 镜像：别分发；用户自备 Windows license/ISO，或走“用户已有 VM”，只分发 provisioning 脚本和 agent；
    - “不随分发”不等于免费支持：多 VMM 版本矩阵的支持成本要提前算。

#### 第 2 点：VM 内文件操作——共享文件夹会废掉内层 ACL

**为什么**：内层“专用账户 + NTFS ACL”要生效，前提是文件在 guest 的 NTFS 卷上；常见共享文件夹不携带 NTFS 安全描述符：

| 方式                            | 文件权限由谁决定                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| VirtualBox 共享文件夹（vboxsf） | VBox 共享设置（只读/可写）+ 宿主用户，guest 的 NTFS ACL 不参与                               |
| VMware 共享文件夹（hgfs）       | 同上                                                                                         |
| QEMU 9p                         | QEMU 9p server 按宿主进程权限；无 Windows ACL 语义                                           |
| SMB 映射                        | 宿主共享的 NTFS ACL + 共享凭据；guest 所有命令共用同一凭据，不是内层账户                     |
| Hyper-V                         | 没有共享文件夹功能；Enhanced Session 的驱动器重定向是 RDP 通道，同样不按 guest 账户 ACL 裁决 |

所以“workspace 共享挂进去 + 靠 VM 内账户 ACL 决定谁能改哪些文件”这条链是断的：可写目录里沙箱账户能改整棵挂载树；read-only/workspace-write 也做不出按命令的粒度（共享文件夹只有只读/可写开关）。

**并且要区分**：

- agent 的文件工具逻辑（read/write/edit/glob）只约束 agent 自己；命令里跑个 `python -c "open(...)"` 就绕过了；
- ACL 强制约束的是“以这个账户运行的任何进程”；文件权限必须落在后者，才能叫沙箱。

**两种自洽的模型**：

| 模型                         | 做法                                                                                                                                                                        | 内层 ACL 是否有效  | 代价                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| A. guest 本地工作区 + 同步   | 任务开始把 workspace 推进 guest 本地 NTFS；命令/文件工具都在 guest 跑，内层账户 ACL 生效；结束/增量同步回宿主，宿主同步层是唯一写宿主工作区的人，负责路径/链接/ADS/大小校验 | ✅                 | 同步延迟、大仓库慢、宿主 IDE 与 VM 内容短暂不一致、冲突处理                           |
| B. 宿主共享可写 + 宿主侧强制 | workspace 直接共享；放弃内层 ACL 管 workspace，改由宿主 SMB ACL/每命令凭据或宿主 workspace service 强制；内层账户只管 guest 系统和 WFP                                      | ❌（workspace 侧） | 实时一致、实现简单；边界在宿主侧，共享实现本身是攻击面；每命令权限要宿主侧做凭据/策略 |

**如果坚持共享文件夹 + 内层 ACL**：实际落在 B——能让“VM 内账户”决定权限的只有 guest 本地文件。要么改成 A，要么明确承认 workspace 写权限由宿主侧强制、内层 ACL 只保护 guest 系统。

**折中**：VHDX 工作区卷——guest 内是真 NTFS 卷（ACL 生效），宿主在任务边界挂载/卸载做同步；缺点是并发/锁和 UX 复杂，不如 A 直接。

**如果选 A，架构要跟着改**：

- 文件工具全部进 VM（read/write/edit/glob/grep 走 guest agent），宿主 workspace 只是镜像——否则两边内容分叉，必出“明明改了为什么读不到”的 bug；
- 宿主同步层是安全闸门：guest 说“我要写 `../../..`、写 symlink、写 ADS、写 1TB”时宿主必须拒绝；只允许 workspace 前缀内的普通文件；
- 冲突策略：任务期间用户在宿主改了同一文件怎么办？建议“任务期间宿主工作区加锁/只读提示”，或明确 last-writer-wins；不要默默覆盖；
- 性能：`npm install`/构建在 VM 本地盘跑（不要跑在 9p/SMB 上），同步只搬源码/产物；大仓库用增量同步（rsync/文件监听）。

**本轮结论**：第 1 点让“底座可替换”，第 2 点让“文件一致性”有解；但第 2 点的正确形态是“guest 本地工作区 + 宿主同步闸门”，不是“共享文件夹 + 内层 ACL”。

---

### 2.12 第 12 轮：把宿主 workspace 映射为网络驱动器

**用户原文**：

> 对于第二点，把宿主的workspace映射为vm中的网络驱动器怎样？

**助手回复（整理）**：

**结论**：网络驱动器比 9p/vboxsf 好，但它仍然不是“VM 内账户 ACL 决定 workspace 权限”的模型。

**权限链**：

```
guest 命令 → SMB 客户端（用映射时的凭据）→ 宿主 SMB 服务 → 宿主 NTFS ACL
```

guest 里那个“专用本地账户”的 token/ACL 根本不参与这张网的授权——SMB 授权看的是映射会话用的宿主凭据，不是 guest 账户。

**能得到**：实时一致（同一份文件）、宿主侧 NTFS ACL + SMB 签名/加密/审计、共享范围限定在 workspace、凭据可轮换。
**得不到**：VM 内账户对 workspace 的细粒度读写控制；挂载可写时沙箱账户能写整棵树；read-only/workspace-write 只能靠“挂只读 share 还是可写 share”做粗粒度。

**两条自洽的路**：

|                        | 网络驱动器（SMB）                  | guest 本地 + 同步                    |
| ---------------------- | ---------------------------------- | ------------------------------------ |
| 实时一致               | ✅ 同一份文件                      | ❌ 任务边界同步                      |
| workspace 权限由谁强制 | 宿主 ACL / SMB 凭据（可信）        | guest 内账户 ACL（guest 管理员可绕） |
| 内层账户+WFP 的作用    | 只保护 guest 系统 + 网络（卫生层） | 文件权限也在这里                     |
| 宿主机暴露面           | 宿主 SMB 服务暴露给 guest          | 无宿主持久共享                       |
| 实现复杂度             | 中（SMB 配置/凭据/网络模式）       | 高（同步/冲突/一致性）               |
| 大仓库/构建性能        | 小文件多时慢（npm/build 要注意）   | 本地盘快，同步成本另算               |

**如果走 SMB，必须配套的安全设计**：

1. **网络模式**：guest 只能走 host-only / internal 网络，绝不能 NAT/bridged；VirtualBox host-only、VMware host-only、Hyper-V internal switch；QEMU **别用 slirp**（它会把宿主 loopback 服务通过 10.0.2.2 暴露给 guest，宿主防火墙很难区分），用 tap/内部网络或换 VMM。
2. **宿主侧最小权限**：专用本地共享账户、只授权 workspace 目录 NTFS ACL、拒绝 `.ssh` 等敏感路径、强随机密码、按 VM 轮换；SMB 强制签名，能开加密就开。
3. **防火墙只放行 guest→宿主 445**，阻断 guest→宿主其他端口、阻断 guest→外网（出网走宿主代理）。
4. **凭据风险要认**：映射凭据存在 guest 凭据管理器/内存，guest 被攻陷会泄露——只能靠“该账户本来就只有 workspace 权限 + 定期轮换”兜底。
5. **路径映射**：guest 是 `Z:\...`，宿主是 `D:\wellspring\...`；模型/脚本里的绝对路径、cwd、配置文件、构建工具都会不一致；要么 agent 做路径重写（脆弱），要么接受“Windows VM 模式下 workspace 路径与宿主不同”并写进文档。
6. **性能**：代码编辑没问题；`npm install`/`node_modules`/增量构建在小文件风暴下明显变慢，最好把缓存/构建产物放 guest 本地盘，只让源码走共享。
7. **并发**：多会话同时写同一 workspace 会互相踩，需要串行或按会话隔离。

**如果坚持“内层账户说了算”**：回到 guest 本地工作区 + 宿主同步闸门；SMB 只做只读输入或完全不用。

**本轮结论**：如果核心承诺是“宿主 workspace 的写权限必须由可信边界决定”，SMB 反而更对（guest 被攻陷也绕不过宿主 ACL）；但要接受“内层账户不管 workspace”。如果核心承诺是“内层账户决定”，用 guest 本地 + 同步。

---

### 2.13 第 13 轮：为什么专用账户 + WFP 能做到颗粒度控制

**用户原文**：

> 那为什么“专用本地账户 + WFP”就能做到颗粒度控制

**助手回复（整理）**：

**颗粒度不是“账户”给的，也不是“WFP”单独给的**：

```
颗粒度 = 可识别身份（SID） × 内核逐请求判定 × 对象/流级规则
```

- **身份**：专用本地账户提供唯一、稳定的 SID；
- **逐请求判定**：NTFS 在每次 `open` 时做 ACL 检查；WFP 在每条 `connect` 时做过滤判定；
- **对象/流级规则**：ACL 的 ACE 精确到“文件/目录 + 读/写/删”；代理 allowlist 精确到域名。

“账户 + WFP”只是让这三件事连起来的组合。

**文件颗粒度来自 NTFS ACL**：

- NTFS 对每个文件/目录对象都有安全描述符；每次打开拿进程 token 的 SID 比对 ACL；
- 给沙箱账户在 workspace 根写可继承 ALLOW ACE（MODIFY），在 `.ssh` 写 DENY ACE，在 scratch 写写权限——精确到路径、精确到操作，且对以该账户运行的所有进程生效（node、git、python、恶意脚本一视同仁），用户态绕不过去；
- 账户的作用是提供“这个 SID 是谁”，ACL 才是“能对哪个对象做什么”。

**网络颗粒度来自 WFP 逐连接判定 + 代理域名规则**：

- WFP 在 `ALE_AUTH_CONNECT` 层对每条连接做判定，条件可以匹配令牌用户 SID + 目标 IP/端口/协议；
- 可以写：`SID = 沙箱账户` 的连接一律 BLOCK，只 PERMIT 到代理端口——保证“出网只有代理一条路”；
- WFP 本身不做域名级判定——域名 allowlist 是代理做的：连接到代理后，代理按 HTTP/CONNECT 的目标域名决定放不放行；
- 组合起来：WFP 把“绕过代理直连”从物理上堵死，代理再做细粒度域名控制。WFP 的粒度是“每条流”，代理的粒度是“每个域名”。

**为什么必须有独立账户，光靠受限 token 不行**：

- 文件：用受限 token（restricting SID）也能做，因为 NTFS 的两次访问检查会用 restricting SIDs 匹配 ACE——不一定需要账户；
- 网络：WFP 的连接归属匹配的是令牌的用户身份（user SID）。写受限 token 不改变用户 SID（还是调用者的 SID），所以没法“只拦沙箱进程、不拦宿主进程”。要让 WFP 定位到一个独立主体，就必须给沙箱一个独立的账户 SID；
- 而且 NTFS 授权也复用这个 SID，两条链共用同一个身份，策略才一致。

**为什么共享文件夹 / SMB 做不到**：因为强制点和身份错位了：

| 资源            | 强制点                    | 用来授权的身份               | 粒度                                      |
| --------------- | ------------------------- | ---------------------------- | ----------------------------------------- |
| guest 本地 NTFS | guest 的 NTFS 驱动        | token 用户 SID（= 沙箱账户） | 每个文件/操作                             |
| guest 出站网络  | guest 的 WFP              | token 用户 SID（= 沙箱账户） | 每条流（SID/IP/端口/协议）                |
| 宿主共享（SMB） | 宿主 SMB 服务 + 宿主 NTFS | SMB 会话凭据（宿主账户）     | 共享/宿主 ACL，guest 账户不在链上         |
| 9p / vboxsf     | QEMU/VBox 共享服务        | 宿主进程 / 共享设置          | 整树 + 只读开关，没有 per-file 安全描述符 |

SMB 映射：guest 里的“沙箱账户”是 guest 本地 SID，宿主的 ACL 不认识它；宿主只认映射时用的共享凭据。9p/vboxsf：guest 看到的是合成文件系统，没有 NTFS 安全描述符，也就没有 per-file ACL 可判。不是“账户+WFP 更神”，而是**强制点必须认识这个身份，并且按对象/流逐次判定**。

**颗粒度的边界**：

1. guest 管理员能绕过（改 ACL、关 WFP）；所以颗粒度只在“不可信代码拿不到 guest 管理员”的前提下成立，guest 管理员应该是你的控制面（agent 服务），不是被沙箱化的命令。
2. ACL 只管路径和操作，不管内容（不能判断“文件里是不是密钥”）。
3. 并发与生命周期：一个账户 + 每命令 grant/revoke，并发命令会共享授权、可能互相读；要真正 per-command，就 per-command 账户或 per-command 工作区。srt 的“kept grant 可被其他会话读”就是这类残留。
4. WFP 只是围栏，真正的域名策略在代理；代理不在链上，细粒度就没了。
5. 路径/链接仍有 TOCTOU、junction/8.3/ADS 等坑，颗粒度不等于“没有绕过路径”。

**回到 VM 方案**：

- guest 本地 workspace + 命令以 guest 沙箱账户运行 + guest WFP/宿主代理 → 三条链都在 guest 里闭合，颗粒度成立；
- workspace 走宿主 SMB 映射 → 文件强制点变成宿主 SMB，身份是共享凭据，guest 账户不在链上，文件颗粒度退回“共享级”；只剩 guest 内系统文件/网络受账户+WFP 约束。

**本轮结论**：颗粒度不是账户带来的，是“强制点认识这个身份、并按对象/流逐次判定”带来的；账户提供 WFP 可定位的身份，ACL/WFP/代理提供规则。

---

### 2.14 第 14 轮：VM 本地 NTFS 磁盘能否与宿主实时同步

**用户原文**：

> 虚拟机本地的磁盘（非网络）NTFS，能不能宿主更改实时同步

**助手回复（整理）**：

**直接回答：不能靠“共享同一个 VM 本地 NTFS 卷”做到实时。** 三条硬约束：

1. **虚拟磁盘被运行中的 VM 独占**：VHDX/qcow2/VDI 在 VM 运行时，宿主再挂载会被拒绝（Hyper-V 的“共享 VHDX”是给 guest 集群用的特殊模式，不是桌面场景的通用 NTFS 共享）；VM 暂停/关机后宿主才能挂。
2. **NTFS 不是多写者文件系统**：两个 OS 实例同时写同一卷，缓存、日志、元数据会互相破坏；Windows 只有 CSVFS 这类集群文件系统支持多节点同时写，桌面 NTFS 没有这个能力。
3. **“只读挂载”也不安全**：宿主只读挂载正在被 VM 写的卷，仍可能与 VM 的写入/日志回放冲突；能安全只读的是快照，不是活动卷。

**三种可实现的模型**：

| 模型                                     | 实时性                              | 内层账户 ACL 对 workspace     | 宿主工具路径                 | 主要代价                                         |
| ---------------------------------------- | ----------------------------------- | ----------------------------- | ---------------------------- | ------------------------------------------------ |
| A. guest 本地 VHDX + 宿主镜像 + 双向同步 | 亚秒~秒级（watcher + 增量），非严格 | ✅ 生效                       | 宿主看到的是镜像（路径不同） | 冲突/重命名/删除/文件锁；需要 single-writer 协议 |
| B. 宿主共享（SMB/9p/vboxsf）             | ✅ 同一份                           | ❌（宿主 ACL / 无安全描述符） | 直接                         | SMB 暴露、凭据、性能                             |
| C. 任务边界挂载 VHDX                     | ❌ 只在任务边界                     | ✅ 生效                       | 任务后可见                   | 交互式编辑不可行                                 |

**A 怎么落地（最接近“内层 ACL + 宿主可见”）**：

- guest 本地 VHDX 放 workspace，命令以 guest 沙箱账户运行 → NTFS ACL 生效；
- 宿主维护一个 mirror 目录，由同步代理双向搬运：guest 侧 `ReadDirectoryChangesW` + 增量推送，宿主侧改动反向推入 guest；
- 关键设计是 **single-writer**：命令运行期间冻结宿主 mirror（宿主编辑排队或提示“沙箱忙”）；命令结束再双向对齐。否则并发写同一文件必然冲突；
- 宿主文件工具/IDE 看到的是 mirror，路径与 guest 不同，需要路径映射；
- 难点是分布式文件系统老问题：重命名、删除、文件锁、ADS、大小写、大文件、半写状态。不要手写 naive mirror；用成熟同步引擎，或对代码仓库直接用 git 作为同步协议（任务前 pull、任务后 commit/push）。

**C 的定位**：如果工作流是“agent 跑任务、用户看结果”，C 最稳：任务结束 → VM 暂停/卸载 VHDX → 宿主挂载同步 → 交还。内层 ACL 完整、无 SMB 暴露、无实时冲突；代价是任务期间宿主看不到中间状态。

**B 的定位**：如果“宿主实时编辑同一份文件”是硬需求，只能选 B，并接受 workspace 权限由宿主 SMB/NTFS 决定、guest 账户不在链上；内层账户+WFP 降级为 guest 系统/网络卫生层。可以用“只读 share / 可写 share 按命令切换”做粗粒度 read-only vs workspace-write。

**如果既想要实时、又想要内层 ACL**：现实里只能“二选一 + 折中”：

1. 宿主镜像只读展示 + 写操作全部走 guest agent（IDE 体验打折）；
2. 命令运行期间冻结宿主写，空闲时双向同步：接近实时，命令期间宿主只读（A 的实用形态）；
3. 放弃内层 ACL 对 workspace 的承诺，用 B，把细粒度放到宿主 ACL/每命令 SMB 凭据上。

**本轮结论**：“VM 本地 NTFS + 宿主实时读写同一份”没有第三种答案；不是实现不够好，是 NTFS 和虚拟磁盘的模型决定的。

---

### 2.15 第 15 轮：方案 A 详解

**用户原文**：

> 详细讲解方案A

**助手回复（整理）**：

**方案 A = guest 本地 NTFS + 宿主镜像 + 双向同步**：workspace 放在 guest 的本地 NTFS 卷（VHDX）上，让“专用账户 + ACL”真正生效；宿主保留一个普通目录作为镜像，让用户 IDE/文件工具能看见、能编辑；两边靠同步代理保持“近实时”一致。

**核心决策：谁是 source of truth。**

- 命令执行期间：guest VHDX 是唯一事实源，宿主镜像冻结（只读）；
- 空闲期间：宿主镜像可写，改动被推入 guest；
- 两边都维护 **base manifest**（上次达成一致的状态），用来判断谁改了什么、有没有冲突。
- 这条规则决定了：不是“两个盘同时写”，而是“分时单写 + 状态对账”。

#### 组件

```
宿主
├─ Workspace Mirror（普通 NTFS 目录，用户可见的 D:\wellspring）
├─ Sync Controller（Wellspring 内）
│    ├─ 宿主侧 watcher（ReadDirectoryChangesW）
│    ├─ manifest DB（SQLite/JSON：path → type/size/mtime/fileId/hash/epoch）
│    ├─ Lease Manager（IDLE / BUSY 单写者状态机）
│    └─ 传输层（分块、校验、重试）
└─ VM Adapter（起停 VM、挂 VHDX、agent 通道）

Guest
├─ Guest Agent（SYSTEM 服务：exec、fs RPC、watcher、账户/ACL、WFP）
├─ Workspace VHDX → 挂成 W:（NTFS，沙箱账户 ACL 生效）
├─ Scratch（独立卷/目录，不参与同步，放 TEMP/HOME/构建缓存）
└─ 沙箱账户（命令以它运行）
```

#### 同步引擎

**状态模型**：

- manifest 记录每个相对路径的类型、大小、mtime（UTC FILETIME）、**NTFS File ID**（`FILE_ID_INFO`）、内容 hash（BLAKE3/SHA-256）、epoch；
- 两侧各自维护“相对 base 的变更日志”；对账时比 base：只有 host 改 → host→guest；只有 guest 改 → guest→host；两边都改 → 冲突。

**变更检测**：

- guest 侧：NTFS **USN Journal**（agent 是 SYSTEM，权限没问题）——读 USN 记录、按 workspace 前缀过滤、处理 journal wrap；拿不到就回退 watcher + 全扫描；
- 宿主侧：`ReadDirectoryChangesW` 递归监听；缓冲区溢出会丢事件，触发一次全树扫描；宿主卷的 USN 读取通常要管理员权限，默认不用；
- 快速路径：mtime + size 相同跳过；不同再算 hash；时间戳不可信时（host/guest 时钟偏差）以 hash 为准；
- 重命名：用 File ID 匹配，而不是路径，否则一次 rename 会被当成“删一个 + 建一个”；
- 删除：墓碑（tombstone）记录，防止“另一侧用旧数据把文件复活”。

**传输协议**：

```
HELLO/CAP → MANIFEST → {STAT | GET | PUT | MKDIR | RENAME | DELETE | QUIESCE}* → DONE
```

- 每文件：先比 hash，再分块传（64–256 KB），写入临时文件 + 原子 rename，最后设 mtime；
- 顺序：父目录先建、子项先删；rename 用 file ID 做 move；
- 大文件支持断点续传；文本可选 zstd 压缩；
- 背压、单文件/单目录大小上限、超时重试；
- 所有路径以“workspace 相对路径”传输，不接受绝对路径。

**忽略规则（很重要）**：

- `.wellspringignore` + 默认忽略 `node_modules`、`.venv`、`target`、`dist`、构建缓存、`.wellspring/`；
- 这些路径只存在于 guest VHDX，不往宿主镜像传——否则一次 `npm install` 会把同步打爆；
- 代价：宿主镜像里没有 `node_modules`，需要的话加“导出产物”开关；
- `.git` 是决策点：同步它能让宿主 `git status` 正常，但文件多、churn 大；建议 git 操作只在一侧做（全在 guest 或全在 host），避免两边同时改 `.git`。

**文件语义支持矩阵**：

| 项目                         | 处理                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| 普通文件/目录/mtime/只读属性 | ✅ 同步                                                          |
| 大小写                       | 两边都是 NTFS，按不敏感处理；大小写-only 重命名需特殊处理        |
| symlink/junction/reparse     | ❌ 拒绝并跳过（同步层不跟随，用 `FILE_FLAG_OPEN_REPARSE_POINT`） |
| 硬链接                       | ❌ 跨边界复制内容会丢语义，明确不支持                            |
| ADS（`file:stream`）         | ❌ 剥离或拒绝                                                    |
| 文件锁/共享冲突              | 重试 + 超时跳过，下轮再传                                        |
| ACL/security descriptor      | ❌ 不同步（guest ACL 是沙箱策略，host ACL 是用户权限）           |
| 长路径/保留名/尾随点         | `\\?\` + 规范化 + 拒绝非法名                                     |

#### 单写者协议（Lease）与生命周期

```
START
  attach Workspace VHDX → guest agent ready → 初始 seed/对账
IDLE
  host/guest watcher → debounce 300–500ms → 双向同步
  用户 IDE 可写镜像
RUN COMMAND
  QUIESCE：停 host watcher、排空 host→guest 队列、等 guest 文件静止
  取 lease（host 镜像只读）→ exec（沙箱账户）→ 收集 stdout/exit
  DRAIN：guest→host 增量同步
  释放 lease
CRASH/STOP
  最终同步 → detach VHDX → VM 关机
```

- **BUSY 期间用户在宿主 IDE 改了文件**：记录到 host pending，命令结束后按 base 做三方合并；不同文件正常应用；同一文件两边都改 → 冲突：保留双方（`xxx.conflict-<ts>`）或让 UI 让用户选。
- **命令超时/被杀**：guest 侧可能留下半写文件；下次同步按 hash 对账，半写文件标记异常。
- **崩溃恢复**：重启后 attach VHDX，NTFS 日志自恢复；manifest 与两侧状态对账；建议“未完成命令的 guest 变更”和“host pending”都保留，冲突显式暴露，不要静默覆盖。

#### VHDX 与 guest 细节

- 每个 workspace 一个动态 VHDX；Hyper-V 用 VHDX、QEMU 用 qcow2（adapter 负责格式）。挂成 guest 的 `W:` 数据盘，格式化 NTFS。
- **ACL**：沙箱账户在 `W:\` 根授 MODIFY；read-only 模式只授 READ/EXECUTE；`W:\` 下可按策略加 DENY（workspace-write 本来就是整树可写，细粒度 deny 要额外规则）。
- **scratch 独立**：`W:` 只放 workspace；构建缓存/TEMP/HOME 放另一块 guest 本地盘，不参与同步，避免噪声。
- **agent 必须是 SYSTEM 服务**，控制通道设备/命名管道 ACL 只给 SYSTEM/Administrators——沙箱命令不能访问 agent 通道，否则它能让 agent 以 SYSTEM 执行任意操作。
- **同步服务以 SYSTEM 读 VHDX 是允许的**（host 是可信侧）；但 host→guest 的写入仍要经过宿主侧闸门。
- VHDX 动态增长不自动收缩；定期离线 compact。

#### 安全边界

- **guest 不可信**：宿主同步层是闸门——所有入站路径做前缀校验、拒绝 reparse/ADS/设备名、限制大小/数量、句柄式操作防 TOCTOU；
- **沙箱命令**：以专用账户运行，受 guest NTFS ACL 约束；read-only 命令没有写 ACE；scratch 可写；
- **控制通道**：agent 设备/管道 ACL 隔离，WFP 只做纵深（真断网在宿主侧）；
- **host mirror**：保留宿主用户自己的 ACL；同步不写 ACL；
- **产物风险**：guest 命令写进 workspace 的文件会同步到宿主镜像，宿主可能之后执行它们——产品层要提示“沙箱产物不可信，别自动运行”。

#### 性能

| 场景                         | 预期                                                      |
| ---------------------------- | --------------------------------------------------------- |
| 初始 seed（10 万文件/几 GB） | 分钟级（流式/压缩）                                       |
| 空闲小编辑                   | 200–500ms debounce，亚秒级                                |
| 命令后增量                   | 按变更量；`npm install` 靠 ignore 规避                    |
| 大文件                       | 分块 + 限速；避免全量 hash                                |
| 变更检测                     | USN（guest）远快于全树扫描；host watcher 溢出触发一次全扫 |

关键指标：sync lag、队列深度、字节/秒、冲突率、watcher 溢出次数。

#### 失败与并发

- **host 崩溃/退出**：VHDX 留在磁盘；重启 attach、对账；
- **guest 崩溃**：VM 重启、agent 重连、VHDX NTFS 自恢复；
- **磁盘满**：预检，不够就拒绝执行命令；
- **同步中断**：临时文件 + 原子 rename，重传；
- **多实例**：workspace 用锁文件（宿主独占打开）+ VHDX 独占锁，第二个 Wellspring 实例 fail fast，或共享一个 daemon。

#### 方案 A 的边界（不要对外承诺）

- 不是共享文件系统：host/guest 不能同时写同一文件；靠 lease 避免；
- 宿主看到的是镜像，有秒级延迟；IDE 的 watcher 可能重复触发；
- 不同步 ACL/链接/ADS/硬链接；ignore 路径在宿主不可见；
- 命令期间宿主只读；外部 IDE 的写入会进冲突流程；
- 路径映射：guest 里是 `W:\`，宿主是 `D:\wellspring`；模型/UI 用宿主路径，agent 内部做相对路径映射，命令里硬编码的绝对路径要额外处理。

#### 里程碑与工作量

| 阶段         | 内容                                                     |
| ------------ | -------------------------------------------------------- |
| M0（1–2 周） | 单向 seed + 命令后 guest→host 拉回 + lease（无连续同步） |
| M1（3–5 周） | USN 增量 + 双向 idle 同步 + 冲突检测 + ignore + 原子写入 |
| M2（3–4 周） | 崩溃恢复、大文件、多实例锁、性能调优、安全 fuzz          |

合计 **2–4 人月**（不含 guest agent 与 VM 生命周期管理）。可直接复用现成同步引擎的思路（rsync 增量、Syncthing 的 DB 模型），但不要手写 naive mirror：重命名/删除/并发/文件锁是分布式文件系统的经典坑。

#### 什么时候选 A

- 需要“VM 内账户 ACL 真正决定 workspace 写权限”；
- 能接受“命令期间宿主只读、空闲时秒级同步”；
- 不接受 SMB 暴露、也不接受 9p/vboxsf 没有 ACL。

如果“宿主实时编辑 + VM 立即看到同一份文件”是硬需求，A 只能做到秒级，不能做到共享文件系统；那种场景只能选 B（宿主共享 + 宿主 ACL），并放弃内层账户对 workspace 的承诺。

**本轮结论**：方案 A 是自洽的，但本质是一个“分布式文件同步 + 单写者 lease + 安全闸门”项目，不是简单挂载；先做 M0 验证延迟/同步成本/崩溃恢复，再决定是否投入完整同步引擎。

---

## 3. 方案对比总表

> 表中“内层 ACL”指“VM/沙箱内专用账户的 NTFS ACL 是否对 workspace 生效”。

| 方案                                          | 隔离强度           | 单次延迟                  | 版本覆盖                 | 需管理员        | Windows 命令     | workspace 内层 ACL | 主要代价                                    |
| --------------------------------------------- | ------------------ | ------------------------- | ------------------------ | --------------- | ---------------- | ------------------ | ------------------------------------------- |
| Node permission model（现状）                 | 同内核、仅插件进程 | 低                        | 全                       | 否              | 否（插件专用）   | —                  | 网络/进程不隔离；Node 官方称不是安全边界    |
| 用户态 token + 合成 SID + ACL + Job（无提权） | 同内核             | 毫秒                      | 全                       | 否              | ✅               | ✅（本机文件）     | 无网络围栏；读边界弱；路径/ACL 长尾         |
| 专用账户 + WFP（srt/Codex）                   | 同内核             | 毫秒~百毫秒               | Pro+（建账户）           | 一次 UAC        | ✅               | ✅                 | 机器级状态；Schannel 等兼容性；ACL 生命周期 |
| Sandboxie 式（驱动+注入）                     | 同内核（驱动 TCB） | 接近原生                  | 全（要驱动签名）         | 是              | ✅               | ✅                 | 驱动 CVE/签名/Windows 更新兼容；GPL/许可    |
| Windows Sandbox                               | VM 级              | 10–20s 启动，单实例       | Pro/Enterprise/Education | 是（启用功能）  | ✅               | ✅                 | 非 per-command；GUI/单实例；默认网络/剪贴板 |
| WSL2 + bwrap                                  | VM 级（Linux）     | 秒级                      | 需 WSL                   | 一次            | ❌（关 interop） | Linux 侧           | 无 Windows 命令；interop 必须关             |
| HCS/Hyper-V + Windows guest                   | VM 级              | 秒级（热池可 1–2s）       | Pro+                     | 是              | ✅               | ✅（guest 本地盘） | Windows 镜像授权；镜像/agent/生命周期       |
| QEMU + Windows guest                          | VM 级              | 20–60s 冷启；常驻后可接受 | 可跨平台宿主             | 是（WHPX 功能） | ✅               | ✅（guest 本地盘） | WHPX 依赖；QEMU 设备模型/GPL；镜像授权      |
| fork VirtualBox                               | VM 级              | 同 VBox                   | —                        | 是（驱动）      | ✅               | ✅                 | GPLv3/驱动签名/CVE/1–2 人年；不推荐         |
| fork VMware                                   | —                  | —                         | —                        | —               | —                | —                  | 无源码，不可行                              |
| 自研 hypervisor                               | VM 级              | 取决于实现                | —                        | 是              | 取决于 guest     | 取决于 guest       | 2–3 人年起步；不建议                        |

---

## 4. 最终参考架构（截至记录时）

### 4.1 形态

- `wellspring start` 启动常驻 Windows VM（或 attach 到已有的 Wellspring 沙箱 daemon）；
- VM 与 Wellspring 进程同生命周期，退出时优雅关闭；
- workspace 在 guest 本地 NTFS VHDX 上（内层 ACL 生效）；
- 宿主保留 workspace mirror；同步代理双向同步 + 单写者 lease；
- 控制通道（agent）只允许 SYSTEM/Administrators 访问；
- 网络强制点在宿主侧（VM 无直连出口 / 宿主代理），guest WFP 作纵深；
- 底座可插拔（VM Adapter + capability probe），首版只支持 2–3 个 VMM。

### 4.2 信任模型

| 侧                         | 信任级别         | 职责                                                                      |
| -------------------------- | ---------------- | ------------------------------------------------------------------------- |
| 宿主 Wellspring 控制面     | 可信             | 生命周期、lease、同步闸门、网络控制、审计                                 |
| Guest Agent（SYSTEM）      | 可信控制面       | exec、fs RPC、账户/ACL、WFP、watcher                                      |
| 沙箱命令（guest 沙箱账户） | 不可信           | 只能读/写 ACL 允许的 guest 本地路径；网络只走代理                         |
| VMM（用户选择）            | 半可信/外部依赖  | 提供 VM 边界；版本/漏洞由用户与 VMM 负责，Wellspring 做能力探测与风险提示 |
| workspace mirror           | 可信但内容是输出 | 保留宿主 ACL；同步不写 ACL；产物按不可信对待                              |

### 4.3 数据流

```
Agent 文件工具 / execute_code
  → guest agent（SYSTEM）分配沙箱账户执行
  → guest 本地 NTFS（ACL 判定读写）
  → 命令结束
  → 同步代理把变更写入宿主 mirror（宿主闸门校验）
  → 宿主 IDE 看到更新
（空闲时相反方向：宿主编辑 → 同步 → guest VHDX）
```

---

## 5. 待定决策清单

| #   | 决策           | 选项                                                   | 建议                                                           |
| --- | -------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| D1  | 威胁模型       | 防手滑/防模型乱来 vs 防恶意代码/内核级 vs 多租户       | 先明确；决定是否必须 VM                                        |
| D2  | 分发与许可     | 开源 / 商业闭源；是否分发 Windows 镜像                 | 先法务；倾向“只提供下载/脚本，不分发镜像”                      |
| D3  | VMM 支持清单   | Hyper-V / QEMU / VirtualBox / VMware / WSL2 / WSB      | 首版 2–3 个；跨平台统一才选 QEMU                               |
| D4  | workspace 模型 | guest 本地 + 同步（A） / 宿主共享（B） / 任务边界（C） | 要内层 ACL 选 A/C；要实时选 B 并承认宿主侧强制                 |
| D5  | 文件工具归属   | 全部进 VM / 留宿主 / 混合                              | 选 A 则全部进 VM，避免分叉                                     |
| D6  | 多会话/多实例  | 每实例一 VM / 每会话一 VM / 共享 daemon                | 单实例一 VM 最简单；多会话需 per-session 账户或 VM             |
| D7  | 网络强制点     | 宿主侧断开/代理 + guest WFP 纵深                       | 宿主侧为准                                                     |
| D8  | 控制通道安全   | 自建 agent + 设备 ACL / 用 qemu-ga                     | 自建 agent；不用 qemu-ga 的 SYSTEM `guest-exec`                |
| D9  | 同步粒度/忽略  | 每任务边界 / 连续空闲同步 + 忽略规则                   | 先 M0 任务边界，再 M1 连续                                     |
| D10 | 生命周期/崩溃  | 懒启动/后台预热；孤儿 VM/锁/磁盘恢复                   | 必做                                                           |
| D11 | 语言/TCB       | C/C++ 用户态 / Rust / 驱动 / UEFI                      | 用户态 C/C++ 可；安全解析建议 Rust；UEFI 属于 VM/hypervisor 层 |
| D12 | 迁移语义       | 用户换 VMM 时保留什么                                  | workspace/配置可移植；VM 快照/guest 状态不可移植               |

---

## 6. 风险登记

| 风险                                | 影响               | 缓解                                                 |
| ----------------------------------- | ------------------ | ---------------------------------------------------- |
| Windows 镜像授权/再分发不合规       | 产品无法分发       | 法务前置；不分发镜像；用户自备 license               |
| VMM 版本/漏洞/兼容性                | 隔离失效或体验崩塌 | 支持矩阵 + 版本探测 + fail-closed + 安全公告         |
| guest 管理员被拿下                  | 内层 ACL/WFP 失效  | 宿主侧网络/文件闸门；每会话 VM/快照；最小 guest 权限 |
| 共享文件夹/9p/网络驱动器无 ACL      | 权限模型不成立     | 明确模型：guest 本地 + 同步，或宿主侧 ACL            |
| 同 VHDX 双挂载                      | 卷损坏/数据丢失    | 禁止；用文件级同步或任务边界挂载                     |
| 同步冲突/误删                       | 用户数据丢失       | lease + base manifest + 冲突保留 + 备份              |
| ACL 生命周期/残留                   | 越权或清理不净     | 账本 + 幂等 + 崩溃恢复 + 定期校验                    |
| Schannel/TLS 不可用                 | 依赖工具链失效     | 文档 + 代理/OpenSSL 工作区 + 兼容性测试              |
| 路径语义（junction/8.3/ADS/长路径） | 绕过或误判         | 句柄优先 + 拒绝 reparse/ADS + fuzz                   |
| TCB 内存安全（C/C++）               | 沙箱逃逸/提权      | Rust 解析层 + ASan/fuzz/CFG/CET + 代码审查           |
| EDR/AV 冲突                         | 部署失败/误报      | 白名单/兼容性矩阵/用户提示                           |
| 多实例/并发                         | 资源翻倍/互相踩    | 锁文件、共享 daemon、每实例 VM 的配额                |
| 驱动签名（若走 Sandboxie/驱动路线） | 无法安装/更新      | EV + attestation；避免自研驱动优先                   |

---

## 7. 术语表

| 术语                          | 含义                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| per-command / per-session     | 每条命令一个隔离边界 / 每个会话（或 VM）一个边界                                         |
| restricted token              | `CreateRestrictedToken` 生成的受限令牌；访问检查用 token SID + restricting SIDs 两轮判定 |
| write-restricted token        | `WRITE_RESTRICTED`：restricting SIDs 只影响写访问，读不受影响                            |
| DACL / ACE / SID              | 自主访问控制列表 / 访问控制项 / 安全标识符                                               |
| WFP                           | Windows Filtering Platform，内核网络过滤框架；防火墙/杀软都建在它上面                    |
| ALE_AUTH_CONNECT              | WFP 的出站连接授权层；可按用户 SID、地址、端口、协议匹配                                 |
| surrogate spawn               | 子进程通过 Task Scheduler、COM、BITS、WMI 等服务“借壳”派生                               |
| VHDX / qcow2                  | Hyper-V / QEMU 的虚拟磁盘格式；运行时被 VM 独占                                          |
| guest agent                   | VM 内的控制代理（exec、文件传输、账户/ACL、WFP）                                         |
| USN Journal                   | NTFS 变更日志；高效检测文件创建/修改/删除/重命名                                         |
| lease / single-writer         | 单写者租约：某一时刻只有一侧能写，避免双向同步冲突                                       |
| 9p / virtiofs / vboxsf / hgfs | 各类共享文件夹/共享文件系统；多数不携带 Windows NTFS ACL                                 |
| HCS                           | Host Compute System，微软的 VM/容器管理 API                                              |
| WHPX                          | Windows Hypervisor Platform，第三方 VMM 的加速 API                                       |
| SbieDrv / SbieDll / SbieSvc   | Sandboxie 的驱动 / 注入 DLL / 服务                                                       |
| Schannel                      | Windows 的 TLS 实现；在受限 token 下可能拿不到凭据                                       |
| keep grant                    | srt 在会话间保留的写授权（可被其他沙箱会话读）                                           |
| 颗粒度                        | 本记录中指“按身份 + 按对象/流逐次判定的控制精度”                                         |

---

## 8. 参考链接

### 8.1 沙箱方案与同行实现

- Anthropic sandbox-runtime（srt）npm 包与 README：<https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime>（README 原文可通过 unpkg 读取：<https://unpkg.com/@anthropic-ai/sandbox-runtime@latest/README.md>）
- OpenAI Codex Windows sandbox 复盘：<https://openai.com/index/building-codex-windows-sandbox/>
- Talkback 对该复盘的摘要：<https://talkback.sh/resource/fe8a0520-66fd-4245-9326-7ff837052e9f/>
- Codex mxc-sandbox（Windows 沙箱实现目录）：<https://github.com/openai/codex/tree/main/codex-rs/mxc-sandbox>
- 微软 winapp CLI 的 Windows Sandbox 自动化文档：<https://github.com/microsoft/winappCli/blob/main/docs/sandbox-execution.md>

### 8.2 Windows 沙盒/虚拟化原语

- Windows Sandbox 概述：<https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/>
- 安装 Windows Sandbox：<https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install>
- 使用与配置（`.wsb` 默认值）：<https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file>
- HCS（Host Compute System）概述：<https://learn.microsoft.com/en-us/virtualization/api/hcs/overview>
- dotnet-computevirtualization（HCS .NET 封装样例）：<https://github.com/microsoft/dotnet-computevirtualization>
- QEMU WHPX 文档：<https://www.qemu.org/docs/master/system/whpx.html>
- Windows Filtering Platform：<https://learn.microsoft.com/en-us/windows/win32/fwp/windows-filtering-platform-start-page>
- CreateRestrictedToken：<https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken>
- Job Objects：<https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>
- Windows 11 Licensing for Virtual Desktops：<https://www.microsoft.com/licensing/docs/documents/download/Windows%2011%20licensing%20for%20Virtual%20Desktops.pdf>

### 8.3 VirtualBox / Sandboxie

- VirtualBox Licensing FAQ：<https://www.virtualbox.org/wiki/Licensing_FAQ?version=23>
- Sandboxie 仓库（GPLv3 核心 + 自定义 Plus 许可）：<https://github.com/sandboxie-plus/Sandboxie>
- Sandboxie LICENSE.Plus：<https://github.com/sandboxie-plus/Sandboxie/blob/master/LICENSE.Plus>
- Sandboxie LICENSE.Classic：<https://github.com/sandboxie-plus/Sandboxie/blob/master/LICENSE.Classic>
- Sandboxie Isolation Mechanism：<https://sandboxie-plus.com/sandboxie/isolationmechanism/>
- Sandboxie Access Token Isolation：<https://sandboxie-plus.com/sandboxie/accesstokenisolation/>
- Sandboxie Sandbox Hierarchy：<https://sandboxie-plus.com/sandboxie/sandboxhierarchy/>
- Sandboxie Code Injection：<https://sandboxie-plus.github.io/sandboxie-docs/Content/CodeInjection/>
- Sandboxie Start Command Line：<https://sandboxie-plus.github.io/sandboxie-docs/Content/StartCommandLine/>
- Sandboxie Network Access：<https://sandboxie-plus.com/sandboxie/networkaccess/>
- Sandboxie Known Conflicts：<https://sandboxie-plus.github.io/sandboxie-docs/Content/KnownConflicts/>

### 8.4 仓库内相关文件

- `src/sandbox/types.ts`：`SandboxBackend` 接口与 `enforcement` 定义
- `src/sandbox/manager.ts`：后端选择、环境、workspace/scratch、artifact 收集
- `src/sandbox/backends/`：`bwrap`、`seatbelt`、`node-permission`、`direct`
- `native/seatbelt-run/src/main.c`：macOS 原生 launcher 的参考实现
- `scripts/verify-sandbox.ts`、`scripts/sandbox-matrix.ts`：探针矩阵
- `.github/workflows/sandbox-macos.yml`：现有沙箱 CI 参考

---

## 9. 时间线

| 时间（Asia/Shanghai） | 事件                                                            |
| --------------------- | --------------------------------------------------------------- |
| 2026-11-02 11:25      | 第 1 轮：提出自研 Windows 沙盒，询问看法                        |
| 11:39                 | 第 2 轮：Windows Sandbox 的版本与性能                           |
| 11:50                 | 第 4 轮：fork VBox/VMware vs 自研                               |
| 12:00                 | 第 6 轮：语言选型（C/C++/ASM/UEFI）与方案 A 缺陷                |
| 13:29                 | 第 9 轮：QEMU + VM + 内层账户/WFP 初始评估                      |
| 13:42 左右            | 第 10 轮：用户纠正长驻模型（`wellspring start`）                |
| 17:20 左右            | 第 11 轮：可插拔 VM 底座 + 共享文件夹（消息重复投递三次后合并） |
| 17:31 前后            | 第 12–15 轮：网络驱动器、颗粒度原理、VHDX 实时同步、方案 A 详解 |
| 2026-11-02 晚         | 本文档生成                                                      |

---

## 10. 下一步建议（记录时未决）

1. **先定 D1/D2/D4/D5**（威胁模型、分发/许可、workspace 模型、文件工具归属），再选 VMM 和动手。
2. **1–2 周 spike**：QEMU + WHPX 或 HCS 起 Windows guest，自建 agent，验证：
    - 每命令端到端延迟（p50/p95）；
    - guest 本地 NTFS + 沙箱账户 ACL 的实际拦截效果；
    - workspace 同步（M0：单向 seed + 命令后拉回）的耗时与冲突；
    - stop/重启/崩溃恢复。
3. **探针矩阵先于实现**：把“写 workspace、写外部、读密钥、出网、junction/ADS/8.3/长路径、子进程、超时、内存”做成 Windows 版 `verify-sandbox`，自报必须被实测支撑。
4. **安全评审**：控制通道 ACL、同步闸门、路径规范化、lease 并发、崩溃恢复。
5. **法务评审**：Windows 镜像授权、VMM 下载/分发形态、Sandboxie/GPL 相关（若考虑复用）。

---

> 本文档由对话整理生成，用于内部方案讨论与后续设计输入；文中引用的第三方资料与许可条款以官方原文为准，具体实施前需法务与安全评审。
