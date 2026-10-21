/*
 * 最小 ZIP 读取器，只服务本地插件安装。
 * 支持 store/deflate 两种压缩方式，拒绝加密、ZIP64、符号链接与路径穿越。
 */

import { inflateRawSync } from "node:zlib"

import { ensureDir, writeBytesAtomic } from "../platform/file.ts"
import { dirname, resolve, sep } from "node:path"

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_ENTRIES = 10_000
const MAX_ENTRY_BYTES = 100 * 1024 * 1024
const MAX_TOTAL_BYTES = 200 * 1024 * 1024

export interface ZipEntry {
    readonly name: string
    readonly data: Buffer
}

function fail(message: string): never {
    throw new Error(`zip 包非法：${message}`)
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

function findEocd(buffer: Buffer): number {
    const minimum = Math.max(0, buffer.length - 65_557)
    for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
        if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
            return offset
        }
    }
    return fail("找不到中央目录")
}

export function readZip(buffer: Buffer): ZipEntry[] {
    if (buffer.length < 22) {
        fail("文件过短")
    }
    const eocd = findEocd(buffer)
    const entries = buffer.readUInt16LE(eocd + 10)
    const centralOffset = buffer.readUInt32LE(eocd + 16)
    if (entries > MAX_ENTRIES) {
        fail("文件条目过多")
    }
    if (centralOffset === 0xffffffff) {
        fail("不支持 ZIP64")
    }

    const result: ZipEntry[] = []
    let total = 0
    let offset = centralOffset

    for (let index = 0; index < entries; index += 1) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
            fail("中央目录损坏")
        }
        const flags = buffer.readUInt16LE(offset + 8)
        const method = buffer.readUInt16LE(offset + 10)
        const compressedSize = buffer.readUInt32LE(offset + 20)
        const uncompressedSize = buffer.readUInt32LE(offset + 24)
        const nameLength = buffer.readUInt16LE(offset + 28)
        const extraLength = buffer.readUInt16LE(offset + 30)
        const commentLength = buffer.readUInt16LE(offset + 32)
        const externalAttributes = buffer.readUInt32LE(offset + 38)
        const localOffset = buffer.readUInt32LE(offset + 42)
        const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8")
        offset += 46 + nameLength + extraLength + commentLength

        validateName(name)
        if ((flags & 0x1) !== 0) {
            fail(`不支持加密条目：${name}`)
        }
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
            fail("不支持 ZIP64 条目")
        }
        if (uncompressedSize > MAX_ENTRY_BYTES) {
            fail(`单文件过大：${name}`)
        }
        total += uncompressedSize
        if (total > MAX_TOTAL_BYTES) {
            fail("解压后总大小超限")
        }

        if (name.endsWith("/")) {
            result.push({ name, data: Buffer.alloc(0) })
            continue
        }
        if (((externalAttributes >>> 16) & 0o170000) === 0o120000) {
            fail(`不支持符号链接：${name}`)
        }
        if (
            localOffset + 30 > buffer.length ||
            buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE
        ) {
            fail(`本地文件头损坏：${name}`)
        }
        const localNameLength = buffer.readUInt16LE(localOffset + 26)
        const localExtraLength = buffer.readUInt16LE(localOffset + 28)
        const dataStart = localOffset + 30 + localNameLength + localExtraLength
        const end = dataStart + compressedSize
        if (end > buffer.length) {
            fail(`数据越界：${name}`)
        }
        const compressed = buffer.subarray(dataStart, end)

        let data: Buffer
        if (method === 0) {
            data = Buffer.from(compressed)
        } else if (method === 8) {
            try {
                data = inflateRawSync(compressed)
            } catch (error) {
                fail(
                    `解压失败：${name}（${error instanceof Error ? error.message : String(error)}）`,
                )
            }
        } else {
            fail(`不支持的压缩方式 ${method}：${name}`)
        }
        if (data.length !== uncompressedSize) {
            fail(`解压大小不符：${name}`)
        }
        result.push({ name, data })
    }
    return result
}

/** 解压到目标目录；调用方负责临时目录与清理 */
export async function extractZip(buffer: Buffer, destination: string): Promise<void> {
    const root = resolve(destination)
    for (const entry of readZip(buffer)) {
        const target = resolve(root, entry.name)
        if (target !== root && !target.startsWith(`${root}${sep}`)) {
            fail(`路径穿越：${entry.name}`)
        }
        if (entry.name.endsWith("/")) {
            await ensureDir(target)
            continue
        }
        await ensureDir(dirname(target))
        await writeBytesAtomic(target, entry.data)
    }
}
