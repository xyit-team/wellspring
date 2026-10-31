<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"

import { conversationStats } from "../logic/conversations"
import {
    cacheHitPercent,
    formatTokenCount,
    formatTokenCountExact,
    totalTokensOf,
    uncachedInputTokens,
} from "../logic/usage"
import {
    activeConversation,
    closeStats,
    conversationContextInfo,
    conversationUsageTotals,
    formatContextTokens,
    modelLabel,
    statsState,
} from "../store"
import type { TokenUsage } from "../types"

const dialogEl = ref<HTMLDialogElement | null>(null)

const isTurn = computed(() => statsState.kind === "turn")
const conversation = computed(() => activeConversation())
const turn = computed(() => statsState.turn)
const counts = computed(() => conversationStats(conversation.value))
const usage = computed<TokenUsage | null>(() => {
    if (isTurn.value) return turn.value?.usage ?? null
    return conversationUsageTotals(conversation.value)
})

const subtitle = computed(() => {
    if (isTurn.value) {
        const parts: string[] = []
        if (turn.value?.turn !== null && turn.value?.turn !== undefined) {
            parts.push(`第 ${turn.value.turn} 轮`)
        }
        if (turn.value?.model !== undefined && turn.value.model !== "") parts.push(turn.value.model)
        return parts.join(" · ")
    }
    const parts: string[] = []
    if (counts.value !== null) {
        parts.push(`${counts.value.turns} 轮 · ${counts.value.steps} 步`)
    }
    const model = modelLabel(conversation.value)
    if (model !== "模型") parts.push(model)
    return parts.join(" · ")
})

interface StatsRow {
    label: string
    value: string
    emphasis?: boolean
}

/** 上下文占用：真实 prompt tokens 优先，旧会话仍按字符数估算 */
const contextRows = computed((): StatsRow[] => {
    if (isTurn.value) {
        const tokens = turn.value?.usage.contextTokens
        const window = turn.value?.window ?? null
        if (typeof tokens !== "number" || window === null) return []
        return [
            {
                label: "上下文已用",
                value: `${Math.min(100, Math.round((tokens / window) * 100))}%（${formatTokenCount(tokens)} / ${formatTokenCount(window)}）`,
            },
        ]
    }
    const info = conversationContextInfo(conversation.value)
    if (info === null) return []
    return [
        {
            label: "上下文已用",
            value: `${info.percent}%（${formatTokenCount(info.used)} / ${formatTokenCount(info.window)}）${info.estimated ? " · 按字符数估算" : ""}`,
        },
    ]
})

/** Token 明细：缓存命中、未缓存输入、缓存读写、输出、推理与合计 */
const usageRows = computed((): StatsRow[] => {
    const value = usage.value
    if (value === null) return []
    const rows: StatsRow[] = []
    const cachePercent = cacheHitPercent(value)
    if (cachePercent !== null) {
        rows.push({ label: "缓存命中", value: `${cachePercent}%`, emphasis: true })
    }
    const uncached = uncachedInputTokens(value)
    if (uncached !== null) {
        rows.push({ label: "未缓存输入", value: `${formatTokenCountExact(uncached)} tok` })
    }
    if (typeof value.cacheReadTokens === "number") {
        rows.push({ label: "缓存读取", value: `${formatTokenCountExact(value.cacheReadTokens)} tok` })
    }
    if (typeof value.cacheWriteTokens === "number") {
        rows.push({
            label: "缓存写入",
            value: `${formatTokenCountExact(value.cacheWriteTokens)} tok`,
        })
    }
    if (value.outputTokens !== null) {
        rows.push({ label: "输出", value: `${formatTokenCountExact(value.outputTokens)} tok` })
    }
    if (typeof value.reasoningTokens === "number") {
        rows.push({
            label: "其中推理",
            value: `${formatTokenCountExact(value.reasoningTokens)} tok`,
        })
    }
    const total = totalTokensOf(value)
    if (total !== null) {
        rows.push({ label: "合计", value: `${formatTokenCountExact(total)} tok`, emphasis: true })
    }
    return rows
})

const emptyHint = computed(() => {
    if (isTurn.value) return "这次回复没有 token 用量（供应商未返回，或这一轮在产生用量前就被停止）。"
    return "当前会话还没有可统计的 token 用量。"
})

function show(): void {
    if (dialogEl.value !== null && !dialogEl.value.open) dialogEl.value.showModal()
}

watch(
    () => statsState.open,
    (open) => {
        const dialog = dialogEl.value
        if (open) show()
        else if (dialog !== null && dialog.open) dialog.close()
    },
)

onMounted(() => {
    if (statsState.open) show()
})

function close(): void {
    closeStats()
}

function onCancel(event: Event): void {
    event.preventDefault()
    close()
}
</script>

<template>
    <dialog
        ref="dialogEl"
        class="dialog stats-dialog"
        aria-labelledby="stats-title"
        @cancel="onCancel"
        @close="statsState.open && close()"
    >
        <div class="dialog-head">
            <div>
                <h2 id="stats-title">{{ isTurn ? "本轮用量" : "会话统计" }}</h2>
                <p>{{ subtitle }}</p>
            </div>
            <button class="btn btn-icon btn-ghost" type="button" aria-label="关闭" @click="close">
                <svg class="icon" aria-hidden="true"><use href="#i-x" /></svg>
            </button>
        </div>
        <div class="dialog-body">
            <dl v-if="contextRows.length > 0" class="stats-grid stats-context">
                <template v-for="row in contextRows" :key="row.label">
                    <dt>{{ row.label }}</dt>
                    <dd>{{ row.value }}</dd>
                </template>
            </dl>
            <p class="stats-section">Token 用量</p>
            <dl v-if="usageRows.length > 0" class="stats-grid">
                <template v-for="row in usageRows" :key="row.label">
                    <dt>{{ row.label }}</dt>
                    <dd :data-emphasis="row.emphasis === true ? 'true' : undefined">
                        {{ row.value }}
                    </dd>
                </template>
            </dl>
            <p v-else class="stats-note">{{ emptyHint }}</p>
            <p class="stats-note">
                缓存命中率按供应商返回的缓存读取 tokens / prompt tokens 计算；供应商不返回缓存用量时只显示输入与输出。
            </p>
        </div>
        <div class="dialog-foot">
            <button class="btn btn-primary" type="button" @click="close">关闭</button>
        </div>
    </dialog>
</template>
