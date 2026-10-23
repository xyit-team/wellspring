/*
 * sandbox child 内的宿主 bridge。
 * 由 plugin-host runner 安装；宿主进程里为 null，走本地实现。
 */

import type { Host } from "../api/host/host.ts"

export type BridgeLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export type BridgeOutputKind = "info" | "warn" | "error" | "print"

export interface HostBridge {
    /** 子进程 → 宿主请求（fs、subscribe、getHost snapshot 外的命令等） */
    request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>
    /** 单向事件（log/output/event publish） */
    notify(method: string, params: unknown): void
    getHostSnapshot(): Host
    shutdown(): void
}

let bridge: HostBridge | null = null

export function setHostBridge(value: HostBridge | null): void {
    bridge = value
}

export function getHostBridge(): HostBridge | null {
    return bridge
}
