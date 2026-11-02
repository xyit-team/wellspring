/*
 * 按 PATH 查找可执行文件
 *
 * 平台不假设 FHS 布局：Termux 的二进制在 $PREFIX/bin，NixOS 在 /nix/store，
 * macOS 的 Homebrew 在 /opt/homebrew/bin，写死 /usr/bin 在这些环境里一律找不到
 */

import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join, sep } from "node:path"

/** 文件存在且带执行位 */
function isExecutableFile(path: string): boolean {
    try {
        if (!statSync(path).isFile()) {
            return false
        }
        accessSync(path, constants.X_OK)
        return true
    } catch {
        return false
    }
}

/**
 * 返回第一个匹配的绝对路径；找不到返回 null
 *
 * name 里带路径分隔符时按路径处理（同样要求可执行），否则扫 PATH
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
    if (name === "") {
        return null
    }
    if (name.includes(sep) || name.includes("/")) {
        return isExecutableFile(name) ? name : null
    }
    for (const dir of (env["PATH"] ?? "").split(delimiter)) {
        if (dir === "") {
            continue
        }
        const candidate = join(dir, name)
        if (isExecutableFile(candidate)) {
            return isAbsolute(candidate) ? candidate : join(process.cwd(), candidate)
        }
    }
    return null
}
