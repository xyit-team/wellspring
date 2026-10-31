/*
 * 构建 Vue 前端并把产物打包成插件内 TS 资源。
 *
 * 插件运行时在 sandbox 里，不能读插件包内文件，也不该依赖外部 CDN，
 * 所以这里把 Vite 产出的 JS/CSS 直接生成为 `src/assets/vue-client.ts` 里的字符串常量，
 * 再由插件 HTTP 服务同源下发（保持严格 CSP）。
 *
 * 用法：node plugins/wellspring-web/scripts/build-ui.mjs
 */

import { spawnSync } from "node:child_process"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

const pluginDir = join(import.meta.dirname, "..")
const frontendDir = join(pluginDir, "frontend")
const distDir = join(frontendDir, "dist")
const target = join(pluginDir, "src", "assets", "vue-client.ts")

const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const build = spawnSync(npm, ["run", "build"], {
    cwd: frontendDir,
    stdio: "inherit",
    env: process.env,
})
if (build.status !== 0) {
    process.exit(build.status ?? 1)
}

const files = await readdir(distDir)
const jsFile = files.find((name) => name.endsWith(".js"))
if (jsFile === undefined) {
    console.error("没有找到构建产物 app-vue.js")
    process.exit(1)
}
const cssFile = files.find((name) => name.endsWith(".css"))
const js = await readFile(join(distDir, jsFile), "utf8")
const css = cssFile === undefined ? "" : await readFile(join(distDir, cssFile), "utf8")

await mkdir(join(pluginDir, "src", "assets"), { recursive: true })
const content = `/*
 * 由 scripts/build-ui.mjs 从 frontend/ 构建生成，请勿手改。
 * 前端：Vue 3 + Vite（IIFE 产物），插件 HTTP 服务同源下发。
 */

export const VUE_CLIENT_JS: string = ${JSON.stringify(js)}

export const VUE_CLIENT_CSS: string = ${JSON.stringify(css)}
`
await writeFile(target, content, "utf8")
console.log(`已生成 ${target}（JS ${Math.round(js.length / 1024)}KB，CSS ${Math.round(css.length / 1024)}KB）`)
