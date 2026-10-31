/*
 * 页面覆盖：插件数据目录下的 page.html 优先于内置模板，改完刷新即生效，不必重启进程。
 * 文件不存在、为空或读取失败时回退到 pages.ts 的内置模板；不做落盘种子，避免插件升级后仍服务旧页面。
 * 文件里的 {{theme}} 替换成 renderHome 写入的 data-theme 属性，缺省则不替换（首屏可能闪一下主题色）。
 */

import type { HostFileApi } from "wellspring/api/host/index.ts"

export const PAGE_OVERRIDE_FILE = "page.html"

const THEME_PLACEHOLDER = /\{\{\s*theme\s*\}\}/g

/** 读取覆盖页；没有可用覆盖时返回 null */
export async function loadPageOverride(
    fs: HostFileApi,
    themeAttribute: string,
    onError: (error: unknown) => void,
): Promise<string | null> {
    let raw: string | null
    try {
        raw = await fs.readText(PAGE_OVERRIDE_FILE)
    } catch (error) {
        onError(error)
        return null
    }
    if (raw === null || raw.trim() === "") {
        return null
    }
    return raw.replace(THEME_PLACEHOLDER, themeAttribute)
}
