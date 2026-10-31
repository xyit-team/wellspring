<script setup lang="ts">
import { onMounted, ref } from "vue"

import { apiJson } from "../api"
import { store } from "../store"

interface HostPluginItem {
    id: string
    name: string
    version: string
    deps: string[]
    commands: string[]
    status: string
}

interface HostSnapshot {
    status: string
    os: { platform: string; arch: string; release: string; node: string; cwd: string }
    paths: { configDir: string; dataDir: string; cacheDir: string; logDir: string }
    plugins: HostPluginItem[]
    pluginVersion: string
    apiVersion: number
}

const HOST_STATUS_TEXT: Record<string, string> = {
    running: "running · 运行中",
    starting: "starting · 启动中",
    stopping: "stopping · 停止中",
    stopped: "stopped · 已停止",
}

const data = ref<HostSnapshot | null>(null)
const error = ref("")
const loading = ref(false)

async function load(): Promise<void> {
    loading.value = true
    error.value = ""
    try {
        data.value = await apiJson<HostSnapshot>("/api/host")
    } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
        loading.value = false
    }
}

function workspaceText(): string {
    if (store.group === "ungrouped") return "未分组"
    if (store.workspace === null) return "（未选择）"
    return `${store.workspace.name} · ${store.workspace.root}`
}

onMounted(() => {
    void load()
})
</script>

<template>
    <main class="main">
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
                <h1>系统状态</h1>
                <p>宿主、运行时与已加载的插件。</p>
            </div>
            <div class="topbar-actions">
                <button class="btn btn-outline btn-sm" type="button" @click="load">
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-refresh" /></svg>
                    <span>刷新</span>
                </button>
            </div>
        </header>
        <div class="view-scroll">
            <div class="page-narrow">
                <div v-if="loading" class="dialog-loading">
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-refresh" /></svg>
                    <span>正在读取宿主信息…</span>
                </div>
                <div v-else-if="error !== ''" class="dialog-loading">
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-alert" /></svg>
                    <span>{{ error }}</span>
                </div>
                <template v-else-if="data !== null">
                    <dl class="status-grid">
                        <dt>宿主状态</dt>
                        <dd>{{ HOST_STATUS_TEXT[data.status] ?? data.status }}</dd>
                        <dt>工作区</dt>
                        <dd>{{ workspaceText() }}</dd>
                        <dt>插件版本</dt>
                        <dd>v{{ data.pluginVersion }} · API {{ data.apiVersion }}</dd>
                        <dt>平台</dt>
                        <dd>{{ [data.os.platform, data.os.arch, data.os.release].filter(Boolean).join(" · ") }}</dd>
                        <dt>Node</dt>
                        <dd>{{ data.os.node }}</dd>
                        <dt>工作目录</dt>
                        <dd>{{ data.os.cwd }}</dd>
                        <dt>配置目录</dt>
                        <dd>{{ data.paths.configDir }}</dd>
                        <dt>数据目录</dt>
                        <dd>{{ data.paths.dataDir }}</dd>
                        <dt>缓存目录</dt>
                        <dd>{{ data.paths.cacheDir }}</dd>
                        <dt>日志目录</dt>
                        <dd>{{ data.paths.logDir }}</dd>
                    </dl>
                    <p class="section-label">插件（{{ data.plugins.length }}）</p>
                    <ul class="plugin-list">
                        <li v-for="plugin in data.plugins" :key="plugin.id" class="plugin-item">
                            <span
                                class="badge"
                                :class="{
                                    'badge-ok': plugin.status === 'ok',
                                    'badge-error': plugin.status === 'failed',
                                }"
                            >
                                <span class="dot"></span>
                                {{ plugin.status }}
                            </span>
                            <span class="name">{{ plugin.name || plugin.id }}</span>
                            <span class="ver">v{{ plugin.version }}</span>
                        </li>
                    </ul>
                </template>
            </div>
        </div>
    </main>
</template>
