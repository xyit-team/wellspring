<script setup lang="ts">
import { nextTick, onMounted, reactive, ref } from "vue"
import { RouterLink, useRouter } from "vue-router"

import { AuthError, apiJson } from "../api"
import { store, toast } from "../store"

const router = useRouter()
const form = reactive({ current: "", next: "", confirm: "" })
const message = ref("")
const tone = ref<"warn" | "error" | "ok">("warn")
const busy = ref(false)
const currentInput = ref<HTMLInputElement | null>(null)

function fail(text: string, level: "warn" | "error" = "warn"): void {
    message.value = text
    tone.value = level
}

async function save(): Promise<void> {
    if (form.current === "") return fail("请输入当前密码。")
    if (form.next.length < 6) return fail("新密码至少 6 位。")
    if (form.next.length > 200) return fail("新密码不能超过 200 位。")
    if (form.next === form.current) return fail("新密码不能和当前密码相同。")
    if (form.next !== form.confirm) return fail("两次输入的新密码不一致。")
    busy.value = true
    try {
        await apiJson("/api/auth/password", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ currentPassword: form.current, newPassword: form.next }),
        })
        toast("密码已修改，其他设备已退出登录", "info", 4200)
        form.current = ""
        form.next = ""
        form.confirm = ""
        message.value = ""
        await router.push("/")
    } catch (error) {
        if (error instanceof AuthError) {
            window.location.reload()
            return
        }
        const status = (error as { status?: number } | null)?.status
        if (status === 401 || (error instanceof Error && error.message.includes("当前密码"))) {
            fail("当前密码不正确。", "error")
            form.current = ""
            await nextTick()
            currentInput.value?.focus()
        } else if (status === 429) {
            fail("尝试过于频繁，请稍后再试。")
        } else {
            fail(error instanceof Error ? error.message : "修改密码失败。", "error")
        }
    } finally {
        busy.value = false
    }
}

onMounted(() => {
    currentInput.value?.focus()
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
                <h1>修改访问密码</h1>
                <p>修改后其他设备上的登录会失效。</p>
            </div>
        </header>
        <div class="view-scroll">
            <form class="page-narrow password-form" novalidate @submit.prevent="save">
                <div class="field">
                    <label for="password-current">当前密码</label>
                    <input
                        id="password-current"
                        ref="currentInput"
                        v-model="form.current"
                        class="input"
                        type="password"
                        autocomplete="current-password"
                        spellcheck="false"
                    />
                </div>
                <div class="field">
                    <label for="password-new">新密码</label>
                    <input
                        id="password-new"
                        v-model="form.next"
                        class="input"
                        type="password"
                        autocomplete="new-password"
                        spellcheck="false"
                    />
                </div>
                <div class="field">
                    <label for="password-confirm">确认新密码</label>
                    <input
                        id="password-confirm"
                        v-model="form.confirm"
                        class="input"
                        type="password"
                        autocomplete="new-password"
                        spellcheck="false"
                    />
                </div>
                <p v-if="message !== ''" class="form-message" :class="`is-${tone}`" role="status">{{ message }}</p>
                <p class="form-note">密码至少 6 位、最多 200 位。修改成功后当前浏览器保持登录。</p>
                <div class="password-actions">
                    <RouterLink class="btn btn-outline" to="/">取消</RouterLink>
                    <button class="btn btn-primary" type="submit" :disabled="busy">保存</button>
                </div>
            </form>
        </div>
    </main>
</template>
