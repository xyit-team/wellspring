/*
 * version：读取 package.json 的版本号并输出运行环境。
 */

import { join } from "node:path"

import { readTextIfExists } from "../platform/file.ts"
import { platform } from "../platform/os.ts"
import { success, type CommandContext, type CommandOutcome } from "./shared.ts"

interface PackageJson {
    readonly name?: string
    readonly version?: string
}

async function readPackage(): Promise<PackageJson> {
    const file = join(import.meta.dirname, "../../package.json")
    const text = await readTextIfExists(file)
    if (text === null) {
        return {}
    }
    try {
        return JSON.parse(text) as PackageJson
    } catch {
        return {}
    }
}

export async function runVersionCommand(ctx: CommandContext): Promise<CommandOutcome> {
    const pkg = await readPackage()
    const data = {
        name: pkg.name ?? "wellspring",
        version: pkg.version ?? "0.0.0",
        node: process.versions.node,
        platform,
    }
    ctx.elog.print(`${data.name} ${data.version}`)
    ctx.elog.print(`node ${data.node}  ${data.platform}`)
    return success(data)
}
