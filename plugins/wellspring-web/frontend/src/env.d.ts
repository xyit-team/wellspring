/*
 * 前端类型声明补充
 *
 * 之前 frontend/tsconfig.json 从未被执行（package.json 只有 vite build），
 * 所以缺 .vue shim 与 nprogress 声明这件事一直没暴露——tsc 对组件等于没检查。
 */

/// <reference types="vite/client" />

declare module "*.vue" {
    import type { DefineComponent } from "vue"

    const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
    export default component
}

declare module "nprogress" {
    interface NProgress {
        start(): NProgress
        done(force?: boolean): NProgress
        configure(options: Record<string, unknown>): NProgress
        inc(amount?: number): NProgress
        set(value: number): NProgress
        isStarted(): boolean
    }

    const nprogress: NProgress
    export default nprogress
}

declare module "nprogress/nprogress.css"
