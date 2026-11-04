/*
 * 插件运行时目录：
 * - 数据：<dataDir>/plugin-data/<id>/
 * - 配置：<configDir>/plugins/<id>.json（插件自己的 JSON 配置）
 *
 * id 可带 @scope 前缀，此时按字面拆成多级目录，与 npm 的 node_modules 布局一致
 * 无 scope 的 id 路径与旧版完全一致
 */

import { join } from "node:path"

import type { PluginConfig } from "../api/host/plugin.ts"
import { ensureDir, readJsonIfExists } from "../platform/file.ts"
import { getPaths, type ResolvedPaths } from "../platform/path.ts"
import { pluginIdSegments } from "./paths.ts"

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** id 的路径段；不合法时抛错 */
function segmentsOf(id: string): readonly string[] {
    const segments = pluginIdSegments(id)
    if (segments === null || CONTROL_CHARS.test(id)) {
        throw new Error(`插件 id 不合法：${id}`)
    }
    return segments
}

/** 插件专属数据目录，平台会确保存在 */
export function pluginDataDir(id: string, paths: ResolvedPaths = getPaths()): string {
    return join(paths.dataDir, "plugin-data", ...segmentsOf(id))
}

/** 插件专属配置文件 */
export function pluginConfigFile(id: string, paths: ResolvedPaths = getPaths()): string {
    const segments = segmentsOf(id)
    const last = segments[segments.length - 1] ?? ""
    // scope 目录 + <name>.json，与插件目录同级
    return join(paths.configDir, "plugins", ...segments.slice(0, -1), `${last}.json`)
}

export async function ensurePluginDataDir(
    id: string,
    paths: ResolvedPaths = getPaths(),
): Promise<string> {
    const dir = pluginDataDir(id, paths)
    await ensureDir(dir)
    return dir
}

/** 读取插件配置；文件不存在时返回空对象 */
export async function loadPluginConfig(
    id: string,
    paths: ResolvedPaths = getPaths(),
): Promise<PluginConfig> {
    const value = await readJsonIfExists<unknown>(pluginConfigFile(id, paths))
    if (value === null) {
        return {}
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`插件配置必须是 JSON 对象：${pluginConfigFile(id, paths)}`)
    }
    return value as Record<string, unknown>
}
