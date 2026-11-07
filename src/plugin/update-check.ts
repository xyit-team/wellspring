// 插件更新检查：宿主按清单里声明的来源（npm / github）查最新版本，与已装版本比较

// 1.7 之前由插件在 init 里注册探针；现在来源写在 package.json 的
// wellspring.npm / wellspring.github 里，宿主自己查
// 插件不需要联网，sandbox 也不必放开 network

// 边界：
// 只在检查更新时查网络，加载插件时不发请求
// 单个插件失败（网络错、没声明来源、超时）只影响这一项
// 没有声明来源的插件 hasSource = false，不发起请求
// 比较是纯函数，不依赖 semver 包，预发布按 semver 规则排序

import type { SourceOptions } from "./sources.ts"
import { resolveGithubRelease, resolveNpmRelease } from "./sources.ts"

/** 已装插件，来自 package.json */
export interface InstalledPlugin {
    /** 本地名（目录名 / 插件 id） */
    readonly id: string
    readonly version: string
    /** 清单声明的 npm 包名 */
    readonly npm?: string | null
    /** 清单声明的 GitHub 仓库 */
    readonly github?: string | null
}

export interface PluginUpdateCheck {
    readonly id: string
    /** 已装版本 */
    readonly installed: string
    /** 查到的最新版本；失败或没有来源时为 null */
    readonly latest: string | null
    readonly updateAvailable: boolean
    /** 失败原因；成功或没有来源时为 null */
    readonly error: string | null
    /** 是否声明了更新来源 */
    readonly hasSource: boolean
    /** 兼容 1.6 及以前的字段名，等同 hasSource */
    readonly hasProbe: boolean
    /** 用到的渠道；没有来源时为 null */
    readonly channel: "npm" | "github" | null
    /** 最新版下载地址；没有来源或失败时为 null */
    readonly downloadUrl: string | null
}

/** 检查超时上限：界面等待不超过此值 */
export const UPDATE_CHECK_TIMEOUT_MS = 20_000

/** `v1.2.3` / `1.2.3` / `1.2.3-rc.1` 拆成可比较的部分 */
function parseVersion(value: string): { core: number[]; pre: string[] } | null {
    const text = value.trim().replace(/^v/i, "")
    if (text === "") return null
    const [coreText = "", preText] = text.split("-", 2) as [string, string | undefined]
    const core: number[] = []
    for (const part of coreText.split(".")) {
        if (/^\d+$/.test(part)) {
            core.push(Number(part))
            continue
        }
        // 首段非数字视为标签（latest / stable / main），按解析失败处理
        if (core.length === 0) return null
        // 后续段允许 x / * 这类占位，按 0 处理（1.2.x 等价于 1.2.0）
        core.push(0)
    }
    if (core.length === 0) return null
    const pre = preText === undefined ? [] : preText.split(".")
    return { core, pre }
}

/**
 * 比较两个版本
 *
 * 返回 -1 / 0 / 1；预发布低于同号正式版（semver 规则）
 * 预发布之间按段比较：数字段按数值，其余按字典序
 * 解析不了的值（空串、latest 这类标签）返回 0
 */
export function compareVersions(left: string, right: string): number {
    const a = parseVersion(left)
    const b = parseVersion(right)
    if (a === null || b === null) {
        return 0
    }
    const length = Math.max(a.core.length, b.core.length)
    for (let index = 0; index < length; index += 1) {
        const diff = (a.core[index] ?? 0) - (b.core[index] ?? 0)
        if (diff !== 0) return diff < 0 ? -1 : 1
    }
    if (a.pre.length === 0 && b.pre.length === 0) return 0
    // 正式版大于预发布
    if (a.pre.length === 0) return 1
    if (b.pre.length === 0) return -1
    const count = Math.max(a.pre.length, b.pre.length)
    for (let index = 0; index < count; index += 1) {
        const leftPart = a.pre[index]
        const rightPart = b.pre[index]
        // 段数少的算小（1.0.0-rc < 1.0.0-rc.1）
        if (leftPart === undefined) return -1
        if (rightPart === undefined) return 1
        const leftNumeric = /^\d+$/.test(leftPart)
        const rightNumeric = /^\d+$/.test(rightPart)
        if (leftNumeric && rightNumeric) {
            const diff = Number(leftPart) - Number(rightPart)
            if (diff !== 0) return diff < 0 ? -1 : 1
            continue
        }
        // 数字段低于字母段
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
        if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
    }
    return 0
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * 检查更新
 *
 * 有 npm 声明就查 npm，npm 未声明时查 github；都没有声明时 hasSource = false，不发请求
 * 结果按入参顺序返回
 */
export async function checkPluginUpdates(
    installed: readonly InstalledPlugin[],
    options: SourceOptions & { readonly timeoutMs?: number } = {},
): Promise<readonly PluginUpdateCheck[]> {
    const timeoutMs = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS
    const sourceOptions: SourceOptions = { ...options, timeoutMs }
    return await Promise.all(
        installed.map(async (plugin): Promise<PluginUpdateCheck> => {
            const npm = typeof plugin.npm === "string" && plugin.npm !== "" ? plugin.npm : null
            const github =
                typeof plugin.github === "string" && plugin.github !== "" ? plugin.github : null
            if (npm === null && github === null) {
                return {
                    id: plugin.id,
                    installed: plugin.version,
                    latest: null,
                    updateAvailable: false,
                    error: null,
                    hasSource: false,
                    hasProbe: false,
                    channel: null,
                    downloadUrl: null,
                }
            }
            const channel: "npm" | "github" = npm === null ? "github" : "npm"
            try {
                const release =
                    npm === null
                        ? await resolveGithubRelease(github ?? "", null, sourceOptions)
                        : await resolveNpmRelease(npm, null, sourceOptions)
                const latest = release.version
                if (latest === null) {
                    return {
                        id: plugin.id,
                        installed: plugin.version,
                        latest: null,
                        updateAvailable: false,
                        error: "无法确认最新版本（下载地址来自源码 tarball）",
                        hasSource: true,
                        hasProbe: true,
                        channel,
                        downloadUrl: release.url,
                    }
                }
                return {
                    id: plugin.id,
                    installed: plugin.version,
                    latest,
                    updateAvailable: compareVersions(latest, plugin.version) > 0,
                    error: null,
                    hasSource: true,
                    hasProbe: true,
                    channel,
                    downloadUrl: release.url,
                }
            } catch (error) {
                return {
                    id: plugin.id,
                    installed: plugin.version,
                    latest: null,
                    updateAvailable: false,
                    error: errorText(error),
                    hasSource: true,
                    hasProbe: true,
                    channel,
                    downloadUrl: null,
                }
            }
        }),
    )
}
