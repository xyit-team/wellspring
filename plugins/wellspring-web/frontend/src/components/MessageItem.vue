<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue"

import { formatUsageBadge } from "../logic/usage"
import { messageBlocks } from "../logic/message-blocks"
import { openTurnStats } from "../store"
import type { MarkdownMessage } from "../types"
import MarkdownText from "./MarkdownText.vue"
import ProcessRow from "./ProcessRow.vue"

const props = defineProps<{
    message: MarkdownMessage
    streaming: boolean
    isLast: boolean
}>()

const emit = defineEmits<{ copy: [text: string]; retry: [] }>()

/** 正文与思考/工具行按 at（发生时的正文字符偏移）穿插，和旧版渲染顺序一致 */
const blocks = computed(() => messageBlocks(props.message.text ?? "", props.message.process ?? []))

const lastMarkdownIndex = computed(() => {
    for (let index = blocks.value.length - 1; index >= 0; index -= 1) {
        if (blocks.value[index]?.type === "md") return index
    }
    return -1
})

const meta = computed(() => {
    const message = props.message
    const parts: string[] = []
    if (typeof message.model === "string" && message.model !== "") parts.push(message.model)
    if (typeof message.turn === "number") parts.push(`第 ${message.turn} 轮`)
    if (typeof message.steps === "number") parts.push(`${message.steps} 步`)
    return parts
})

const hasText = computed(() => blocks.value.some((block) => block.type === "md" && block.text !== ""))

/** 回复下方的用量摘要：`用量 12.3K · 缓存 85%`；没有真实用量时不显示 */
const usageLabel = computed(() => (props.streaming ? null : formatUsageBadge(props.message.usage)))

function openUsage(): void {
    openTurnStats(props.message)
}

/*
 * 复制反馈：成功后按钮换成对勾，2.5 秒后自己淡出恢复。
 * 不用 toast 追着报「已复制」——按钮本身就在手指底下，它变色比弹一条提示快。
 */
const COPY_RESET_MS = 2500
const copied = ref(false)
let copyTimer = 0

function onCopy(): void {
    emit("copy", props.message.text)
    copied.value = true
    window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
        copied.value = false
    }, COPY_RESET_MS)
}

onBeforeUnmount(() => window.clearTimeout(copyTimer))
</script>

<template>
    <article
        class="msg"
        :class="message.role === 'user' ? 'msg-user' : 'msg-assistant'"
        :data-settled="streaming ? undefined : 'true'"
    >
        <span v-if="message.role === 'assistant'" class="msg-avatar" aria-hidden="true">
            <svg class="icon" aria-hidden="true"><use href="#i-spring" /></svg>
        </span>
        <div class="msg-body">
            <div v-if="message.role === 'assistant' && meta.length > 0" class="msg-meta">
                <span class="name">Agent</span>
                <span v-if="typeof message.model === 'string' && message.model !== ''" class="model">
                    {{ message.model }}
                </span>
                <template v-for="(part, index) in meta.slice(1)" :key="index">
                    <span class="sep">·</span>
                    <span>{{ part }}</span>
                </template>
            </div>

            <template v-if="message.role === 'user'">
                <div class="msg-bubble">{{ message.text }}</div>
            </template>
            <template v-else>
                <div class="msg-content">
                    <template v-for="(block, index) in blocks" :key="index">
                        <ProcessRow v-if="block.type === 'proc'" :item="block.item" />
                        <MarkdownText
                            v-else-if="block.text !== ''"
                            :text="block.text"
                            :streaming="streaming && index === lastMarkdownIndex"
                        />
                    </template>
                    <p v-if="!hasText && streaming" class="proc-empty">正在回复…</p>
                </div>
            </template>

            <p v-if="message.error" class="msg-error-box">
                {{ typeof message.error === "string" ? message.error : "回复失败" }}
            </p>
            <p v-if="message.stopped" class="msg-stopped">已停止</p>

            <button
                v-if="message.role === 'assistant' && usageLabel !== null"
                class="msg-usage"
                type="button"
                title="查看本轮 token 用量与缓存命中"
                @click="openUsage"
            >
                <svg class="icon icon-xs" aria-hidden="true"><use href="#i-chart" /></svg>
                <span>{{ usageLabel }}</span>
            </button>

            <div class="msg-actions" :data-pinned="message.error ? 'true' : undefined">
                <button
                    v-if="message.text !== ''"
                    class="btn btn-ghost"
                    type="button"
                    :data-copied="copied ? 'true' : undefined"
                    :aria-label="copied ? '已复制' : '复制这条回复'"
                    @click="onCopy"
                >
                    <svg class="icon icon-sm" aria-hidden="true">
                        <use :href="copied ? '#i-check' : '#i-copy'" />
                    </svg>
                    <span>{{ copied ? "已复制" : "复制" }}</span>
                </button>
                <button v-if="message.error && isLast" class="btn btn-ghost" type="button" @click="emit('retry')">
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-refresh" /></svg>
                    <span>重试</span>
                </button>
            </div>
        </div>
    </article>
</template>
