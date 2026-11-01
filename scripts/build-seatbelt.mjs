#!/usr/bin/env node
/*
 * 构建 macOS Seatbelt loader：native/seatbelt-run/src/main.c → bin/darwin-<arch>/seatbelt-run
 *
 * 产物按架构分目录，SeatbeltBackend.packagedLauncherPath() 按 process.arch 解析
 * 缺产物时退回 /usr/bin/sandbox-exec（deprecated），两者都没有则 fail-closed
 *
 * 用法：
 *   node scripts/build-seatbelt.mjs            当前架构
 *   node scripts/build-seatbelt.mjs --all      arm64 与 x64
 *   node scripts/build-seatbelt.mjs --clean    清理产物
 *
 * 仅 macOS 可构建：依赖 libsandbox.1.dylib 与 Mach-O 链接
 */

import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const source = join(repoRoot, "native", "seatbelt-run", "src", "main.c")
const binRoot = join(repoRoot, "bin")

/** Node 的 process.arch → clang 的 -arch 取值 */
const CLANG_ARCH = { arm64: "arm64", x64: "x86_64" }

const args = new Set(process.argv.slice(2))
const buildAll = args.has("--all")
const cleanOnly = args.has("--clean")

function fail(message) {
    console.error(message)
    process.exit(1)
}

function run(command, commandArgs) {
    const result = spawnSync(command, commandArgs, { encoding: "utf8" })
    if (result.error) {
        return { ok: false, output: result.error.message }
    }
    return {
        ok: result.status === 0,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    }
}

function clean() {
    if (existsSync(binRoot)) {
        rmSync(binRoot, { recursive: true, force: true })
        console.log(`已清理 ${binRoot}`)
    }
}

if (process.platform !== "darwin") {
    /* -arch 只换目标架构，链接仍需 macOS SDK 与 Mach-O 运行时 */
    if (cleanOnly) {
        clean()
        process.exit(0)
    }
    fail(
        "seatbelt-run 仅 macOS 可构建：需要 libsandbox 与 Mach-O 链接\n" +
            "非 macOS 上 SeatbeltBackend 报不可用",
    )
}

if (cleanOnly) {
    clean()
    process.exit(0)
}

if (!existsSync(source)) {
    fail(`找不到源码：${source}`)
}

const clang = run("xcrun", ["--sdk", "macosx", "--find", "clang"])
if (!clang.ok) {
    fail("找不到 clang：xcode-select --install\n" + `${clang.output}`)
}

/* 显式绑定 SDK：不带 -isysroot 时系统头文件路径为空，dlfcn.h 会报 file not found */
const sdk = run("xcrun", ["--sdk", "macosx", "--show-sdk-path"])
if (!sdk.ok || sdk.output === "") {
    fail("找不到 macOS SDK：xcode-select --install\n" + `${sdk.output}`)
}

const targets = buildAll ? ["arm64", "x64"] : [process.arch]
for (const arch of targets) {
    if (CLANG_ARCH[arch] === undefined) {
        fail(`不支持的架构：${arch}（只支持 arm64 / x64）`)
    }
}

/** 编译单个架构，返回产物路径 */
function build(arch) {
    const outDir = join(binRoot, `darwin-${arch}`)
    const outFile = join(outDir, "seatbelt-run")
    mkdirSync(outDir, { recursive: true })

    const compiled = run(clang.output, [
        "-O2",
        "-arch",
        CLANG_ARCH[arch],
        "-isysroot",
        sdk.output,
        "-mmacosx-version-min=11.0",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-o",
        outFile,
        source,
    ])
    if (!compiled.ok) {
        fail(`编译失败（${arch}）：\n${compiled.output}`)
    }
    chmodSync(outFile, 0o755)

    /* 本机编译会自动 ad-hoc 签名，产物经 strip 或跨机拷贝后签名缺失 */
    const signed = run("codesign", ["--force", "--sign", "-", outFile])
    if (!signed.ok) {
        fail(`ad-hoc 签名失败（${arch}）：\n${signed.output}`)
    }

    const verified = run("codesign", ["--verify", "--strict", outFile])
    if (!verified.ok) {
        fail(`签名校验失败（${arch}）：\n${verified.output}`)
    }

    return outFile
}

/** 端到端自检：施加一份 profile 再 exec /usr/bin/true，证明内核真的接受 */
function selfTest(file) {
    const result = run(file, ["--self-test"])
    if (!result.ok) {
        fail(`自检失败：${file}\n${result.output}`)
    }
    return result.output
}

const built = []
for (const arch of targets) {
    const file = build(arch)
    const output = selfTest(file)
    const size = statSync(file).size
    built.push({ arch, file, size, output })
}

console.log(`\n已构建 ${built.length} 个 seatbelt-run：`)
for (const item of built) {
    console.log(`  ${item.arch.padEnd(6)} ${String(item.size).padStart(7)} B  ${item.file}`)
    console.log(`         ${item.output}`)
}

const available = readdirSync(binRoot).filter((name) => name.startsWith("darwin-"))
console.log(`\nbin/ 现有平台包：${available.join(", ")}`)
if (!available.includes(`darwin-${process.arch}`)) {
    console.log(`提示：当前架构 ${process.arch} 没有产物，运行时将退回 sandbox-exec。`)
}
