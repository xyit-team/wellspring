<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"

import AskCard from "../components/AskCard.vue"
import Composer from "../components/Composer.vue"
import ComposerStats from "../components/ComposerStats.vue"
import ExtensionSlot from "../components/ExtensionSlot.vue"
import MessageItem from "../components/MessageItem.vue"
import {
    SUGGESTIONS,
    activeConversation,
    activeStreaming,
    conversationPath,
    copyText,
    exportConversation,
    hiddenCount,
    hiddenRoundCount,
    loadEarlier,
    openConversation,
    pinWindow,
    retryMessage,
    store,
    toast,
} from "../store"

const messagesBox = ref<HTMLElement | null>(null)
const composer = ref<InstanceType<typeof Composer> | null>(null)
const atBottom = ref(true)

const route = useRoute()
const router = useRouter()

const conversation = computed(() => activeConversation())
const hidden = computed(() => hiddenCount(conversation.value))
/** 按钮按轮说话：50 轮的会话被折掉 40 轮，比「还有 83 条」好读 */
const hiddenRounds = computed(() => hiddenRoundCount(conversation.value))
const earlierLabel = computed(() =>
    hiddenRounds.value > 0
        ? `加载更早（还有 ${hiddenRounds.value} 轮）`
        : `加载更早（还有 ${hidden.value} 条）`,
)
const visibleMessages = computed(() => {
    const conv = conversation.value
    if (conv === null) return []
    return conv.messages.slice(hidden.value)
})
const topbarTitle = computed(() => {
    if (store.group === "none") return "未选择工作区"
    const conv = conversation.value
    if (conv !== null && conv.messages.length > 0) return conv.title
    return store.group === "ungrouped" ? "未分组" : "新对话"
})
const topbarMeta = computed(() => {
    if (store.group === "none") return "工作区由你手动添加"
    const conv = conversation.value
    if (conv === null || conv.messages.length === 0) {
        return store.group === "ungrouped"
            ? "未分组"
            : `会话保存在「${store.workspace?.name ?? "工作区"}」`
    }
    const parts = [`${conv.messages.length} 条消息`]
    let turns = 0
    let steps = 0
    let model = ""
    for (const message of conv.messages) {
        if (message.role !== "assistant") continue
        if (typeof message.model === "string" && message.model !== "") model = message.model
        if (typeof message.turn !== "number") continue
        turns += 1
        if (typeof message.steps === "number") steps += message.steps
    }
    if (turns > 0) parts.push(`${turns} 轮 · ${steps} 步`)
    if (model !== "") parts.push(model)
    parts.push("已保存")
    return parts.join(" · ")
})

function scrollToBottom(smooth = false): void {
    const box = messagesBox.value
    if (box === null) return
    box.scrollTo({ top: box.scrollHeight, behavior: smooth ? "smooth" : "auto" })
}

function scheduleScroll(): void {
    void nextTick(() => scrollToBottom(false))
}

/**
 * 打开会话后要停在最新一条
 *
 * 正文由 MarkdownText 在挂载后再渲染，nextTick 时高度还没撑开，滚一次经常落空。
 * 这里在之后两帧各补一次，并用 ResizeObserver 跟着内容高度走。
 */
let stickToBottom = true
let resizeObserver: ResizeObserver | null = null

function pinToBottom(): void {
    stickToBottom = true
    scrollToBottom(false)
    void nextTick(() => scrollToBottom(false))
    requestAnimationFrame(() => {
        scrollToBottom(false)
        requestAnimationFrame(() => scrollToBottom(false))
    })
}

function routeConversationId(): string | null {
    if (route.name !== "conversation") return null
    const raw = route.params.id
    if (typeof raw === "string" && raw !== "") return raw
    if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0] !== "") return raw[0]
    return null
}

/** 地址 → 会话：直达 /c/:id、刷新、浏览器前进后退都按 URL 选中会话 */
async function applyRouteConversation(): Promise<void> {
    const id = routeConversationId()
    if (id === null || store.activeId === id) return
    if (await openConversation(id)) return
    toast("会话不存在或已被删除", "warn")
    void router.replace("/")
}

/** 会话 → 地址：切换会话或发出第一条消息后，把地址换成 /c/:id */
function syncRouteToConversation(): void {
    const id = store.activeId
    const conv = store.conversations.find((item) => item.id === id)
    if (route.name === "chat") {
        // 新会话在发第一条消息之前没有可恢复的地址，留在 /
        if (conv !== undefined && conv.messages.length > 0) {
            void router.replace(conversationPath(conv))
        }
        return
    }
    if (route.name !== "conversation") return
    if (id === routeConversationId()) return
    if (conv !== undefined && conv.messages.length > 0) {
        void router.replace(conversationPath(conv))
    } else {
        void router.replace("/")
    }
}

watch(
    () => routeConversationId(),
    (id) => {
        if (id !== null) void applyRouteConversation()
    },
    { immediate: true },
)
/*
 * 不 immediate：首次进入页面时不要从 / 自动跳到上次的会话地址，
 * 否则浏览器后退会立刻被补回去，用户永远退不出会话。只在切换会话 /
 * 发出第一条消息后同步地址。
 */
watch(() => [store.activeId, conversation.value?.messages.length ?? 0] as const, syncRouteToConversation)

/*
 * 切到/打开会话时按默认窗口钉一次折叠起点
 *
 * 只在会话 id 变化时钉，不跟着消息条数走：默认窗口盯着最近 N 轮，
 * 消息一多起点就往后挪，正在读的旧轮会被当场收起来。
 * 不 immediate：首帧会话可能还没加载出来，等它出现时 id 从 null 变成真实 id 会再触发一次。
 */
watch(() => conversation.value?.id ?? null, () => pinWindow(conversation.value))

watch(
    () => [store.group, store.activeId],
    pinToBottom,
)
watch(
    // 换会话、换分组后消息数量变化：停在最新
    () => conversation.value?.messages.length ?? 0,
    () => {
        if (stickToBottom) pinToBottom()
    },
)
watch(
    () => activeStreaming()?.text,
    () => {
        if (stickToBottom) scheduleScroll()
    },
)

function onMessagesScroll(): void {
    const box = messagesBox.value
    if (box === null) return
    const gap = box.scrollHeight - box.scrollTop - box.clientHeight
    atBottom.value = gap < 120
    // 用户自己往上翻就别再拽回底部
    stickToBottom = gap < 160
}

onMounted(() => {
    pinToBottom()
    const box = messagesBox.value
    if (box === null || typeof ResizeObserver !== "function") return
    // 正文是后渲染的：内容变高时补一次贴底
    resizeObserver = new ResizeObserver(() => {
        if (stickToBottom) scrollToBottom(false)
    })
    const inner = box.firstElementChild
    if (inner !== null) resizeObserver.observe(inner)
})

onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
})

async function onCopy(text: string): Promise<void> {
    await copyText(text)
}

async function onRetry(index: number): Promise<void> {
    await retryMessage(conversation.value, index)
}

/**
 * 加载更早的内容而不丢视线
 *
 * 新消息插在顶部，scrollHeight 会变高；不补偿的话用户视口会往下跳一段，
 * 刚才读的那一行直接跑掉了。这里把多出来的高度补回 scrollTop。
 */
async function onLoadEarlier(): Promise<void> {
    const box = messagesBox.value
    const conv = conversation.value
    if (box === null || conv === null) return
    const before = box.scrollHeight
    const offset = box.scrollTop
    loadEarlier(conv)
    await nextTick()
    box.scrollTop = offset + (box.scrollHeight - before)
}

function onExport(): void {
    exportConversation(conversation.value)
}

function fillSuggestion(prompt: string): void {
    const node = document.getElementById("composer-input") as HTMLTextAreaElement | null
    if (node === null) return
    node.value = prompt
    node.focus()
    composer.value?.focus()
}

function emptyCopy(): string {
    if (store.group === "none") return "先添加一个工作区，Agent 会在该目录下读代码、执行命令。"
    if (store.group === "ungrouped") return "未分组里没有可继续的会话。"
    return "Agent 会在当前工作区里读代码、执行命令、查资料。回复流式返回，会话按工作区保存。"
}

</script>

<template>
    <main class="main">
        <header class="topbar">
            <button
                class="btn btn-icon btn-ghost only-mobile"
                type="button"
                aria-label="打开会话列表"
                @click="store.sidebarOpen = true"
            >
                <svg class="icon" aria-hidden="true"><use href="#i-menu" /></svg>
            </button>
            <div class="topbar-title">
                <h1>{{ topbarTitle }}</h1>
                <p>{{ topbarMeta }}</p>
            </div>
            <div class="topbar-actions">
                <ExtensionSlot name="topbar.actions" />
                <button
                    class="btn btn-icon btn-ghost"
                    type="button"
                    aria-label="导出当前会话为 Markdown"
                    title="导出为 Markdown"
                    :disabled="conversation === null || conversation.messages.length === 0"
                    @click="onExport"
                >
                    <svg class="icon" aria-hidden="true"><use href="#i-download" /></svg>
                </button>
            </div>
        </header>
        <div
            class="messages"
            ref="messagesBox"
            role="log"
            aria-label="对话消息"
            tabindex="0"
            @scroll.passive="onMessagesScroll"
        >
            <div class="messages-inner">
                <button
                    v-if="hidden > 0 && conversation"
                    class="load-earlier"
                    type="button"
                    @click="onLoadEarlier"
                >
                    <span class="load-earlier-btn">{{ earlierLabel }}</span>
                </button>
                <template v-if="visibleMessages.length === 0">
                    <div class="empty">
                        <div class="empty-head">
                            <span class="mark mark-lg">
                                <svg class="icon icon-lg" aria-hidden="true"><use href="#i-spring" /></svg>
                            </span>
                            <h2 class="empty-title">{{ store.group === "none" ? "还没有工作区" : "有什么可以帮忙的？" }}</h2>
                        </div>
                        <p class="empty-copy">{{ emptyCopy() }}</p>
                        <div class="suggestions" v-if="store.group === 'workspace'">
                            <button
                                v-for="suggestion in SUGGESTIONS"
                                :key="suggestion.label"
                                id="suggestion"
                                class="suggestion"
                                type="button"
                                @click="fillSuggestion(suggestion.prompt)"
                            >
                                <svg class="icon" aria-hidden="true"><use :href="`#i-${suggestion.icon}`" /></svg>
                                <span class="label">{{ suggestion.label }}</span>
                                <span class="desc">{{ suggestion.desc }}</span>
                            </button>
                        </div>
                    </div>
                </template>
                <MessageItem
                    v-for="(message, index) of visibleMessages"
                    :key="`${conversation?.id}-${hidden + index}`"
                    :message="message"
                    :streaming="message === activeStreaming()"
                    :is-last="index === visibleMessages.length - 1"
                    @copy="onCopy"
                    @retry="onRetry(hidden + index)"
                />
            </div>
        </div>
        <div class="composer-wrap">
            <ExtensionSlot name="composer.above" />
            <button
                v-if="!atBottom"
                class="scroll-bottom"
                type="button"
                aria-label="回到底部"
                @click="scrollToBottom(true)"
            >
                <svg class="icon icon-sm" aria-hidden="true"><use href="#i-arrow-down" /></svg>
            </button>
            <AskCard />
            <Composer ref="composer" />
            <ComposerStats />
        </div>
    </main>
</template>
