/*
 * 测试用最小 zip 写入器：store 方式打包，避免引入额外依赖。
 */

const CRC_TABLE: number[] = Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    return value >>> 0
})

function crc32(data: Buffer): number {
    let crc = 0xffffffff
    for (const byte of data) {
        crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
}

export function makeZip(files: Readonly<Record<string, string>>): Buffer {
    const locals: Buffer[] = []
    const centrals: Buffer[] = []
    let offset = 0

    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content, "utf8")
        const nameBuffer = Buffer.from(name, "utf8")
        const checksum = crc32(data)

        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(0, 6)
        local.writeUInt16LE(0, 8)
        local.writeUInt16LE(0, 10)
        local.writeUInt16LE(0x21, 12)
        local.writeUInt32LE(checksum, 14)
        local.writeUInt32LE(data.length, 18)
        local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(nameBuffer.length, 26)
        local.writeUInt16LE(0, 28)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4)
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(0, 8)
        central.writeUInt16LE(0, 10)
        central.writeUInt16LE(0x21, 12)
        central.writeUInt32LE(checksum, 16)
        central.writeUInt32LE(data.length, 20)
        central.writeUInt32LE(data.length, 24)
        central.writeUInt16LE(nameBuffer.length, 28)
        central.writeUInt16LE(0, 30)
        central.writeUInt16LE(0, 32)
        central.writeUInt16LE(0, 34)
        central.writeUInt16LE(0, 36)
        central.writeUInt32LE(0, 38)
        central.writeUInt32LE(offset, 42)

        locals.push(local, nameBuffer, data)
        centrals.push(central, nameBuffer)
        offset += local.length + nameBuffer.length + data.length
    }

    const centralBuffer = Buffer.concat(centrals)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(Object.keys(files).length, 8)
    eocd.writeUInt16LE(Object.keys(files).length, 10)
    eocd.writeUInt32LE(centralBuffer.length, 12)
    eocd.writeUInt32LE(offset, 16)
    eocd.writeUInt16LE(0, 20)

    return Buffer.concat([...locals, centralBuffer, eocd])
}
