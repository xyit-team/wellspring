/*
 * node-pty 的 spawn-helper 执行位补偿。
 *
 * node-pty 1.1.0 的 prebuilds 里 spawn-helper 是 644，spawn 时才报
 * posix_spawnp failed。这里钉住补偿逻辑本身：识别、修复、修不了时的报错。
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
    ensureSpawnHelperExecutable,
    spawnHelperCandidates,
} from "../src/sandbox/node-pty-permissions.ts"

interface FakeFile {
    mode: number
    isFile?: boolean
}

/** 用内存里的文件表模拟 fs，chmod 会真的改表 */
function fakeFs(files: Record<string, FakeFile>) {
    const chmodCalls: Array<{ file: string; mode: number }> = []
    return {
        chmodCalls,
        stat: (file: string) => {
            const hit = files[file]
            if (hit === undefined) {
                throw new Error(`ENOENT: ${file}`)
            }
            return { isFile: () => hit.isFile !== false, mode: hit.mode }
        },
        chmod: (file: string, mode: number) => {
            chmodCalls.push({ file, mode })
            const hit = files[file]
            if (hit === undefined) {
                throw new Error(`ENOENT: ${file}`)
            }
            hit.mode = mode
        },
    }
}

const MODULE_DIR = "/app/node_modules/node-pty"

function candidates(platform: NodeJS.Platform = "darwin") {
    return spawnHelperCandidates(MODULE_DIR, platform, "arm64")
}

test("候选路径：prebuilds 优先，退回 build/Release", () => {
    assert.deepEqual(candidates(), [
        "/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
        "/app/node_modules/node-pty/build/Release/spawn-helper",
    ])
})

test("644 的 spawn-helper 被补成 755", () => {
    const prebuild = candidates()[0]
    assert.ok(prebuild !== undefined)
    const fs = fakeFs({ [prebuild]: { mode: 0o644 } })
    const result = ensureSpawnHelperExecutable({
        moduleDir: MODULE_DIR,
        platform: "darwin",
        arch: "arm64",
        stat: fs.stat,
        chmod: fs.chmod,
    })
    assert.equal(result.error, null)
    assert.equal(result.repaired, prebuild)
    assert.deepEqual(fs.chmodCalls, [{ file: prebuild, mode: 0o755 }])
})

test("已有执行位时不动它", () => {
    const prebuild = candidates()[0]
    assert.ok(prebuild !== undefined)
    const fs = fakeFs({ [prebuild]: { mode: 0o755 } })
    const result = ensureSpawnHelperExecutable({
        moduleDir: MODULE_DIR,
        platform: "darwin",
        arch: "arm64",
        stat: fs.stat,
        chmod: fs.chmod,
    })
    assert.deepEqual(result, { repaired: null, error: null })
    assert.equal(fs.chmodCalls.length, 0, "不该多余 chmod")
})

test("prebuilds 缺失时退回 build/Release", () => {
    const fallback = candidates()[1]
    assert.ok(fallback !== undefined)
    const fs = fakeFs({ [fallback]: { mode: 0o600 } })
    const result = ensureSpawnHelperExecutable({
        moduleDir: MODULE_DIR,
        platform: "linux",
        arch: "arm64",
        stat: fs.stat,
        chmod: fs.chmod,
    })
    assert.equal(result.repaired, fallback)
    assert.equal(result.error, null)
})

test("两处都不存在时不报错", () => {
    const fs = fakeFs({})
    const result = ensureSpawnHelperExecutable({
        moduleDir: MODULE_DIR,
        platform: "darwin",
        arch: "arm64",
        stat: fs.stat,
        chmod: fs.chmod,
    })
    assert.deepEqual(result, { repaired: null, error: null })
})

test("Windows 不处理", () => {
    const fs = fakeFs({})
    const result = ensureSpawnHelperExecutable({
        moduleDir: MODULE_DIR,
        platform: "win32",
        arch: "x64",
        stat: fs.stat,
        chmod: fs.chmod,
    })
    assert.deepEqual(result, { repaired: null, error: null })
    assert.equal(fs.chmodCalls.length, 0)
})

test("chmod 失败时给出可读原因，而不是让 spawn 时才炸", () => {
    const prebuild = candidates()[0]
    assert.ok(prebuild !== undefined)
    const result = ensureSpawnHelperExecutable({
        moduleDir: MODULE_DIR,
        platform: "darwin",
        arch: "arm64",
        stat: () => ({ isFile: () => true, mode: 0o644 }),
        chmod: () => {
            throw new Error("EPERM")
        },
    })
    assert.equal(result.repaired, null)
    assert.match(result.error ?? "", /spawn-helper 缺少执行位且无法修复/)
    assert.match(result.error ?? "", /EPERM/)
})

test("目录不是普通文件时跳过", () => {
    const prebuild = candidates()[0]
    assert.ok(prebuild !== undefined)
    const fs = fakeFs({ [prebuild]: { mode: 0o644, isFile: false } })
    const result = ensureSpawnHelperExecutable({
        moduleDir: MODULE_DIR,
        platform: "darwin",
        arch: "arm64",
        stat: fs.stat,
        chmod: fs.chmod,
    })
    assert.deepEqual(result, { repaired: null, error: null })
    assert.equal(fs.chmodCalls.length, 0)
})
