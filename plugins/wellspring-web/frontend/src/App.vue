<script setup lang="ts">
import { onMounted, watch } from "vue"
import { RouterView, useRouter } from "vue-router"

import { loadExtensions } from "./extensions"
import { bindReconnect, connectAddons, start, store } from "./store"

const router = useRouter()

// 关闭服务后立刻切到关闭屏：路由守卫只在导航时生效，这里主动推一次
watch(
    () => store.shutdownRequested,
    (requested) => {
        if (requested && router.currentRoute.value.name !== "shutdown") {
            void router.replace({ name: "shutdown" })
        }
    },
)

onMounted(async () => {
    const theme = document.documentElement.getAttribute("data-theme")
    if (theme === "light" || theme === "dark") store.theme = theme
    // 路由守卫已拿过 /api/state；这里兜底首次进入（或直接刷新某个深层路由）的情况
    if (!store.ready) await start()
    if (store.authenticated) {
        connectAddons()
        bindReconnect()
        void loadExtensions()
    }
})
</script>

<template>
    <div v-if="!store.ready" class="boot" role="status" aria-live="polite">
        <span class="mark mark-lg"><svg class="icon" aria-hidden="true"><use href="#i-spring" /></svg></span>
        <p>正在连接 Wellspring…</p>
    </div>
    <RouterView v-else />
</template>
