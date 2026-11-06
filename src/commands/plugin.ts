/*
 * plugin 命令：list / new / install / update / link / enable / disable / remove。
 *
 * install 支持三种来源：`npm:<包名>[@版本]`、`github:<owner/repo>[@tag]`、本地路径。
 * update 按清单声明的来源（wellspring.npm / wellspring.github）或安装时记录来源更新；
 * 有正在运行的 Wellspring 服务时拒绝。
 */

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readFile } from "node:fs/promises"

import { Result } from "../api/result/result.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { booleanValue, parseCommandArgs } from "../input/parse-options.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import { removePath, statIfExists } from "../platform/file.ts"
import { installPlugin } from "../plugin/install.ts"
import { linkPlugin, removePlugin } from "../plugin/loader.ts"
import {
    manifestGithub,
    manifestLocalName,
    manifestNpm,
    readPluginManifest,
} from "../plugin/manifest.ts"
import { PLUGIN_ID, listPluginDirs, pluginDirOf, pluginsRoot } from "../plugin/paths.ts"
import { scaffoldPlugin } from "../plugin/scaffold.ts"
import { readPluginState, setPluginEnabled } from "../plugin/state.ts"
import { sourceOptionsOf, updatePlugin } from "../plugin/update.ts"
import { checkPluginUpdates, type PluginUpdateCheck } from "../plugin/update-check.ts"
import {
    downloadPluginPackage,
    parsePluginSpec,
    resolveGithubRelease,
    resolveNpmRelease,
    type PluginSpec,
} from "../plugin/sources.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

interface ScannedPlugin {
    /** 本地名（目录名 / 插件 id） */
    readonly id: string
    /** 包名（npm 身份）；没有 package.json 时为 null */
    readonly name: string | null
    readonly version: string
    readonly enabled: boolean
    readonly deps: readonly string[]
    /** 1.7 之前的 plugins/@scope/name 布局 */
    readonly legacy: boolean
    readonly npm: string | null
    readonly github: string | null
}

/** 只扫插件目录的文件，不启动插件进程（plugin list / enable / disable 用） */
async function scanPluginDirs(paths: ResolvedPaths): Promise<ScannedPlugin[]> {
    const root = pluginsRoot(paths)
    const disabled = await readPluginState(paths)
    const plugins: ScannedPlugin[] = []
    for (const found of await listPluginDirs(root)) {
        const dir = found.dir
        const manifest = await readPluginManifest(dir)
        const localName = manifestLocalName(manifest) ?? found.dirName
        const version =
            typeof manifest?.version === "string" && manifest.version !== ""
                ? manifest.version
                : "0.0.0"
        let deps: string[] = []
        try {
            const source = await readFile(join(dir, "index.ts"), "utf8")
            const match = /deps\s*:\s*\[([^\]]*)\]/.exec(source)
            if (match !== null) {
                deps = [...(match[1] ?? "").matchAll(/["']([^"']+)["']/g)].map(
                    (item) => item[1] ?? "",
                )
            }
        } catch {
            /* 读不到入口时按没有依赖处理 */
        }
        plugins.push({
            id: localName,
            name: manifest?.name ?? null,
            version,
            enabled: !disabled.has(found.id),
            deps: deps.filter((dep) => dep !== ""),
            legacy: found.legacy,
            npm: manifestNpm(manifest),
            github: manifestGithub(manifest),
        })
    }
    return plugins
}

/** 依赖目标插件的其它插件 */
function dependentsOf(
    plugins: readonly ScannedPlugin[],
    id: string,
    names: readonly string[],
): string[] {
    return plugins
        .filter(
            (plugin) =>
                plugin.id !== id && plugin.deps.some((dep) => dep === id || names.includes(dep)),
        )
        .map((plugin) => plugin.id)
}

/** 检查结果行 */
function describeUpdate(check: PluginUpdateCheck | undefined): string {
    if (check === undefined) {
        return "检查更新：没有结果"
    }
    if (!check.hasSource) {
        return "检查更新：没有声明 wellspring.npm / wellspring.github"
    }
    if (check.error !== null) {
        return `检查更新失败（${check.channel ?? "来源"}）：${check.error}`
    }
    if (!check.updateAvailable) {
        return `已是最新（${check.installed}）`
    }
    const download = check.downloadUrl === null ? "" : `  下载：${check.downloadUrl}`
    return `可更新（${check.channel ?? "来源"}）：${check.installed} → ${check.latest}${download}`
}

/** 从来源装一个新插件；npm/github 会先下载到临时目录 */
async function installFromSpec(
    ctx: CommandContext,
    raw: string,
    force: boolean,
): Promise<{ readonly id: string }> {
    const spec: PluginSpec = parsePluginSpec(raw)
    if (spec.type === "file") {
        const target = resolve(spec.path)
        const installed = await installPlugin(target, ctx.paths, {
            force,
            source: { type: "file", spec: target },
        })
        return installed
    }
    const sourceOptions = sourceOptionsOf(ctx.settings)
    const release =
        spec.type === "npm"
            ? await resolveNpmRelease(spec.name, spec.version, sourceOptions)
            : await resolveGithubRelease(spec.repo, spec.ref, sourceOptions)
    const workDir = await mkdtemp(join(tmpdir(), "wellspring-plugin-install-"))
    try {
        const file = await downloadPluginPackage(release.url, workDir, sourceOptions)
        const installed = await installPlugin(file, ctx.paths, {
            force,
            source: { type: spec.type, spec: raw.slice(raw.indexOf(":") + 1) },
        })
        return installed
    } finally {
        await removePath(workDir)
    }
}

export async function runPluginCommand(
    ctx: CommandContext,
    argv: readonly string[],
): Promise<CommandOutcome> {
    const [subcommand, ...rest] = argv
    const parsed = parseCommandArgs(rest, {
        force: { type: "boolean" },
        ignore: { type: "boolean" },
        dir: { type: "string" },
        // list / update 用
        check: { type: "boolean" },
        // update 用：npm / github / file
        type: { type: "string" },
        // update --type file 用
        from: { type: "string" },
    })
    if (!parsed.isSuccess()) {
        return { result: Result.error<unknown>(parsed.getCode() ?? USAGE_CODES.invalidValue) }
    }
    const line = parsed.getData()
    if (line === null) {
        return failure(USAGE_CODES.invalidValue)
    }
    const force = booleanValue(line.values, "force")
    const ignore = booleanValue(line.values, "ignore")
    const check = booleanValue(line.values, "check")

    try {
        switch (subcommand) {
            case "list": {
                const plugins = await scanPluginDirs(ctx.paths)
                /* --check 只读清单 + 查网络，不再需要启动插件进程 */
                const updates = check
                    ? await checkPluginUpdates(
                          plugins.map((plugin) => ({
                              id: plugin.id,
                              version: plugin.version,
                              npm: plugin.npm,
                              github: plugin.github,
                          })),
                          sourceOptionsOf(ctx.settings),
                      )
                    : null
                for (const plugin of plugins) {
                    const deps = plugin.deps.length === 0 ? "-" : plugin.deps.join(",")
                    const status = plugin.enabled ? "enabled" : "disabled"
                    const legacy = plugin.legacy ? "  [旧布局]" : ""
                    ctx.elog.print(
                        `${plugin.id}  ${plugin.name ?? plugin.id}@${plugin.version}  ${status}  deps=${deps}${legacy}`,
                    )
                    if (updates === null) continue
                    ctx.elog.print(
                        `  ${describeUpdate(updates.find((item) => item.id === plugin.id))}`,
                    )
                }
                if (updates !== null) {
                    const count = updates.filter((item) => item.updateAvailable).length
                    ctx.elog.print(count === 0 ? "没有可用更新" : `${count} 个插件有可用更新`)
                }
                return success(plugins)
            }
            case "new": {
                const name = line.positionals[0]
                if (name === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:name`)
                }
                const created = await scaffoldPlugin({
                    name,
                    parentDir:
                        typeof line.values["dir"] === "string" ? line.values["dir"] : undefined,
                    force,
                })
                ctx.elog.info(`已创建插件 ${name}：${created.dir}`)
                ctx.elog.print("下一步：")
                ctx.elog.print(`  wellspring plugin link ${created.dir}`)
                ctx.elog.print(`  wellspring plugin list`)
                ctx.elog.print(`  wellspring ${created.commandName}`)
                ctx.elog.print("类型检查：先把 Wellspring 链接进插件（见插件 README）")
                return success(created)
            }
            case "enable":
            case "disable": {
                const name = line.positionals[0]
                if (name === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:name`)
                }
                if (!PLUGIN_ID.test(name)) {
                    return failure(`${USAGE_CODES.invalidValue}:name`)
                }
                const plugins = await scanPluginDirs(ctx.paths)
                const match =
                    plugins.find((plugin) => plugin.id === name) ??
                    plugins.find((plugin) => plugin.name === name)
                if (match === undefined) {
                    return failure(`plugin.not-found:${name}`)
                }
                const enabled = subcommand === "enable"
                await setPluginEnabled(match.id, enabled, ctx.paths)
                ctx.elog.info(`${enabled ? "已启用" : "已禁用"}插件 ${match.id}（下次运行生效）`)
                return success({ id: match.id, enabled })
            }
            case "install": {
                const source = line.positionals[0]
                if (source === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:source`)
                }
                const installed = await installFromSpec(ctx, source, force)
                ctx.elog.info(`已安装插件 ${installed.id}`)
                return success(installed)
            }
            case "update": {
                const name = line.positionals[0]
                if (name === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:name`)
                }
                const rawType = line.values["type"]
                const type = typeof rawType === "string" ? rawType.trim() : undefined
                if (type !== undefined && type !== "npm" && type !== "github" && type !== "file") {
                    return failure(`${USAGE_CODES.invalidValue}:--type（npm / github / file）`)
                }
                const rawFrom = line.values["from"]
                const result = await updatePlugin(name, {
                    paths: ctx.paths,
                    config: ctx.settings,
                    logger: ctx.logger,
                    ...(type === undefined ? {} : { type }),
                    ...(typeof rawFrom === "string" ? { from: rawFrom } : {}),
                    force,
                    checkOnly: check,
                })
                if (!result.ok) {
                    ctx.elog.error(result.message)
                    return failure(`plugin.update-failed:${result.message}`)
                }
                ctx.elog.info(result.message)
                return success(result)
            }
            case "link": {
                const source = line.positionals[0]
                if (source === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:path`)
                }
                const name = await linkPlugin(source, ctx.paths)
                ctx.elog.info(`已链接插件 ${name}`)
                return success({ id: name })
            }
            case "remove": {
                const name = line.positionals[0]
                if (name === undefined) {
                    return failure(`${USAGE_CODES.missingValue}:name`)
                }
                const plugins = await scanPluginDirs(ctx.paths)
                const target =
                    plugins.find((plugin) => plugin.id === name) ??
                    plugins.find((plugin) => plugin.name === name)
                /*
                 * 找不到就必须说找不到
                 *
                 * 以前无论有没有这个插件都会打印「已删除插件」：`rm --force` 对不存在的路径
                 * 不报错，名字打错或者已经被删掉时，用户以为卸载成功、实际什么都没发生。
                 */
                if (target === undefined) {
                    ctx.elog.error(`没有这个插件：${name}（wellspring plugin list 看已装的）`)
                    return failure(`plugin.not-found:${name}`)
                }
                const names = [target.name ?? target.id]
                const dependents = dependentsOf(plugins, target.id, names)
                if (dependents.length > 0 && !ignore) {
                    ctx.elog.error(
                        `插件 ${target.id} 被这些插件依赖：${dependents.join(", ")}；` +
                            "确认要强制卸载请加 --ignore",
                    )
                    return failure(`plugin.has-dependents:${dependents.join(",")}`)
                }
                const dir = pluginDirOf(pluginsRoot(ctx.paths), target.id)
                if (dir === null || (await statIfExists(dir)) === null) {
                    return failure(`plugin.not-found:${target.id}`)
                }
                await removePlugin(target.id, ctx.paths)
                // 删掉目录后禁用记录也要跟着清，否则同名的插件重装回来还是禁用态
                await setPluginEnabled(target.id, true, ctx.paths)
                ctx.elog.info(
                    `已删除插件 ${target.id}${ignore && dependents.length > 0 ? "（忽略依赖）" : ""}`,
                )
                return success({ id: target.id })
            }
            default:
                return failure(`${USAGE_CODES.unknownSubcommand}:plugin ${subcommand ?? ""}`)
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return failure(`plugin.failed:${message}`)
    }
}
