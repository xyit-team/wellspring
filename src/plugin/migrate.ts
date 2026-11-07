// 插件 id 迁移的宿主实现：plugin-data、插件配置、禁用状态，可选删除旧插件目录
// 每步先检查再执行；失败即停止，已完成的步骤写入 steps，供命令报告迁移进度

import { cp, readdir, rename } from "node:fs/promises"
import { dirname } from "node:path"

import type { Logger } from "pino"

import type { HostMigrateApi, HostMigrateInput, HostMigrateResult } from "../api/host/migrate.ts"
import { PLUGIN_ID } from "../api/host/plugin.ts"
import { ensureDir, removePath, statIfExists } from "../platform/file.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import { pluginDirOf, pluginsRoot } from "./paths.ts"
import { pluginConfigFile, pluginDataDir } from "./runtime.ts"
import { readPluginState, setPluginEnabled } from "./state.ts"

export interface HostMigratorOptions {
    readonly paths: ResolvedPaths
    readonly logger: Logger
}

/**
 * 目标数据目录是否有真实内容
 *
 * 插件加载时宿主会预建 <plugin-data>/<id>/（含 tmp/），目录存在不代表有数据要保护
 * 只有 tmp/ 时按空目录处理
 */
async function hasRealContent(dir: string): Promise<boolean> {
    const entries = await readdir(dir).catch(() => [] as string[])
    return entries.some((name) => name !== "tmp")
}

/** rename 跨盘 / 被占用时退回「复制 + 删除」 */
async function movePath(from: string, to: string): Promise<void> {
    await ensureDir(dirname(to))
    try {
        await rename(from, to)
        return
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code ?? ""
        if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES" && code !== "ENOTEMPTY") {
            throw error
        }
    }
    await cp(from, to, { recursive: true })
    await removePath(from)
}

export function createHostMigrator(options: HostMigratorOptions): HostMigrateApi {
    const logger = options.logger.child({ module: "plugin-migrate" })

    const failure = (
        input: HostMigrateInput,
        steps: string[],
        skipped: string[],
        error: string,
    ): HostMigrateResult => ({
        ok: false,
        from: input.from,
        to: input.to,
        steps,
        skipped,
        error,
    })

    return {
        async movePluginData(input: HostMigrateInput): Promise<HostMigrateResult> {
            const from = typeof input.from === "string" ? input.from.trim() : ""
            const to = typeof input.to === "string" ? input.to.trim() : ""
            const steps: string[] = []
            const skipped: string[] = []
            const base = { from, to, steps, skipped }

            if (!PLUGIN_ID.test(from) || !PLUGIN_ID.test(to)) {
                return {
                    ...base,
                    ok: false,
                    error: `插件 id 不合法：${from || "（空）"} → ${to || "（空）"}`,
                }
            }
            if (from === to) {
                return { ...base, ok: false, error: "新旧 id 相同，不需要迁移" }
            }

            try {
                /* 1. plugin-data：回收站、技能、缓存都在这里 */
                const fromData = pluginDataDir(from, options.paths)
                const toData = pluginDataDir(to, options.paths)
                const dataExists = (await statIfExists(fromData)) !== null
                const dataTargetExists = (await statIfExists(toData)) !== null
                if (!dataExists) {
                    skipped.push(`旧数据目录不存在：${fromData}`)
                } else if (
                    dataTargetExists &&
                    input.force !== true &&
                    (await hasRealContent(toData))
                ) {
                    return failure(
                        { ...input, from, to },
                        steps,
                        skipped,
                        `新 id 的数据目录已经有内容：${toData}；确认真要覆盖请加 force`,
                    )
                } else {
                    if (dataTargetExists) {
                        /* 只有宿主预建的 tmp/ 时直接清掉；force 时覆盖已有内容 */
                        await removePath(toData)
                        steps.push(`清掉已有的新数据目录：${toData}`)
                    }
                    await movePath(fromData, toData)
                    steps.push(`迁移插件数据：${fromData} → ${toData}`)
                }

                /* 2. 插件配置：<configDir>/plugins/<id>.json */
                const fromConfig = pluginConfigFile(from, options.paths)
                const toConfig = pluginConfigFile(to, options.paths)
                if ((await statIfExists(fromConfig)) === null) {
                    skipped.push(`旧插件配置不存在：${fromConfig}`)
                } else {
                    if ((await statIfExists(toConfig)) !== null) {
                        if (input.force !== true) {
                            return failure(
                                { ...input, from, to },
                                steps,
                                skipped,
                                `新 id 的配置文件已经存在：${toConfig}；确认真要覆盖请加 force`,
                            )
                        }
                        await removePath(toConfig)
                    }
                    await movePath(fromConfig, toConfig)
                    steps.push(`迁移插件配置：${fromConfig} → ${toConfig}`)
                }

                /*
                 * 3. 禁用状态：plugins-state.json 以完整 id 为 key
                 *
                 * 只清掉旧 id 的标记，禁用状态不带去新 id
                 * 新 id 被禁用后插件不再加载，迁移命令自身也会随插件消失
                 */
                const disabled = await readPluginState(options.paths)
                if (disabled.has(from)) {
                    await setPluginEnabled(from, true, options.paths)
                    steps.push(`清掉旧 id 的禁用标记：${from}（新 id 保持启用）`)
                }

                /* 4. 旧插件目录（可选） */
                if (input.removeOld === true) {
                    const oldDir = pluginDirOf(pluginsRoot(options.paths), from)
                    if (oldDir === null) {
                        skipped.push(`旧插件目录名不合法：${from}`)
                    } else if ((await statIfExists(oldDir)) === null) {
                        skipped.push(`旧插件目录不存在：${oldDir}`)
                    } else {
                        try {
                            await removePath(oldDir)
                            steps.push(`删除旧插件目录：${oldDir}`)
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error)
                            return failure(
                                { ...input, from, to },
                                steps,
                                skipped,
                                `旧插件目录删不掉（可能正在运行，先 wellspring stop）：${message}`,
                            )
                        }
                    }
                } else {
                    skipped.push(
                        `旧插件目录保留；升级完成后用 wellspring plugin remove ${from} 删掉它`,
                    )
                }

                logger.info({ from, to, steps: steps.length }, "插件数据迁移完成")
                return { ...base, ok: true }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn({ from, to, error: message }, "插件数据迁移失败")
                return failure({ ...input, from, to }, steps, skipped, message)
            }
        },
    }
}
