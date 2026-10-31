import { createRouter, createWebHistory } from "vue-router"

import AppLayout from "./layouts/AppLayout.vue"
import AuthView from "./views/AuthView.vue"
import ChatView from "./views/ChatView.vue"
import ExtensionPageView from "./views/ExtensionPageView.vue"
import ExtensionsView from "./views/ExtensionsView.vue"
import NetworkView from "./views/NetworkView.vue"
import NotFoundView from "./views/NotFoundView.vue"
import PasswordView from "./views/PasswordView.vue"
import PluginsView from "./views/PluginsView.vue"
import ProvidersView from "./views/ProvidersView.vue"
import ShutdownView from "./views/ShutdownView.vue"
import StatusView from "./views/StatusView.vue"
import { start, store } from "./store"

/**
 * 所有界面都是路由（history 模式，服务端已对非 /api 路径回同一份外壳）：
 * 登录 / 关闭屏在布局之外；主界面（侧栏 + 内容区）是一层嵌套路由，
 * 设置类页面（供应商 / 插件 / 密码 / 状态）与 Web 扩展页面都挂在它下面，
 * 未匹配的地址落到 404 页。
 */
export const router = createRouter({
    history: createWebHistory(),
    routes: [
        { path: "/login", name: "login", component: AuthView, meta: { title: "登录" } },
        { path: "/shutdown", name: "shutdown", component: ShutdownView, meta: { title: "已关闭" } },
        {
            path: "/",
            component: AppLayout,
            children: [
                { path: "", name: "chat", component: ChatView, meta: { title: "对话" } },
                {
                    // 每个会话一个地址：刷新/直达/浏览器前进后退都能回到同一个会话
                    path: "c/:id",
                    name: "conversation",
                    component: ChatView,
                    meta: { title: "对话" },
                },
                {
                    path: "extensions",
                    name: "extensions",
                    component: ExtensionsView,
                    meta: { title: "Web 扩展" },
                },
                {
                    path: "ext/:id",
                    name: "extension",
                    component: ExtensionPageView,
                    meta: { title: "Web 扩展" },
                },
                {
                    path: "providers",
                    name: "providers",
                    component: ProvidersView,
                    meta: { title: "模型与供应商" },
                },
                {
                    path: "network",
                    name: "network",
                    component: NetworkView,
                    meta: { title: "网络代理" },
                },
                {
                    path: "plugins",
                    name: "plugins",
                    component: PluginsView,
                    meta: { title: "插件管理" },
                },
                {
                    path: "password",
                    name: "password",
                    component: PasswordView,
                    meta: { title: "修改密码" },
                },
                {
                    path: "status",
                    name: "status",
                    component: StatusView,
                    meta: { title: "系统状态" },
                },
                {
                    path: ":pathMatch(.*)*",
                    name: "not-found",
                    component: NotFoundView,
                    meta: { title: "页面不存在" },
                },
            ],
        },
    ],
    /** 换页时回到顶部：聊天区自己的滚动状态由 ChatView 维护 */
    scrollBehavior: () => ({ top: 0 }),
})

function routeTitle(to: { meta: Record<string, unknown> }): string {
    const title = to.meta["title"]
    return typeof title === "string" ? `${title} · Wellspring` : "Wellspring"
}

router.beforeEach(async (to) => {
    // 首次进入先拿 /api/state：标题栏、鉴权、工作区都依赖它
    if (!store.ready) await start()
    if (store.shutdownRequested) {
        return to.name === "shutdown" ? true : { name: "shutdown" }
    }
    if (!store.authenticated) {
        if (to.name === "shutdown") return true
        if (to.name === "login") return true
        const query = to.fullPath === "/" ? {} : { redirect: to.fullPath }
        return { name: "login", query }
    }
    if (to.name === "login" || to.name === "shutdown") return { name: "chat" }
    return true
})

router.afterEach((to) => {
    document.title = routeTitle(to)
})
