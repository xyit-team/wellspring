/*
 * tsc 的 rewriteRelativeImportExtensions 只改 JS，.d.ts 里仍然保留 ".ts"。
 * 声明文件是给消费者 tsc 看的；带 .ts 后缀的相对导入会要求对方打开
 * allowImportingTsExtensions，所以发布前统一改回 .js。
 */

import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const DIST = fileURLToPath(new URL("../dist/", import.meta.url))

async function declarations(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
            files.push(...(await declarations(path)))
        } else if (entry.name.endsWith(".d.ts")) {
            files.push(path)
        }
    }
    return files
}

let rewritten = 0
for (const file of await declarations(DIST)) {
    const source = await readFile(file, "utf8")
    const next = source.replace(/(["'])(\.{1,2}\/[^"']+)\.ts\1/g, "$1$2.js$1")
    if (next !== source) {
        await writeFile(file, next)
        rewritten += 1
    }
}
console.log(`声明文件已重写：${rewritten} 个`)
