<script setup lang="ts">
import { RouterLink } from "vue-router"

import { store } from "../store"
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
                <h1>页面不存在</h1>
                <p>这个地址没有对应的页面。</p>
            </div>
        </header>
        <div class="view-scroll">
            <div class="page-narrow">
                <div class="empty">
                    <div class="empty-head">
                        <span class="mark mark-lg">
                            <svg class="icon icon-lg" aria-hidden="true"><use href="#i-alert" /></svg>
                        </span>
                        <h2 class="empty-title">没有这个页面</h2>
                    </div>
                    <p class="empty-copy">
                        检查地址是否写错，或者从侧栏重新进入。刷新任意深层地址都能直接打开对应的页面。
                    </p>
                    <div class="suggestions">
                        <RouterLink class="suggestion" to="/extensions">
                            <svg class="icon" aria-hidden="true"><use href="#i-code" /></svg>
                            <span class="label">Web 扩展</span>
                            <span class="desc">安装、打开与删除扩展</span>
                        </RouterLink>
                        <RouterLink class="suggestion" to="/providers">
                            <svg class="icon" aria-hidden="true"><use href="#i-cpu" /></svg>
                            <span class="label">模型与供应商</span>
                            <span class="desc">模型、Key 与上下文窗口</span>
                        </RouterLink>
                        <RouterLink class="suggestion" to="/status">
                            <svg class="icon" aria-hidden="true"><use href="#i-server" /></svg>
                            <span class="label">系统状态</span>
                            <span class="desc">宿主、运行时与插件</span>
                        </RouterLink>
                    </div>
                </div>
            </div>
        </div>
    </main>
</template>
