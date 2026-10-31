<script setup lang="ts">
import { computed, ref } from "vue"

import { answerAsk, store } from "../store"

const custom = ref("")
const options = computed(() => store.ask?.options ?? [])

function choose(option: string): void {
    custom.value = option
}

function submit(answer?: string): void {
    void answerAsk(answer ?? custom.value)
}
</script>

<template>
    <section v-if="store.ask" class="ask-card" aria-labelledby="ask-question">
        <header class="ask-head">
            <div class="ask-heading">
                <p class="ask-eyebrow">Agent 提问</p>
                <h2 class="ask-question" id="ask-question">{{ store.ask.question }}</h2>
            </div>
            <div class="ask-head-actions">
                <button class="btn btn-icon btn-ghost" type="button" aria-label="跳过并关闭" @click="submit(null)">
                    <svg class="icon" aria-hidden="true"><use href="#i-x" /></svg>
                </button>
            </div>
        </header>
        <div class="ask-body">
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
        <footer class="ask-foot">
            <div class="ask-actions">
                <button class="btn btn-outline" type="button" @click="submit(null)">跳过</button>
                <button class="btn btn-primary" type="button" :disabled="custom.trim() === ''" @click="submit()">回答</button>
            </div>
        </footer>
    </section>
</template>
