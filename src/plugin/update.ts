/*
 * 插件更新：按清单声明的来源（wellspring.npm / wellspring.github / 安装时记录的 source）
 * 查最新版本，下载并复用 installPlugin(mode: "update") 落盘。
 *
 * 约束：
 * - 有正在运行的 Wellspring 服务（service.json + pid 存活）时拒绝更新：
 *   Windows 上插件目录被进程当 cwd，且运行中的服务还持有旧代码
 * - 没有声明来源的插件直接报错，不会默默跳过
 * - 不指定 type 时用配置 plugins.update.type（默认 npm）
 */

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Logger } from "pino"

import type { AppSetting, PluginUpdateType } from "../config/types.ts"
import { DEFAULT_PLUGINS } from "../config/defaults.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import { readJsonIfExists, removePath, statIfExists } from "../platform/file.ts"
import { isProcessAlive, readServiceRecord } from "../service/control.ts"
import { installPlugin } from "./install.ts"
import {
    manifestGithub,
    manifestLocalName,
    manifestNpm,
    manifestSource,
    readPluginManifest,
    type PluginManifest,
} from "./manifest.ts"
import { listPluginDirs } from "./paths.ts"
import {
    downloadPluginPackage,
    resolveGithubRelease,
    resolveNpmRelease,
    type SourceOptions,
} from "./sources.ts"
import { compareVersions } from "./update-check.ts"

export interface InstalledPluginRecord {
    /** 本地名（目录名 / 插件 id） */
    readonly id: string
    readonly dir: string
    readonly version: string
    readonly manifest: PluginManifest | null
}

/** 按名字找已装插件：接受本地名、目录 id、或清单里的 npm 包名 */
export async function findInstalledPlugin(
    name: string,
    paths: ResolvedPaths,
): Promise<InstalledPluginRecord | null> {
    for (const entry of await listPluginDirs(join(paths.dataDir, "plugins"))) {
        const manifest = await readPluginManifest(entry.dir)
        const localName = manifestLocalName(manifest) ?? entry.dirName
        const version =
            typeof manifest?.version === "string" && manifest.version !== ""
                ? manifest.version
                : "0.0.0"
        if (
            name === localName ||
            name === entry.id ||
            name === entry.dirName ||
            name === manifest?.name
        ) {
            return { id: localName, dir: entry.dir, version, manifest }
        }
    }
    return null
}

/** 由配置生成来源查询参数（registry / token / 代理） */
export function sourceOptionsOf(config: AppSetting): SourceOptions {
    const update = config.plugins?.update ?? DEFAULT_PLUGINS.update
    return {
        registry: update.registry,
        githubToken: update.githubToken,
        proxy: config.network.proxy,
    }
}

export interface UpdatePluginOptions {
    readonly paths: ResolvedPaths
    readonly config: AppSetting
    readonly logger: Logger
    /** 指定渠道；缺省用配置 plugins.update.type */
    readonly type?: PluginUpdateType
    /** --type file 时的本地路径；缺省用安装时记录的来源 */
    readonly from?: string
    /** 已是最新也重装 */
    readonly force?: boolean
    /** 只检查不安装 */
    readonly checkOnly?: boolean
    /** 覆盖来源参数（测试注入 / 自建镜像） */
    readonly sources?: SourceOptions
}

export interface UpdatePluginResult {
    readonly ok: boolean
    readonly id: string
    /** 已装版本；找不到插件时为空串 */
    readonly installedVersion: string
    /** 查到的最新版本；file 渠道或失败时为 null */
    readonly latestVersion: string | null
    readonly channel: PluginUpdateType | null
    /** 是否真的换了版本/重装了 */
    readonly changed: boolean
    readonly message: string
}

function fail(
    id: string,
    installedVersion: string,
    channel: PluginUpdateType | null,
    message: string,
): UpdatePluginResult {
    return {
        ok: false,
        id,
        installedVersion,
        latestVersion: null,
        channel,
        changed: false,
        message,
    }
}

/** 服务是否正在运行（有 service.json 且 pid 活着） */
export async function runningServicePid(paths: ResolvedPaths): Promise<number | null> {
    const record = await readServiceRecord(paths)
    if (record === null) {
        return null
    }
    return isProcessAlive(record.pid) ? record.pid : null
}

/** 本地来源的版本：目录读 package.json；归档包读不出来先当未知 */
async function localVersionOf(
    spec: string,
): Promise<{ version: string | null; manifest: PluginManifest | null }> {
    const info = await statIfExists(spec)
    if (info === null || !info.isDirectory()) {
        return { version: null, manifest: null }
    }
    const manifest = await readJsonIfExists<PluginManifest>(join(spec, "package.json"))
    const version =
        typeof manifest?.version === "string" && manifest.version !== "" ? manifest.version : null
    return { version, manifest }
}

export async function updatePlugin(
    name: string,
    options: UpdatePluginOptions,
): Promise<UpdatePluginResult> {
    const channel = options.type ?? (options.config.plugins?.update ?? DEFAULT_PLUGINS.update).type
    const running = await runningServicePid(options.paths)
    if (running !== null) {
        return fail(
            name,
            "",
            channel,
            `Wellspring 服务正在运行（pid ${running}），先 wellspring stop 再更新插件`,
        )
    }

    const installed = await findInstalledPlugin(name, options.paths)
    if (installed === null) {
        return fail(name, "", channel, `插件未安装：${name}（wellspring plugin list 看已装的）`)
    }

    const sourceOptions: SourceOptions = { ...sourceOptionsOf(options.config), ...options.sources }
    const recorded = manifestSource(installed.manifest)

    try {
        if (channel === "file") {
            const spec =
                options.from ??
                (recorded !== null && recorded.type === "file" ? recorded.spec : null)
            if (spec === null) {
                return fail(
                    installed.id,
                    installed.version,
                    channel,
                    `插件 ${installed.id} 没有记录本地来源；用 --from <路径> 指定`,
                )
            }
            const local = await localVersionOf(spec)
            const latest = local.version
            if (options.checkOnly) {
                return {
                    ok: true,
                    id: installed.id,
                    installedVersion: installed.version,
                    latestVersion: latest,
                    channel,
                    changed: false,
                    message:
                        latest === null
                            ? `本地来源：${spec}（读不到版本）`
                            : `本地来源：${spec}（${installed.version} → ${latest}）`,
                }
            }
            if (
                !options.force &&
                latest !== null &&
                compareVersions(latest, installed.version) <= 0
            ) {
                return {
                    ok: true,
                    id: installed.id,
                    installedVersion: installed.version,
                    latestVersion: latest,
                    channel,
                    changed: false,
                    message: `已是最新（${installed.version}）`,
                }
            }
            const result = await installPlugin(spec, options.paths, {
                mode: "update",
                force: true,
                expectedLocalName: installed.id,
                source: { type: "file", spec },
            })
            options.logger.info({ id: result.id, from: spec }, "已从本地来源更新插件")
            return {
                ok: true,
                id: installed.id,
                installedVersion: installed.version,
                latestVersion: latest,
                channel,
                changed: true,
                message:
                    latest === null
                        ? `已重装 ${installed.id}（本地来源 ${spec}）`
                        : `已更新 ${installed.id}：${installed.version} → ${latest}`,
            }
        }

        if (channel === "npm") {
            const spec =
                manifestNpm(installed.manifest) ??
                (recorded !== null && recorded.type === "npm" ? recorded.spec : null)
            if (spec === null) {
                return fail(
                    installed.id,
                    installed.version,
                    channel,
                    `插件 ${installed.id} 没有声明 wellspring.npm，无法从 npm 更新`,
                )
            }
            const release = await resolveNpmRelease(spec, null, sourceOptions)
            if (release.version === null) {
                return fail(installed.id, installed.version, channel, `npm 没有返回版本号：${spec}`)
            }
            return await installFromRelease(installed, release.version, release.url, channel, {
                ...options,
                source: { type: "npm", spec },
            })
        }

        const repo =
            manifestGithub(installed.manifest) ??
            (recorded !== null && recorded.type === "github" ? recorded.spec : null)
        if (repo === null) {
            return fail(
                installed.id,
                installed.version,
                channel,
                `插件 ${installed.id} 没有声明 wellspring.github，无法从 GitHub 更新`,
            )
        }
        const release = await resolveGithubRelease(repo, null, sourceOptions)
        if (release.version === null) {
            return fail(
                installed.id,
                installed.version,
                channel,
                `无法确认 GitHub 上的最新版本：${repo}`,
            )
        }
        return await installFromRelease(installed, release.version, release.url, channel, {
            ...options,
            source: { type: "github", spec: repo },
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        options.logger.warn({ plugin: installed.id, channel, error: message }, "插件更新失败")
        return fail(installed.id, installed.version, channel, message)
    }
}

async function installFromRelease(
    installed: InstalledPluginRecord,
    latestVersion: string,
    url: string,
    channel: PluginUpdateType,
    options: UpdatePluginOptions & { readonly source: { type: "npm" | "github"; spec: string } },
): Promise<UpdatePluginResult> {
    if (options.checkOnly) {
        return {
            ok: true,
            id: installed.id,
            installedVersion: installed.version,
            latestVersion,
            channel,
            changed: false,
            message:
                compareVersions(latestVersion, installed.version) > 0
                    ? `可更新：${installed.version} → ${latestVersion}`
                    : `已是最新（${installed.version}）`,
        }
    }
    if (!options.force && compareVersions(latestVersion, installed.version) <= 0) {
        return {
            ok: true,
            id: installed.id,
            installedVersion: installed.version,
            latestVersion,
            channel,
            changed: false,
            message: `已是最新（${installed.version}）`,
        }
    }
    const workDir = await mkdtemp(join(tmpdir(), "wellspring-plugin-update-"))
    try {
        const sourceOptions: SourceOptions = {
            ...sourceOptionsOf(options.config),
            ...options.sources,
        }
        const file = await downloadPluginPackage(url, workDir, sourceOptions)
        const result = await installPlugin(file, options.paths, {
            mode: "update",
            force: true,
            expectedLocalName: installed.id,
            source: options.source,
        })
        options.logger.info(
            { id: result.id, channel, from: installed.version, to: latestVersion },
            "已更新插件",
        )
        return {
            ok: true,
            id: installed.id,
            installedVersion: installed.version,
            latestVersion,
            channel,
            changed: true,
            message: `已更新 ${installed.id}：${installed.version} → ${latestVersion}`,
        }
    } finally {
        await removePath(workDir)
    }
}
