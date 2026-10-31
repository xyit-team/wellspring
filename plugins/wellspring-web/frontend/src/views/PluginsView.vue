<script setup lang="ts">
import { onMounted, ref } from "vue"

import {
    installPlugin,
    loadPlugins,
    pluginsState,
    removePluginById,
    setPluginsMessage,
    store,
    togglePlugin,
} from "../store"

const fileInput = ref<HTMLInputElement | null>(null)
const force = ref(false)

function statusLabel(status: string): string {
    if (status === "ok") return "运行中"
    if (status === "failed") return "加载失败"
    if (status === "disabled") return "已禁用"
    return "未加载"
}

function statusClass(status: string): string {
    if (status === "ok") return "is-ok"
    if (status === "failed") return "is-failed"
    if (status === "disabled") return "is-disabled"
    return "is-unknown"
}

async function onInstall(): Promise<void> {
    const file = fileInput.value?.files?.[0]
    if (file === undefined) {
        setPluginsMessage("先选择一个 .zip 插件包", "error")
        return
    }
    await installPlugin(file, force.value)
    if (fileInput.value !== null) fileInput.value.value = ""
}

onMounted(() => {
    setPluginsMessage("")
    void loadPlugins()
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
                <h1>插件管理</h1>
                <p>启用 / 禁用即时生效；安装、卸载与禁用 wellspring-web 需要重启 Wellspring。</p>
            </div>
        </header>
        <div class="view-scroll">
            <div class="page-narrow">
                <p class="plugins-notice">插件代码以宿主授权运行，安装前请确认来源可信。</p>
                <div class="plugins-list">
                    <p v-if="pluginsState.plugins === null" class="plugins-empty">正在读取…</p>
                    <p v-else-if="pluginsState.plugins.length === 0" class="plugins-empty">插件目录里还没有插件</p>
                    <div v-for="plugin in pluginsState.plugins ?? []" :key="plugin.id" class="plugin-row">
                        <div class="plugin-head">
                            <span class="plugin-name">{{ plugin.name || plugin.id }}</span>
                            <span class="plugin-status" :class="statusClass(plugin.status)">{{ statusLabel(plugin.status) }}</span>
                        </div>
                        <p class="plugin-meta">
                            {{ plugin.id }}
                            <template v-if="plugin.version"> · v{{ plugin.version }}</template>
                            <template v-if="plugin.dir && plugin.dir !== plugin.id"> · 目录 {{ plugin.dir }}</template>
                        </p>
                        <p v-if="plugin.deps.length > 0" class="plugin-deps">依赖：{{ plugin.deps.join(", ") }}</p>
                        <p v-if="plugin.commands.length > 0" class="plugin-deps">命令：{{ plugin.commands.join(", ") }}</p>
                        <div class="plugin-actions">
                            <button
                                v-if="plugin.enabled"
                                class="btn btn-outline btn-sm"
                                :class="{ 'btn-danger': plugin.id === 'wellspring-web' }"
                                type="button"
                                :disabled="pluginsState.busy"
                                @click="togglePlugin(plugin, false)"
                            >
                                {{ plugin.id === "wellspring-web" ? "禁用（危险）" : "禁用" }}
                            </button>
                            <button
                                v-else
                                class="btn btn-primary btn-sm"
                                type="button"
                                :disabled="pluginsState.busy"
                                @click="togglePlugin(plugin, true)"
                            >
                                启用
                            </button>
                            <button
                                v-if="plugin.id === 'wellspring-web'"
                                class="btn btn-outline btn-sm"
                                type="button"
                                disabled
                                title="网页管理依赖 wellspring-web，不能用网页卸载"
                            >
                                卸载
                            </button>
                            <button
                                v-else-if="plugin.enabled"
                                class="btn btn-outline btn-sm"
                                type="button"
                                disabled
                                title="插件正在运行，先禁用再卸载"
                            >
                                卸载
                            </button>
                            <button
                                v-else
                                class="btn btn-danger-ghost btn-sm"
                                type="button"
                                :disabled="pluginsState.busy"
                                @click="removePluginById(plugin)"
                            >
                                卸载
                            </button>
                        </div>
                    </div>
                </div>
                <p v-if="pluginsState.message !== ''" class="plugins-message" :class="`is-${pluginsState.tone}`" role="status">
                    {{ pluginsState.message }}
                </p>
                <section class="plugins-install" aria-labelledby="plugins-install-title">
                    <h3 id="plugins-install-title">安装插件</h3>
                    <p class="plugins-note">上传 zip 包（含 package.json 与 index.ts），上限 10MB；声明了 packageManager 与 dependencies 时会自动安装依赖，可能需要几十秒。安装后重启生效。</p>
                    <div class="plugins-install-row">
                        <input ref="fileInput" class="input" type="file" accept=".zip,application/zip" />
                        <label class="plugins-force">
                            <input v-model="force" type="checkbox" />
                            <span>覆盖同名插件</span>
                        </label>
                    </div>
                    <div class="models-actions">
                        <button class="btn btn-primary" type="button" :disabled="pluginsState.busy" @click="onInstall">
                            上传并安装
                        </button>
                    </div>
                </section>
            </div>
        </div>
    </main>
</template>
