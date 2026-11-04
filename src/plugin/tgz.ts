/*
 * 最小 tar.gz 读取器，只服务本地插件安装。
 * 支持 ustar 与 pax 长路径头，拒绝符号链接、硬链接与路径穿越。
 */

import { dirname, resolve, sep } from "node:path"
import { gunzipSync } from "node:zlib"

import { ensureDir, writeBytesAtomic } from "../platform/file.ts"

const BLOCK = 512
const MAX_ENTRIES = 10_000
const MAX_ENTRY_BYTES = 100 * 1024 * 1024
const MAX_TOTAL_BYTES = 200 * 1024 * 1024
/** tar 类型标志 */
const TYPE_FILE = 0x30
const TYPE_FILE_LEGACY = 0x00
const TYPE_DIRECTORY = 0x35
const TYPE_PAX = 0x78
const TYPE_PAX_GLOBAL = 0x67

const PAX_PATH = "path="

export interface TgzEntry {
    readonly name: string
    readonly data: Buffer
}

function fail(message: string): never {
    throw new Error(`tar.gz 包非法：${message}`)
}

function validateName(name: string): void {
    if (name === "" || name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name)) {
        fail(`非法路径：${name}`)
    }
    for (const segment of name.split("/")) {
        if (segment === ".." || segment === ".") {
            fail(`非法路径：${name}`)
        }
    }
}

/** 八进制字段，允许前导空格与 NUL */
function readOctal(header: Buffer, offset: number, length: number): number {
    const text = header
        .subarray(offset, offset + length)
        .toString("utf8")
        .replace(/\0.*$/, "")
        .trim()
    if (text === "") return 0
    if (!/^[0-7]+$/.test(text)) {
        fail(`无法解析的数字字段：${text}`)
    }
    return parseInt(text, 8)
}

function readString(header: Buffer, offset: number, length: number): string {
    return header
        .subarray(offset, offset + length)
        .toString("utf8")
        .replace(/\0.*$/, "")
}

/** pax 扩展头：以「长度 key=value\n」逐行记录，只关心 path */
function parsePaxPath(data: Buffer): string | null {
    let cursor = 0
    const text = data.toString("utf8")
    while (cursor < text.length) {
        const space = text.indexOf(" ", cursor)
        if (space < 0) break
        const length = Number(text.slice(cursor, space))
        if (!Number.isFinite(length) || length <= 0) break
        const record = text.slice(space + 1, cursor + length - 1)
        cursor += length
        if (record.startsWith(PAX_PATH)) {
            // 记录本身以换行结尾，值里不含它
            return record.slice(PAX_PATH.length).replace(/\n$/, "")
        }
    }
    return null
}

/** 解压 tar 流，返回普通文件条目 */
export function readTgz(buffer: Buffer): TgzEntry[] {
    let tar: Buffer
    try {
        tar = gunzipSync(buffer, { maxOutputLength: MAX_TOTAL_BYTES })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return fail(`解压失败：${message}`)
    }
    const entries: TgzEntry[] = []
    let total = 0
    let offset = 0
    /** 上一个 pax 头给出的路径，作用于紧随其后的条目 */
    let pendingPath: string | null = null

    while (offset + BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK)
        // 全零块表示归档结束，其后允许补零
        if (header.every((byte) => byte === 0)) {
            break
        }
        if (entries.length >= MAX_ENTRIES) {
            fail("文件条目过多")
        }

        const size = readOctal(header, 124, 12)
        const type = header[156] ?? TYPE_FILE_LEGACY
        const dataStart = offset + BLOCK
        const dataEnd = dataStart + size
        if (dataEnd > tar.length) {
            fail("条目越界")
        }
        const data = tar.subarray(dataStart, dataEnd)
        offset = dataStart + Math.ceil(size / BLOCK) * BLOCK

        if (type === TYPE_PAX || type === TYPE_PAX_GLOBAL) {
            if (size > MAX_ENTRY_BYTES) {
                fail("扩展头过大")
            }
            pendingPath = parsePaxPath(data) ?? pendingPath
            continue
        }
        if (type !== TYPE_FILE && type !== TYPE_FILE_LEGACY) {
            // 目录跳过；符号链接与设备文件拒绝
            if (type === TYPE_DIRECTORY) {
                pendingPath = null
                continue
            }
            return fail(`不支持的条目类型：${String.fromCharCode(type)}`)
        }

        const baseName = readString(header, 0, 100)
        const prefix = readString(header, 345, 155)
        const name = pendingPath ?? (prefix === "" ? baseName : `${prefix}/${baseName}`)
        pendingPath = null
        validateName(name)

        if (size > MAX_ENTRY_BYTES) {
            fail(`条目过大：${name}`)
        }
        total += size
        if (total > MAX_TOTAL_BYTES) {
            fail("解压后总量超限")
        }
        entries.push({ name, data: Buffer.from(data) })
    }

    if (entries.length === 0) {
        fail("没有文件条目")
    }
    return entries
}

/** 解压到目标目录，已存在同名文件时覆盖 */
export async function extractTgz(buffer: Buffer, destination: string): Promise<void> {
    const root = resolve(destination)
    for (const entry of readTgz(buffer)) {
        const target = resolve(root, entry.name)
        if (target !== root && !target.startsWith(root + sep)) {
            fail(`路径越界：${entry.name}`)
        }
        await ensureDir(dirname(target))
        await writeBytesAtomic(target, entry.data)
    }
}
