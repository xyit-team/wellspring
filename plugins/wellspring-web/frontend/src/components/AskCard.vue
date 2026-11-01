<script setup lang="ts">
import { computed, ref, watch } from "vue"

import { answerAsk, store } from "../store"

const custom = ref("")
const options = computed(() => store.ask?.options ?? [])

/*
 * 换下一问时清空草稿
 *
 * AskCard 常驻挂载（只在内层 section 上 v-if），custom 会跨提问保留，
 * 下一问点「跳过」就会带上上一轮输入过的答案。按 ask 对象身份比对，
 * askId 缺失时同样能触发。
 */
watch(
    () => store.ask,
    () => {
        custom.value = ""
    },
)

function choose(option: string): void {
    custom.value = option
}

// 折叠只作用在本组件，问题抬头始终可见
function toggleMinimized(): void {
    store.askMinimized = !store.askMinimized
}

/** null = 跳过（回传空答案），字符串 = 用户答案 */
function submit(answer: string | null): void {
    custom.value = ""
    void answerAsk(answer)
}
</script>

<template>
    <section
        v-if="store.ask"
        class="ask-card"
        :data-minimized="store.askMinimized ? 'true' : undefined"
        aria-labelledby="ask-question"
    >
        <header class="ask-head">
            <div class="ask-heading">
                <p class="ask-eyebrow">Agent 提问</p>
                <h2 class="ask-question" id="ask-question">{{ store.ask.question }}</h2>
            </div>
            <div class="ask-head-actions">
                <button
                    class="btn btn-icon btn-ghost"
                    type="button"
                    :aria-expanded="!store.askMinimized"
                    :aria-label="store.askMinimized ? '展开提问' : '收起提问'"
                    :title="store.askMinimized ? '展开提问' : '收起提问'"
                    @click="toggleMinimized"
                >
                    <svg class="icon" aria-hidden="true">
                        <use :href="store.askMinimized ? '#i-chevron-down' : '#i-chevron'" />
                    </svg>
                </button>
                <button class="btn btn-icon btn-ghost" type="button" aria-label="跳过并关闭" @click="submit(null)">
                    <svg class="icon" aria-hidden="true"><use href="#i-x" /></svg>
                </button>
            </div>
        </header>
        <div v-if="!store.askMinimized" class="ask-body">
            <div class="ask-options" role="radiogroup" aria-label="候选答案">
                <button
                    v-for="(option, index) in options"
                    :key="index"
                    class="ask-option"
                    type="button"
                    :data-selected="custom === option"
                    @click="choose(option)"
                >
                    <span class="ask-number">{{ index + 1 }}</span>
                    <span>{{ option }}</span>
                </button>
            </div>
            <div class="ask-custom">
                <textarea v-model="custom" class="ask-input" rows="1" maxlength="8000" placeholder="输入你的答案"></textarea>
            </div>
        </div>
        <footer v-if="!store.askMinimized" class="ask-foot">
            <div class="ask-actions">
                <button class="btn btn-outline" type="button" @click="submit(null)">跳过</button>
                <button class="btn btn-primary" type="button" :disabled="custom.trim() === ''" @click="submit(custom)">回答</button>
            </div>
        </footer>
    </section>
</template>
