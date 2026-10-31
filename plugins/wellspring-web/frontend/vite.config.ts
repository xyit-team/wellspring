import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"

/*
 * 前端构建：lib 模式产出一份可直接由 <script defer> 加载的 IIFE。
 * 插件运行时把这些产物打包成 TS 字符串（scripts/build-web-ui.mjs），
 * 由插件自己的 HTTP 服务同源下发，保持无 CDN、严格 CSP。
 */
export default defineConfig({
    plugins: [vue()],
    /* lib 模式不会自动替换 NODE_ENV，手动钉成 production（浏览器里没有 process） */
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
        lib: {
            entry: "src/main.ts",
            formats: ["es"],
            fileName: () => "app-vue.js",
        },
        rollupOptions: {
            // 扩展模块会从 /assets/app-vue.js 复用同一个 Vue 运行时
            external: [],
        },
        cssCodeSplit: false,
        minify: "esbuild",
        target: "es2022",
        emptyOutDir: true,
        outDir: "dist",
    },
})
