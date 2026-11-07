// HostFileApi 实现：根目录内的相对路径访问

import { readdir } from "node:fs/promises"
import { isAbsolute, resolve, sep } from "node:path"

import type { HostFileApi, HostFileEntry, HostFileStat, HostFileType } from "../api/host/fs.ts"
import {
    ensureDir,
    readBytesIfExists,
    readJsonIfExists,
    readTextIfExists,
    removePath,
    statIfExists,
    writeBytesAtomic,
    writeJsonAtomic,
    writeTextAtomic,
} from "../platform/file.ts"

function safePath(root: string, relative: string): string {
    if (typeof relative !== "string" || relative.includes("\0")) {
        throw new Error("文件路径不合法")
    }
    if (isAbsolute(relative)) {
        throw new Error(`不允许绝对路径：${relative}`)
    }
    const target = resolve(root, relative)
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
        throw new Error(`路径越界：${relative}`)
    }
    return target
}

function fileTypeOf(isFile: boolean, isDirectory: boolean): HostFileType {
    if (isFile) {
        return "file"
    }
    if (isDirectory) {
        return "directory"
    }
    return "other"
}

/** 为某个根目录创建 HostFileApi；目录不存在时首次写入自动创建 */
export function createPluginFileApi(root: string): HostFileApi {
    const base = resolve(root)

    const api: HostFileApi = {
        root: base,
        async readText(path) {
            return await readTextIfExists(safePath(base, path))
        },
        async readBytes(path) {
            const bytes = await readBytesIfExists(safePath(base, path))
            return bytes === null ? null : new Uint8Array(bytes)
        },
        async readJson<T = unknown>(path: string) {
            return await readJsonIfExists<T>(safePath(base, path))
        },
        async writeText(path, text) {
            await writeTextAtomic(safePath(base, path), text)
        },
        async writeBytes(path, bytes) {
            await writeBytesAtomic(safePath(base, path), bytes)
        },
        async writeJson(path, value) {
            await writeJsonAtomic(safePath(base, path), value)
        },
        async list(path = "") {
            const dir = safePath(base, path)
            const entries = await readdir(dir, { withFileTypes: true })
            const result: HostFileEntry[] = []
            for (const entry of entries) {
                const info = await statIfExists(resolve(dir, entry.name))
                result.push({
                    name: entry.name,
                    type: fileTypeOf(entry.isFile(), entry.isDirectory()),
                    size: info?.size ?? 0,
                    mtimeMs: info?.mtimeMs ?? 0,
                })
            }
            result.sort((left, right) => left.name.localeCompare(right.name))
            return result
        },
        async stat(path) {
            const info = await statIfExists(safePath(base, path))
            if (info === null) {
                return null
            }
            const stat: HostFileStat = {
                type: fileTypeOf(info.isFile(), info.isDirectory()),
                size: info.size,
                mtimeMs: info.mtimeMs,
            }
            return stat
        },
        async mkdir(path) {
            await ensureDir(safePath(base, path))
        },
        async remove(path) {
            await removePath(safePath(base, path))
        },
        async exists(path) {
            return (await statIfExists(safePath(base, path))) !== null
        },
    }
    return api
}
