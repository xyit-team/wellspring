<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import { RouterView } from "vue-router"

import ApprovalDialog from "../components/ApprovalDialog.vue"
import ConfirmDialog from "../components/ConfirmDialog.vue"
import Sidebar from "../components/Sidebar.vue"
import StatsDialog from "../components/StatsDialog.vue"
import { addWorkspace, addWorkspaceAt, store, toast } from "../store"

/*
 * 拖文件夹进页面 → 添加工作区
 *
 * 浏览器不给网页绝对路径；Firefox 这类在 dataTransfer 里带 text/uri-list（file:///…），
 * 其余浏览器只给 Files 类型，取不到路径时退到原生目录选择框
 */
const dropping = ref(false)
let depth = 0

function hasFiles(event: DragEvent): boolean {
    const types = event.dataTransfer?.types
    return types !== undefined && Array.from(types).includes("Files")
}

function onDragEnter(event: DragEvent): void {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth += 1
    dropping.value = true
}

function onDragOver(event: DragEvent): void {
    if (!hasFiles(event)) return
    event.preventDefault()
}

function onDragLeave(event: DragEvent): void {
    if (!hasFiles(event)) return
    depth = Math.max(0, depth - 1)
    if (depth === 0) dropping.value = false
}

/** 从 uri-list / plain 里挑出本地路径；Chrome 对本地文件不给这两个数据 */
function droppedPaths(data: DataTransfer | null): string[] {
    if (data === null) return []
    const raw = [data.getData("text/uri-list"), data.getData("text/plain")]
        .join("\n")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("file://"))
    const paths: string[] = []
    for (const line of raw) {
        try {
            const path = decodeURIComponent(new URL(line).pathname)
            const clean = path.length > 1 ? path.replace(/[\\/]+$/, "") : path
            if (clean !== "" && !paths.includes(clean)) paths.push(clean)
        } catch {
            /* 非法 uri 直接跳过 */
        }
    }
    return paths
}

async function onDrop(event: DragEvent): Promise<void> {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth = 0
    dropping.value = false
    const paths = droppedPaths(event.dataTransfer)
    if (paths.length === 0) {
        toast("浏览器不提供拖入文件夹的绝对路径，改用目录选择框", "warn")
        await addWorkspace()
        return
    }
    for (const path of paths) {
        if (await addWorkspaceAt(path)) return
    }
}

onMounted(() => {
    window.addEventListener("dragenter", onDragEnter)
    window.addEventListener("dragover", onDragOver)
    window.addEventListener("dragleave", onDragLeave)
    window.addEventListener("drop", onDrop)
})

onBeforeUnmount(() => {
    window.removeEventListener("dragenter", onDragEnter)
    window.removeEventListener("dragover", onDragOver)
    window.removeEventListener("dragleave", onDragLeave)
    window.removeEventListener("drop", onDrop)
})
</script>

<template>
    <div class="app" :data-sidebar="store.sidebarOpen ? 'open' : 'closed'">
        <Sidebar />
        <div class="scrim" v-if="store.sidebarOpen" @click="store.sidebarOpen = false"></div>
        <RouterView />
        <div v-if="dropping" class="drop-hint" role="status">
            <svg class="icon icon-lg" aria-hidden="true"><use href="#i-folder" /></svg>
            <p>松开以添加工作区</p>
        </div>
        <ConfirmDialog />
        <ApprovalDialog />
        <StatsDialog />
    </div>
</template>
