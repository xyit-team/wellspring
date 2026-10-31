import NProgress from "nprogress"
import { createApp, watch } from "vue"
import Vue3Toastify, { updateGlobalOptions } from "vue3-toastify"

import "nprogress/nprogress.css"
import "vue3-toastify/dist/index.css"

import App from "./App.vue"
import { router } from "./router"
import { store } from "./store"

// 扩展模块从这里 import Vue 运行时与 toast，保证和主界面用同一个 Vue 实例
export * from "vue"
export { toast } from "vue3-toastify"
export { default as NProgress } from "nprogress"

NProgress.configure({ showSpinner: false, trickleSpeed: 120 })

/** 跟随应用主题：system 交给 toastify 的 auto（按 prefers-color-scheme 解析） */
function toastTheme(): "auto" | "light" | "dark" {
    if (store.theme === "light") return "light"
    if (store.theme === "dark") return "dark"
    return "auto"
}

const app = createApp(App)
app.use(router)
const toastOptions = () => ({
    autoClose: 3200,
    position: "top-center" as const,
    closeButton: false,
    hideProgressBar: true,
    theme: toastTheme(),
})
app.use(Vue3Toastify, toastOptions())
app.mount("#vue-app")

// App.onMounted 会从 data-theme 恢复主题；挂载后再同步一次全局 toast 主题
updateGlobalOptions(toastOptions())
watch(() => store.theme, () => updateGlobalOptions(toastOptions()))
