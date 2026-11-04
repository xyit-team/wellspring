/*
 * 插件目录与命名规则。
 */

import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { getPaths, type ResolvedPaths } from "../platform/path.ts"

/** 单段目录名：字母数字开头，允许 . _ -，最长 64 */
export const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

import { PLUGIN_ID } from "../api/host/plugin.ts"

export { PLUGIN_ID }

/** 插件根目录：<dataDir>/plugins */
export function pluginsRoot(paths: ResolvedPaths = getPaths()): string {
    return join(paths.dataDir, "plugins")
}

export function isValidPluginName(name: string): boolean {
    return PLUGIN_NAME.test(name)
}

/**
 * id 的路径段
 *
 * `@scope/name` 拆成两段，无 scope 时为一段；不合法返回 null
 */
export function pluginIdSegments(id: string): readonly string[] | null {
    if (!PLUGIN_ID.test(id)) {
        return null
    }
    return id.split("/")
}

/** 插件目录的绝对路径；id 不合法返回 null */
export function pluginDirOf(root: string, id: string): string | null {
    const segments = pluginIdSegments(id)
    return segments === null ? null : join(root, ...segments)
}

export interface PluginDirEntry {
    /** 完整 id（含 scope） */
    readonly id: string
    /** 目录名，即 id 的最后一段 */
    readonly dirName: string
    /** 绝对路径 */
    readonly dir: string
}

/**
 * 列出插件根目录下的插件目录
 *
 * 支持 @scope 嵌套：`plugins/@xyit/x` 记为 id `@xyit/x`
 * 顶层与 scope 内的点开头目录、非目录条目都跳过
 */
export async function listPluginDirs(root: string): Promise<readonly PluginDirEntry[]> {
    let names: string[]
    try {
        names = (await readdir(root)).sort()
    } catch {
        return []
    }
    const found: PluginDirEntry[] = []
    for (const name of names) {
        if (name.startsWith(".")) {
            continue
        }
        if (name.startsWith("@")) {
            const scope = name.slice(1)
            if (!PLUGIN_NAME.test(scope)) {
                continue
            }
            const scopeDir = join(root, name)
            let children: string[]
            try {
                children = (await readdir(scopeDir)).sort()
            } catch {
                continue
            }
            for (const child of children) {
                if (child.startsWith(".") || !PLUGIN_NAME.test(child)) {
                    continue
                }
                const dir = join(scopeDir, child)
                if (await isDirectory(dir)) {
                    found.push({ id: `${name}/${child}`, dirName: child, dir })
                }
            }
            continue
        }
        if (!PLUGIN_NAME.test(name)) {
            continue
        }
        const dir = join(root, name)
        if (await isDirectory(dir)) {
            found.push({ id: name, dirName: name, dir })
        }
    }
    return found
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory()
    } catch {
        return false
    }
}
