// 插件脚手架：生成可加载的最小插件目录

import { join, resolve } from "node:path"

import {
    ensureDir,
    removePath,
    statIfExists,
    writeJsonAtomic,
    writeTextAtomic,
} from "../platform/file.ts"
import { PLUGIN_ID, PLUGIN_NAME } from "./paths.ts"
import { packageLocalName } from "./manifest.ts"

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
        'import { onMessage, onInit, onShutdown } from "wellspring/api/host/index.ts"',
        'import type { WellspringPlugin } from "wellspring/api/host/index.ts"',
        "",
        "// 钩子可以放在模块顶层；平台在 import 时会把它们归属到当前插件",
        "onMessage(({ phase, prompt }) => {",
        '    if (phase === "before") prompt.push("你是一个运行在 Wellspring 里的助手")',
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
        "    const plugin = {",
        `        id: ${JSON.stringify(pluginName)},`,
        `        name: ${JSON.stringify(pluginName)},`,
        '        version: "0.1.0",',
        '        status: "ok",',
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
        "    } satisfies WellspringPlugin",
        "",
        "    return plugin",
        "}",
        "",
    ].join("\n")
}

function readmeTemplate(pluginName: string, commandName: string): string {
    return [
        `# ${pluginName}`,
        "",
        "## 开发",
        "",
        "编辑器 / tsc 解析 `wellspring/api/host/index.ts` 需要先把 Wellspring 链接进来：",
        "",
        "```bash",
        "pnpm link /path/to/Wellspring",
        "pnpm add -D typescript @types/node   # 如果还没有",
        "pnpm exec tsc --noEmit",
        "```",
        "",
        "运行时不需要链接：通过 `wellspring plugin link <this-dir>` 加载时，平台会解析宿主 API。",
        "",
        "## 依赖",
        "",
        "`package.json` 的 `packageManager` 声明插件使用哪个包管理器（`npm@11.20.0`、`pnpm@10` 等）。",
        "安装 zip 或目录时，有 `dependencies` 会按这个声明自动安装；没有声明时按 lockfile 推断。",
        "",
        "## 加载",
        "",
        "```bash",
        `wellspring plugin link \"$PWD\"`,
        "wellspring plugin list",
        `wellspring ${commandName}`,
        "```",
        "",
    ].join("\n")
}

export async function scaffoldPlugin(
    options: ScaffoldPluginOptions,
): Promise<ScaffoldPluginResult> {
    const name = options.name.trim()
    if (!PLUGIN_ID.test(name)) {
        throw new Error(`插件名不合法：${name}`)
    }
    const parentDir = resolve(options.parentDir ?? process.cwd())
    /* 本地名取包名最后一段：@scope/demo → 目录 demo */
    const localName = packageLocalName(name)
    if (localName === null || !PLUGIN_NAME.test(localName)) {
        throw new Error(`插件本地名不合法：${name}`)
    }
    const dir = join(parentDir, localName)
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
        packageManager: "npm@11.20.0",
        type: "module",
        main: "index.ts",
        wellspring: { apiVersion: 1, name: localName },
    })
    await writeTextAtomic(join(dir, "index.ts"), template(name, commandName))
    await writeJsonAtomic(join(dir, "tsconfig.json"), {
        compilerOptions: {
            target: "ES2024",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            skipLibCheck: true,
            types: ["node"],
        },
        include: ["index.ts"],
    })
    await writeTextAtomic(join(dir, "README.md"), readmeTemplate(name, commandName))
    return { dir, commandName }
}
