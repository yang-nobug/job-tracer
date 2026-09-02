<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../utils/markdown'

const props = withDefaults(defineProps<{
  content?: string | null
  compact?: boolean
}>(), {
  content: '',
  compact: false
})

const rendered = computed(() => renderMarkdown(props.content))
</script>

<template>
  <div class="rich-text" :class="{ 'rich-text--compact': compact }" v-html="rendered" />
</template>
