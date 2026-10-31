<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"

import { mdRender } from "../logic/markdown"

const props = withDefaults(defineProps<{ text: string; streaming?: boolean }>(), {
    streaming: false,
})
const host = ref<HTMLElement | null>(null)

/**
 * 上一次渲染到的字符数
 *
 * 流式增量只给“这次新来的那段”加逐字入场：老内容每次重渲染都是纯文本节点，
 * 不会重播动画（重播会让整段正文一闪一闪）。
 */
let renderedChars = 0

/**
 * 合批间隔
 *
 * 逐字入场一个字 90ms，四个字错开 30ms 就排到 180ms。
 * 如果每来一个 token 就整块重渲染，上一批还没播完的 span 会被直接从 DOM 里换掉，
 * 字会在模糊到一半时突然变清晰。所以按 200ms 合批：一批的字播完，下一批才进来。
 */
const FLUSH_MS = 200

/** 每批最多给这么多个字做逐字入场；一批来得太多就只让最后几个字入场，其余直接出现 */
const REVEAL_LIMIT = 4

/** 相邻字的延迟：错开 30ms，一串字才会“晕开”而不是同时闪 */
const REVEAL_STAGGER_MS = 30

let flushTimer = 0

function revealNewChars(host: HTMLElement, from: number): void {
    const total = props.text.length
    if (total <= from) return

    const start = Math.max(from, total - REVEAL_LIMIT)
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    // 每个文本节点记住它在全文里的起点，才能把“第几个字”换算成节点内的下标
    const targets: Array<{ node: Text; absStart: number }> = []
    let index = 0
    let node = walker.nextNode()
    while (node !== null) {
        const length = node.textContent?.length ?? 0
        if (index + length > start) targets.push({ node: node as Text, absStart: index })
        index += length
        if (index >= total) break
        node = walker.nextNode()
    }

    let ord = 0
    for (const target of targets) {
        const textNode = target.node
        const value = textNode.textContent ?? ""
        const localFrom = Math.max(0, start - target.absStart)
        if (localFrom >= value.length) continue

        const fragment = document.createDocumentFragment()
        if (localFrom > 0) fragment.appendChild(document.createTextNode(value.slice(0, localFrom)))
        for (const char of value.slice(localFrom)) {
            const span = document.createElement("span")
            span.className = "tchar"
            span.style.setProperty("--d", `${ord * REVEAL_STAGGER_MS}ms`)
            span.textContent = char
            fragment.appendChild(span)
            ord += 1
        }
        textNode.replaceWith(fragment)
    }
}

function render(): void {
    if (host.value === null) return
    const previous = renderedChars
    host.value.replaceChildren(mdRender(props.text, 0))
    renderedChars = props.text.length
    // 首屏整段渲染不播动画；只有流式追加的那一段才逐字入场
    if (props.streaming && previous > 0 && props.text.length > previous) {
        revealNewChars(host.value, previous)
    }
}

function flush(): void {
    flushTimer = 0
    render()
}

function schedule(): void {
    // 非流式（首屏、定稿）立刻渲染，不欠一帧
    if (!props.streaming) {
        window.clearTimeout(flushTimer)
        flushTimer = 0
        render()
        return
    }
    if (flushTimer !== 0) return
    flushTimer = window.setTimeout(flush, FLUSH_MS)
}

onMounted(render)
watch(() => props.text, schedule)
// 流式结束的那一帧必须立刻补上最后一段，不能等合批
watch(() => props.streaming, (streaming) => {
    if (!streaming) schedule()
})

onBeforeUnmount(() => window.clearTimeout(flushTimer))
</script>

<template>
    <div ref="host" class="md" :class="{ 'is-streaming': streaming }"></div>
</template>
