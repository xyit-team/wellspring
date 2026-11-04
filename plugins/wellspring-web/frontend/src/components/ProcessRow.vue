<script setup lang="ts">
import { computed, ref } from "vue"

import { formatPayload } from "../logic/tool-payload"
import type { ProcessItem } from "../types"
import MarkdownText from "./MarkdownText.vue"

const props = defineProps<{ item: ProcessItem }>()

const TOOL_LABELS: Record<string, string> = {
    read: "读取文件",
    write: "写入文件",
    delete_file: "删除文件",
    execute_code: "执行命令",
    web_search: "网页搜索",
    web_fetch: "抓取网页",
    query_task: "查询任务",
    stop_task: "停止任务",
    ask: "询问用户",
}

const open = ref(props.item.open === true)

const state = computed(() => {
    if (props.item.kind === "reasoning") return props.item.running === true ? "running" : "ok"
    if (props.item.kind === "steer") return "ok"
    if (props.item.kind === "prepare") return props.item.status ?? "running"
    return props.item.status ?? "running"
})

const icon = computed(() => {
    if (props.item.kind === "reasoning") return "think"
    if (props.item.kind === "steer") return "send"
    return "tool"
})

const title = computed(() => {
    if (props.item.kind === "reasoning") return "思考"
    if (props.item.kind === "steer") return "插话"
    if (props.item.kind === "prepare") return "准备工作区"
    return TOOL_LABELS[props.item.name ?? ""] ?? props.item.name ?? "工具"
})

/** 思考耗时：秒级就够，超过一分钟折成分 */
function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 1) return "不到 1 秒"
    if (seconds < 60) return `${seconds} 秒`
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
}

const reasoningElapsed = computed(() => {
    const { startedAt, endedAt } = props.item
    if (typeof startedAt !== "number" || typeof endedAt !== "number") return ""
    return formatElapsed(endedAt - startedAt)
})

const statusText = computed(() => {
    if (props.item.kind === "reasoning") {
        if (props.item.running === true) return "思考中"
        // 思考完成后显示用了多久，而不是一直挂着「思考中」
        const elapsed = reasoningElapsed.value
        return elapsed === "" ? "已思考" : `思考了 ${elapsed}`
    }
    if (props.item.kind === "steer") return ""
    if (props.item.kind === "prepare") {
        if (state.value === "running") return "准备中"
        if (state.value === "error") return "失败"
        return "完成"
    }
    if (state.value === "running") return "运行中"
    if (state.value === "error") return "失败"
    if (state.value === "stopped") return "已中断"
    return "完成"
})

const summary = computed(() => {
    if (props.item.kind === "reasoning") {
        const text = (props.item.text ?? "").trim()
        const line = text.split("\n").find((item) => item.trim() !== "") ?? ""
        return line.length > 80 ? `${line.slice(0, 80)}…` : line
    }
    if (props.item.kind === "steer") {
        // 摘要只留一行，展开才看完整插话内容
        const text = (props.item.text ?? "").trim()
        return text.length > 80 ? `${text.slice(0, 80)}…` : text
    }
    if (props.item.kind === "prepare") {
        const text = (props.item.text ?? "").trim()
        return text.length > 100 ? `${text.slice(0, 100)}…` : text
    }
    const parts: string[] = []
    const args = (props.item.arguments ?? "").trim()
    if (args !== "") parts.push(args.replace(/\s+/g, " "))
    const result = (props.item.result ?? "").trim()
    if (result !== "") parts.push(result.replace(/\s+/g, " "))
    const text = parts.join(" · ")
    return text.length > 100 ? `${text.slice(0, 100)}…` : text
})

const running = computed(
    () => props.item.running === true || props.item.status === "running",
)

function toggle(): void {
    open.value = !open.value
}
</script>

<template>
    <div class="proc-row" :data-kind="item.kind" :data-state="state" :data-open="open ? 'true' : 'false'">
        <button class="proc-head" type="button" :aria-expanded="open" @click="toggle">
            <span class="proc-icon">
                <svg class="icon icon-sm" aria-hidden="true"><use :href="`#i-${icon}`" /></svg>
            </span>
            <span class="proc-title">{{ title }}</span>
            <span class="proc-summary">
                <span class="proc-summary-text" :data-shimmer="running && item.kind === 'reasoning' ? 'true' : undefined">
                    {{ summary }}
                </span>
            </span>
            <span v-if="statusText !== ''" class="proc-status">{{ statusText }}</span>
            <span class="proc-chevron">
                <svg class="icon icon-xs" aria-hidden="true"><use href="#i-chevron" /></svg>
            </span>
        </button>
        <!--
            折叠用 Grid 0fr→1fr：高度由浏览器自己算，不用 JS 量 scrollHeight，
            内容变高（流式追加、换字号）时也不会错位。
            收起后 visibility: hidden，里面的按钮不会被 Tab 到。
        -->
        <div class="proc-fold" :data-open="open ? 'true' : 'false'">
            <div class="proc-body">
                <template v-if="item.kind === 'reasoning'">
                    <MarkdownText v-if="(item.text ?? '') !== ''" :text="item.text ?? ''" />
                </template>
                <template v-else-if="item.kind === 'steer'">
                    <p class="md">{{ item.text }}</p>
                </template>
                <template v-else>
                    <div v-if="(item.arguments ?? '') !== ''" class="proc-section">
                        <div class="proc-section-title">参数</div>
                        <pre class="proc-pre">{{ formatPayload(item.arguments) }}</pre>
                    </div>
                    <div v-if="(item.result ?? '') !== ''" class="proc-section">
                        <div class="proc-section-title">{{ item.status === 'error' ? '错误' : '结果' }}</div>
                        <pre class="proc-pre">{{ formatPayload(item.result) }}</pre>
                    </div>
                    <p v-if="(item.arguments ?? '') === '' && (item.result ?? '') === ''" class="proc-empty">
                        {{ item.status === "running" ? "正在执行…" : "没有输出" }}
                    </p>
                    <p v-if="item.truncated === true" class="proc-empty">输出过长，只保留了开头部分。</p>
                </template>
            </div>
        </div>
    </div>
</template>
