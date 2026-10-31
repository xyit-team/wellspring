<script setup lang="ts">
import { onMounted, ref, watch } from "vue"

import { confirmState, settleConfirm } from "../store"

const dialogEl = ref<HTMLDialogElement | null>(null)

function show(): void {
    if (dialogEl.value !== null && !dialogEl.value.open) dialogEl.value.showModal()
}

watch(
    () => confirmState.open,
    (open) => {
        const dialog = dialogEl.value
        if (open) show()
        else if (dialog !== null && dialog.open) dialog.close()
    },
)

onMounted(() => {
    if (confirmState.open) show()
})

function close(value: boolean): void {
    settleConfirm(value)
}

function onCancel(event: Event): void {
    event.preventDefault()
    close(false)
}
</script>

<template>
    <dialog ref="dialogEl" class="dialog" aria-labelledby="confirm-title" @cancel="onCancel" @close="confirmState.open && close(false)">
        <div class="dialog-head">
            <div>
                <h2 id="confirm-title">{{ confirmState.options?.title ?? "确认操作" }}</h2>
                <p>{{ confirmState.options?.body ?? "" }}</p>
            </div>
            <button class="btn btn-icon btn-ghost" type="button" aria-label="关闭" @click="close(false)">
                <svg class="icon" aria-hidden="true"><use href="#i-x" /></svg>
            </button>
        </div>
        <div class="dialog-foot">
            <button class="btn btn-outline" type="button" @click="close(false)">
                {{ confirmState.options?.cancelLabel ?? "取消" }}
            </button>
            <button
                class="btn"
                :class="confirmState.options?.danger === true ? 'btn-danger' : 'btn-primary'"
                type="button"
                @click="close(true)"
            >
                {{ confirmState.options?.confirmLabel ?? "确认" }}
            </button>
        </div>
    </dialog>
</template>
