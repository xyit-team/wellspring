/*
 * 跨平台的测试入口：显式列出 test/ 下的 *.test.ts / *.test.mjs。
 *
 * 不用 `node --test test`：Node 24 不接受目录参数；
 * 也不用 `node --test` 的默认发现规则：不同 Node 版本对 .ts 的发现范围不一致。
 */

import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const TEST_ROOT = fileURLToPath(new URL("../test/", import.meta.url))

function collect(dir) {
    const files = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
            files.push(...collect(path))
        } else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.mjs")) {
            files.push(path)
        }
    }
    return files
}

const files = collect(TEST_ROOT).sort()
if (files.length === 0) {
    console.error("没有找到测试文件")
    process.exit(1)
}
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" })
process.exit(result.status ?? 1)
