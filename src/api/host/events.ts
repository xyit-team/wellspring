/*
 * 宿主事件总线
 * 插件从 "wellspring/api/host/index.ts" 导入 event 订阅与发布事件
 */

export { EventEntity, EventBus, eventBus } from "../../event/event.ts"
export type { EventListener } from "../../event/event.ts"

/** 沙盒工作区准备事件：Web 端显示“正在准备工作区” */
export { SANDBOX_PREPARE_EVENT } from "../../sandbox/prepare-event.ts"
export type { SandboxPrepareEvent, SandboxPreparePhase } from "../../sandbox/prepare-event.ts"
