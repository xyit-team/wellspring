<script setup lang="ts">
import { computed, ref } from "vue"

import type { ProcessItem } from "../types"
import ProcessRow from "./ProcessRow.vue"

const props = defineProps<{ items: readonly ProcessItem[] }>()

// 完成后出现，默认收起
const open = ref(false)

// 思考耗时文案：超过一分钟折成分
function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 1) return "不到 1 秒"
    if (seconds < 60) return `${seconds} 秒`
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
}

const summary = computed(() => {
    let reasoning = 0
    let tools = 0
    let thinkingMs = 0
    for (const item of props.items) {
        if (item.kind === "reasoning") {
            reasoning += 1
            if (typeof item.startedAt === "number" && typeof item.endedAt === "number") {
                thinkingMs += Math.max(0, item.endedAt - item.startedAt)
            }
            continue
        }
        if (item.kind === "tool") tools += 1
    }
    const parts: string[] = []
    if (reasoning > 0) parts.push(`思考 ${reasoning} 段`)
    if (tools > 0) parts.push(`调用 ${tools} 次`)
    if (thinkingMs > 0) parts.push(formatElapsed(thinkingMs))
    return parts.length === 0 ? `${props.items.length} 步` : parts.join(" · ")
})

function toggle(): void {
    open.value = !open.value
}
</script>

<template>
    <div class="proc-group" :data-open="open ? 'true' : 'false'">
        <button class="proc-head proc-group-head" type="button" :aria-expanded="open" @click="toggle">
            <span class="proc-icon">
                <svg class="icon icon-sm" aria-hidden="true"><use href="#i-think" /></svg>
            </span>
            <span class="proc-title">步骤</span>
            <span class="proc-summary">
                <span class="proc-summary-text">{{ summary }}</span>
            </span>
            <span class="proc-status">{{ open ? "收起" : "展开" }}</span>
            <span class="proc-chevron">
                <svg class="icon icon-xs" aria-hidden="true"><use href="#i-chevron" /></svg>
            </span>
        </button>
        <div class="proc-fold" :data-open="open ? 'true' : 'false'">
            <div class="proc-body proc-group-body">
                <ProcessRow v-for="(item, index) in items" :key="index" :item="item" />
            </div>
        </div>
    </div>
</template>
