/*
 * 宿主事件总线。
 * 插件可以通过 `import { event } from "wellspring/api/host/index.ts"` 订阅/发布事件。
 */

export { EventEntity, EventBus, eventBus } from "../../event/event.ts"
export type { EventListener } from "../../event/event.ts"

/** 沙盒工作区准备状态：Web 端用来显示“正在准备工作区” */
export { SANDBOX_PREPARE_EVENT } from "../../sandbox/prepare-event.ts"
export type { SandboxPrepareEvent, SandboxPreparePhase } from "../../sandbox/prepare-event.ts"
