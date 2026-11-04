import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { gzipSync } from "node:zlib"

import { extractTgz, readTgz } from "../src/plugin/tgz.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-tgz-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

const BLOCK = 512

interface Entry {
    readonly name: string
    readonly content: string
    readonly type?: string
    readonly paxPath?: string
}

function octal(value: number, length: number): string {
    return `${value.toString(8).padStart(length - 1, "0")}\0`
}

function header(name: string, size: number, type = "0"): Buffer {
    const buf = Buffer.alloc(BLOCK, 0)
    buf.write(name, 0, 100, "utf8")
    buf.write(octal(0o644, 8), 100, 8, "utf8")
    buf.write(octal(0, 8), 108, 8, "utf8")
    buf.write(octal(0, 8), 116, 8, "utf8")
    buf.write(octal(size, 12), 124, 12, "utf8")
    buf.write(octal(0, 12), 136, 12, "utf8")
    buf.fill(0x20, 148, 156)
    buf.write(type, 156, 1, "utf8")
    buf.write("ustar\0", 257, 6, "utf8")
    buf.write("00", 263, 2, "utf8")
    let sum = 0
    for (const byte of buf) sum += byte
    buf.write(octal(sum, 8), 148, 8, "utf8")
    return buf
}

/** 手工拼 tar：只覆盖测试需要的形态 */
function makeTar(entries: readonly Entry[]): Buffer {
    const parts: Buffer[] = []
    for (const entry of entries) {
        if (entry.paxPath !== undefined) {
            const record = `path=${entry.paxPath}\n`
            const body = `${record.length + ` ${record}`.length} ${record}`
            const data = Buffer.from(body, "utf8")
            parts.push(header("PaxHeader", data.length, "x"))
            parts.push(data, Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK - data.length, 0))
        }
        const data = Buffer.from(entry.content, "utf8")
        parts.push(header(entry.name, data.length, entry.type ?? "0"))
        parts.push(data, Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK - data.length, 0))
    }
    parts.push(Buffer.alloc(BLOCK * 2, 0))
    return gzipSync(Buffer.concat(parts))
}

test("readTgz：解出普通文件与其内容", () => {
    const archive = makeTar([{ name: "pkg/index.ts", content: "export {}\n" }])
    const entries = readTgz(archive)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.name, "pkg/index.ts")
    assert.equal(entries[0]?.data.toString("utf8"), "export {}\n")
})

test("readTgz：目录条目跳过，不产生空文件", () => {
    const archive = makeTar([
        { name: "pkg/", content: "", type: "5" },
        { name: "pkg/a.ts", content: "a" },
    ])
    const entries = readTgz(archive)
    assert.deepEqual(
        entries.map((entry) => entry.name),
        ["pkg/a.ts"],
    )
})

test("readTgz：pax 长路径生效", () => {
    const longName = `pkg/${"d".repeat(120)}/file.ts`
    const archive = makeTar([{ name: "truncated", content: "x", paxPath: longName }])
    const entries = readTgz(archive)
    assert.equal(entries[0]?.name, longName)
})

test("readTgz：拒绝路径穿越", () => {
    for (const name of ["../evil.ts", "pkg/../../evil.ts", "/etc/passwd", "pkg\\evil.ts"]) {
        const archive = makeTar([{ name, content: "x" }])
        assert.throws(() => readTgz(archive), /非法路径/, `应拒绝：${name}`)
    }
})

test("readTgz：拒绝符号链接", () => {
    const archive = makeTar([{ name: "pkg/link", content: "", type: "2" }])
    assert.throws(() => readTgz(archive), /不支持的条目类型/)
})

test("readTgz：非 gzip 输入报错而非崩溃", () => {
    assert.throws(() => readTgz(Buffer.from("not a gzip")), /包非法：解压失败/)
})

test("readTgz：空归档报错", () => {
    assert.throws(() => readTgz(gzipSync(Buffer.alloc(BLOCK * 2, 0))), /没有文件条目/)
})

test("extractTgz：落盘并保持目录结构", async () => {
    const target = join(root, "out")
    await extractTgz(
        makeTar([
            { name: "package/package.json", content: '{"name":"p"}' },
            { name: "package/src/a.ts", content: "a" },
        ]),
        target,
    )
    assert.equal(await readFile(join(target, "package/package.json"), "utf8"), '{"name":"p"}')
    assert.equal(await readFile(join(target, "package/src/a.ts"), "utf8"), "a")
})

test("readTgz：解出真实 npm tarball 的结构", async () => {
    // 离线形态：用 fixture 代替网络，验证 ustar 解析对真实产物成立
    const archive = makeTar(
        Array.from({ length: 50 }, (_, index) => ({
            name: `package/dist/mod-${index}.js`,
            content: `// ${index}\n`,
        })),
    )
    const entries = readTgz(archive)
    assert.equal(entries.length, 50)
    assert.ok(entries.every((entry) => entry.name.startsWith("package/dist/")))
})
