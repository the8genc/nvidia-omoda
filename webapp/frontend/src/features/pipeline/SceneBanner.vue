<!-- Concern: thin top banner showing the periodically-polled VLM scene description | Non-concern: polling/the VLM call (composable + backend own that) | IO: () -> banner -->
<script setup lang="ts">
import { Sparkles } from 'lucide-vue-next'
import { useSceneDescription } from '@/composables/useSceneDescription'

const { text, pending } = useSceneDescription()
</script>

<template>
  <div class="banner" :class="{ 'is-pending': pending }">
    <Sparkles :size="13" :stroke-width="2" class="banner__icon" />
    <span class="banner__text">{{ text ?? 'Analyzing scene…' }}</span>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px var(--space-5);
  background: var(--color-accent-soft);
  border-bottom: 1px solid var(--color-accent-border);
  color: var(--color-text);
  font-size: var(--text-xs);
  line-height: 1.4;
  flex: none;
}
.banner__icon {
  color: var(--color-accent);
  flex: none;
}
.banner__text {
  min-width: 0;
}
.banner.is-pending {
  opacity: 0.7;
}
</style>
