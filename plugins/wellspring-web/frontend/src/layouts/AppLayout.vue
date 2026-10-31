<script setup lang="ts">
import { RouterView } from "vue-router"

import ApprovalDialog from "../components/ApprovalDialog.vue"
import ConfirmDialog from "../components/ConfirmDialog.vue"
import Sidebar from "../components/Sidebar.vue"
import StatsDialog from "../components/StatsDialog.vue"
import { store } from "../store"
</script>

<template>
    <div class="app" :data-sidebar="store.sidebarOpen ? 'open' : 'closed'">
        <Sidebar />
        <div class="scrim" v-if="store.sidebarOpen" @click="store.sidebarOpen = false"></div>
        <RouterView />
        <ConfirmDialog />
        <ApprovalDialog />
        <StatsDialog />
    </div>
</template>
