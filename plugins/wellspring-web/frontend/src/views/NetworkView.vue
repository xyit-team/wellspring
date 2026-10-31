<script setup lang="ts">
import { computed, onMounted, ref } from "vue"

import { formatNoProxy } from "../logic/network"
import {
    clearNetworkProxy,
    loadNetwork,
    networkState,
    saveNetworkProxy,
    store,
} from "../store"

const urlInput = ref("")
const noProxyInput = ref("")
const saving = ref(false)

const proxy = computed(() => networkState.proxy)
const isDirect = computed(() => proxy.value === null)
const currentText = computed(() => {
    const value = proxy.value
    if (value === null) return "直连"
    const suffixes = (value.noProxy ?? []).join(", ")
    return suffixes === "" ? value.url : `${value.url}（不走代理：${suffixes}）`
})

onMounted(async () => {
    await loadNetwork()
    urlInput.value = networkState.proxy?.url ?? ""
    noProxyInput.value = formatNoProxy(networkState.proxy?.noProxy)
})

async function save(): Promise<void> {
    saving.value = true
    try {
        if (await saveNetworkProxy(urlInput.value, noProxyInput.value)) {
            noProxyInput.value = formatNoProxy(networkState.proxy?.noProxy)
        }
    } finally {
        saving.value = false
    }
}

async function useDirect(): Promise<void> {
    saving.value = true
    try {
        if (await clearNetworkProxy()) {
            urlInput.value = ""
            noProxyInput.value = ""
        }
    } finally {
        saving.value = false
    }
}
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
                <h1>网络代理</h1>
                <p>模型调用、拉取模型列表与网页搜索/抓取是否经过 HTTP/HTTPS 代理。</p>
            </div>
        </header>
        <div class="view-scroll">
            <div class="page-narrow">
                <p class="models-current">当前：{{ currentText }}</p>
                <section class="models-add" aria-labelledby="network-proxy-title">
                    <h3 id="network-proxy-title">HTTP / HTTPS 代理</h3>
                    <div class="models-form">
                        <label class="models-field models-field-wide">
                            <span>代理地址</span>
                            <input
                                v-model="urlInput"
                                class="input"
                                type="text"
                                autocomplete="off"
                                spellcheck="false"
                                placeholder="http://127.0.0.1:7890"
                            />
                        </label>
                        <label class="models-field models-field-wide">
                            <span>不走代理的主机</span>
                            <input
                                v-model="noProxyInput"
                                class="input"
                                type="text"
                                autocomplete="off"
                                spellcheck="false"
                                placeholder="localhost, 127.0.0.1, .internal（逗号或空格分隔）"
                            />
                        </label>
                    </div>
                    <div class="models-actions">
                        <button class="btn btn-primary" type="button" :disabled="saving" @click="save">
                            {{ saving ? "保存中…" : "保存代理" }}
                        </button>
                        <button
                            class="btn btn-outline"
                            type="button"
                            :disabled="saving || isDirect"
                            @click="useDirect"
                        >
                            改为直连
                        </button>
                    </div>
                </section>
                <p class="models-note">
                    保存后写入宿主的 <code>app-setting.json</code>，下一轮模型调用生效，不需要重启服务。
                    只支持 HTTP/HTTPS 代理；认证信息可以写在地址里（<code>http://user:pass@host:port</code>）。
                    代理地址留空等于直连。
                </p>
                <p class="models-note">
                    模型供应商的 Base URL、API Key 仍在上方「供应商」页配置；代理只影响出站网络请求。
                </p>
            </div>
        </div>
    </main>
</template>
