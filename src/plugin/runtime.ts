/*
 * 插件运行时目录：
 * - 数据：<dataDir>/plugin-data/<id>/
 * - 配置：<configDir>/plugins/<id>.json（插件自己的 JSON 配置）
 */

import { join } from "node:path"

import type { PluginConfig } from "../api/host/plugin.ts"
import { ensureDir, readJsonIfExists } from "../platform/file.ts"
import { getPaths, type ResolvedPaths } from "../platform/path.ts"
import { PLUGIN_NAME } from "./paths.ts"

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function assertPluginId(id: string): void {
    if (!PLUGIN_NAME.test(id) || CONTROL_CHARS.test(id)) {
        throw new Error(`插件 id 不合法：${id}`)
    }
}

/** 插件专属数据目录，平台会确保存在 */
export function pluginDataDir(id: string, paths: ResolvedPaths = getPaths()): string {
    assertPluginId(id)
    return join(paths.dataDir, "plugin-data", id)
}

/** 插件专属配置文件 */
export function pluginConfigFile(id: string, paths: ResolvedPaths = getPaths()): string {
    assertPluginId(id)
    return join(paths.configDir, "plugins", `${id}.json`)
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
