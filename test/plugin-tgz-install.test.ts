import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { gzipSync } from "node:zlib"

import type { ResolvedPaths } from "../src/platform/path.ts"
import { installPlugin } from "../src/plugin/install.ts"
import { makeZip } from "./helpers/zip.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-tgz-install-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

const BLOCK = 512

function octal(value: number, length: number): string {
    return `${value.toString(8).padStart(length - 1, "0")}\0`
}

function header(name: string, size: number): Buffer {
    const buf = Buffer.alloc(BLOCK, 0)
    buf.write(name, 0, 100, "utf8")
    buf.write(octal(0o644, 8), 100, 8, "utf8")
    buf.write(octal(0, 8), 108, 8, "utf8")
    buf.write(octal(0, 8), 116, 8, "utf8")
    buf.write(octal(size, 12), 124, 12, "utf8")
    buf.write(octal(0, 12), 136, 12, "utf8")
    buf.fill(0x20, 148, 156)
    buf.write("0", 156, 1, "utf8")
    buf.write("ustar\0", 257, 6, "utf8")
    buf.write("00", 263, 2, "utf8")
    let sum = 0
    for (const byte of buf) sum += byte
    buf.write(octal(sum, 8), 148, 8, "utf8")
    return buf
}

// npm 风格 tarball：内容在 package/ 之下
function npmTarball(files: Readonly<Record<string, string>>): Buffer {
    const parts: Buffer[] = []
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content, "utf8")
        parts.push(header(name, data.length), data)
        parts.push(Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK - data.length, 0))
    }
    parts.push(Buffer.alloc(BLOCK * 2, 0))
    return gzipSync(Buffer.concat(parts))
}

function paths(dataDir: string): ResolvedPaths {
    return {
        configDir: join(dataDir, "config"),
        dataDir,
        cacheDir: join(dataDir, "cache"),
        logDir: join(dataDir, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
}

const MANIFEST = JSON.stringify({
    name: "wellspring-core",
    version: "2.0.0",
    type: "module",
    main: "index.ts",
})
const ENTRY =
    'export function setup() { return { id: "wellspring-core", name: "C", version: "2.0.0", status: "ok" } }\n'

test("installPlugin：接受 .tgz，并拉平 npm 的 package/ 前缀", async () => {
    const dir = join(root, "install-tgz")
    const file = join(dir, "plugin.tgz")
    await mkdir(dir, { recursive: true })
    await writeFile(
        file,
        npmTarball({ "package/package.json": MANIFEST, "package/index.ts": ENTRY }),
    )

    const result = await installPlugin(file, paths(dir), {})
    assert.equal(result.id, "wellspring-core")
    assert.equal(result.target, join(dir, "plugins", "wellspring-core"))
    const pkg = JSON.parse(await readFile(join(result.target, "package.json"), "utf8")) as {
        name: string
        version: string
    }
    assert.equal(pkg.name, "wellspring-core")
    assert.equal(pkg.version, "2.0.0")
    assert.match(await readFile(join(result.target, "index.ts"), "utf8"), /export function setup/)
})

test("installPlugin：.zip 分支未被破坏", async () => {
    const dir = join(root, "install-zip")
    await mkdir(dir, { recursive: true })
    const file = join(dir, "plugin.zip")
    await writeFile(
        file,
        makeZip({
            "package.json": JSON.stringify({
                name: "zip-plugin",
                version: "1.0.0",
                type: "module",
                main: "index.ts",
            }),
            "index.ts":
                'export function setup() { return { id: "zip-plugin", name: "Z", version: "1.0.0", status: "ok" } }\n',
        }),
    )
    const result = await installPlugin(file, paths(dir), {})
    assert.equal(result.id, "zip-plugin")
})
