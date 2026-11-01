/*
 * 本地插件安装与更新：目录或 zip 包。
 * zip 在插件根目录下的临时目录解压，校验后再搬到 plugins/<name>。
 *
 * 插件 package.json 可以用 packageManager 声明包管理器；声明了 dependencies 时
 * 安装阶段会调用它自动安装依赖（没有声明则按 lockfile 推断，仍没有则报错）。
 */

import { cp, lstat, readFile, readdir, rename, stat } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"

import { ensureDir, readJsonIfExists, removePath, statIfExists } from "../platform/file.ts"
import { getPaths, type ResolvedPaths } from "../platform/path.ts"
import {
    hasPluginDependencies,
    installPluginDependencies,
    packageManagerLabel,
    type PluginDependencyInstallResult,
    type PluginPackageJsonLike,
} from "./package-manager.ts"
import { PLUGIN_NAME, pluginsRoot } from "./paths.ts"
import { extractZip } from "./zip.ts"

const ENTRIES = ["index.ts", "index.js", "index.mjs", "index.mts"]

/** install = 新装；update = 必须已装同名插件，覆盖它 */
export type PluginInstallMode = "install" | "update"

export interface InstallPluginOptions {
    readonly force?: boolean
    /** 默认 install */
    readonly mode?: PluginInstallMode
    /** 解析出插件名后、写入磁盘前调用；返回非空字符串表示拒绝安装 */
    readonly validateId?: (id: string) => string | null
    /** 测试注入；默认使用真实包管理器安装依赖 */
    readonly runInstall?: typeof import("./package-manager.ts").runPackageInstall
}

export interface InstallPluginResult {
    readonly id: string
    readonly target: string
    /** 实际使用的包管理器（带声明版本，例如 npm@11.20.0）；没有安装依赖时为 null */
    readonly packageManager: string | null
    readonly dependenciesInstalled: boolean
}

interface PackageManifest extends PluginPackageJsonLike {
    readonly name?: unknown
    readonly main?: unknown
    readonly wellspring?: {
        readonly entry?: unknown
    }
}

async function hasEntry(dir: string): Promise<boolean> {
    for (const entry of ENTRIES) {
        if ((await statIfExists(join(dir, entry))) !== null) {
            return true
        }
    }
    const pkg = await readJsonIfExists<PackageManifest>(join(dir, "package.json"))
    if (pkg === null) {
        return false
    }
    const candidates: string[] = []
    if (typeof pkg.wellspring?.entry === "string") {
        candidates.push(pkg.wellspring.entry)
    }
    if (typeof pkg.main === "string") {
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
    if (await hasEntry(root)) {
        return root
    }
    const entries = await readdir(root, { withFileTypes: true })
    const dirs = entries.filter((entry) => entry.isDirectory())
    if (dirs.length === 1) {
        const child = join(root, dirs[0]?.name ?? "")
        if (await hasEntry(child)) {
            return child
        }
    }
    throw new Error("zip 中找不到插件入口（index.ts/js/mjs/mts 或 package.json main）")
}

async function resolveSourceName(
    source: string,
    sourceDir: string,
    temp: boolean,
): Promise<string> {
    const pkg = await readJsonIfExists<PackageManifest>(join(sourceDir, "package.json"))
    if (typeof pkg?.name === "string" && pkg.name.trim() !== "") {
        return pkg.name.trim()
    }
    const candidate = basename(source, extname(source))
    return temp ? candidate : basename(sourceDir)
}

/** 复制插件目录到暂存区；node_modules 不复制，交给包管理器装 */
async function copyToStage(source: string, stage: string): Promise<void> {
    await cp(source, stage, {
        recursive: true,
        force: true,
        filter: (path) => basename(path) !== "node_modules",
    })
}

/** 安装本地插件目录或 zip 包 */
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
        await extractZip(buffer, temp)
        sourceDir = await normalizeExtracted(temp)
        fromArchive = true
    }

    let stage: string | null = null
    let moved = false
    try {
        if (!(await hasEntry(sourceDir))) {
            throw new Error("插件缺少入口（index.ts/js/mjs/mts 或 package.json main）")
        }
        const name = await resolveSourceName(source, sourceDir, fromArchive)
        if (!PLUGIN_NAME.test(name)) {
            throw new Error(`插件名不合法：${name}`)
        }
        const rejected = options.validateId?.(name) ?? null
        if (rejected !== null) {
            throw new Error(rejected)
        }

        const target = join(root, name)
        /* 存在性用 lstat：悬空符号链接的 stat 是 ENOENT，update 会误判成没装 */
        const existing = await lstat(target).catch(() => null)
        if (options.mode === "update") {
            if (existing === null) {
                throw new Error(`插件未安装：${name}`)
            }
            if (existing.isSymbolicLink()) {
                throw new Error(
                    `${name} 是 link 进来的开发插件，update 不覆盖符号链接；转为安装版需先 plugin remove ${name}`,
                )
            }
        } else if (existing !== null && options.force !== true) {
            throw new Error(`插件已存在：${name}`)
        }

        const pkg = await readJsonIfExists<PackageManifest>(join(sourceDir, "package.json"))
        const needsInstall = pkg !== null && hasPluginDependencies(pkg)

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
            dependencies = await installPluginDependencies(installDir, pkg, {
                ...(options.runInstall === undefined ? {} : { run: options.runInstall }),
            })
        }

        if (existing !== null) {
            await removePath(target)
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
        return {
            id: name,
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
