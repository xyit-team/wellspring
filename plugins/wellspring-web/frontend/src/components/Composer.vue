<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useRouter } from "vue-router"

import { apiJson } from "../api"
import { MAX_MESSAGE_CHARS } from "../logic/conversations"
import { mentionRanges } from "../logic/mentions"
import {
    PERMISSIONS,
    SEND_MODES,
    UNGROUPED,
    activeBusy,
    activeConversation,
    addWorkspace,
    chooseModel,
    chooseReasoning,
    confirmDialog,
    conversationSettings,
    contextWindowOf,
    cycleTheme,
    exportConversation,
    findProvider,
    formatContextTokens,
    loadModels,
    modelLabel,
    modelsState,
    newConversation,
    rememberReference,
    savePermission,
    saveSendMode,
    stopGeneration,
    store,
    submitMessage,
    toast,
} from "../store"

interface TriggerEntry {
    path: string
    type: "file" | "directory"
}

interface TriggerItem {
    badge: string
    label: string
    description: string
    disabled?: boolean
    entry?: TriggerEntry
    run?: () => void
}

const router = useRouter()

const SLASH_COMMANDS: Array<{ name: string; description: string; run: () => void }> = [
    { name: "new", description: "新建会话", run: () => newConversation() },
    { name: "stop", description: "停止当前回复", run: () => stopGeneration() },
    {
        name: "export",
        description: "导出当前会话为 Markdown",
        run: () => exportConversation(activeConversation()),
    },
    { name: "status", description: "查看宿主与插件状态", run: () => void router.push("/status") },
    { name: "theme", description: "切换主题", run: () => cycleTheme() },
    { name: "workspace", description: "添加工作区", run: () => void addWorkspace() },
    { name: "help", description: "查看可用指令", run: () => showSlashHelp() },
]

const input = ref<HTMLTextAreaElement | null>(null)
/**
 * 触摸为主的设备（手机/平板）
 *
 * 手机软键盘没有 Shift 键，而桌面端约定是 Enter 换行、Shift+Enter 发送。
 * 所以在粗指针设备上改成 Enter 直接发送（与主流聊天应用一致），
 * enterkeyhint 也跟着换成「发送」，键盘右下角那颗键的语义才对得上。
 */
const coarsePointer = ref(false)
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const query = window.matchMedia("(pointer: coarse)")
    coarsePointer.value = query.matches
    query.addEventListener("change", (event) => {
        coarsePointer.value = event.matches
    })
}
const highlightBox = ref<HTMLElement | null>(null)
const permissionOpen = ref(false)
const modelOpen = ref(false)
const sendKeyOpen = ref(false)
const draft = computed({
    get: () => store.draft,
    set: (value: string) => {
        store.draft = value
    },
})

/**
 * 实际生效的发送键
 *
 * 触摸为主的设备没有 Shift / Ctrl 的稳定入口（软键盘只有一颗回车），
 * 所以粗指针设备上一律按「Enter 发送」走，配置只对桌面键盘生效。
 * 这样手机上不会出现「按了回车只换行、却找不到发送键」的死角。
 */
const sendMode = computed(() => (coarsePointer.value ? "enter" : store.sendMode))
const sendModeInfo = computed(() => SEND_MODES[sendMode.value])
/** 提示行里的按键文案：发送键在忙时会变成插话 */
const sendKeys = computed(() => sendModeInfo.value.keys)

const menuKind = ref<"mention" | "slash" | null>(null)
const menuTitle = ref("")
const menuItems = ref<TriggerItem[]>([])
const menuIndex = ref(0)
const range = ref({ start: 0, end: 0 })
/** Esc 停止需要连按两次（第一次只提示），避免误触把回合砍掉 */
let stopArmed = false
let stopArmTimer = 0
let searchTimer = 0
let searchSeq = 0

const canSend = computed(
    () => store.group !== "none" && (store.group !== UNGROUPED || store.conversations.length > 0),
)
/** 只反映当前会话：别的会话在跑不影响这里的发送/插话切换 */
const busy = computed(() => activeBusy())
const sendLabel = computed(() => (busy.value ? "插话" : "发送"))
const permissionLabel = computed(() => {
    const value = store.permission
    return value === "read-only"
        ? "只读"
        : value === "danger-full-access"
          ? "完全访问"
          : "工作区可写"
})
const modelText = computed(() => modelLabel(activeConversation()))
const reasoningLevels = computed(() =>
    Array.isArray(modelsState.models?.reasoningLevels)
        ? modelsState.models.reasoningLevels
        : ["off", "low", "high", "max"],
)
const providerGroups = computed(() => modelsState.models?.providers ?? [])

/** 草稿里的 @ 引用区间 → 高亮片段（textarea 文本透明层，只给引用加底色） */
const highlightSegments = computed(() => {
    const text = draft.value
    const ranges = mentionRanges(text)
    if (ranges.length === 0) return [{ text, ref: false, active: false }]
    const segments: Array<{ text: string; ref: boolean; active: boolean }> = []
    let from = 0
    for (const item of ranges) {
        if (item.start > from)
            segments.push({ text: text.slice(from, item.start), ref: false, active: false })
        segments.push({ text: text.slice(item.start, item.end), ref: true, active: false })
        from = item.end
    }
    if (from < text.length) segments.push({ text: text.slice(from), ref: false, active: false })
    return segments
})

function syncHighlightScroll(): void {
    const node = input.value
    const box = highlightBox.value
    if (node === null || box === null) return
    box.scrollTop = node.scrollTop
}

function autoGrow(): void {
    const node = input.value
    if (node === null) return
    node.style.height = "auto"
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`
    syncHighlightScroll()
}

// 草稿由 store 回填，不经过 onInput，回填后重新量高
watch(draft, () => {
    void nextTick(autoGrow)
})

function mentionRoot(): { workspaceId: string } | { workspaceRoot: string } | null {
    if (store.group === "workspace" && store.workspace !== null) {
        return { workspaceId: store.workspace.id }
    }
    if (store.group === UNGROUPED) {
        const conv = activeConversation()
        if (conv !== null && conv.workspaceRoot !== null)
            return { workspaceRoot: conv.workspaceRoot }
    }
    return null
}

function isTriggerBoundary(text: string, index: number): boolean {
    if (index === 0) return true
    const previous = text.charAt(index - 1)
    if (prevBoundary(previous)) return true
    return /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(
        previous,
    )
}

function prevBoundary(character: string): boolean {
    if (character === "") return true
    if (/\s/.test(character)) return true
    return ",;:!?()[]{}<>\"'，。；：！？、（）【】《》「」『』“”‘’…—～·".includes(character)
}

function triggerContext(): {
    kind: "mention" | "slash"
    query: string
    start: number
    end: number
} | null {
    const node = input.value
    if (node === null) return null
    const value = node.value
    const start = typeof node.selectionStart === "number" ? node.selectionStart : value.length
    const end = typeof node.selectionEnd === "number" ? node.selectionEnd : start
    if (start !== end) return null
    const before = value.slice(0, start)
    const at = before.lastIndexOf("@")
    if (at !== -1) {
        const token = before.slice(at)
        if (!/\s/.test(token) && isTriggerBoundary(before, at)) {
            return {
                kind: "mention",
                query: token.slice(1),
                start: start - token.length,
                end: start,
            }
        }
    }
    const slashMatch = /(^|\s)\/([^\s]*)$/.exec(before)
    if (slashMatch === null) return null
    return {
        kind: "slash",
        query: slashMatch[2] ?? "",
        start: start - (1 + (slashMatch[2]?.length ?? 0)),
        end: start,
    }
}

function buildSlashItems(query: string): TriggerItem[] {
    const needle = query.toLowerCase()
    const items: TriggerItem[] = []
    for (const command of SLASH_COMMANDS) {
        if (
            needle !== "" &&
            !command.name.toLowerCase().includes(needle) &&
            !command.description.toLowerCase().includes(needle)
        ) {
            continue
        }
        items.push({
            badge: "/",
            label: `/${command.name}`,
            description: command.description,
            run: command.run,
        })
    }
    return items
}

function openMenu(
    kind: "mention" | "slash",
    items: TriggerItem[],
    title: string,
    context: { start: number; end: number },
): void {
    menuKind.value = kind
    menuItems.value = items
    menuTitle.value = title
    range.value = { start: context.start, end: context.end }
    menuIndex.value = firstEnabled(0)
}

function firstEnabled(from: number): number {
    const items = menuItems.value
    for (let i = 0; i < items.length; i += 1) {
        const index = (from + i) % items.length
        if (items[index]?.disabled !== true) return index
    }
    return -1
}

function closeMenu(): void {
    menuKind.value = null
    menuItems.value = []
    menuIndex.value = 0
    if (searchTimer !== 0) {
        window.clearTimeout(searchTimer)
        searchTimer = 0
    }
}

function refreshTrigger(): void {
    if (menuKind.value !== null && menuKind.value === "mention") {
        // 继续输入时保持菜单，只重算区间；下面统一重建
    }
    const context = triggerContext()
    if (context === null) {
        closeMenu()
        return
    }
    if (context.kind === "slash") {
        const items = buildSlashItems(context.query)
        if (items.length === 0) {
            closeMenu()
            return
        }
        openMenu("slash", items, "指令", context)
        return
    }
    if (mentionRoot() === null) {
        closeMenu()
        return
    }
    openMenu(
        "mention",
        [{ badge: "…", label: "正在搜索工作区文件…", description: "", disabled: true }],
        "文件与文件夹",
        context,
    )
    scheduleSearch(context.query)
}

function scheduleSearch(query: string): void {
    if (searchTimer !== 0) window.clearTimeout(searchTimer)
    const seq = ++searchSeq
    searchTimer = window.setTimeout(async () => {
        searchTimer = 0
        const root = mentionRoot()
        if (root === null) {
            closeMenu()
            return
        }
        const params =
            "workspaceId" in root
                ? `workspaceId=${encodeURIComponent(root.workspaceId)}`
                : `workspaceRoot=${encodeURIComponent(root.workspaceRoot)}`
        try {
            const data = await apiJson<{ entries?: TriggerEntry[]; truncated?: boolean }>(
                `/api/files?${params}&q=${encodeURIComponent(query)}`,
            )
            if (seq !== searchSeq || menuKind.value !== "mention") return
            const entries = Array.isArray(data.entries) ? data.entries : []
            const items: TriggerItem[] = entries.map((entry) => ({
                badge: entry.type === "directory" ? "folder" : "file",
                label: entry.path + (entry.type === "directory" ? "/" : ""),
                description:
                    entry.type === "directory"
                        ? "目录"
                        : entry.path.lastIndexOf("/") <= 0
                          ? "工作区根目录"
                          : entry.path.slice(0, entry.path.lastIndexOf("/")),
                entry,
            }))
            if (items.length === 0) {
                items.push({
                    badge: "?",
                    label: "没有匹配的文件",
                    description: "试试文件名片段、目录名，或带 / 的路径片段",
                    disabled: true,
                })
            }
            menuItems.value = items
            menuIndex.value = firstEnabled(0)
            menuTitle.value =
                data.truncated === true
                    ? "文件与文件夹（结果较多，继续输入筛选）"
                    : "文件与文件夹（Enter 插入，Esc 关闭）"
        } catch {
            if (seq !== searchSeq || menuKind.value !== "mention") return
            menuItems.value = [
                { badge: "!", label: "读取工作区文件失败", description: "", disabled: true },
            ]
            menuIndex.value = -1
        }
    }, 120)
}

function replaceToken(text: string): void {
    const node = input.value
    if (node === null) return
    const value = node.value
    const next = value.slice(0, range.value.start) + text + value.slice(range.value.end)
    if (next.length > MAX_MESSAGE_CHARS) {
        toast(`消息超过 ${MAX_MESSAGE_CHARS} 字符上限`, "warn")
        return
    }
    draft.value = next
    const position = range.value.start + text.length
    void nextTick(() => {
        node.value = next
        node.setSelectionRange(position, position)
        autoGrow()
    })
}

function selectItem(index: number): void {
    const kind = menuKind.value
    const item = menuItems.value[index]
    if (kind === null || item === undefined || item.disabled === true) return
    if (kind === "slash") {
        replaceToken("")
        closeMenu()
        item.run?.()
        return
    }
    const entry = item.entry
    if (entry === undefined) return
    const path = entry.type === "directory" ? `${entry.path}/` : entry.path
    if (/[\u0000-\u001f\u007f"]/.test(path)) {
        toast("这个路径含有无法写入消息的字符", "warn")
        return
    }
    const mention = /\s/.test(path) ? `@"${path}"` : `@${path}`
    if (entry.type === "directory") {
        replaceToken(mention)
        refreshTrigger()
        return
    }
    rememberReference(entry.path)
    replaceToken(`${mention} `)
    closeMenu()
    input.value?.focus()
}

function moveSelection(delta: number): void {
    if (menuItems.value.length === 0) return
    let index = menuIndex.value
    for (let step = 0; step < menuItems.value.length; step += 1) {
        index = (index + delta + menuItems.value.length) % menuItems.value.length
        if (menuItems.value[index]?.disabled !== true) {
            menuIndex.value = index
            return
        }
    }
}

function showSlashHelp(): void {
    const node = input.value
    const position = typeof node?.selectionStart === "number" ? node.selectionStart : 0
    openMenu("slash", buildSlashItems(""), "指令（Enter 执行，Esc 关闭）", {
        start: position,
        end: position,
    })
}

async function submit(): Promise<void> {
    const node = input.value
    if (node === null) return
    const text = draft.value
    if (text.trim() === "") {
        node.focus()
        return
    }
    closeMenu()
    /*
     * 立刻清空输入框，不要等 submitMessage（它要等整轮流式跑完）：
     * 否则发送后草稿会一直留在框里，而这一轮结束时又会把用户中途敲的新内容一起清掉。
     */
    draft.value = ""
    node.value = ""
    autoGrow()
    node.focus()
    const accepted = await submitMessage(text)
    // 校验失败（超长 / 没有工作区）时把文本还回去，但不要覆盖用户这期间新输入的内容
    if (!accepted && draft.value === "") {
        draft.value = text
        node.value = text
        autoGrow()
        await nextTick()
        node.focus()
    }
}

function onInput(): void {
    const node = input.value
    if (node !== null) draft.value = node.value
    autoGrow()
    refreshTrigger()
}

function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return
    if (menuKind.value !== null) {
        if (event.key === "ArrowDown") {
            event.preventDefault()
            moveSelection(1)
            return
        }
        if (event.key === "ArrowUp") {
            event.preventDefault()
            moveSelection(-1)
            return
        }
        if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault()
            selectItem(menuIndex.value)
            return
        }
        if (event.key === "Escape") {
            event.preventDefault()
            closeMenu()
            return
        }
    }
    if (event.key === "Escape" && sendKeyOpen.value) {
        event.preventDefault()
        sendKeyOpen.value = false
        return
    }
    if (event.key === "Escape" && busy.value) {
        /*
         * 停止要按两次：单按 Esc 直接砍掉一轮，用户很可能只是想关掉什么，
         * 结果把还在跑的回合停了、界面上留一条空白「已停止」。
         */
        event.preventDefault()
        if (stopArmed) {
            stopArmed = false
            window.clearTimeout(stopArmTimer)
            stopGeneration()
            return
        }
        stopArmed = true
        toast("再按一次 Esc 停止这一轮", "info", 2000)
        stopArmTimer = window.setTimeout(() => {
            stopArmed = false
        }, 1600)
        return
    }
    if (event.key !== "Enter") return

    /*
     * 只有配置好的那个组合发送，其余 Enter 一律留给换行（textarea 原生行为）。
     * 这里刻意不把 Ctrl/⌘+Enter 做成“永远发送”的万能键：
     * 用户选了 Shift+Enter 发送，再让 Ctrl+Enter 也发送，等于两个键都能发，
     * 提示行就说不清 Enter 到底会干什么。
     */
    const wantsSend =
        sendMode.value === "enter"
            ? !event.shiftKey
            : sendMode.value === "shift-enter"
              ? event.shiftKey
              : event.ctrlKey || event.metaKey

    if (!wantsSend) return
    event.preventDefault()
    void submit()
}

function chooseSendMode(value: "enter" | "shift-enter" | "ctrl-enter"): void {
    saveSendMode(value)
    sendKeyOpen.value = false
}

/** 关闭菜单并跳到供应商管理；写成函数而不是内联多语句，格式化不会把它拆坏 */
function openProviders(): void {
    modelOpen.value = false
    void router.push("/providers")
}

async function toggleModelMenu(): Promise<void> {
    permissionOpen.value = false
    modelOpen.value = !modelOpen.value
    if (modelOpen.value) await loadModels()
}

function pickModel(providerId: string, model: string): void {
    chooseModel(providerId, model)
    modelOpen.value = false
}

function pickReasoning(level: string): void {
    chooseReasoning(level)
    modelOpen.value = false
}

async function choosePermission(value: string): Promise<void> {
    if (value === "danger-full-access" && store.permission !== "danger-full-access") {
        const ok = await confirmDialog({
            title: "开启完全访问？",
            body: "Agent 可以读写任意路径、执行任意命令，仅建议在可信任务下临时开启。",
            confirmLabel: "仍然开启",
            danger: true,
        })
        if (!ok) return
    }
    savePermission(value)
    permissionOpen.value = false
}

/** 点输入区以外的地方就收起发送键菜单（菜单自己 stop 了冒泡） */
function closeSendKey(): void {
    sendKeyOpen.value = false
}

onMounted(() => {
    autoGrow()
    input.value?.focus()
    document.addEventListener("click", closeSendKey)
})

onBeforeUnmount(() => document.removeEventListener("click", closeSendKey))

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
    <form class="composer" :class="{ 'is-busy': busy }" @submit.prevent="submit">
        <label class="sr-only" for="composer-input">输入消息</label>
        <div class="composer-field">
            <div ref="highlightBox" class="composer-highlight" aria-hidden="true">
                <div class="composer-highlight-inner">
                    <template v-for="(segment, index) in highlightSegments" :key="index">
                        <span v-if="segment.ref" class="composer-ref">{{ segment.text }}</span>
                        <span v-else>{{ segment.text }}</span>
                    </template>
                </div>
            </div>
            <textarea
                id="composer-input"
                ref="input"
                :value="draft"
                rows="1"
                :maxlength="MAX_MESSAGE_CHARS"
                :placeholder="coarsePointer ? '输入消息' : `输入消息，${sendModeInfo.short}`"
                :enterkeyhint="sendMode === 'enter' ? 'send' : 'enter'"
                @input="onInput"
                @keydown="onKeydown"
                @scroll.passive="syncHighlightScroll"
            ></textarea>
        </div>
        <div v-if="menuKind !== null" class="trigger-menu">
            <p class="trigger-title">{{ menuTitle }}</p>
            <ul class="trigger-list" role="listbox" aria-label="输入建议">
                <li
                    v-for="(item, index) in menuItems"
                    :key="index"
                    class="trigger-item"
                    :data-selected="index === menuIndex"
                    :data-disabled="item.disabled === true"
                    role="option"
                    @mousedown.prevent
                    @click="selectItem(index)"
                >
                    <span class="trigger-badge">
                        <svg v-if="item.badge === 'folder'" class="icon icon-sm" aria-hidden="true">
                            <use href="#i-folder" />
                        </svg>
                        <svg
                            v-else-if="item.badge === 'file'"
                            class="icon icon-sm"
                            aria-hidden="true"
                        >
                            <use href="#i-file" />
                        </svg>
                        <template v-else>{{ item.badge }}</template>
                    </span>
                    <span class="trigger-body">
                        <span class="trigger-name">{{ item.label }}</span>
                        <span v-if="item.description !== ''" class="trigger-desc">{{
                            item.description
                        }}</span>
                    </span>
                    <span v-if="item.disabled !== true" class="trigger-enter">↵</span>
                </li>
            </ul>
        </div>
        <div class="composer-bar">
            <div class="composer-model">
                <button
                    class="perm-btn model-btn"
                    type="button"
                    aria-haspopup="menu"
                    :aria-expanded="modelOpen"
                    title="切换模型（本会话）"
                    @click="toggleModelMenu"
                >
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-cpu" /></svg>
                    <span class="model-label">{{ modelText }}</span>
                    <svg class="icon icon-xs perm-caret" aria-hidden="true">
                        <use href="#i-chevron-down" />
                    </svg>
                </button>
                <div
                    class="perm-menu model-menu"
                    v-show="modelOpen"
                    role="menu"
                    aria-label="切换模型"
                >
                    <p class="perm-menu-title">切换模型 <span>对之后的对话生效</span></p>
                    <div class="model-menu-list">
                        <div class="model-menu-reasoning">
                            <span class="model-menu-reasoning-label">推理等级</span>
                            <div class="model-menu-reasoning-options">
                                <button
                                    v-for="level in reasoningLevels"
                                    :key="level"
                                    class="model-menu-reasoning-btn"
                                    :class="{
                                        'is-active':
                                            conversationSettings(activeConversation()).reasoning ===
                                            level,
                                    }"
                                    type="button"
                                    @click.stop="pickReasoning(level)"
                                >
                                    {{ level }}
                                </button>
                            </div>
                        </div>
                        <div
                            v-for="provider in providerGroups"
                            :key="provider.id"
                            class="model-menu-group"
                        >
                            <div class="model-menu-provider">
                                {{ provider.name }}
                                <span v-if="provider.builtin" class="perm-option-tag">内置</span>
                            </div>
                            <button
                                v-for="model in provider.models.length > 0
                                    ? provider.models
                                    : provider.defaultModel
                                      ? [provider.defaultModel]
                                      : []"
                                :key="model"
                                class="model-menu-item"
                                type="button"
                                role="menuitem"
                                :class="{
                                    'is-active':
                                        conversationSettings(activeConversation()).provider ===
                                            provider.id &&
                                        conversationSettings(activeConversation()).model === model,
                                }"
                                @click="pickModel(provider.id, model)"
                            >
                                {{ model }}
                                <span
                                    v-if="contextWindowOf(provider.id, model) !== null"
                                    class="model-menu-context"
                                >
                                    {{
                                        formatContextTokens(
                                            contextWindowOf(provider.id, model) ?? 0,
                                        )
                                    }}
                                </span>
                            </button>
                            <span
                                v-if="provider.models.length === 0 && !provider.defaultModel"
                                class="model-menu-empty"
                            >
                                还没有模型，去供应商管理里添加
                            </span>
                        </div>
                    </div>
                    <button class="model-menu-manage" type="button" @click="openProviders">
                        供应商管理…
                    </button>
                </div>
            </div>
            <div class="composer-perm">
                <button
                    class="perm-btn"
                    type="button"
                    aria-haspopup="menu"
                    :aria-expanded="permissionOpen"
                    title="Agent 权限（对之后的回合生效）"
                    @click="permissionOpen = !permissionOpen"
                >
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-shield" /></svg>
                    <span class="perm-label">{{ permissionLabel }}</span>
                    <svg class="icon icon-xs perm-caret" aria-hidden="true">
                        <use href="#i-chevron-down" />
                    </svg>
                </button>
                <div class="perm-menu" v-show="permissionOpen" role="menu" aria-label="Agent 权限">
                    <p class="perm-menu-title">Agent 权限 <span>对之后的回合生效</span></p>
                    <button
                        v-for="(info, value) in PERMISSIONS"
                        :key="value"
                        class="perm-option"
                        type="button"
                        role="menuitemradio"
                        :aria-checked="store.permission === value"
                        @click="choosePermission(value)"
                    >
                        <span class="perm-option-head"
                            ><span class="perm-option-name">{{ info.label }}</span></span
                        >
                        <span class="perm-option-desc">{{ info.hint }}</span>
                    </button>
                </div>
            </div>
            <!--
                提示行：按键部分是一颗按钮，点开就能换发送键。
                放在这里而不是另开设置页——用户想知道「按回车会怎样」的时刻，
                正是眼睛落在这行字上的时刻。
            -->
            <div class="composer-hint" :data-kind="busy ? 'busy' : !canSend ? 'blocked' : 'idle'">
                <span v-if="!canSend" class="hint-plain">先添加工作区</span>
                <template v-else>
                    <span v-if="busy" class="hint-plain">回复中…</span>
                    <div class="hint-keys-wrap" @click.stop>
                        <button
                            class="hint-keys"
                            type="button"
                            aria-haspopup="menu"
                            :aria-expanded="sendKeyOpen"
                            :aria-label="`发送键：${sendModeInfo.label}，点击更改`"
                            @click="sendKeyOpen = !sendKeyOpen"
                        >
                            <template v-for="(key, index) in sendKeys" :key="key">
                                <kbd>{{ key }}</kbd
                                ><span v-if="index < sendKeys.length - 1" class="hint-plus">+</span>
                            </template>
                            <span class="hint-action">{{ busy ? "插话" : "发送" }}</span>
                            <svg class="icon icon-xs hint-caret" aria-hidden="true">
                                <use href="#i-chevron-down" />
                            </svg>
                        </button>
                        <div
                            v-show="sendKeyOpen"
                            class="send-key-menu"
                            role="menu"
                            aria-label="发送键"
                        >
                            <p class="perm-menu-title">
                                发送键 <span>Enter 换行，只有这个组合会发送</span>
                            </p>
                            <button
                                v-for="(info, value) in SEND_MODES"
                                :key="value"
                                class="perm-option"
                                type="button"
                                role="menuitemradio"
                                :aria-checked="store.sendMode === value"
                                @click="chooseSendMode(value)"
                            >
                                <span class="perm-option-head">
                                    <span class="perm-option-name">{{ info.label }}</span>
                                </span>
                                <span class="perm-option-desc">{{ info.hint }}</span>
                            </button>
                            <p v-if="coarsePointer" class="send-key-note">
                                触摸设备上 Enter 直接发送，这里的选择只影响桌面键盘。
                            </p>
                        </div>
                    </div>
                    <span v-if="busy" class="hint-plain"
                        ><kbd>Esc</kbd> 停止</span
                    >
                </template>
            </div>
            <div class="composer-send">
                <button class="btn btn-primary btn-send" type="submit" :disabled="!canSend">
                    {{ sendLabel }}
                </button>
                <button
                    v-if="busy"
                    class="btn btn-danger-ghost btn-send"
                    type="button"
                    @click="stopGeneration"
                >
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-stop" /></svg>
                    <span>停止</span>
                </button>
            </div>
        </div>
    </form>
</template>
