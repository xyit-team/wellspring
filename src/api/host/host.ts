/*
 * 宿主信息 API：插件通过 getHost() 读取宿主状态、插件列表、OS 与路径
 */

import { release as osRelease } from "node:os"

import type { PlatformName } from "../../platform/os.ts"
import { getHostBridge } from "../../sandbox/bridge-state.ts"
import type { ResolvedPaths } from "../../platform/path.ts"
import type { PluginStatus } from "./plugin.ts"

export type HostStatus = "starting" | "running" | "stopping" | "stopped"
export type HostPluginStatus = PluginStatus | "disabled"

export interface HostOSInfo {
    readonly platform: PlatformName
    readonly arch: string
    readonly release: string
    readonly node: string
    readonly cwd: string
}

export interface HostPlugin {
    readonly id: string
    readonly name: string
    readonly version: string
    readonly deps: readonly string[]
    readonly commands: readonly string[]
    getStatus(): HostPluginStatus
}

export interface Host {
    getPlugins(): readonly HostPlugin[]
    getOS(): HostOSInfo
    getPaths(): ResolvedPaths
    getStatus(): HostStatus
}

interface HostState {
    status: HostStatus
    paths: ResolvedPaths | null
    os: HostOSInfo
    plugins: HostPlugin[]
}

const state: HostState = {
    status: "starting",
    paths: null,
    os: {
        platform: "linux",
        arch: process.arch,
        release: osRelease(),
        node: process.version,
        cwd: process.cwd(),
    },
    plugins: [],
}

/** 平台内部：初始化宿主信息 */
export function configureHost(options: {
    readonly paths?: ResolvedPaths
    readonly os?: Partial<HostOSInfo>
}): void {
    if (options.paths !== undefined) {
        state.paths = options.paths
    }
    if (options.os !== undefined) {
        state.os = { ...state.os, ...options.os }
    }
}

/** 平台内部：更新宿主生命周期状态 */
export function setHostStatus(status: HostStatus): void {
    state.status = status
}

/** 平台内部：更新插件列表 */
export function setHostPlugins(plugins: readonly HostPlugin[]): void {
    state.plugins = [...plugins]
}

export function getHost(): Host {
    const bridge = getHostBridge()
    if (bridge !== null) {
        return bridge.getHostSnapshot()
    }
    return {
        getPlugins: () => [...state.plugins],
        getOS: () => ({ ...state.os }),
        getPaths: () => {
            if (state.paths === null) {
                throw new Error("宿主路径尚未初始化")
            }
            return state.paths
        },
        getStatus: () => state.status,
    }
}
