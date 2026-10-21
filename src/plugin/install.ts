/*
 * 本地插件安装：目录或 zip 包。
 * zip 在插件根目录下的临时目录解压，校验后再搬到 plugins/<name>。
 */

import { cp, readFile, readdir, rename, stat } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"

import { ensureDir, readJsonIfExists, removePath, statIfExists } from "../platform/file.ts"
import { getPaths, type ResolvedPaths } from "../platform/path.ts"
import { PLUGIN_NAME, pluginsRoot } from "./paths.ts"
import { extractZip } from "./zip.ts"

const ENTRIES = ["index.ts", "index.js", "index.mjs", "index.mts"]

export interface InstallPluginOptions {
    readonly force?: boolean
}

export interface InstallPluginResult {
    readonly id: string
    readonly target: string
}

interface PackageManifest {
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

    try {
        if (!(await hasEntry(sourceDir))) {
            throw new Error("插件缺少入口（index.ts/js/mjs/mts 或 package.json main）")
        }
        const name = await resolveSourceName(source, sourceDir, fromArchive)
        if (!PLUGIN_NAME.test(name)) {
            throw new Error(`插件名不合法：${name}`)
        }

        const target = join(root, name)
        const existing = await statIfExists(target)
        if (existing !== null) {
            if (options.force !== true) {
                throw new Error(`插件已存在：${name}`)
            }
            await removePath(target)
        }

        if (fromArchive) {
            // 与临时目录同根，rename 保持原子
            await rename(sourceDir, target)
        } else {
            await cp(sourceDir, target, { recursive: true, force: true })
        }
        return { id: name, target }
    } finally {
        if (fromArchive) {
            await removePath(temp)
        }
    }
}
