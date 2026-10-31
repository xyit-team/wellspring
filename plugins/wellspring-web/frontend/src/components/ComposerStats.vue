<script setup lang="ts">
import { computed } from "vue"

import { cacheHitPercent, formatTokenCount, totalTokensOf } from "../logic/usage"
import {
    activeConversation,
    conversationContextInfo,
    conversationUsageTotals,
    formatContextTokens,
    openSessionStats,
} from "../store"

/** 输入框下方的一行统计：上下文占用 / 会话用量 / 缓存命中率 */

const conversation = computed(() => activeConversation())
const context = computed(() => conversationContextInfo(conversation.value))
const totals = computed(() => conversationUsageTotals(conversation.value))
const totalTokens = computed(() => totalTokensOf(totals.value))
const cacheHit = computed(() => cacheHitPercent(totals.value))

const tone = computed(() => {
    const percent = context.value?.percent ?? 0
    return percent >= 90 ? "danger" : percent >= 75 ? "warn" : "ok"
})
/** 占用条填充比例（0–1）；超过 100% 时钉在满格 */
const ratio = computed(() => Math.min(1, Math.max(0, (context.value?.percent ?? 0) / 100)))
const visible = computed(
    () => context.value !== null || totalTokens.value !== null || cacheHit.value !== null,
)
const title = computed(() => (visible.value ? "查看会话 Token 统计（上下文占用与缓存命中）" : ""))

const contextDetail = computed(() => {
    const info = context.value
    if (info === null) return ""
    const detail = `${formatContextTokens(info.used)} / ${formatContextTokens(info.window)} tokens`
    return info.estimated
        ? `上下文估算 ${info.percent}%（${detail}，按字符数估算）`
        : `上下文已用 ${info.percent}%（${detail}）`
})

function open(): void {
    openSessionStats()
}
</script>

<template>
    <button
        v-if="visible"
        class="composer-stats"
        type="button"
        :title="title"
        :aria-label="title"
        @click="open"
    >
        <span
            v-if="context !== null"
            class="composer-stats-context"
            :data-tone="tone"
            :title="contextDetail"
        >
            <span class="meter-bar" aria-hidden="true">
                <span class="meter-bar-fill" :style="{ transform: `scaleX(${ratio})` }"></span>
            </span>
            <span>{{ context.estimated ? "估算" : "上下文" }} {{ context.percent }}%</span>
        </span>
        <span v-if="context !== null && totalTokens !== null" class="composer-stats-sep" aria-hidden="true">·</span>
        <span v-if="totalTokens !== null" class="composer-stats-tokens">
            会话用量 {{ formatTokenCount(totalTokens) }} tok
        </span>
        <span v-if="cacheHit !== null" class="composer-stats-sep" aria-hidden="true">·</span>
        <span v-if="cacheHit !== null" class="composer-stats-cache">缓存命中 {{ cacheHit }}%</span>
    </button>
</template>
