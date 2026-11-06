/*
 * 本地插件安装与更新：目录、zip 或 tar.gz 包。
 * 归档在插件根目录下的临时目录解压，校验后再搬到 plugins/<本地名>。
 *
 * 本地名来自清单 `wellspring.name`（没有时回退到 package.json name 的最后一段）：
 * 目录是单层的 plugins/<本地名>，与 npm scope 无关，方便没有 npm/github 的本地插件。
 *
 * 插件 package.json 可以用 packageManager 声明包管理器；声明了 dependencies 时
 * 安装阶段会调用它自动安装依赖（没有声明则按 lockfile 推断，仍没有则报错）。
 */

import { cp, lstat, readFile, readdir, rename, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

import { ensureDir, removePath, statIfExists } from "../platform/file.ts"
import { getPaths, type ResolvedPaths } from "../platform/path.ts"
import {
    hasPluginDependencies,
    installPluginDependencies,
    packageManagerLabel,
    type PluginDependencyInstallResult,
    type PluginPackageJsonLike,
} from "./package-manager.ts"
import {
    manifestLocalName,
    readPluginManifest,
    writePluginSource,
    type PluginManifest,
    type PluginSource,
} from "./manifest.ts"
import { PLUGIN_NAME, listPluginDirs, pluginDirOf, pluginsRoot } from "./paths.ts"
import { setPluginEnabled } from "./state.ts"
import { extractTgz } from "./tgz.ts"
import { extractZip } from "./zip.ts"

const ENTRIES = ["index.ts", "index.js", "index.mjs", "index.mts"]

/** install = 新装；update = 必须已装同名插件，覆盖它 */
export type PluginInstallMode = "install" | "update"

export interface InstallPluginOptions {
    readonly force?: boolean
    /** 默认 install */
    readonly mode?: PluginInstallMode
    /** 解析出本地名后、写入磁盘前调用；返回非空字符串表示拒绝安装 */
    readonly validateId?: (id: string) => string | null
    /** 测试注入；默认使用真实包管理器安装依赖 */
    readonly runInstall?: typeof import("./package-manager.ts").runPackageInstall
    /** 安装来源，装完写进已装插件的 package.json（供 update --type file 用） */
    readonly source?: PluginSource
    /** update 时要求的本地名：包里的本地名与它不一致就拒绝，避免更新到另一个插件 */
    readonly expectedLocalName?: string
}

export interface InstallPluginResult {
    /** 本地名，与目录名、插件 id 一致 */
    readonly id: string
    /** 包名（npm 身份，可能带 scope）；没有 package.json 时为 null */
    readonly packageName: string | null
    readonly target: string
    /** 实际使用的包管理器（带声明版本，例如 npm@11.20.0）；没有安装依赖时为 null */
    readonly packageManager: string | null
    readonly dependenciesInstalled: boolean
}

async function hasEntry(dir: string, pkg: PluginManifest | null): Promise<boolean> {
    for (const entry of ENTRIES) {
        if ((await statIfExists(join(dir, entry))) !== null) {
            return true
        }
    }
    const candidates: string[] = []
    const manifestEntry = pkg?.wellspring?.entry
    if (typeof manifestEntry === "string") {
        candidates.push(manifestEntry)
    }
    if (typeof pkg?.main === "string") {
        candidates.push(pkg.main)
    }
    for (const candidate of candidates) {
        if ((await statIfExists(resolve(dir, candidate))) !== null) {
            return true
        }
    }
    return false
}

/** 压缩包常见形态是外面套一层目录；没有根入口时向下找唯一子目录 */
async function normalizeExtracted(root: string): Promise<string> {
    if (await hasEntry(root, await readPluginManifest(root))) {
        return root
    }
    const entries = await readdir(root, { withFileTypes: true })
    const dirs = entries.filter((entry) => entry.isDirectory())
    if (dirs.length === 1) {
        const child = join(root, dirs[0]?.name ?? "")
        if (await hasEntry(child, await readPluginManifest(child))) {
            return child
        }
    }
    throw new Error("zip 中找不到插件入口（index.ts/js/mjs/mts 或 package.json main）")
}

/** 复制插件目录到暂存区；node_modules 不复制，交给包管理器装 */
async function copyToStage(source: string, stage: string): Promise<void> {
    await cp(source, stage, {
        recursive: true,
        force: true,
        filter: (path) => basename(path) !== "node_modules",
    })
}

/** gzip 魔数：1f 8b */
function isGzip(buffer: Buffer): boolean {
    return buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

/** 找同名的旧布局目录（plugins/@scope/<本地名>），1.7 之前装的插件在这里 */
async function findLegacyDir(
    root: string,
    localName: string,
): Promise<{ readonly id: string; readonly dir: string } | null> {
    for (const entry of await listPluginDirs(root)) {
        if (entry.legacy && entry.dirName === localName) {
            return { id: entry.id, dir: entry.dir }
        }
    }
    return null
}

/** 安装本地插件目录或 zip / tgz 包 */
export async function installPlugin(
    sourcePath: string,
    paths: ResolvedPaths = getPaths(),
    options: InstallPluginOptions = {},
): Promise<InstallPluginResult> {
    const source = resolve(sourcePath)
    const info = await stat(source)
    const root = pluginsRoot(paths)
    await ensureDir(root)

    const temp = join(root, `.install-${process.pid}-${Date.now().toString(36)}`)
    let sourceDir: string
    let fromArchive = false

    if (info.isDirectory()) {
        sourceDir = source
    } else {
        const buffer = await readFile(source)
        await removePath(temp)
        await ensureDir(temp)
        // 按文件头判断格式：npm tarball 常被存成无扩展名的临时文件
        if (isGzip(buffer)) {
            await extractTgz(buffer, temp)
        } else {
            await extractZip(buffer, temp)
        }
        sourceDir = await normalizeExtracted(temp)
        fromArchive = true
    }

    let stage: string | null = null
    let moved = false
    try {
        const pkg = await readPluginManifest(sourceDir)
        if (!(await hasEntry(sourceDir, pkg))) {
            throw new Error("插件缺少入口（index.ts/js/mjs/mts 或 package.json main）")
        }
        const packageName =
            typeof pkg?.name === "string" && pkg.name.trim() !== "" ? pkg.name.trim() : null
        const declared = manifestLocalName(pkg)
        if (declared === null || !PLUGIN_NAME.test(declared)) {
            throw new Error(
                "插件清单缺少合法的本地名：请在 package.json 的 wellspring.name 里声明" +
                    "（字母数字开头，允许 . _ -），或使用合法的 package.json name",
            )
        }
        if (options.expectedLocalName !== undefined && options.expectedLocalName !== declared) {
            throw new Error(
                `包里的本地名是 ${declared}，与要更新的 ${options.expectedLocalName} 不一致`,
            )
        }
        const rejected = options.validateId?.(declared) ?? null
        if (rejected !== null) {
            throw new Error(rejected)
        }

        const target = pluginDirOf(root, declared)
        if (target === null) {
            throw new Error(`插件本地名不合法：${declared}`)
        }
        /*
         * 存在性用 lstat：悬空符号链接的 stat 是 ENOENT，update 会误判成没装。
         * update 还要找旧布局（plugins/@scope/<本地名>），找到就顺手迁到单层布局。
         */
        let existing = await lstat(target).catch(() => null)
        let legacy: { readonly id: string; readonly dir: string } | null = null
        if (existing === null && options.mode === "update") {
            legacy = await findLegacyDir(root, declared)
            existing = legacy === null ? null : await lstat(legacy.dir).catch(() => null)
        }
        if (options.mode === "update") {
            if (existing === null) {
                throw new Error(`插件未安装：${declared}`)
            }
            if (existing.isSymbolicLink()) {
                throw new Error(
                    `${declared} 是 link 进来的开发插件，update 不覆盖符号链接；转为安装版需先 plugin remove ${declared}`,
                )
            }
        } else if (existing !== null && options.force !== true) {
            const installed = await readPluginManifest(legacy?.dir ?? target)
            const detail =
                typeof installed?.name === "string" && installed.name !== ""
                    ? installed.name
                    : "未知来源"
            throw new Error(
                `插件已存在：${declared}（已装的是 ${detail}）；覆盖请加 --force，或先 plugin remove ${declared}`,
            )
        }

        /* 清单一律按 PluginManifest 读，这里只取包管理器关心的 dependencies */
        const dependencyManifest = pkg as unknown as PluginPackageJsonLike
        const needsInstall = pkg !== null && hasPluginDependencies(dependencyManifest)

        let installDir = sourceDir
        if (needsInstall && !fromArchive) {
            /*
             * 目录安装不能碰源目录：复制到暂存区后再安装依赖，
             * node_modules 不复制，避免把开发目录里的依赖带进去。
             */
            stage = join(root, `.install-stage-${process.pid}-${Date.now().toString(36)}`)
            await removePath(stage)
            await copyToStage(sourceDir, stage)
            installDir = stage
        }

        let dependencies: PluginDependencyInstallResult = {
            manager: null,
            installed: false,
            reason: null,
        }
        if (needsInstall) {
            dependencies = await installPluginDependencies(installDir, dependencyManifest, {
                ...(options.runInstall === undefined ? {} : { run: options.runInstall }),
            })
        }

        if (existing !== null) {
            await removePath(legacy?.dir ?? target)
        }
        if (fromArchive) {
            // 与临时目录同根，rename 保持原子
            await rename(sourceDir, target)
        } else if (stage !== null) {
            await rename(stage, target)
            moved = true
        } else {
            await cp(sourceDir, target, { recursive: true, force: true })
        }

        if (legacy !== null) {
            /* 旧布局的身份跟着退休，否则禁用状态会挂在旧 id 上 */
            await setPluginEnabled(legacy.id, true, paths)
        }
        if (options.source !== undefined) {
            await writePluginSource(target, options.source)
        }

        return {
            id: declared,
            packageName,
            target,
            packageManager:
                dependencies.manager === null ? null : packageManagerLabel(dependencies.manager),
            dependenciesInstalled: dependencies.installed,
        }
    } finally {
        if (fromArchive) {
            await removePath(temp)
        }
        if (stage !== null && !moved) {
            await removePath(stage)
        }
    }
}
