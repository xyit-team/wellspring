/*
 * 文件落盘
 *
 * 流程：临时文件 -> fsync -> rename -> chmod -> fsync 目录
 * Windows 不执行 chmod 与目录 fsync；rename 遇文件占用时短暂重试
 */

import { randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, type Stats } from "node:fs"
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { isWindows } from "./os.ts"
import type { PathRoots } from "./path.ts"

const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** 是否为文件不存在（ENOENT） */
export function isNotFound(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ENOENT"
    )
}

/** 创建目录，默认权限 0700 */
export async function ensureDir(dir: string, mode = DIR_MODE): Promise<void> {
    await mkdir(dir, { recursive: true, mode })
}

/** 同步验证文件可写；创建父目录并打开目标，失败时抛出，供需要提前确认的调用方使用 */
export function assertWritableFile(file: string, mode = FILE_MODE): void {
    mkdirSync(dirname(file), { recursive: true, mode: DIR_MODE })
    const fd = openSync(file, "a", mode)
    closeSync(fd)
}

/** 读取文本文件，不存在时返回 null */
export async function readTextIfExists(file: string): Promise<string | null> {
    try {
        return await readFile(file, "utf8")
    } catch (error) {
        if (isNotFound(error)) {
            return null
        }
        throw error
    }
}

/** 读取二进制文件，不存在时返回 null */
export async function readBytesIfExists(file: string): Promise<Buffer | null> {
    try {
        return await readFile(file)
    } catch (error) {
        if (isNotFound(error)) {
            return null
        }
        throw error
    }
}

/** stat，文件不存在时返回 null */
export async function statIfExists(file: string): Promise<Stats | null> {
    try {
        return await stat(file)
    } catch (error) {
        if (isNotFound(error)) {
            return null
        }
        throw error
    }
}

// 删除时短暂冲突的错误码；Windows 进程退出与句柄释放不同步
const TRANSIENT_REMOVE_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"])

/*
 * 删除文件或目录，不存在时忽略
 *
 * Windows 上目录被进程当作 cwd 或仍有句柄未释放时，rm 返回 EBUSY / EPERM
 * 进程退出瞬间句柄释放有延迟，按 50ms 起指数退避重试，上限 6 次
 * 重试用尽后抛出原始错误
 */
export async function removePath(file: string): Promise<void> {
    let wait = 50
    for (let attempt = 1; ; attempt += 1) {
        try {
            await rm(file, { recursive: true, force: true })
            return
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code ?? ""
            if (attempt >= 6 || !TRANSIENT_REMOVE_CODES.has(code)) {
                throw error
            }
            await sleep(wait)
            wait = Math.min(wait * 2, 800)
        }
    }
}

/** 读取 JSON 文件，不存在时返回 null；解析失败向上抛出 */
export async function readJsonIfExists<T>(file: string): Promise<T | null> {
    const text = await readTextIfExists(file)
    return text === null ? null : (JSON.parse(text) as T)
}

export interface WriteFileOptions {
    /** 文件权限，默认 0600 */
    readonly mode?: number
}

/*
 * 原子写
 *
 * 临时文件必须与目标文件同目录；跨分区 rename 不具备原子性
 */
export async function writeTextAtomic(
    file: string,
    text: string,
    options: WriteFileOptions = {},
): Promise<void> {
    await writeBytesAtomic(file, Buffer.from(text, "utf8"), options)
}

/** 原子写二进制（会话的 zstd 段用） */
export async function writeBytesAtomic(
    file: string,
    data: Uint8Array,
    options: WriteFileOptions = {},
): Promise<void> {
    const dir = dirname(file)
    const mode = options.mode ?? FILE_MODE
    await ensureDir(dir)

    const tmp = join(dir, `.${basename(file)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
    const handle = await open(tmp, "w", mode)
    try {
        await handle.writeFile(data)
        // 数据先 fsync
        await handle.sync()
    } catch (error) {
        await handle.close().catch(() => undefined)
        await unlink(tmp).catch(() => undefined)
        throw error
    }
    await handle.close()

    try {
        await renameWithRetry(tmp, file)
    } catch (error) {
        await unlink(tmp).catch(() => undefined)
        throw error
    }

    if (!isWindows) {
        // 部分文件系统 rename 后权限跟随临时文件，这里显式重设
        await chmodQuiet(file, mode)
    }
    await syncDir(dir)
}

/** 原子写 JSON，固定 4 空格缩进并保留末尾换行 */
export async function writeJsonAtomic(
    file: string,
    value: unknown,
    options: WriteFileOptions & { readonly indent?: number } = {},
): Promise<void> {
    const text = `${JSON.stringify(value, null, options.indent ?? 4)}\n`
    await writeTextAtomic(file, text, options)
}

/** 将损坏文件移到一边，返回移动后的位置 */
export async function moveAside(file: string, suffix: string): Promise<string> {
    const target = `${file}.${suffix}`
    await rename(file, target)
    return target
}

/** 备份与损坏文件用的时间戳，形如 20260919-013045 */
export function timeStamp(date = new Date()): string {
    const pad = (n: number): string => String(n).padStart(2, "0")
    return (
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    )
}

/** 创建四个根目录；POSIX 下将已存在目录权限收紧至 0700 */
export async function ensureDirs(roots: PathRoots, mode = DIR_MODE): Promise<void> {
    for (const dir of [roots.configDir, roots.dataDir, roots.cacheDir, roots.logDir]) {
        await ensureDir(dir, mode)
        if (isWindows) {
            continue
        }
        const info = await stat(dir)
        if ((info.mode & 0o777) !== mode) {
            await chmodQuiet(dir, mode)
        }
    }
}

// Android 外部存储（FAT/exFAT）与部分挂载点不支持 chmod，权限收紧失败时继续
const CHMOD_IGNORED_CODES = new Set(["EPERM", "EACCES", "EINVAL", "ENOTSUP", "ENOSYS"])

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"])
const RENAME_ATTEMPTS = 3

function isRetryableRenameError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
        return false
    }
    const code = (error as { code?: unknown }).code
    return typeof code === "string" && RENAME_RETRY_CODES.has(code)
}

// Windows 上杀毒软件与索引服务短暂占用目标文件，rename 失败时重试
async function renameWithRetry(from: string, to: string): Promise<void> {
    const attempts = isWindows ? RENAME_ATTEMPTS : 1
    for (let attempt = 1; ; attempt++) {
        try {
            await rename(from, to)
            return
        } catch (error) {
            if (attempt >= attempts || !isRetryableRenameError(error)) {
                throw error
            }
            await sleep(40 * attempt)
        }
    }
}

async function chmodQuiet(file: string, mode: number): Promise<void> {
    try {
        await chmod(file, mode)
    } catch (error) {
        const code = (error as { code?: unknown }).code
        if (typeof code !== "string" || !CHMOD_IGNORED_CODES.has(code)) {
            throw error
        }
    }
}

async function syncDir(dir: string): Promise<void> {
    if (isWindows) {
        return
    }
    try {
        const handle = await open(dir, "r")
        try {
            await handle.sync()
        } finally {
            await handle.close()
        }
    } catch {
        // 目录 fsync 失败时忽略
    }
}
