/*
 * 插件版本探针：收集远端最新版本，与已装版本比较
 *
 * 最新版本的来源归插件：npm registry、GitHub Release、自建更新服务
 * 插件在 init 里交出异步函数，宿主负责收集、并发调用、隔离失败
 *
 * 四条边界：
 * - 探针仅在检查更新时调用，加载插件时不发起网络请求
 * - 单个探针失败（网络错、返回空、超时）只影响这一项
 * - 下载地址可选，给了必须是 .zip（安装入口只接受 zip 包）
 * - 比较是纯函数，不依赖 semver 包，预发布按 semver 规则排序
 */

import type { PluginVersionProbe } from "../api/host/plugin.ts"

/** 已装插件，来自 package.json */
export interface InstalledPlugin {
    /** 对外的插件身份，结果里原样带回 */
    readonly id: string
    readonly version: string
    /**
     * 探针可能的注册名，按顺序尝试
     *
     * 探针以插件归属名注册（package.json 的 name，缺失时用目录名）
     * 对外 id 来自 setup() 返回值，两者通常一致但不保证
     */
    readonly probeIds?: readonly string[]
}

export interface PluginUpdateCheck {
    readonly id: string
    /** 已装版本 */
    readonly installed: string
    /** 探针报的最新版本；没有探针、探针失败或超时为 null */
    readonly latest: string | null
    readonly updateAvailable: boolean
    /** 失败原因；成功或没有探针时为 null */
    readonly error: string | null
    /** 插件没注册探针时为 false */
    readonly hasProbe: boolean
    /** 最新版 zip 包地址；插件没给或没通过校验时为 null */
    readonly downloadUrl: string | null
}

const probes = new Map<string, PluginVersionProbe>()

/** 注册探针；同一插件重复注册报错 */
export function setVersionProbe(pluginId: string, probe: PluginVersionProbe): void {
    if (typeof probe !== "function") {
        throw new TypeError(`版本探针必须是函数：${pluginId}`)
    }
    if (probes.has(pluginId)) {
        throw new Error(`插件 ${pluginId} 已经注册过版本探针`)
    }
    probes.set(pluginId, probe)
}

export function removeVersionProbe(pluginId: string): void {
    probes.delete(pluginId)
}

export function clearVersionProbes(): void {
    probes.clear()
}

export function hasVersionProbe(pluginId: string): boolean {
    return probes.has(pluginId)
}

/** 已注册的插件 id；测试与排查用 */
export function versionProbeIds(): readonly string[] {
    return [...probes.keys()]
}

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
        // 首段非数字视为标签（latest / stable / main），解析失败
        // 按 0.0.0 处理会把它算成有更新

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
        const left_ = a.pre[index]
        const right_ = b.pre[index]
        // 段数少的算小（1.0.0-rc < 1.0.0-rc.1）
        if (left_ === undefined) return -1
        if (right_ === undefined) return 1
        const leftNumeric = /^\d+$/.test(left_)
        const rightNumeric = /^\d+$/.test(right_)
        if (leftNumeric && rightNumeric) {
            const diff = Number(left_) - Number(right_)
            if (diff !== 0) return diff < 0 ? -1 : 1
            continue
        }
        // 数字段低于字母段
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
        if (left_ !== right_) return left_ < right_ ? -1 : 1
    }
    return 0
}

/** 探针超时：查网络给足余量，但不能让一次检查挂住界面 */
export const VERSION_PROBE_TIMEOUT_MS = 10_000

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * 校验下载地址
 *
 * 只接受 http/https 的 .zip
 * 安装入口只接受 zip 包，tarball 与仓库页在安装阶段失败
 */
export function validateDownloadUrl(value: string): { url: string | null; error: string | null } {
    const text = value.trim()
    if (text === "") {
        return { url: null, error: "下载地址为空" }
    }
    let parsed: URL
    try {
        parsed = new URL(text)
    } catch {
        return { url: null, error: `下载地址不是合法 URL：${text}` }
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { url: null, error: `下载地址必须用 http/https：${parsed.protocol}` }
    }
    // 只校验路径部分，查询串带 .zip 不算
    if (!/\.zip$/i.test(parsed.pathname)) {
        return { url: null, error: `下载地址必须是 .zip 文件：${text}` }
    }
    return { url: text, error: null }
}

interface ProbeOutcome {
    readonly version: string | null
    readonly downloadUrl: string | null
    readonly error: string | null
}

/**
 * 规整探针返回值
 *
 * 两种形态都接受：版本号字符串，或 { version, downloadUrl }
 * 版本号缺失、下载地址不合法均记为失败
 */
export function readProbeValue(value: unknown): ProbeOutcome {
    const raw = typeof value === "string" ? { version: value } : value
    if (typeof raw !== "object" || raw === null) {
        return { version: null, downloadUrl: null, error: "版本探针没有返回版本号" }
    }
    const record = raw as { version?: unknown; downloadUrl?: unknown }
    const version = typeof record.version === "string" ? record.version.trim() : ""
    if (version === "") {
        return { version: null, downloadUrl: null, error: "版本探针没有返回版本号" }
    }
    if (record.downloadUrl === undefined || record.downloadUrl === null) {
        return { version, downloadUrl: null, error: null }
    }
    if (typeof record.downloadUrl !== "string") {
        return { version, downloadUrl: null, error: "下载地址必须是字符串" }
    }
    const checked = validateDownloadUrl(record.downloadUrl)
    if (checked.url === null) {
        return { version, downloadUrl: null, error: checked.error }
    }
    return { version, downloadUrl: checked.url, error: null }
}

/** 带超时地跑一个探针 */
async function runProbe(probe: PluginVersionProbe, timeoutMs: number): Promise<ProbeOutcome> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`版本探针超时（${timeoutMs}ms）`)), timeoutMs)
        timer.unref?.()
    })
    try {
        const value = await Promise.race([probe(), timeout])
        return readProbeValue(value)
    } catch (error) {
        return { version: null, downloadUrl: null, error: errorText(error) }
    } finally {
        if (timer !== null) clearTimeout(timer)
    }
}

/**
 * 检查更新
 *
 * 并发运行已注册的探针；无探针的插件标 hasProbe: false，不发起请求
 * 结果按入参顺序返回
 */
export async function checkPluginUpdates(
    installed: readonly InstalledPlugin[],
    options: { readonly timeoutMs?: number } = {},
): Promise<readonly PluginUpdateCheck[]> {
    const timeoutMs = options.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS
    return await Promise.all(
        installed.map(async (plugin): Promise<PluginUpdateCheck> => {
            const candidates = plugin.probeIds ?? [plugin.id]
            let probe: PluginVersionProbe | undefined
            for (const candidate of [plugin.id, ...candidates]) {
                probe = probes.get(candidate)
                if (probe !== undefined) break
            }
            if (probe === undefined) {
                return {
                    id: plugin.id,
                    installed: plugin.version,
                    latest: null,
                    updateAvailable: false,
                    error: null,
                    hasProbe: false,
                    downloadUrl: null,
                }
            }
            const outcome = await runProbe(probe, timeoutMs)
            // 出错时 updateAvailable 为 false，latest 仍返回供展示
            return {
                id: plugin.id,
                installed: plugin.version,
                latest: outcome.version,
                updateAvailable:
                    outcome.error === null &&
                    outcome.version !== null &&
                    compareVersions(outcome.version, plugin.version) > 0,
                error: outcome.error,
                hasProbe: true,
                downloadUrl: outcome.downloadUrl,
            }
        }),
    )
}
