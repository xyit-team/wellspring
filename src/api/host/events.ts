/*
 * 宿主事件总线。
 * 插件可以通过 `import { event } from "wellspring/api/host/index.ts"` 订阅/发布事件。
 */

export { EventEntity, EventBus, eventBus } from "../../event/event.ts"
export type { EventListener } from "../../event/event.ts"
