/*
 * 宿主插件管理服务：列出插件、安装 zip 与 tar.gz、卸载、启用/禁用。
 * 状态文件只记录禁用项；启用/禁用与安装/卸载都要求下次启动生效。
 */

import { randomUUID } from "node:crypto"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

import type { Logger } from "pino"

import type { HostPlugin } from "../api/host/host.ts"
import { getHost } from "../api/host/host.ts"
import type {
    HostPluginEntry,
    HostPluginEntryStatus,
    HostPluginInstallInput,
    HostPluginListResult,
    HostPluginMutationResult,
    HostPluginUpdateResult,
    HostPluginsApi,
} from "../api/host/plugins.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import { checkPluginUpdates } from "./version-probes.ts"
import {
    ensureDir,
    readJsonIfExists,
    removePath,
    statIfExists,
    writeBytesAtomic,
} from "../platform/file.ts"
import { installPlugin } from "./install.ts"
import { PLUGIN_ID, listPluginDirs, pluginDirOf, pluginsRoot } from "./paths.ts"
import { readPluginState, setPluginEnabled } from "./state.ts"

const WEB_PLUGIN_ID = "wellspring-web"

/** 热启用/禁用的结果；由 loader 的插件运行时实现 */
export interface PluginHotOutcome {
    readonly ok: boolean
    readonly id: string
    readonly changed?: boolean
    readonly dependents?: readonly string[]
    readonly error?: string
}

export interface PluginHotController {
    /** 热启用；id 可以是插件 id 或目录名 */
    hotEnable(id: string): Promise<PluginHotOutcome>
    /** 热禁用；id 可以是插件 id 或目录名 */
    hotDisable(id: string): Promise<PluginHotOutcome>
    /** 卸载后清掉运行时里的失败/禁用占位 */
    hotForget?(id: string): Promise<void>
}
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_BASE64_CHARS = Math.ceil((MAX_ARCHIVE_BYTES * 4) / 3) + 1024
const MAX_FILENAME_CHARS = 200
const MAX_ERROR_CHARS = 300

export interface HostPluginManagerOptions {
    readonly paths: ResolvedPaths
    readonly logger: Logger
    /** 测试与宿主启动早期可注入插件快照；默认读当前宿主状态 */
    readonly getHostPlugins?: () => readonly HostPlugin[]
    /** 提供热启用/禁用；没有时一律写状态并要求重启 */
    readonly runtime?: PluginHotController
}

export interface HostPluginManager extends HostPluginsApi {}

interface ScannedPlugin extends HostPluginEntry {
    readonly dirPath: string
}

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS)
}

function failure(id: string, error: string): HostPluginMutationResult {
    return { ok: false, id, restartRequired: false, error }
}

function isBase64(value: string): boolean {
    if (value.length === 0 || value.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

export function createHostPluginManager(options: HostPluginManagerOptions): HostPluginManager {
    const logger = options.logger.child({ module: "plugins" })

    const hostPlugins = (): readonly HostPlugin[] =>
        options.getHostPlugins === undefined ? getHost().getPlugins() : options.getHostPlugins()

    const scan = async (): Promise<ScannedPlugin[]> => {
        const root = pluginsRoot(options.paths)
        const disabled = await readPluginState(options.paths)
        const loaded = hostPlugins()
        const entries: ScannedPlugin[] = []
        for (const found of await listPluginDirs(root)) {
            const dirPath = found.dir
            const pkg = await readJsonIfExists<{ name?: unknown; version?: unknown }>(
                join(dirPath, "package.json"),
            )
            const pkgName =
                typeof pkg?.name === "string" && PLUGIN_ID.test(pkg.name) ? pkg.name : null
            const matched =
                loaded.find((plugin) => plugin.id === found.id) ??
                (pkgName === null ? undefined : loaded.find((plugin) => plugin.id === pkgName))
            const enabled = !disabled.has(found.id)
            let status: HostPluginEntryStatus
            if (!enabled) status = "disabled"
            else if (matched === undefined) status = "unknown"
            else {
                const hostStatus = matched.getStatus()
                status = hostStatus === "disabled" ? "disabled" : hostStatus
            }
            entries.push({
                id: matched?.id ?? pkgName ?? found.id,
                name: matched?.name ?? pkgName ?? found.id,
                version:
                    matched?.version ?? (typeof pkg?.version === "string" ? pkg.version : "0.0.0"),
                status,
                enabled,
                deps: matched?.deps ?? [],
                commands: matched?.commands ?? [],
                dir: found.id,
                dirPath,
            })
        }
        return entries
    }

    const dependentsOf = (target: ScannedPlugin, entries: readonly ScannedPlugin[]): string[] =>
        entries
            .filter((entry) => entry.id !== target.id && entry.deps.includes(target.id))
            .map((entry) => entry.id)

    const resolve = async (id: string): Promise<ScannedPlugin | null> => {
        const entries = await scan()
        return (
            entries.find((entry) => entry.id === id) ??
            entries.find((entry) => entry.dir === id) ??
            null
        )
    }

    return {
        async list(): Promise<HostPluginListResult> {
            try {
                const entries = await scan()
                return {
                    plugins: entries.map((entry) => ({
                        id: entry.id,
                        name: entry.name,
                        version: entry.version,
                        status: entry.status,
                        enabled: entry.enabled,
                        deps: entry.deps,
                        commands: entry.commands,
                        dir: entry.dir,
                    })),
                }
            } catch (error) {
                logger.warn({ error: errorText(error) }, "读取插件列表失败")
                return { plugins: [] }
            }
        },

        /**
         * 检查更新：探针由插件注册，此处负责并发调用与失败隔离
         * 停用的插件一并检查
         */
        async checkUpdates(): Promise<HostPluginUpdateResult> {
            try {
                const entries = await scan()
                const checks = await checkPluginUpdates(
                    entries.map((entry) => ({
                        id: entry.id,
                        version: entry.version,
                        // 探针按归属名注册，可能和对外 id 不同
                        probeIds: [entry.dir, entry.name],
                    })),
                )
                return { plugins: checks }
            } catch (error) {
                logger.warn({ error: errorText(error) }, "检查插件更新失败")
                return { plugins: [] }
            }
        },

        async install(input: HostPluginInstallInput): Promise<HostPluginMutationResult> {
            const filename = typeof input.filename === "string" ? input.filename.trim() : ""
            if (
                filename === "" ||
                filename.length > MAX_FILENAME_CHARS ||
                !/\.(zip|tgz|tar\.gz)$/i.test(filename)
            ) {
                return failure("", "只支持 .zip 与 .tar.gz 插件包")
            }
            const raw =
                typeof input.dataBase64 === "string" ? input.dataBase64.replace(/\s+/g, "") : ""
            if (raw.length === 0 || raw.length > MAX_BASE64_CHARS || !isBase64(raw)) {
                return failure("", "插件包内容不合法或超过 10MB")
            }
            const bytes = Buffer.from(raw, "base64")
            if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) {
                return failure("", "插件包内容不合法或超过 10MB")
            }
            const root = pluginsRoot(options.paths)
            try {
                await ensureDir(root)
                // 解压按文件头判断格式，临时文件不依赖扩展名
                const tempFile = join(root, `.install-${randomUUID()}.archive`)
                await writeBytesAtomic(tempFile, bytes)
                try {
                    const installed = await installPlugin(tempFile, options.paths, {
                        force: input.force === true,
                        validateId: (id) =>
                            id === WEB_PLUGIN_ID
                                ? "不能通过网页安装或覆盖 wellspring-web，请用 CLI 安装"
                                : null,
                    })
                    logger.info(
                        {
                            id: installed.id,
                            packageManager: installed.packageManager,
                            dependenciesInstalled: installed.dependenciesInstalled,
                        },
                        "已安装插件",
                    )
                    return {
                        ok: true,
                        id: installed.id,
                        restartRequired: true,
                        packageManager: installed.packageManager,
                        dependenciesInstalled: installed.dependenciesInstalled,
                    }
                } finally {
                    await removePath(tempFile)
                }
            } catch (error) {
                return failure("", errorText(error))
            }
        },

        async remove(id: string): Promise<HostPluginMutationResult> {
            const target = await resolve(id)
            if (target === null) return failure(id, "plugin.not-found")
            if (target.id === WEB_PLUGIN_ID || target.dir === WEB_PLUGIN_ID) {
                return failure(target.id, "不能卸载 wellspring-web：网页管理页依赖它")
            }
            if (options.runtime !== undefined && target.status === "ok") {
                return failure(target.id, "插件正在运行，请先禁用再卸载")
            }
            const entries = await scan()
            const dependents = dependentsOf(target, entries)
            if (dependents.length > 0) {
                return {
                    ok: false,
                    id: target.id,
                    restartRequired: false,
                    dependents,
                    error: `插件被依赖：${dependents.join(", ")}`,
                }
            }
            try {
                await removePath(target.dirPath)
                /*
                 * 再确认一次：Windows 上目录被进程占成 cwd 时删不掉，
                 * 而 `rm --force` 对「没删掉但其实还在」不会报错，
                 * 不复查就会出现「界面说卸载成功、插件还在」。
                 */
                if ((await statIfExists(target.dirPath)) !== null) {
                    logger.warn({ id: target.id, dir: target.dirPath }, "插件目录没删掉")
                    return failure(
                        target.id,
                        `插件目录没删掉，可能还有进程在用：${target.dirPath}；先禁用并重启 Wellspring 再试`,
                    )
                }
                await setPluginEnabled(target.dir, true, options.paths)
                await options.runtime?.hotForget?.(target.dir)
                logger.info({ id: target.id }, "已删除插件")
                return {
                    ok: true,
                    id: target.id,
                    changed: true,
                    restartRequired: options.runtime === undefined,
                    ...(options.runtime === undefined ? {} : { hot: true }),
                }
            } catch (error) {
                logger.warn({ id: target.id, error: errorText(error) }, "删除插件失败")
                return failure(target.id, errorText(error))
            }
        },

        async enable(id: string): Promise<HostPluginMutationResult> {
            const target = await resolve(id)
            if (target === null) return failure(id, "plugin.not-found")
            if (target.id !== WEB_PLUGIN_ID && options.runtime !== undefined) {
                const result = await options.runtime.hotEnable(target.dir)
                if (!result.ok) {
                    return {
                        ok: false,
                        id: result.id,
                        restartRequired: false,
                        error: result.error,
                    }
                }
                return {
                    ok: true,
                    id: result.id,
                    changed: result.changed ?? true,
                    restartRequired: false,
                    hot: true,
                }
            }
            try {
                const changed = await setPluginEnabled(target.dir, true, options.paths)
                return {
                    ok: true,
                    id: target.id,
                    changed,
                    restartRequired: changed,
                }
            } catch (error) {
                return failure(target.id, errorText(error))
            }
        },

        async disable(id: string): Promise<HostPluginMutationResult> {
            const target = await resolve(id)
            if (target === null) return failure(id, "plugin.not-found")
            if (target.id !== WEB_PLUGIN_ID && options.runtime !== undefined) {
                const result = await options.runtime.hotDisable(target.dir)
                if (!result.ok) {
                    return {
                        ok: false,
                        id: result.id,
                        restartRequired: false,
                        dependents: result.dependents,
                        error: result.error,
                    }
                }
                return {
                    ok: true,
                    id: result.id,
                    changed: result.changed ?? true,
                    restartRequired: false,
                    hot: true,
                }
            }
            try {
                const changed = await setPluginEnabled(target.dir, false, options.paths)
                const entries = await scan()
                return {
                    ok: true,
                    id: target.id,
                    changed,
                    restartRequired: changed,
                    dependents: dependentsOf(target, entries),
                }
            } catch (error) {
                return failure(target.id, errorText(error))
            }
        },
    }
}
