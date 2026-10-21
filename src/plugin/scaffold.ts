/*
 * 插件脚手架：生成可加载的最小插件目录。
 */

import { join, resolve } from "node:path"

import {
    ensureDir,
    removePath,
    statIfExists,
    writeJsonAtomic,
    writeTextAtomic,
} from "../platform/file.ts"
import { PLUGIN_NAME } from "./paths.ts"

export interface ScaffoldPluginOptions {
    readonly name: string
    /** 生成到哪个父目录，默认当前工作目录 */
    readonly parentDir?: string
    readonly force?: boolean
}

export interface ScaffoldPluginResult {
    readonly dir: string
    readonly commandName: string
}

/** 插件名 → 合法命令名；名字不适用时回落到 hello */
export function commandNameOf(pluginName: string): string {
    let slug = pluginName
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
    if (!/^[a-z][a-z0-9-]*$/.test(slug) || slug.length < 2) {
        slug = "hello"
    }
    return slug.slice(0, 32).replace(/-+$/, "")
}

function template(pluginName: string, commandName: string): string {
    return [
        'import { beforeMessage, onInit, onShutdown } from "wellspring/api/host/index.ts"',
        "",
        "// 钩子可以放在模块顶层；平台在 import 时会把它们归属到当前插件",
        "beforeMessage(({ prompt }) => {",
        '    prompt.push("你是一个运行在 Wellspring 里的助手")',
        "})",
        "",
        "export function setup() {",
        "    onInit(() => {",
        "        // wellspring start 时触发",
        "    })",
        "    onShutdown(() => {",
        "        // wellspring start 关闭时触发",
        "    })",
        "",
        "    return {",
        `        id: ${JSON.stringify(pluginName)},`,
        `        name: ${JSON.stringify(pluginName)},`,
        '        version: "0.1.0",',
        "        deps: [],",
        "        commands: [",
        "            {",
        `                name: ${JSON.stringify(commandName)},`,
        `                summary: ${JSON.stringify(`${pluginName} 示例命令`)},`,
        "                run: (ctx) => {",
        '                    ctx.output.info("argv=" + ctx.argv.join(","))',
        "                    return 0",
        "                },",
        "            },",
        "        ],",
        "    }",
        "}",
        "",
    ].join("\n")
}

export async function scaffoldPlugin(
    options: ScaffoldPluginOptions,
): Promise<ScaffoldPluginResult> {
    const name = options.name.trim()
    if (!PLUGIN_NAME.test(name)) {
        throw new Error(`插件名不合法：${name}`)
    }
    const parentDir = resolve(options.parentDir ?? process.cwd())
    const dir = join(parentDir, name)
    const existing = await statIfExists(dir)
    if (existing !== null) {
        if (options.force !== true) {
            throw new Error(`目录已存在：${dir}`)
        }
        await removePath(dir)
    }
    await ensureDir(dir)

    const commandName = commandNameOf(name)
    await writeJsonAtomic(join(dir, "package.json"), {
        name,
        version: "0.1.0",
        type: "module",
        main: "index.ts",
        wellspring: { apiVersion: 1 },
    })
    await writeTextAtomic(join(dir, "index.ts"), template(name, commandName))
    return { dir, commandName }
}
