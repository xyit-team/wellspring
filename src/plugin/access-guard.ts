/*
 * 插件访问守卫：插件加载/执行期间禁止直接 import 文件、进程等模块，
 * 统一走宿主 API（api.fs / ctx.fs、api.logger 等）。
 * 这是软隔离，无法阻止 plugin 通过 process.getBuiltinModule 等宿主逃逸。
 */

import { registerHooks } from "node:module"

import { getHookOwner } from "../api/host/hooks.ts"

const BLOCKED = new Set([
    "fs",
    "node:fs",
    "fs/promises",
    "node:fs/promises",
    "child_process",
    "node:child_process",
    "worker_threads",
    "node:worker_threads",
    "vm",
    "node:vm",
    "module",
    "node:module",
    "inspector",
    "node:inspector",
])

let installed = false

export function ensureAccessGuard(): void {
    if (installed) {
        return
    }
    installed = true
    registerHooks({
        resolve(specifier, context, nextResolve) {
            const owner = getHookOwner()
            if (owner !== null && BLOCKED.has(specifier)) {
                throw new Error(
                    `插件 ${owner} 禁止直接访问 ${specifier}，请使用 api.fs / ctx.fs 等宿主 API`,
                )
            }
            return nextResolve(specifier, context)
        },
    })
}
