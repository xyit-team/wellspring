/*
 * 插件目录与命名规则。
 */

import { join } from "node:path"

import { getPaths, type ResolvedPaths } from "../platform/path.ts"

/** 插件目录名/包名：字母数字开头，允许 . _ -，最长 64 */
export const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 插件根目录：<dataDir>/plugins */
export function pluginsRoot(paths: ResolvedPaths = getPaths()): string {
    return join(paths.dataDir, "plugins")
}

export function isValidPluginName(name: string): boolean {
    return PLUGIN_NAME.test(name)
}
