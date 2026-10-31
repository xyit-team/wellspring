/*
 * 前端类型检查。
 *
 * frontend/tsconfig.json 以前从未被执行（只有 vite build，esbuild 不做类型检查），
 * 所以组件里的类型错误一直没人拦。这里把它纳入验证流程。
 *
 * 已知存量债务：logic/conversations.ts 与 logic/mentions.ts 是从旧客户端迁来的
 * JS 风格代码（var + 未注解参数）。它们的错误不在这里拦，但新文件、store、
 * 组件、视图、路由出现类型错误会直接失败——这正是这轮想守住的边界。
 *
 * 用法：node plugins/wellspring-web/scripts/check-ui.mjs
 */

import { spawnSync } from "node:child_process"
import { join } from "node:path"

const pluginDir = join(import.meta.dirname, "..")
const frontendDir = join(pluginDir, "frontend")

/** 允许保留类型错误的存量文件 */
const LEGACY = ["src/logic/conversations.ts", "src/logic/mentions.ts"]

const tsc = join(pluginDir, "..", "..", "node_modules", ".bin", "tsc")
const result = spawnSync(tsc, ["--noEmit", "-p", "tsconfig.json"], {
    cwd: frontendDir,
    encoding: "utf8",
})

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
const lines = output.split("\n").filter((line) => line.includes("error TS"))
const errors = lines.filter((line) => {
    const match = /^(src\/[^(]+)\(/.exec(line)
    return match === null || !LEGACY.includes(match[1])
})

if (errors.length > 0) {
    console.error("前端类型检查失败：")
    for (const line of errors) console.error(line)
    process.exit(1)
}

console.log(`前端类型检查通过（存量债务 ${lines.length} 处：${LEGACY.join(", ")}）`)
