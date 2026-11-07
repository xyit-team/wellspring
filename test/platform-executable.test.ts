/*
 * findExecutable：按 PATH 查找可执行文件
 *
 * bwrap 位置随发行版不同：Termux 在 $PREFIX/bin，NixOS 在 /nix/store
 * 写死 /usr/bin 时这些环境装了也报找不到
 */

import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { findExecutable } from "../src/platform/executable.ts"

let root = ""
let first = ""
let second = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-exec-"))
    first = join(root, "first")
    second = join(root, "second")
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })

    // first 放不可执行的同名文件，可执行文件在 second
    await writeFile(join(first, "bwrap"), "not executable")
    await writeFile(join(second, "bwrap"), "#!/bin/sh\n")
    await chmod(join(second, "bwrap"), 0o755)
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

test("跳过没有执行位的同名文件，取 PATH 里第一个可执行的", () => {
    const env = { PATH: `${first}:${second}` }
    assert.equal(findExecutable("bwrap", env), join(second, "bwrap"))
})

test("PATH 里都没有时返回 null", () => {
    assert.equal(findExecutable("definitely-not-here", { PATH: `${first}:${second}` }), null)
    assert.equal(findExecutable("bwrap", { PATH: first }), null)
    assert.equal(findExecutable("bwrap", {}), null)
})

test("空目录项按 POSIX 语义忽略，不把相对路径当命中", () => {
    const env = { PATH: `:${second}` }
    assert.equal(findExecutable("bwrap", env), join(second, "bwrap"))
})

test("带分隔符的名字按路径处理", () => {
    assert.equal(findExecutable(join(second, "bwrap"), { PATH: "" }), join(second, "bwrap"))
    assert.equal(findExecutable(join(first, "bwrap"), { PATH: "" }), null)
    assert.equal(findExecutable("", { PATH: second }), null)
})

test("目录不算可执行文件", () => {
    assert.equal(findExecutable(second, { PATH: "" }), null)
})
