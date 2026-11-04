#!/usr/bin/env node
/*
 * 构建 Windows sandbox launcher：native/win-sandbox/src/main.cpp → bin/win32-<arch>/win-sandbox.exe
 *
 * 不依赖 vcvars：直接定位 MSVC 与 Windows SDK，拼出 PATH/INCLUDE/LIB 后调用 cl.exe。
 * 用法：
 *   node scripts/build-win-sandbox.mjs                构建当前架构并自检
 *   node scripts/build-win-sandbox.mjs --no-self-test 跳过自检（受限环境构建用）
 *   node scripts/build-win-sandbox.mjs --clean        清理产物
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const source = join(repoRoot, "native", "win-sandbox", "src", "main.cpp")
const binRoot = join(repoRoot, "bin")

const args = new Set(process.argv.slice(2))
const cleanOnly = args.has("--clean")
const skipSelfTest = args.has("--no-self-test")

function fail(message) {
    console.error(message)
    process.exit(1)
}

function run(command, commandArgs, options = {}) {
    const result = spawnSync(command, commandArgs, { encoding: "utf8", ...options })
    return {
        ok: result.status === 0 && result.error === undefined,
        status: result.status,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
        error: result.error,
    }
}

if (process.platform !== "win32") {
    if (cleanOnly) {
        rmSync(binRoot, { recursive: true, force: true })
        process.exit(0)
    }
    fail("win-sandbox 仅 Windows 可构建")
}

if (cleanOnly) {
    if (existsSync(binRoot)) {
        rmSync(binRoot, { recursive: true, force: true })
        console.log(`已清理 ${binRoot}`)
    }
    process.exit(0)
}

if (!existsSync(source)) {
    fail(`找不到源码：${source}`)
}

const arch = process.arch
if (arch !== "x64" && arch !== "arm64") {
    fail(`不支持的架构：${arch}（只支持 x64 / arm64）`)
}
const targetArch = arch
const hostBin = "Hostx64"
const targetBin = arch === "x64" ? "x64" : "arm64"

function findVisualStudio() {
    const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe"
    if (existsSync(vswhere)) {
        const result = run(vswhere, [
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
        ])
        const path = result.output.split(/\r?\n/).find((line) => line.trim() !== "")
        if (path !== undefined) {
            return path.trim()
        }
    }
    const candidates = [
        "C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools",
        "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools",
        "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools",
    ]
    return candidates.find((path) => existsSync(path)) ?? null
}

function versionKey(text) {
    return text
        .split(".")
        .map((part) => Number(part))
        .filter((part) => Number.isFinite(part))
}

function compareVersion(a, b) {
    const left = versionKey(a)
    const right = versionKey(b)
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const diff = (left[index] ?? 0) - (right[index] ?? 0)
        if (diff !== 0) {
            return diff
        }
    }
    return 0
}

const vsPath = findVisualStudio()
if (vsPath === null) {
    fail("找不到 Visual Studio Build Tools（需要 MSVC 与 Windows SDK）")
}
const toolsRoot = join(vsPath, "VC", "Tools", "MSVC")
if (!existsSync(toolsRoot)) {
    fail(`找不到 MSVC Tools 目录：${toolsRoot}`)
}
const msvcVersions = readdirSync(toolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersion)
const msvcVersion = msvcVersions.at(-1)
if (msvcVersion === undefined) {
    fail(`MSVC Tools 目录为空：${toolsRoot}`)
}
const msvcRoot = join(toolsRoot, msvcVersion)
const cl = join(msvcRoot, "bin", hostBin, targetBin, "cl.exe")
if (!existsSync(cl)) {
    fail(`找不到 cl.exe：${cl}`)
}

const sdkRoot = "C:\\Program Files (x86)\\Windows Kits\\10"
const includeRoot = join(sdkRoot, "Include")
if (!existsSync(includeRoot)) {
    fail(`找不到 Windows SDK：${includeRoot}`)
}
const sdkVersions = readdirSync(includeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersion)
const sdkVersion = sdkVersions.at(-1)
if (sdkVersion === undefined) {
    fail(`Windows SDK Include 为空：${includeRoot}`)
}

const outDir = join(binRoot, `win32-${arch}`)
const outFile = join(outDir, "win-sandbox.exe")
mkdirSync(outDir, { recursive: true })

const sdkInclude = join(includeRoot, sdkVersion)
const sdkLib = join(sdkRoot, "Lib", sdkVersion)
const include = [
    join(msvcRoot, "include"),
    join(sdkInclude, "um"),
    join(sdkInclude, "shared"),
    join(sdkInclude, "ucrt"),
    join(sdkInclude, "winrt"),
].join(";")
const lib = [
    join(msvcRoot, "lib", targetBin),
    join(sdkLib, "um", targetBin),
    join(sdkLib, "ucrt", targetBin),
].join(";")
const path = [
    join(msvcRoot, "bin", hostBin, targetBin),
    join(sdkRoot, "bin", sdkVersion, "x64"),
].join(";")

const clArgs = [
    "/nologo",
    "/utf-8",
    "/std:c++20",
    "/O2",
    "/W4",
    "/WX",
    "/EHsc",
    "/DUNICODE",
    "/D_UNICODE",
    `/Fo${outDir}\\`,
    `/Fe${outFile}`,
    source,
    "advapi32.lib",
    "userenv.lib",
]

const build = spawnSync(cl, clArgs, {
    encoding: "utf8",
    env: {
        ...process.env,
        PATH: `${path};${process.env["PATH"] ?? ""}`,
        INCLUDE: `${include};${process.env["INCLUDE"] ?? ""}`,
        LIB: `${lib};${process.env["LIB"] ?? ""}`,
    },
})
const buildOutput = `${build.stdout ?? ""}${build.stderr ?? ""}`.trim()
if (build.status !== 0 || build.error !== undefined) {
    fail(`编译失败：\n${buildOutput}`)
}
if (!existsSync(outFile)) {
    fail(`编译完成但没有产物：${outFile}`)
}
/* bin/ 会进 npm 包，别把 .obj 一起发布 */
for (const entry of readdirSync(outDir)) {
    if (entry.endsWith(".obj")) {
        rmSync(join(outDir, entry), { force: true })
    }
}
console.log(`已构建 ${outFile}（${statSync(outFile).size} B）`)

if (!skipSelfTest) {
    const selfTest = run(outFile, ["--self-test"], { timeout: 15_000 })
    if (!selfTest.ok) {
        fail(`自检失败：\n${selfTest.output}`)
    }
    console.log(`自检通过：${selfTest.output}`)
}

const built = existsSync(binRoot)
    ? readdirSync(binRoot).filter((name) => name.startsWith("win32-"))
    : []
console.log(`bin/ 现有平台包：${built.join(", ") || "(空)"}`)
