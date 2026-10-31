<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { RouterLink, useRoute, useRouter } from "vue-router"

import ExtensionSlot from "./ExtensionSlot.vue"

import {
    UNGROUPED,
    addWorkspace,
    conversationPath,
    cycleTheme,
    deleteConversation,
    newConversation,
    relativeTime,
    removeWorkspace,
    confirmDialog,
    selectGroup,
    store,
} from "../store"

const route = useRoute()
const router = useRouter()
const workspaceFolded = ref(false)
const THEME_INFO = {
    system: { label: "跟随系统", icon: "monitor" },
    light: { label: "浅色", icon: "sun" },
    dark: { label: "深色", icon: "moon" },
} as const
const themeLabel = computed(
    () => THEME_INFO[(store.theme as keyof typeof THEME_INFO) ?? "system"]?.label ?? "跟随系统",
)
const themeIcon = computed(
    () => THEME_INFO[(store.theme as keyof typeof THEME_INFO) ?? "system"]?.icon ?? "monitor",
)
const footFolded = ref(true)

/** 手机抽屉没有返回键：外接键盘按 Esc 关掉它 */
function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !store.sidebarOpen) return
    event.preventDefault()
    store.sidebarOpen = false
}

onMounted(() => {
    window.addEventListener("keydown", onKeydown)
})

onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKeydown)
})

const activeConversations = computed(() =>
    store.conversations.filter((conv) => conv.messages.length > 0),
)

/** 会话是否正在跑一轮（含别的窗口发起的） */
function isRunning(conversationId: string): boolean {
    return store.runningIds.includes(conversationId)
}

/** 工作区里是否已有会话在跑 */
function workspaceRunning(workspaceId: string): boolean {
    return store.runningWorkspaces.includes(workspaceId)
}

const workspaceTitle = computed(() => {
    if (store.group === UNGROUPED) return "未分组"
    return store.workspace?.name ?? ""
})

/** 当前分组要回落的地址：有最近会话就去它的 /c/:id，否则回空白对话页 */
function chatPath(): string {
    const conv = store.conversations.find((item) => item.id === store.activeId)
    return conv !== undefined && conv.messages.length > 0 ? conversationPath(conv) : "/"
}

async function onSelectWorkspace(id: string): Promise<void> {
    await selectGroup("workspace", id)
    store.sidebarOpen = false
    void router.push(chatPath())
}

async function onSelectUngrouped(): Promise<void> {
    await selectGroup(UNGROUPED)
    store.sidebarOpen = false
    void router.push(chatPath())
}

function onNewConversation(): void {
    if (newConversation() === null) return
    store.sidebarOpen = false
    // 新会话还没有地址（首条消息落盘后由 ChatView 换成 /c/:id）
    void router.push("/")
}

async function onAddWorkspace(): Promise<void> {
    await addWorkspace()
    store.sidebarOpen = false
    void router.push(chatPath())
}

async function onRemoveWorkspace(id: string, name: string): Promise<void> {
    void name
    const ok = await confirmDialog({
        title: "移除工作区",
        body: "移除后会话会转入未分组继续保留，目录本身不会被删除。",
        confirmLabel: "移除",
        danger: true,
    })
    if (!ok) return
    await removeWorkspace(id)
}

async function onDeleteConversation(id: string, title: string): Promise<void> {
    void title
    const ok = await confirmDialog({
        title: "删除会话",
        body: "删除后无法恢复，确定删除这个会话？",
        confirmLabel: "删除",
        danger: true,
    })
    if (!ok) return
    await deleteConversation(id)
}

async function logout(): Promise<void> {
    try {
        await fetch("/api/auth/logout", { method: "POST" })
    } catch {
        /* 忽略 */
    }
    window.location.reload()
}

async function shutdown(): Promise<void> {
    const ok = await confirmDialog({
        title: "关闭 Wellspring",
        body: "服务进程会退出，正在进行的会话会被终止；工作区与会话数据保留。",
        confirmLabel: "关闭服务",
        danger: true,
    })
    if (!ok) return
    try {
        await fetch("/api/shutdown", { method: "POST" })
    } catch {
        /* 忽略 */
    }
    store.shutdownRequested = true
}
</script>

<template>
    <aside class="sidebar" id="sidebar" aria-label="会话与设置">
        <div class="sidebar-head">
            <RouterLink class="brand" to="/" aria-label="回到对话" @click="store.sidebarOpen = false">
                <span class="mark"
                    ><svg class="icon" aria-hidden="true"><use href="#i-spring" /></svg
                ></span>
                <span>Wellspring</span>
            </RouterLink>
            <button
                class="btn btn-icon btn-ghost sidebar-close"
                type="button"
                aria-label="收起会话列表"
                @click="store.sidebarOpen = false"
            >
                <svg class="icon" aria-hidden="true"><use href="#i-x" /></svg>
            </button>
        </div>
        <div class="sidebar-scroll">
            <div class="workspace-section">
                <button
                    class="sidebar-section sidebar-fold"
                    type="button"
                    :aria-expanded="!workspaceFolded"
                    @click="workspaceFolded = !workspaceFolded"
                >
                    <span class="sidebar-fold-caret"
                        ><svg class="icon icon-xs" aria-hidden="true">
                            <use href="#i-chevron-down" /></svg
                    ></span>
                    <span>工作区</span>
                    <span class="sidebar-fold-value" v-if="workspaceFolded">{{
                        workspaceTitle
                    }}</span>
                    <span>{{
                        store.workspaces.length + (store.ungroupedCount > 0 ? 1 : 0) || ""
                    }}</span>
                </button>
                <div class="fold" :data-open="workspaceFolded ? 'false' : 'true'">
                    <div class="workspace-body">
                    <ul class="workspace-list" aria-label="工作区">
                        <li
                            v-if="store.workspaces.length === 0 && store.ungroupedCount === 0"
                            class="workspace-empty"
                        >
                            还没有工作区
                        </li>
                        <li
                            v-for="workspace in store.workspaces"
                            :key="workspace.id"
                            class="ws-row"
                            :data-active="
                                store.group === 'workspace' && store.workspace?.id === workspace.id
                            "
                        >
                            <button
                                class="ws-select"
                                type="button"
                                :title="workspace.root"
                                @click="onSelectWorkspace(workspace.id)"
                            >
                                <svg class="icon icon-sm" aria-hidden="true">
                                    <use href="#i-folder" />
                                </svg>
                                <span class="ws-name">{{ workspace.name }}</span>
                                <span
                                    v-if="workspaceRunning(workspace.id)"
                                    class="ws-running"
                                    title="有会话正在运行"
                                    aria-label="有会话正在运行"
                                ></span>
                                <span class="ws-count">{{ workspace.conversationCount || 0 }}</span>
                            </button>
                            <button
                                class="ws-del"
                                type="button"
                                :aria-label="`移除工作区：${workspace.name}`"
                                title="移除工作区"
                                @click="onRemoveWorkspace(workspace.id, workspace.name)"
                            >
                                <svg class="icon icon-sm" aria-hidden="true">
                                    <use href="#i-trash" />
                                </svg>
                            </button>
                        </li>
                        <li
                            v-if="store.ungroupedCount > 0"
                            class="ws-row"
                            :data-active="store.group === UNGROUPED"
                        >
                            <button class="ws-select" type="button" @click="onSelectUngrouped">
                                <svg class="icon icon-sm" aria-hidden="true">
                                    <use href="#i-archive" />
                                </svg>
                                <span class="ws-name">未分组</span>
                                <span class="ws-count">{{ store.ungroupedCount }}</span>
                            </button>
                        </li>
                    </ul>
                    <button
                        class="btn btn-ghost btn-sm workspace-add"
                        type="button"
                        @click="onAddWorkspace"
                    >
                        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-plus" /></svg>
                        <span>添加工作区</span>
                    </button>
                    </div>
                </div>
            </div>
            <button class="btn btn-new" type="button" @click="onNewConversation">
                <svg class="icon icon-sm" aria-hidden="true"><use href="#i-plus" /></svg>
                <span>新对话</span>
            </button>
            <p class="sidebar-section">
                <span>最近</span>
                <span>{{ activeConversations.length || "" }}</span>
            </p>
            <nav class="conv-list" aria-label="会话历史">
                <p v-if="activeConversations.length === 0" class="conv-empty">
                    {{
                        store.group === "none"
                            ? "还没有工作区。点击上方「添加工作区」选择一个目录。"
                            : store.group === UNGROUPED
                              ? "未分组里还没有会话。"
                              : "还没有会话。发第一条消息后会自动保存在这里。"
                    }}
                </p>
                <div
                    v-for="conv in activeConversations"
                    :key="conv.id"
                    class="conv"
                    :data-active="conv.id === store.activeId"
                >
                    <RouterLink
                        class="conv-select"
                        :to="conversationPath(conv)"
                        :aria-current="conv.id === store.activeId ? 'page' : undefined"
                        @click="store.sidebarOpen = false"
                    >
                        <span class="conv-title">{{ conv.title }}</span>
                        <span
                            v-if="isRunning(conv.id)"
                            class="conv-running"
                            title="正在运行"
                            aria-label="正在运行"
                        ></span>
                        <span class="conv-time">{{ relativeTime(conv.updatedAt) }}</span>
                    </RouterLink>
                    <button
                        class="conv-del"
                        type="button"
                        :aria-label="`删除会话：${conv.title}`"
                        @click="onDeleteConversation(conv.id, conv.title)"
                    >
                        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-trash" /></svg>
                    </button>
                </div>
            </nav>
        </div>
        <div class="sidebar-foot">
            <button
                class="sidebar-fold foot-fold"
                type="button"
                :aria-expanded="!footFolded"
                @click="footFolded = !footFolded"
            >
                <span class="sidebar-fold-caret"
                    ><svg class="icon icon-xs" aria-hidden="true">
                        <use href="#i-chevron-down" /></svg
                ></span>
                <span>设置</span>
            </button>
            <div class="fold" :data-open="footFolded ? 'false' : 'true'">
                <div class="sidebar-foot-body">
                <button class="btn btn-ghost" type="button" @click="cycleTheme">
                    <svg class="icon icon-sm" aria-hidden="true">
                        <use :href="`#i-${themeIcon}`" />
                    </svg>
                    <span>{{ themeLabel }}</span>
                </button>
                <RouterLink
                    class="btn btn-ghost"
                    :to="'/extensions'"
                    :data-active="route.path === '/extensions' || route.path.startsWith('/ext/')"
                    :aria-current="route.path === '/extensions' ? 'page' : undefined"
                    @click="store.sidebarOpen = false"
                >
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-code" /></svg>
                    <span>Web 扩展</span>
                </RouterLink>
                <RouterLink
                    class="btn btn-ghost"
                    :to="'/providers'"
                    :data-active="route.path === '/providers'"
                    :aria-current="route.path === '/providers' ? 'page' : undefined"
                    @click="store.sidebarOpen = false"
                >
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-cpu" /></svg>
                    <span>供应商</span>
                </RouterLink>
                <RouterLink
                    class="btn btn-ghost"
                    :to="'/network'"
                    :data-active="route.path === '/network'"
                    :aria-current="route.path === '/network' ? 'page' : undefined"
                    @click="store.sidebarOpen = false"
                >
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-network" /></svg>
                    <span>网络代理</span>
                </RouterLink>
                <RouterLink
                    class="btn btn-ghost"
                    :to="'/plugins'"
                    :data-active="route.path === '/plugins'"
                    :aria-current="route.path === '/plugins' ? 'page' : undefined"
                    @click="store.sidebarOpen = false"
                >
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-archive" /></svg>
                    <span>插件管理</span>
                </RouterLink>
                <RouterLink
                    class="btn btn-ghost"
                    :to="'/password'"
                    :data-active="route.path === '/password'"
                    :aria-current="route.path === '/password' ? 'page' : undefined"
                    @click="store.sidebarOpen = false"
                >
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-lock" /></svg>
                    <span>修改密码</span>
                </RouterLink>
                <RouterLink
                    class="btn btn-ghost"
                    :to="'/status'"
                    :data-active="route.path === '/status'"
                    :aria-current="route.path === '/status' ? 'page' : undefined"
                    @click="store.sidebarOpen = false"
                >
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-server" /></svg>
                    <span>系统状态</span>
                </RouterLink>
                <button class="btn btn-ghost shutdown-btn" type="button" @click="shutdown">
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-power" /></svg>
                    <span>关闭 Wellspring</span>
                </button>
                <button class="btn btn-ghost" type="button" @click="logout">
                    <svg class="icon icon-sm" aria-hidden="true"><use href="#i-logout" /></svg>
                    <span>退出登录</span>
                </button>
                </div>
            </div>
            <div class="host-line">
                <span class="dot" aria-hidden="true"></span>
                <span>已连接</span>
                <span class="version">{{ store.version }}</span>
            </div>
            <ExtensionSlot name="sidebar.footer" />
        </div>
        <nav v-if="store.addons.length > 0" class="sidebar-addons" aria-label="插件入口">
            <a
                v-for="addon in store.addons"
                :key="addon.to"
                :href="addon.to"
                :target="addon.external ? '_blank' : undefined"
                :rel="addon.external ? 'noopener noreferrer' : undefined"
            >
                {{ addon.label }}
            </a>
        </nav>
    </aside>
</template>
