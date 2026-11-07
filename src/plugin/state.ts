// 插件启用状态：<dataDir>/plugins-state.json
// key 为插件目录名；禁用的插件在加载时跳过

import { join } from "node:path"

import { readJsonIfExists, writeJsonAtomic } from "../platform/file.ts"
import { getPaths, type ResolvedPaths } from "../platform/path.ts"

interface PluginStateFile {
    readonly version?: number
    readonly disabled?: readonly string[]
}

export function pluginStateFile(paths: ResolvedPaths = getPaths()): string {
    return join(paths.dataDir, "plugins-state.json")
}

/** 读取被禁用的插件目录名集合 */
export async function readPluginState(
    paths: ResolvedPaths = getPaths(),
): Promise<ReadonlySet<string>> {
    const value = await readJsonIfExists<PluginStateFile>(pluginStateFile(paths))
    if (value === null || !Array.isArray(value.disabled)) {
        return new Set()
    }
    return new Set(value.disabled.filter((item): item is string => typeof item === "string"))
}

/** 设置插件启用/禁用，返回是否发生变化 */
export async function setPluginEnabled(
    name: string,
    enabled: boolean,
    paths: ResolvedPaths = getPaths(),
): Promise<boolean> {
    const disabled = new Set(await readPluginState(paths))
    const had = disabled.has(name)
    if (enabled) {
        disabled.delete(name)
    } else {
        disabled.add(name)
    }
    if (had === !enabled) {
        return false
    }
    await writeJsonAtomic(pluginStateFile(paths), {
        version: 1,
        disabled: [...disabled].sort(),
    })
    return true
}
