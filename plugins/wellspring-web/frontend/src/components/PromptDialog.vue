<script setup lang="ts">
import { nextTick, ref, watch } from "vue"

import { promptState, settlePrompt } from "../store"

const dialogEl = ref<HTMLDialogElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const value = ref("")

function show(): void {
    value.value = promptState.options?.value ?? ""
    const dialog = dialogEl.value
    if (dialog !== null && !dialog.open) dialog.showModal()
    void nextTick(() => inputEl.value?.focus())
}

watch(
    () => promptState.open,
    (open) => {
        const dialog = dialogEl.value
        if (open) show()
        else if (dialog !== null && dialog.open) dialog.close()
    },
)

function submit(): void {
    const text = value.value.trim()
    if (text === "") return
    settlePrompt(text)
}

function close(): void {
    settlePrompt(null)
}

function onCancel(event: Event): void {
    event.preventDefault()
    close()
}
</script>

<template>
    <dialog
        ref="dialogEl"
        class="dialog"
        aria-labelledby="prompt-title"
        @cancel="onCancel"
        @close="promptState.open && settlePrompt(null)"
    >
        <form @submit.prevent="submit">
            <div class="dialog-head">
                <div>
                    <h2 id="prompt-title">{{ promptState.options?.title ?? "输入" }}</h2>
                    <p>{{ promptState.options?.body ?? "" }}</p>
                </div>
                <button class="btn btn-icon btn-ghost" type="button" aria-label="关闭" @click="close">
                    <svg class="icon" aria-hidden="true"><use href="#i-x" /></svg>
                </button>
            </div>
            <div class="dialog-body">
                <div class="field">
                    <label for="prompt-input">{{ promptState.options?.label ?? "内容" }}</label>
                    <input
                        id="prompt-input"
                        ref="inputEl"
                        v-model="value"
                        class="input"
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        :placeholder="promptState.options?.placeholder ?? ''"
                    />
                </div>
            </div>
            <div class="dialog-foot">
                <button class="btn btn-outline" type="button" @click="close">
                    {{ promptState.options?.cancelLabel ?? "取消" }}
                </button>
                <button class="btn btn-primary" type="submit" :disabled="value.trim() === ''">
                    {{ promptState.options?.confirmLabel ?? "确定" }}
                </button>
            </div>
        </form>
    </dialog>
</template>
