/*
 * 插件清单（package.json）里宿主关心的字段。
 *
 * 两个身份分开：
 * - **本地身份**（`wellspring.name`）：目录名、插件 id、plugin-data 与配置文件名都用它。
 *   显式声明，不从 npm 包名推导——没有 npm / github 的本地插件照样能装、能测。
 * - **发布身份**（`wellspring.npm` / `wellspring.github`）：只用来查更新，缺省表示该渠道不可用。
 *
 * 老插件没有 `wellspring.name`：回退到 package.json 的 `name` 去掉 scope 作兼容，
 * 调用方可以通过 `hasDeclaredLocalName` 判断是否需要提示用户补字段。
 */

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { PLUGIN_NAME } from "./paths.ts"

/** 更新来源类型；file 表示本地路径，不走网络 */
export type PluginSourceType = "npm" | "github" | "file"

export interface PluginSource {
    readonly type: PluginSourceType
    /** npm 包名 / github 的 owner/repo / 本地绝对路径 */
    readonly spec: string
}

export interface PluginManifest {
    readonly name?: string
    readonly version?: string
    readonly main?: string
    readonly wellspring?: {
        readonly apiVersion?: number
        readonly entry?: unknown
        /** 本地身份：目录名与插件 id */
        readonly name?: unknown
        /** npm 包名，例如 @etheros/wellspring-core */
        readonly npm?: unknown
        /** GitHub 仓库，例如 EtherosGroup/wellspring-core */
        readonly github?: unknown
        /** 安装时由宿主写入的来源记录 */
        readonly source?: unknown
        readonly sandbox?: unknown
    }
}

/**
 * 包名 → 本地名
 *
 * 取最后一段并清洗非法字符：`@xyit/test` → `test`，`@etheros/wellspring-core` → `wellspring-core`。
 * 清洗后仍不合法返回 null。
 */
export function packageLocalName(packageName: string): string | null {
    const trimmed = packageName.trim()
    if (trimmed === "") {
        return null
    }
    const slash = trimmed.lastIndexOf("/")
    const segment = slash === -1 ? trimmed : trimmed.slice(slash + 1)
    const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, "-")
    if (!PLUGIN_NAME.test(cleaned)) {
        return null
    }
    return cleaned
}

/** 清单是否显式声明了 wellspring.name */
export function hasDeclaredLocalName(pkg: PluginManifest | null): boolean {
    const declared = pkg?.wellspring?.name
    return typeof declared === "string" && declared.trim() !== ""
}

/**
 * 清单的本地名
 *
 * 优先 `wellspring.name`；没有时回退到 package.json `name` 的最后一段（旧插件兼容）。
 * 两者都不合法返回 null。
 */
export function manifestLocalName(pkg: PluginManifest | null): string | null {
    const declared = pkg?.wellspring?.name
    if (typeof declared === "string" && declared.trim() !== "") {
        const value = declared.trim()
        return PLUGIN_NAME.test(value) ? value : null
    }
    if (typeof pkg?.name === "string") {
        return packageLocalName(pkg.name)
    }
    return null
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

/** 清单声明的 npm 包名；没声明返回 null */
export function manifestNpm(pkg: PluginManifest | null): string | null {
    return nonEmptyString(pkg?.wellspring?.npm)
}

/** 清单声明的 GitHub 仓库（owner/repo）；没声明返回 null */
export function manifestGithub(pkg: PluginManifest | null): string | null {
    return nonEmptyString(pkg?.wellspring?.github)
}

/** 安装时记录的来源；没有记录返回 null */
export function manifestSource(pkg: PluginManifest | null): PluginSource | null {
    const raw = pkg?.wellspring?.source
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return null
    }
    const record = raw as Record<string, unknown>
    const type = record["type"]
    const spec = record["spec"]
    if (type !== "npm" && type !== "github" && type !== "file") {
        return null
    }
    const text = nonEmptyString(spec)
    if (text === null) {
        return null
    }
    return { type, spec: text }
}

export async function readPluginManifest(dir: string): Promise<PluginManifest | null> {
    try {
        const text = await readFile(join(dir, "package.json"), "utf8")
        const value: unknown = JSON.parse(text)
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return null
        }
        return value as PluginManifest
    } catch {
        return null
    }
}

/**
 * 把安装来源写进已装插件的 package.json
 *
 * 只增一个 `wellspring.source` 字段，不动其它内容；写失败不影响安装本身
 * （更新时拿不到来源只影响 file 类型的 update）。
 */
export async function writePluginSource(dir: string, source: PluginSource): Promise<void> {
    const file = join(dir, "package.json")
    let raw: Record<string, unknown>
    try {
        const value: unknown = JSON.parse(await readFile(file, "utf8"))
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return
        }
        raw = value as Record<string, unknown>
    } catch {
        return
    }
    const previous = raw["wellspring"]
    const wellspring =
        typeof previous === "object" && previous !== null && !Array.isArray(previous)
            ? { ...(previous as Record<string, unknown>) }
            : {}
    wellspring["source"] = { type: source.type, spec: source.spec }
    raw["wellspring"] = wellspring
    await writeFile(file, `${JSON.stringify(raw, null, 4)}\n`, "utf8")
}
