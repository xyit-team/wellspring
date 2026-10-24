#!/usr/bin/env node
/*
 * 用本机 Node 头文件重建 node-pty 原生模块。
 *
 * node-pty 没有 linux 预编译包，pnpm install 时会走 node-gyp；而 node-gyp 自带的
 * 下载器在设置了 HTTP(S)_PROXY 的环境里与 Node 26 不兼容（安装日志里是
 * "gyp ERR! InvalidArgumentError: invalid onError method"），于是 install 失败。
 * 这里直接使用 Node 安装目录里自带的 include/node 头文件，跳过下载。
 *
 * 用法：pnpm pty:build
 * 没装 node-pty 也没关系：终端会自动退回 python3 的 pty 实现。
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const nodeDir = resolve(dirname(process.execPath), "..")
const header = join(nodeDir, "include", "node", "node.h")
if (!existsSync(join(repoRoot, "node_modules", "node-pty"))) {
    console.error("node_modules 里没有 node-pty：先执行 pnpm install。")
    console.error("它不用能装成功也可以——终端会自动退回 python3 的 pty 实现。")
    process.exit(1)
}
if (!existsSync(header)) {
    console.error(`找不到 Node 头文件：${header}`)
    console.error("当前 Node 安装没有附带 include/node，无法编译 node-pty。")
    console.error("终端仍可使用：宿主会自动退回 python3 的 pty 实现。")
    process.exit(1)
}

console.log(`使用本地 Node 头文件重建 node-pty：${nodeDir}`)
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const result = spawnSync(pnpm, ["rebuild", "node-pty"], {
    stdio: "inherit",
    env: { ...process.env, npm_config_nodedir: nodeDir },
})
if (result.status !== 0) {
    console.error("node-pty 重建失败；终端会自动退回 python3 的 pty 实现。")
    process.exit(result.status ?? 1)
}

try {
    const pty = await import("node-pty")
    if (typeof pty.spawn !== "function") {
        throw new Error("node-pty 没有导出 spawn")
    }
    console.log("node-pty 原生模块可用")
} catch (error) {
    console.error(
        `node-pty 仍然无法加载：${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
}
