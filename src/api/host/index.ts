/*
 * 宿主 API 入口。
 * 插件可以 import { beforeMessage } from "wellspring/api/host/index.ts"。
 */

export * from "./hooks.ts"
export * from "./plugin.ts"
export * from "./version.ts"

export type { Logger } from "pino"
