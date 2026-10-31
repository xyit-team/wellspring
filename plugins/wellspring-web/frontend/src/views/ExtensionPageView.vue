<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue"
import { RouterLink, useRoute, useRouter } from "vue-router"

import {
    extensionList,
    extensionMeta,
    extensionModule,
    extensionState,
    loadExtensions,
} from "../extensions"
import { store, toast } from "../store"

const route = useRoute()
const router = useRouter()

const id = computed(() => String(route.params["id"] ?? ""))
const item = computed(() => extensionList().find((entry) => entry.id === id.value) ?? null)
const extModule = computed(() => extensionModule(id.value))
const component = computed(() => extModule.value?.default ?? null)
const meta = computed(() => extensionMeta(item.value))
/** `meta.mode = "page"` 的扩展占满内容区，其余沿用面板卡片的样子 */
const isPage = computed(() => meta.value.mode === "page")
const title = computed(() => meta.value.name ?? item.value?.name ?? "Web 扩展")

const host = {
    version: store.version,
    toast,
    close: () => {
        void router.push("/")
    },
}

/** 网页安装的扩展样式单独放在 <id>.css，路由页面自己挂 <link> */
let styleLink: HTMLLinkElement | null = null
function syncStyle(): void {
    const url = item.value?.styleUrl ?? null
    if (url === null) {
        styleLink?.remove()
        styleLink = null
        return
    }
    if (styleLink !== null && styleLink.getAttribute("href") === url) return
    styleLink?.remove()
    styleLink = document.createElement("link")
    styleLink.rel = "stylesheet"
    styleLink.href = url
    document.head.appendChild(styleLink)
}

onMounted(() => {
    void loadExtensions().then(syncStyle)
})

watch([() => extensionState.loading, () => item.value?.id], ([loading]) => {
    if (!loading && item.value === null) {
        // 扩展被删掉了就回扩展列表
        void router.replace("/extensions")
        return
    }
    syncStyle()
})

onBeforeUnmount(() => {
    styleLink?.remove()
    styleLink = null
})
</script>

<template>
    <main class="main ext-page-main">
        <header class="topbar">
            <button
                class="btn btn-icon btn-ghost only-mobile"
                type="button"
                aria-label="打开会话列表"
                @click="store.sidebarOpen = true"
            >
                <svg class="icon" aria-hidden="true"><use href="#i-menu" /></svg>
            </button>
            <div class="topbar-title">
                <h1>{{ title }}</h1>
                <p>{{ isPage ? "Web 扩展页面" : "Web 扩展面板" }}</p>
            </div>
            <div class="topbar-actions">
                <RouterLink class="btn btn-outline btn-sm" to="/extensions">扩展列表</RouterLink>
            </div>
        </header>
        <div class="view-scroll ext-page-body">
            <p v-if="component === null" class="proc-empty">扩展页面没能加载（可能是页面扩展已被删除）</p>
            <component :is="component" v-else-if="isPage" :host="host" />
            <section v-else class="ext-panel ext-panel-page">
                <header class="ext-head">
                    <div>
                        <p class="ext-eyebrow">Web 扩展</p>
                        <h2>{{ title }}</h2>
                    </div>
                </header>
                <div class="ext-body">
                    <component :is="component" :host="host" />
                </div>
            </section>
        </div>
    </main>
</template>
