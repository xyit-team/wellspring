<script setup lang="ts">
import { computed } from "vue"

import { slotComponents } from "../extensions"
import { store } from "../store"

const props = defineProps<{ name: string }>()
const components = computed(() => slotComponents(props.name))
const host = {
    version: store.version,
}
</script>

<template>
    <component :is="component" v-for="(component, index) in components" :key="index" :host="host" />
</template>
