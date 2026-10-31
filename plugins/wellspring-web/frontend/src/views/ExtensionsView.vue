<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useRouter } from "vue-router"

import { confirmDialog } from "../store"
import {
    extensionList,
    extensionState,
    hiddenBuiltinList,
    installExtensionFile,
    isPageExtension,
    loadExtensions,
    removeExtension,
    setBuiltinVisible,
    type WebExtension,
} from "../extensions"

const router = useRouter()
const fileInput = ref<HTMLInputElement | null>(null)

const allExtensions = computed<WebExtension[]>(() => extensionList())
const hiddenExtensions = computed(() => hiddenBuiltinList())

async function onInstall(): Promise<void> {
    const file = fileInput.value?.files?.[0]
    if (file === undefined) return
    const result = await installExtensionFile(file)
    if (result.ok && fileInput.value !== null) fileInput.value.value = ""
}

/** 页面扩展与面板扩展都走 /ext/<id>：面板版式在路由页面里渲染 */
function openItem(item: WebExtension): void {
    void router.push({ name: "extension", params: { id: item.id } })
}

async function onRemove(item: WebExtension): Promise<void> {
    const ok = await confirmDialog({
        title: "删除扩展",
        body:
            item.source === "bundled"
                ? `内置扩展「${item.name}」的文件仍在 plugins/wellspring-web/plugins，网页端删除只是隐藏，可随时恢复。`
                : `删除扩展「${item.name}」？源码与编译产物会一起清理。`,
        confirmLabel: "删除",
        danger: true,
    })
    if (!ok) return
    await removeExtension(item)
}

onMounted(() => {
    void loadExtensions()
})
</script>

<template>
    <main class="main">
        <header class="topbar">
            <div class="topbar-title">
                <h1>Web 扩展</h1>
                <p>`.vue` 扩展可以打开面板、接管页面，或注入到主界面的固定挂载点</p>
            </div>
        </header>
        <div class="view-scroll">
            <div class="ext-toolbar">
                <input ref="fileInput" class="input" type="file" accept=".vue,text/plain" />
                <button class="btn btn-primary" type="button" :disabled="extensionState.installing" @click="onInstall">
                    {{ extensionState.installing ? "安装中…" : "安装扩展" }}
                </button>
            </div>
            <p class="ext-hint">
                选一个 .vue 文件（含 &lt;template&gt;，可选 &lt;script setup&gt;）；内置扩展放在
                <code>plugins/wellspring-web/plugins/*.vue</code>，重新构建前端后生效。
            </p>
            <p v-if="extensionState.loading" class="proc-empty">正在读取扩展…</p>
            <p v-else-if="allExtensions.length === 0" class="proc-empty">还没有扩展</p>
            <ul v-else class="ext-list ext-main-list">
                <li v-for="item in allExtensions" :key="item.id" class="ext-item">
                    <div class="ext-item-main">
                        <span class="ext-name">{{ item.name }}</span>
                        <span class="ext-meta">
                            {{ item.source === "bundled" ? "内置" : "已安装" }}
                            · {{ isPageExtension(item) ? "页面" : "面板" }}
                            · {{ Math.max(1, Math.round(item.size / 1024)) }}KB
                        </span>
                    </div>
                    <div class="ext-actions">
                        <button class="btn btn-outline btn-sm" type="button" @click="openItem(item)">打开</button>
                        <button class="btn btn-danger-ghost btn-sm" type="button" @click="onRemove(item)">删除</button>
                    </div>
                </li>
            </ul>
            <section v-if="hiddenExtensions.length > 0" class="ext-hidden">
                <p class="ext-hint">已隐藏的内置扩展（文件仍在 plugins 目录）：</p>
                <ul class="ext-list ext-hidden-list">
                    <li v-for="item in hiddenExtensions" :key="item.id" class="ext-item">
                        <div class="ext-item-main">
                            <span class="ext-name">{{ item.name }}</span>
                            <span class="ext-meta">内置 · 已隐藏</span>
                        </div>
                        <div class="ext-actions">
                            <button class="btn btn-outline btn-sm" type="button" @click="setBuiltinVisible(item.id, true)">
                                恢复
                            </button>
                        </div>
                    </li>
                </ul>
            </section>
        </div>
    </main>
</template>
