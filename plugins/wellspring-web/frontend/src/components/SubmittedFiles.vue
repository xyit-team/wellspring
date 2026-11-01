<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue"

import type { SubmittedFile } from "../logic/artifacts"
import { copyText, openFile } from "../store"

const props = defineProps<{ files: readonly SubmittedFile[] }>()

// 当前展开下拉的文件路径
const menu = ref<string | null>(null)
const busy = ref<string | null>(null)

// 定位菜单文案按系统命名
const revealLabel = computed(() => {
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent
    if (/macintosh|mac os x/i.test(ua)) return "在访达中显示"
    if (/windows/i.test(ua)) return "在文件资源管理器中显示"
    return "在文件管理器中显示"
})

function sizeLabel(size: number | null): string {
    if (size === null || size <= 0) return ""
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
    if (size >= 1024) return `${Math.round(size / 1024)} KB`
    return `${size} B`
}

function toggle(path: string): void {
    menu.value = menu.value === path ? null : path
}

function close(): void {
    menu.value = null
}

document.addEventListener("click", close)
onBeforeUnmount(() => document.removeEventListener("click", close))

async function run(file: SubmittedFile, mode: "default" | "reveal"): Promise<void> {
    close()
    busy.value = file.path
    try {
        await openFile(file.path, mode)
    } finally {
        busy.value = null
    }
}

async function copyPath(file: SubmittedFile): Promise<void> {
    close()
    await copyText(file.path)
}
</script>

<template>
    <div v-if="props.files.length > 0" class="submit-files" aria-label="本次提交的文件">
        <div v-for="file in props.files" :key="file.path" class="submit-file">
            <span class="submit-file-icon">
                <svg class="icon icon-sm" aria-hidden="true"><use href="#i-file" /></svg>
            </span>
            <span class="submit-file-name" :title="file.path">{{ file.name }}</span>
            <span v-if="sizeLabel(file.size) !== ''" class="submit-file-size">{{ sizeLabel(file.size) }}</span>
            <div class="submit-file-actions">
                <button
                    class="btn btn-outline btn-sm submit-open"
                    type="button"
                    :disabled="busy === file.path"
                    :title="file.path"
                    @click.stop="run(file, 'default')"
                >
                    打开
                </button>
                <button
                    class="btn btn-ghost btn-sm submit-more"
                    type="button"
                    aria-haspopup="menu"
                    :aria-expanded="menu === file.path"
                    aria-label="其他打开方式"
                    @click.stop="toggle(file.path)"
                >
                    <svg class="icon icon-xs" aria-hidden="true"><use href="#i-chevron-down" /></svg>
                </button>
                <div v-if="menu === file.path" class="submit-menu" role="menu" @click.stop>
                    <button class="submit-menu-item" type="button" role="menuitem" @click="run(file, 'default')">
                        用默认程序打开
                    </button>
                    <button class="submit-menu-item" type="button" role="menuitem" @click="run(file, 'reveal')">
                        {{ revealLabel }}
                    </button>
                    <button class="submit-menu-item" type="button" role="menuitem" @click="copyPath(file)">
                        复制完整路径
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
