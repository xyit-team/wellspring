<script setup lang="ts">
import { onMounted, reactive, ref } from "vue"

import { contextInputEntries } from "../logic/model-context"
import {
    activeModelName,
    clearProviderKey,
    confirmDialog,
    fetchProviderModels,
    findProvider,
    formatContextTokens,
    loadModelContexts,
    loadModels,
    modelsMessage,
    modelsState,
    parseContextTokens,
    removeProvider,
    saveModelContexts,
    saveProvider,
    saveProviderKey,
    setDefaultModel,
    store,
    toast,
} from "../store"

const form = reactive({ name: "", baseUrl: "", models: "", apiKey: "" })
const keyInputs = reactive<Record<string, string>>({})
const contextInputs = reactive<Record<string, string>>({})
const saving = ref(false)
const ready = ref(false)

function providerKeyText(provider: {
    keyConfigured: boolean
    keySource: string | null
    keyMasked: string | null
    envVar: string | null
}): string {
    if (!provider.keyConfigured) return "未配置 Key"
    const source = provider.keySource === "env" ? `环境变量 ${provider.envVar ?? ""}` : "本地凭据"
    return `${source} ${provider.keyMasked ?? ""}`
}

function modelsOf(provider: { models: string[]; defaultModel: string | null }): string[] {
    if (provider.models.length > 0) return provider.models
    return provider.defaultModel ? [provider.defaultModel] : []
}

/** 只补缺失的输入框，避免异步刷新把用户正在编辑的值覆盖掉 */
function syncContexts(): void {
    for (const provider of modelsState.models?.providers ?? []) {
        for (const model of modelsOf(provider)) {
            const key = `${provider.id}/${model}`
            if (contextInputs[key] !== undefined) continue
            const window = modelsState.contexts[key]
            contextInputs[key] = window === undefined ? "" : formatContextTokens(window)
        }
    }
}

async function refresh(): Promise<void> {
    ready.value = false
    await loadModels()
    await loadModelContexts()
    syncContexts()
    ready.value = true
}

async function submit(): Promise<void> {
    saving.value = true
    const ok = await saveProvider(form)
    saving.value = false
    if (!ok) return
    form.name = ""
    form.baseUrl = ""
    form.models = ""
    form.apiKey = ""
    await refresh()
}

async function onSaveKey(id: string): Promise<void> {
    const provider = findProvider(id)
    if (provider === null) return
    await saveProviderKey(provider, keyInputs[id] ?? "")
    keyInputs[id] = ""
    await refresh()
}

async function onClearKey(id: string): Promise<void> {
    const provider = findProvider(id)
    if (provider === null) return
    await clearProviderKey(provider)
    await refresh()
}

async function onFetchModels(id: string): Promise<void> {
    const provider = findProvider(id)
    if (provider === null) return
    await fetchProviderModels(provider, keyInputs[id] ?? "")
    await refresh()
}

async function onRemove(id: string): Promise<void> {
    const provider = findProvider(id)
    if (provider === null) return
    const confirmed = await confirmDialog({
        title: "删除供应商",
        body: `删除供应商「${provider.name}」？自定义配置会一起移除。`,
        confirmLabel: "删除",
        danger: true,
    })
    if (!confirmed) return
    await removeProvider(provider)
    await refresh()
}

async function onPickDefault(id: string, model: string): Promise<void> {
    await setDefaultModel(id, model)
    syncContexts()
}

async function saveContexts(): Promise<void> {
    // 由 logic/model-context.ts 负责「输入框 → 供应商/模型」，模型名里的 / 不会被截断
    const providers = (modelsState.models?.providers ?? []).map((provider) => ({
        id: provider.id,
        models: modelsOf(provider),
    }))
    const items: Array<{ provider: string; model: string; contextWindow: number | null }> = []
    for (const entry of contextInputEntries(providers, contextInputs)) {
        const parsed = parseContextTokens(entry.raw)
        if (!parsed.ok) {
            toast(`上下文窗口格式不正确：${entry.model}`, "error")
            return
        }
        items.push({ provider: entry.provider, model: entry.model, contextWindow: parsed.value })
    }
    if (items.length === 0) {
        toast("还没有可保存的模型", "warn")
        return
    }
    await saveModelContexts(items)
}

onMounted(() => {
    void refresh()
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
                <h1>模型与供应商</h1>
                <p>切换当前模型，或接入任意 OpenAI 兼容接口的自定义供应商。Key 单独保存在宿主凭据文件。</p>
            </div>
        </header>
        <div class="view-scroll">
            <div class="page-narrow">
                <p class="models-current">
                    默认（新会话）：
                    {{ findProvider(modelsState.models?.activeProvider ?? "")?.name ?? modelsState.models?.activeProvider ?? "—" }}
                    / {{ activeModelName() === "" ? "供应商缺省模型" : activeModelName() }}
                    （推理：{{ modelsState.models?.activeReasoning ?? "off" }}）
                </p>
                <div class="models-list">
                    <div
                        v-for="provider in modelsState.models?.providers ?? []"
                        :key="provider.id"
                        class="models-provider"
                        :class="{ 'is-active': provider.id === modelsState.models?.activeProvider }"
                    >
                        <div class="models-provider-head">
                            <span class="models-provider-name">{{ provider.name }}</span>
                            <span v-if="provider.builtin" class="perm-option-tag">内置</span>
                            <button v-else class="btn btn-ghost btn-sm models-remove" type="button" @click="onRemove(provider.id)">
                                删除
                            </button>
                        </div>
                        <div class="models-provider-meta">
                            {{ provider.baseUrl || "SDK 默认地址" }} · {{ providerKeyText(provider) }}
                        </div>
                        <div class="models-models">
                            <span v-if="modelsOf(provider).length === 0" class="models-provider-meta">
                                还没有模型，保存供应商时填写或拉取
                            </span>
                            <button
                                v-for="model in modelsOf(provider)"
                                :key="model"
                                class="models-model-btn"
                                type="button"
                                :class="{
                                    'is-active':
                                        provider.id === modelsState.models?.activeProvider &&
                                        model === activeModelName(),
                                }"
                                @click="onPickDefault(provider.id, model)"
                            >
                                {{ model }}
                            </button>
                        </div>
                        <div class="models-key-row">
                            <input
                                v-model="keyInputs[provider.id]"
                                class="input"
                                type="password"
                                autocomplete="off"
                                spellcheck="false"
                                placeholder="API Key（只写不读）"
                            />
                            <button class="btn btn-outline btn-sm" type="button" @click="onSaveKey(provider.id)">保存 Key</button>
                            <button
                                class="btn btn-ghost btn-sm"
                                type="button"
                                :disabled="!provider.keyStored"
                                @click="onClearKey(provider.id)"
                            >
                                清除
                            </button>
                            <button
                                v-if="!provider.builtin"
                                class="btn btn-outline btn-sm"
                                type="button"
                                @click="onFetchModels(provider.id)"
                            >
                                拉取模型
                            </button>
                        </div>
                    </div>
                </div>
                <section class="models-add" aria-labelledby="models-add-title">
                    <h3 id="models-add-title">添加自定义供应商</h3>
                    <div class="models-form">
                        <label class="models-field">
                            <span>名称</span>
                            <input v-model="form.name" class="input" autocomplete="off" placeholder="例如 DeepSeek" />
                        </label>
                        <label class="models-field">
                            <span>Base URL</span>
                            <input
                                v-model="form.baseUrl"
                                class="input"
                                autocomplete="off"
                                spellcheck="false"
                                placeholder="https://api.deepseek.com/v1"
                            />
                        </label>
                        <label class="models-field">
                            <span>API Key（可选）</span>
                            <input
                                v-model="form.apiKey"
                                class="input"
                                type="password"
                                autocomplete="off"
                                spellcheck="false"
                                placeholder="sk-..."
                            />
                        </label>
                        <label class="models-field models-field-wide">
                            <span>模型（逗号或换行分隔），或者稍后自动拉取</span>
                            <textarea
                                v-model="form.models"
                                class="input models-models-input"
                                rows="2"
                                spellcheck="false"
                                placeholder="deepseek-chat, deepseek-reasoner"
                            ></textarea>
                        </label>
                    </div>
                    <div class="models-actions">
                        <button class="btn btn-primary" type="button" :disabled="saving" @click="submit">保存供应商</button>
                    </div>
                </section>
                <section class="models-context" aria-labelledby="models-context-title">
                    <h3 id="models-context-title">上下文窗口</h3>
                    <p class="models-note">
                        按模型配置上下文长度（tokens），支持 <code>128K</code> / <code>1M</code> 写法；留空表示不配置。
                    </p>
                    <div v-if="ready" class="models-context-list">
                        <div
                            v-for="provider in modelsState.models?.providers ?? []"
                            :key="provider.id"
                            class="models-context-group"
                        >
                            <div class="models-context-provider">{{ provider.name }}</div>
                            <span v-if="modelsOf(provider).length === 0" class="models-context-empty">还没有模型</span>
                            <label
                                v-for="model in modelsOf(provider)"
                                :key="model"
                                class="models-context-row"
                            >
                                <span class="models-context-model">{{ model }}</span>
                                <input
                                    v-model="contextInputs[`${provider.id}/${model}`]"
                                    class="input models-context-input"
                                    type="text"
                                    autocomplete="off"
                                    spellcheck="false"
                                    placeholder="例如 128K"
                                />
                            </label>
                        </div>
                    </div>
                    <div class="models-actions">
                        <button class="btn btn-primary" type="button" @click="saveContexts">保存上下文窗口</button>
                    </div>
                </section>
                <p v-if="modelsMessage.text !== ''" class="models-message" :class="`is-${modelsMessage.tone}`" role="status">
                    {{ modelsMessage.text }}
                </p>
                <p class="models-note">
                    切换模型对之后的对话生效；供应商接口需兼容 <code>GET /models</code> 时才能自动拉取模型。
                </p>
            </div>
        </div>
    </main>
</template>
