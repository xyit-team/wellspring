# Windows 沙盒方案决策摘要

> **日期**：2026-11-03
> **状态**：方向已定；3 项前置决策待确认（见第 8 节）
> **2026-11-04 更新**：主路径已改为“受限 token 用户态沙盒 + 异步准备工作区”，见 [2026-11-04-restricted-token-plan.md](./2026-11-04-restricted-token-plan.md)；本文件的 VM 主路径降级为远期可选强化档。
> **关联文档**：[2026-11-02 讨论全记录](./2026-11-02-discussion-record.md)

---

## 1. 背景（一句话）

Wellspring 在 Windows 上没有 per-command 的 OS 级沙盒后端（插件用 Node permission model，Agent `execute_code` 无隔离），需要一个可维护、可验证、能长期演进的 Windows 隔离方案。

已确认的约束：

- 用户绝大多数时间通过 **`wellspring start`** 使用（长驻服务），不是每次命令起进程；
- VM 与 Wellspring 进程同生命周期，`wellspring` 退出时才关闭；冷启动几十秒可接受；
- 底座在 setup 时可选、后续可改；Wellspring 只提供下载服务，不随包分发 VM / Windows 镜像；
- 沙盒相关代码用 C/C++（ASM/UEFI 视为远期选项）。

---

## 2. 结论：选定的主路径

> **长驻 Windows VM 当专用执行机；workspace 放在 guest 本地 NTFS；宿主持有镜像并在命令边界同步；网络强制在宿主侧；guest 内用专用本地账户 + ACL + WFP 做命令级权限；v1 只支持一个 VMM；C/C++ 只写用户态和 guest agent，不碰 UEFI/ASM/自研驱动；不先做连续双向同步。**

配套：

- 保留现有 **用户态 backend**（restricted token + ACL + Job Object）作为默认/降级路径，`enforcement` 如实标 `partial`；
- VM 路径作为 **Windows 强化档**（v1 标 experimental）；
- 两条路径共用同一套 `SandboxBackend` 接口、策略语言和探针矩阵。

---

## 3. 架构

```
宿主
├─ Wellspring 控制面（start/stop、lease、同步闸门、审计）
├─ VM Adapter（v1 只实现一个后端；capability probe + 如实上报）
├─ 宿主侧网络控制（VM 无直连出口 / 宿主代理 / 防火墙）
├─ 宿主 workspace 镜像（用户 IDE 可见，普通 NTFS 目录）
└─ 同步服务（命令边界同步为主，空闲同步后置）
Guest
├─ Guest Agent（SYSTEM 服务；控制通道设备/管道 ACL 只给 SYSTEM/Administrators）
├─ 沙箱账户（命令以它运行）
├─ Workspace VHDX（guest 本地 NTFS，ACL + WFP 生效）
└─ Scratch（独立卷/目录，不参与同步，放 TEMP/HOME/构建缓存）
```

**信任模型**

| 侧 | 信任级别 | 职责 |
|---|---|---|
| 宿主 Wellspring 控制面 | 可信 | 生命周期、lease、同步闸门、网络控制、审计 |
| Guest Agent（SYSTEM） | 可信控制面 | exec、fs RPC、账户/ACL、WFP、watcher |
| 沙箱命令（guest 沙箱账户） | 不可信 | 只能读写 ACL 允许的 guest 本地路径；网络只走宿主代理 |
| VMM（用户选择/安装） | 半可信/外部依赖 | 提供 VM 边界；版本与漏洞由用户与 VMM 负责，Wellspring 做探测与风险提示 |
| 宿主 workspace 镜像 | 可信但内容是输出 | 保留宿主 ACL；同步不写 ACL；产物按不可信对待 |

**数据流**

```
文件工具 / execute_code
  → Guest Agent 以沙箱账户执行
  → guest 本地 NTFS（ACL 判定）
  → 命令结束
  → 同步服务把变更写入宿主镜像（宿主闸门校验路径/链接/ADS/大小）
  → 宿主 IDE 看到更新
（空闲时反向：宿主编辑 → 同步 → guest VHDX；连续同步后置）
```

---

## 4. 三个关键取舍（为什么不是“全都要”）

| 想同时要 | 现实 |
|---|---|
| VM 内账户 ACL 管 workspace | 要求 workspace 在 guest 本地 NTFS |
| 宿主实时读写同一份文件 | 只能靠共享文件系统/SMB，此时权限由宿主/共享凭据决定，内层 ACL 失效；VHDX 双挂载会坏卷 |
| 零安装、全 Windows 版本、无管理员 | 与 VM/驱动/功能启用互斥 |

**选择**：要“内层 ACL + 可接受的安装成本”，放弃“宿主实时共享同一份文件”（用命令边界同步替代）；保留用户态 backend 覆盖“零安装/快路径”场景。

---

## 5. 三个不做（v1 明确砍掉）

1. **不做“宿主实时编辑同一份文件”**：用命令边界同步/空闲同步代替；要严格实时只能选宿主共享（SMB），并接受权限在宿主侧。
2. **不做“多 VMM 全家桶”**：v1 只支持一个官方后端 + Adapter 接口；其余标记实验/不保证，不做同等安全承诺。
3. **不做“从零 hypervisor / UEFI / 自研驱动”**：hypervisor 用 HCS（Windows-only）或 QEMU+WHPX（跨平台）；UEFI/ASM 不在本期范围。

---

## 6. v1 范围

**In scope**

- 长驻 Windows VM，随 `wellspring start/stop` 启停；
- 单 workspace、guest 本地 VHDX（NTFS）+ 沙箱账户 ACL；
- 命令边界同步（host↔guest 镜像）+ 单写者 lease；
- guest WFP（纵深）+ 宿主侧网络强制（硬边界）；
- 自建 guest agent（控制通道 ACL 隔离）；
- Windows 版探针矩阵 + Windows CI；
- 基础崩溃恢复（孤儿 VM/锁/磁盘检查）。

**Out of scope（本期不做）**

- 连续双向同步与实时冲突合并；
- 多 VMM、多会话共享同一个 VM、多租户；
- Windows 镜像分发/激活/授权方案；
- 内核驱动、UEFI、hypervisor、GPU、GUI 应用兼容性承诺。

---

## 7. 里程碑（12 周）

| 阶段 | 内容 | 交付/验收 |
|---|---|---|
| W0–1 | 写 ADR：威胁模型、产品承诺、非目标、验收指标 | 一页 ADR，三项决策落定 |
| W1–3 | Spike：一个 VMM + guest provisioning + agent + exec + 沙箱账户 ACL + WFP + 宿主侧断网 + 命令边界同步 | 测 3 个数：每命令延迟 p50/p95、同步耗时、崩溃/重启恢复 |
| W4–8 | v1：lease、宿主镜像、同步闸门、探针矩阵、Windows CI | experimental 发布；`enforcement` 与实测一致 |
| W9–12 | 安全评审：控制通道、路径语义、并发、崩溃恢复；评估连续同步 | 评审报告 + 是否投入连续同步的决策 |

**验收指标（建议）**

- 每命令端到端延迟 p50 / p95（不含命令自身执行时间）；
- 命令后同步耗时（典型代码仓库 / 1 万文件）；
- `wellspring stop` 到 VM 关闭的清理时间；崩溃后重启恢复成功率；
- 探针矩阵通过率（写边界、读密钥、出网、junction/ADS/8.3/长路径、子进程、超时、内存）；
- 自报 `enforcement` 与实测不符的次数 = 0。

---

## 8. 待确认的 3 项前置决策

| # | 决策 | 选项 | 影响 |
|---|---|---|---|
| D1 | **威胁模型** | A. 防手滑/防模型乱来；B. 防恶意代码/内核级；C. 多租户 | 决定是否必须 VM；A 可用用户态，B/C 必须 VM |
| D2 | **首发 VMM** | A. HCS/Hyper-V（Windows-only，底座顺）；B. QEMU+WHPX（跨平台统一） | 决定开发成本、WHPX 依赖、设备模型/GPL |
| D3 | **分发形态** | A. 内部；B. 开源；C. 商业产品 | 决定 Windows 镜像授权、provisioning 形态、支持成本 |

**建议**：D1 若选 B/C → 主路径 VM；D2 Windows-only 选 HCS、要跨平台统一选 QEMU；D3 无论哪种都先按“不分发镜像、只分发 agent/provisioning”设计。

---

## 9. 主要风险与缓解

| 风险 | 缓解 |
|---|---|
| guest 管理员被拿下 → 内层 ACL/WFP 失效 | 宿主侧网络/同步闸门；每会话 VM/快照；guest 最小权限 |
| 同步冲突/误删 | lease + base manifest + 冲突保留 + 备份 |
| Windows 镜像授权/再分发不合规 | 法务前置；不分发镜像；用户自备 license/镜像 |
| VMM 版本/漏洞/兼容性 | 支持矩阵 + 版本探测 + fail-closed + 安全公告 |
| Schannel/TLS 在受限 token 下失效 | 文档 + 代理/OpenSSL 工作区 + 兼容性测试 |
| 路径语义（junction/8.3/ADS/长路径） | 句柄优先 + 拒绝 reparse/ADS + fuzz |
| 多实例/并发资源翻倍 | workspace 锁 + VHDX 独占；后续考虑共享 daemon |
| EDR/AV 冲突 | 白名单/兼容性矩阵/用户提示 |

---

## 10. 本周下一步

1. 拍板 D1/D2/D3（半天）；
2. 写 ADR（一页，含“不保证什么”）；
3. 列出 spike 清单：VMM 选型验证、guest 镜像 provisioning、agent 通道、沙箱账户/ACL、WFP、宿主侧断网、命令边界同步；
4. 把 Windows 版探针矩阵先写出来（先于实现，作为验收标准）。

---

## 附：一句话回顾

不是缺方案，而是缺取舍。选定“长驻 VM + guest 本地 workspace + 同步 + 内层账户/ACL/WFP + 宿主侧网络”这一条，把“实时共享、多 VMM、自研 hypervisor/UEFI、连续双向同步”明确列为以后再说——思路就清楚了。
