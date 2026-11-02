#!/usr/bin/env node
/*
 * 校验插件版本：改动过代码的插件，必须同时涨 package.json 里的 version
 *
 * Release 里的插件 zip 由 plugins/ 现打包、文件名带版本号；版本不动就会出现
 * 「文件名相同、内容不同」的包，plugin list 与 SHA256SUMS 都分辨不出新旧
 *
 * 用法：
 *   node scripts/check-plugin-versions.mjs --base v1.3.4
 *   node scripts/check-plugin-versions.mjs --base v1.3.4 --json
 *
 * 退出码：0 通过，1 有插件改了代码但没涨版本，2 参数或 git 出错
 */

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** 只改说明文件不构成发版理由 */
const VERSION_EXEMPT = new Set(["README.md"])

/** plugins/<name>/... → plugins/<name>；不在插件目录里返回 null */
export function pluginDirOf(file) {
    const parts = file.split("/")
    if (parts.length < 3 || parts[0] !== "plugins") {
        return null
    }
    return `${parts[0]}/${parts[1]}`
}

/** 该文件是否要求对应插件涨版本 */
export function requiresVersionBump(file) {
    const dir = pluginDirOf(file)
    if (dir === null) {
        return false
    }
    const tail = file.slice(dir.length + 1)
    return !VERSION_EXEMPT.has(tail)
}

/** 按插件归并改动文件 */
export function groupChangedPlugins(files) {
    const grouped = new Map()
    for (const file of files) {
        if (!requiresVersionBump(file)) {
            continue
        }
        const dir = pluginDirOf(file)
        const list = grouped.get(dir) ?? []
        list.push(file)
        grouped.set(dir, list)
    }
    return grouped
}

/**
 * 找出「改了代码但版本没动」的插件
 *
 * versions / baseVersions：plugins/<name> → 版本号；基线里没有该插件时缺省
 */
export function findVersionViolations({ changed, versions, baseVersions }) {
    const violations = []
    for (const [dir, files] of changed) {
        const version = versions.get(dir) ?? null
        const baseVersion = baseVersions.get(dir) ?? null
        if (version === null) {
            violations.push({ dir, version, baseVersion, files, reason: "missing" })
            continue
        }
        if (version === baseVersion) {
            violations.push({ dir, version, baseVersion, files, reason: "unchanged" })
        }
    }
    return violations
}

function git(args) {
    const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" })
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} 失败：${(result.stderr ?? "").trim()}`)
    }
    return result.stdout
}

/** 读当前工作树的插件版本 */
function currentVersions(dirs) {
    const versions = new Map()
    for (const dir of dirs) {
        const text = readFileSync(join(projectRoot, dir, "package.json"), "utf8")
        versions.set(dir, JSON.parse(text).version ?? null)
    }
    return versions
}

/** 读基线提交里的插件版本；该提交没有这个插件时记 null */
function baseVersions(base, dirs) {
    const versions = new Map()
    for (const dir of dirs) {
        const result = spawnSync("git", ["show", `${base}:${join(dir, "package.json")}`], {
            cwd: projectRoot,
            encoding: "utf8",
        })
        versions.set(
            result.status === 0 ? dir : dir,
            result.status === 0 ? (JSON.parse(result.stdout).version ?? null) : null,
        )
    }
    return versions
}

/** 列出所有带 package.json 的插件目录 */
function pluginDirs() {
    const tracked = git(["ls-files", "plugins/*/package.json"])
        .split("\n")
        .filter((line) => line.trim() !== "")
    return tracked.map((file) => pluginDirOf(file)).filter((dir) => dir !== null)
}

function parseArgs(argv) {
    const index = argv.indexOf("--base")
    const base = index === -1 ? null : (argv[index + 1] ?? null)
    return { base, json: argv.includes("--json") }
}

function main() {
    const { base, json } = parseArgs(process.argv.slice(2))
    if (base === null || base.trim() === "") {
        console.error("用法：node scripts/check-plugin-versions.mjs --base <ref>")
        return 2
    }

    let files = []
    let dirs = []
    try {
        files = git(["diff", "--name-only", base, "HEAD"])
            .split("\n")
            .filter((line) => line.trim() !== "")
        dirs = pluginDirs()
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        return 2
    }

    const changed = groupChangedPlugins(files)
    const violations = findVersionViolations({
        changed,
        versions: currentVersions(dirs),
        baseVersions: baseVersions(base, dirs),
    })

    if (json) {
        console.log(
            JSON.stringify(
                {
                    base,
                    changed: [...changed].map(([dir, list]) => ({
                        dir,
                        files: list.map((file) =>
                            relative(join(projectRoot, dir), join(projectRoot, file)),
                        ),
                    })),
                    violations,
                },
                null,
                4,
            ),
        )
        return violations.length === 0 ? 0 : 1
    }

    if (violations.length === 0) {
        console.log(`插件版本校验通过（基线 ${base}，改动 ${changed.size} 个插件）`)
        return 0
    }

    console.error(`以下插件改了代码但没涨版本（基线 ${base}）：`)
    for (const item of violations) {
        const from = item.baseVersion === null ? "（基线里没有）" : item.baseVersion
        console.error(`  ${item.dir}  ${from} → ${item.version ?? "（缺 version）"}`)
        for (const file of item.files) {
            console.error(`    ${file}`)
        }
    }
    console.error("")
    console.error("改这些插件的 package.json version，然后重跑")
    return 1
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(main())
}
