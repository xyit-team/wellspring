/*
 * 插件分发来源：npm、GitHub、本地路径。
 *
 * 宿主自己下载插件包（不再由插件在 init 里注册探针），所以这里同时负责：
 * - 解析 `plugin install npm:… / github:… / <path>` 的写法
 * - 查某个来源的最新版本与下载地址
 * - 把包下载到临时文件（zip / tgz 由安装流程按魔数识别）
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { fetch as undiciFetch } from "undici"

import type { ProxySetting } from "../config/types.ts"
import { createProxyFetch } from "../network/proxy.ts"

/** 默认 npm registry */
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org"
/** GitHub API 根地址（测试可换成本地 server） */
export const DEFAULT_GITHUB_API = "https://api.github.com"
/** 单次下载/查询的超时 */
export const SOURCE_TIMEOUT_MS = 30_000
const USER_AGENT = "wellspring-plugin"

export type PluginSpec =
    | { readonly type: "npm"; readonly name: string; readonly version: string | null }
    | { readonly type: "github"; readonly repo: string; readonly ref: string | null }
    | { readonly type: "file"; readonly path: string }

const NPM_PREFIX = "npm:"
const GITHUB_PREFIX = "github:"
const NPM_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/
const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 解析 install / update 的来源写法
 *
 * - `npm:@scope/name`、`npm:@scope/name@1.2.3`
 * - `github:owner/repo`、`github:owner/repo@v1.2.3`
 * - 其它一律当本地路径
 */
export function parsePluginSpec(spec: string): PluginSpec {
    const text = spec.trim()
    if (text.startsWith(NPM_PREFIX)) {
        const rest = text.slice(NPM_PREFIX.length).trim()
        /* scoped 包名里也有 @，版本分隔符按“最后一个 @ 且不在开头”找 */
        const at = rest.lastIndexOf("@")
        const hasVersion = at > 0
        const name = hasVersion ? rest.slice(0, at) : rest
        const version = hasVersion ? rest.slice(at + 1).trim() : ""
        if (!NPM_NAME.test(name)) {
            throw new Error(`npm 包名不合法：${name === "" ? spec : name}`)
        }
        return { type: "npm", name, version: version === "" ? null : version }
    }
    if (text.startsWith(GITHUB_PREFIX)) {
        const rest = text.slice(GITHUB_PREFIX.length).trim()
        const at = rest.lastIndexOf("@")
        const hasRef = at > 0
        const repo = hasRef ? rest.slice(0, at) : rest
        const ref = hasRef ? rest.slice(at + 1).trim() : ""
        if (!GITHUB_REPO.test(repo)) {
            throw new Error(`github 仓库写法应为 owner/repo：${repo === "" ? spec : repo}`)
        }
        return { type: "github", repo, ref: ref === "" ? null : ref }
    }
    return { type: "file", path: text }
}

export interface SourceOptions {
    /** npm registry；默认 https://registry.npmjs.org */
    readonly registry?: string
    /** GitHub API 根地址；默认 https://api.github.com */
    readonly githubApi?: string
    /** 私有仓库需要 */
    readonly githubToken?: string | null
    /** 走 network.proxy */
    readonly proxy?: ProxySetting | null
    readonly timeoutMs?: number
    /** 测试注入 */
    readonly fetchImpl?: typeof undiciFetch
}

export interface LatestRelease {
    readonly version: string
    /** 下载地址（zip 或 tar.gz） */
    readonly url: string
    /** 下载来源渠道 */
    readonly channel: "npm" | "github"
}

function resolveFetch(options: SourceOptions): typeof undiciFetch {
    if (options.fetchImpl !== undefined) {
        return options.fetchImpl
    }
    const proxied = createProxyFetch(options.proxy ?? null)
    return proxied ?? undiciFetch
}

function timeoutOf(options: SourceOptions): number {
    return options.timeoutMs ?? SOURCE_TIMEOUT_MS
}

function scopedEncode(name: string): string {
    /* npm registry 的 scoped 路径是 @scope%2fname */
    return name.replace("/", "%2f")
}

async function readJson(
    url: string,
    options: SourceOptions,
    extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
    const fetchImpl = resolveFetch(options)
    const response = await fetchImpl(url, {
        headers: {
            accept: "application/json",
            "user-agent": USER_AGENT,
            ...extraHeaders,
        },
        signal: AbortSignal.timeout(timeoutOf(options)),
    })
    if (!response.ok) {
        /* GitHub 未认证调用有频率限制：403/429 时把解法说出来 */
        const hint =
            url.includes("api.github.com") && (response.status === 403 || response.status === 429)
                ? "（GitHub 未认证调用有频率限制：配置 plugins.update.githubToken 或稍后再试）"
                : ""
        throw new Error(`${url} 返回 ${response.status}${hint}`)
    }
    const value: unknown = await response.json()
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${url} 返回的不是 JSON 对象`)
    }
    return value as Record<string, unknown>
}

function stringOf(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

/** 去掉 tag 前缀 v，例如 v1.2.3 → 1.2.3 */
export function tagToVersion(tag: string): string {
    return tag.trim().replace(/^v/i, "")
}

/** 查 npm 最新版本（或指定版本）与 tarball 地址 */
export async function resolveNpmRelease(
    name: string,
    version: string | null,
    options: SourceOptions = {},
): Promise<LatestRelease> {
    const registry = (options.registry ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, "")
    const endpoint = version === null ? "latest" : scopedEncode(version)
    const data = await readJson(`${registry}/${scopedEncode(name)}/${endpoint}`, options)
    const resolvedVersion = stringOf(data["version"])
    const dist = data["dist"]
    const tarball =
        typeof dist === "object" && dist !== null && !Array.isArray(dist)
            ? stringOf((dist as Record<string, unknown>)["tarball"])
            : null
    if (resolvedVersion === null || tarball === null) {
        throw new Error(`npm registry 没有返回 version / dist.tarball：${name}`)
    }
    return { version: resolvedVersion, url: tarball, channel: "npm" }
}

interface GithubReleaseShape {
    readonly tag_name?: unknown
    readonly assets?: unknown
}

function firstZipAsset(assets: unknown): { url: string | null; name: string | null } {
    if (!Array.isArray(assets)) {
        return { url: null, name: null }
    }
    for (const item of assets) {
        if (typeof item !== "object" || item === null) {
            continue
        }
        const asset = item as Record<string, unknown>
        const name = stringOf(asset["name"])
        const url = stringOf(asset["browser_download_url"])
        if (name !== null && url !== null && /\.zip$/i.test(name)) {
            return { url, name }
        }
    }
    return { url: null, name: null }
}

/**
 * 查 GitHub Release（或指定 tag）
 *
 * 优先用 Release 里的 .zip 资产；没有资产时回落到源码 tarball（codeload）。
 * 版本号取 tag 去掉前缀 v。
 */
export async function resolveGithubRelease(
    repo: string,
    ref: string | null,
    options: SourceOptions = {},
): Promise<LatestRelease> {
    const api = (options.githubApi ?? DEFAULT_GITHUB_API).replace(/\/+$/, "")
    const headers: Record<string, string> = {}
    const token = options.githubToken ?? null
    if (token !== null && token !== "") {
        headers["authorization"] = `Bearer ${token}`
    }
    const endpoint =
        ref === null
            ? `${api}/repos/${repo}/releases/latest`
            : `${api}/repos/${repo}/releases/tags/${encodeURIComponent(ref)}`
    let release: GithubReleaseShape
    try {
        release = (await readJson(endpoint, options, headers)) as GithubReleaseShape
    } catch (error) {
        /* 没有 Release（或指定的是 tag 而不是 release）：退回源码 tarball */
        if (ref === null) {
            throw error
        }
        return {
            version: tagToVersion(ref),
            url: `https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(ref)}`,
            channel: "github",
        }
    }
    const tag = stringOf(release.tag_name)
    if (tag === null) {
        throw new Error(`GitHub Release 没有 tag_name：${repo}`)
    }
    const zip = firstZipAsset(release.assets)
    return {
        version: tagToVersion(tag),
        url:
            zip.url ??
            `https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(tag)}`,
        channel: "github",
    }
}

/**
 * 下载插件包到临时目录，返回文件路径
 *
 * 不按扩展名判断格式：安装流程会看魔数（zip / gzip），这里只保证文件落盘。
 */
export async function downloadPluginPackage(
    url: string,
    workDir: string,
    options: SourceOptions = {},
): Promise<string> {
    const fetchImpl = resolveFetch(options)
    const headers: Record<string, string> = { "user-agent": USER_AGENT }
    /* npm tarball 与 codeload 都不需要认证；GitHub 资产在私有仓库时才需要 */
    const token = options.githubToken ?? null
    if (token !== null && token !== "" && url.includes("github")) {
        headers["authorization"] = `Bearer ${token}`
    }
    const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutOf(options)),
    })
    if (!response.ok) {
        throw new Error(`下载插件包失败（${response.status}）：${url}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    await mkdir(workDir, { recursive: true })
    const file = join(workDir, `plugin-${Date.now().toString(36)}-${buffer.length}.download`)
    await writeFile(file, buffer)
    return file
}
