<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue"
import { useRoute } from "vue-router"

import { readJson } from "../api"
import { store } from "../store"

type Mode = "setup" | "login"

const route = useRoute()
const mode = ref<Mode>(store.configured ? "login" : "setup")
const form = reactive({ password: "", confirm: "" })
const reveal = reactive({ password: false, confirm: false })
const caps = ref(false)
const errors = ref<string[]>([])
const busy = ref(false)
const passwordInput = ref<HTMLInputElement | null>(null)

const title = computed(() => (mode.value === "setup" ? "设置访问密码" : "欢迎回来"))
const subtitle = computed(() =>
    mode.value === "setup"
        ? "第一次使用。密码与会话都保存在插件数据目录，按工作区隔离。"
        : "输入密码继续。登录后可以看到已添加的工作区与它们的会话。",
)
const submitLabel = computed(() => (mode.value === "setup" ? "保存并进入" : "进入"))

/** 守卫拦到登录页时带上原目标，登录后回到那里 */
function target(): string {
    const redirect = route.query["redirect"]
    return typeof redirect === "string" && redirect.startsWith("/") ? redirect : "/"
}

function syncCaps(event: KeyboardEvent): void {
    if (typeof event.getModifierState === "function") {
        caps.value = event.getModifierState("CapsLock")
    }
}

function validate(): string[] {
    const found: string[] = []
    if (form.password === "") found.push("请输入密码。")
    if (mode.value === "setup") {
        if (form.password.length < 6) found.push("密码至少 6 位字符。")
        if (form.password.length > 200) found.push("密码不能超过 200 位。")
        if (form.confirm !== form.password) found.push("两次输入的密码不一致。")
    }
    return found
}

async function submit(): Promise<void> {
    if (busy.value) return
    const found = validate()
    errors.value = found
    if (found.length > 0) return
    busy.value = true
    try {
        const path = mode.value === "setup" ? "/api/auth/setup" : "/api/auth/login"
        const response = await fetch(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: form.password }),
        })
        const data = await readJson<{ error?: string }>(response)
        if (!response.ok) {
            if (response.status === 429) {
                errors.value = ["尝试过于频繁，请稍后再试。"]
            } else if (response.status === 401) {
                errors.value = ["密码不正确。"]
                form.password = ""
                await nextTick()
                passwordInput.value?.focus()
            } else {
                errors.value = [data?.error ?? `请求失败（HTTP ${response.status}）`]
            }
            return
        }
        // 登录后整页进入目标路由：SSE、addon 订阅、工作区状态都重新初始化一次
        window.location.assign(target())
    } catch (error) {
        errors.value = [error instanceof Error ? error.message : "请求失败，请重试。"]
    } finally {
        busy.value = false
    }
}

watch(
    () => store.configured,
    (configured) => {
        mode.value = configured ? "login" : "setup"
    },
)

onMounted(() => {
    void nextTick(() => passwordInput.value?.focus())
})
</script>
<template>
    <div class="auth">
        <aside class="auth-aside">
            <div class="auth-brand">
                <span class="mark"><svg class="icon" aria-hidden="true"><use href="#i-spring" /></svg></span>
                <span>Wellspring</span>
            </div>
            <p class="auth-headline">你的 Agent，<br />在浏览器里继续。</p>
            <p class="auth-copy">与 CLI 共用同一套会话、工具与权限。回复以流式返回，会话按工作区保存在插件数据目录。</p>
            <ul class="auth-points">
                <li><svg class="icon" aria-hidden="true"><use href="#i-spring" /></svg>流式回复，可随时停止</li>
                <li><svg class="icon" aria-hidden="true"><use href="#i-code" /></svg>Markdown 与代码块</li>
                <li><svg class="icon" aria-hidden="true"><use href="#i-folder" /></svg>工作区手动添加，会话按工作区保存</li>
                <li><svg class="icon" aria-hidden="true"><use href="#i-shield" /></svg>本地密码保护，不经过第三方</li>
            </ul>
            <p class="auth-foot">v{{ store.version }} · HOST API {{ store.apiVersion }}</p>
        </aside>
        <main class="auth-main">
            <section class="auth-card" aria-labelledby="auth-title">
                <div class="auth-mobile-brand brand">
                    <span class="mark"><svg class="icon" aria-hidden="true"><use href="#i-spring" /></svg></span>
                    <span>Wellspring</span>
                </div>
                <h1 id="auth-title">{{ title }}</h1>
                <p class="auth-sub">{{ subtitle }}</p>
                <form class="auth-form" novalidate @submit.prevent="submit">
                    <div v-if="errors.length > 0" class="error-summary" role="alert" tabindex="-1">
                        <p class="error-summary-title">{{ mode === "setup" ? "请修正以下问题" : "无法登录" }}</p>
                        <ul>
                            <li v-for="(error, index) in errors" :key="index">{{ error }}</li>
                        </ul>
                    </div>
                    <div class="field">
                        <label for="auth-password">密码</label>
                        <div class="input-group">
                            <input
                                id="auth-password"
                                ref="passwordInput"
                                v-model="form.password"
                                class="input"
                                :type="reveal.password ? 'text' : 'password'"
                                :autocomplete="mode === 'setup' ? 'new-password' : 'current-password'"
                                required
                                @keydown="syncCaps"
                                @keyup="syncCaps"
                            />
                            <button
                                class="input-action"
                                type="button"
                                :aria-label="reveal.password ? '隐藏密码' : '显示密码'"
                                :aria-pressed="reveal.password"
                                @click="reveal.password = !reveal.password"
                            >
                                <svg class="icon icon-sm" aria-hidden="true"><use :href="reveal.password ? '#i-eye-off' : '#i-eye'" /></svg>
                            </button>
                        </div>
                        <p v-if="mode === 'setup'" class="hint">至少 6 位字符。建议使用密码管理器生成。</p>
                    </div>
                    <div v-if="mode === 'setup'" class="field">
                        <label for="auth-confirm">确认密码</label>
                        <div class="input-group">
                            <input
                                id="auth-confirm"
                                v-model="form.confirm"
                                class="input"
                                :type="reveal.confirm ? 'text' : 'password'"
                                autocomplete="new-password"
                                required
                            />
                            <button
                                class="input-action"
                                type="button"
                                :aria-label="reveal.confirm ? '隐藏密码' : '显示密码'"
                                :aria-pressed="reveal.confirm"
                                @click="reveal.confirm = !reveal.confirm"
                            >
                                <svg class="icon icon-sm" aria-hidden="true"><use :href="reveal.confirm ? '#i-eye-off' : '#i-eye'" /></svg>
                            </button>
                        </div>
                    </div>
                    <p v-if="caps" class="auth-caps">大写锁定已开启</p>
                    <button class="btn btn-primary btn-block" type="submit" :disabled="busy">{{ submitLabel }}</button>
                </form>
            </section>
        </main>
    </div>
</template>
