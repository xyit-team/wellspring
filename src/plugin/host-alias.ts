/*
 * 插件侧模块别名。
 * 插件不在 wellspring 包的解析路径内，用 Node 的 resolve hook 把
 * "wellspring" / "wellspring/..." 映射到本仓库的 src 目录，
 * 这样插件可以 import { onMessage, getHost } from "wellspring/api/host/index.ts"。
 */

import { statSync } from "node:fs"
import { registerHooks } from "node:module"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const PROJECT_ROOT = resolve(import.meta.dirname, "../..")
const SOURCE_ROOT = join(PROJECT_ROOT, "src")
const PREFIX = "wellspring/"

let installed = false

function existingFile(path: string): string | null {
    try {
        const info = statSync(path)
        return info.isFile() ? path : null
    } catch {
        return null
    }
}

function resolveHostTarget(specifier: string): string | null {
    if (specifier === "wellspring") {
        return existingFile(join(SOURCE_ROOT, "api", "host", "index.ts"))
    }
    if (!specifier.startsWith(PREFIX)) {
        return null
    }
    const rest = specifier.slice(PREFIX.length)
    if (rest === "" || rest.startsWith("..") || rest.startsWith("/") || rest.includes("\\")) {
        return null
    }
    const direct = existingFile(join(SOURCE_ROOT, rest))
    if (direct !== null) {
        return direct
    }
    return existingFile(join(SOURCE_ROOT, rest, "index.ts"))
}

/** 注册一次即可；在加载插件前调用 */
export function ensureHostAlias(): void {
    if (installed) {
        return
    }
    installed = true
    registerHooks({
        resolve(specifier, context, nextResolve) {
            const target = resolveHostTarget(specifier)
            if (target !== null) {
                return { url: pathToFileURL(target).href, shortCircuit: true }
            }
            return nextResolve(specifier, context)
        },
    })
}
