<!-- Concern: renders a colored dot mapping JobStatus to a token color | Non-concern: what the status means or how it changes (useJob owns that) | IO: (status) -> dot -->
<script setup lang="ts">
import type { JobStatus } from '@/types/pipeline'

defineProps<{
  status: JobStatus
}>()
</script>

<template>
  <span class="status-dot" :class="`status-dot--${status}`" />
</template>

<style scoped>
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-dim);
  flex: none;
}
.status-dot--processing,
.status-dot--queued {
  background: var(--color-warn);
  box-shadow: 0 0 0 3px rgba(217, 164, 65, 0.15);
  animation: pulse 1.4s var(--ease) infinite;
}
.status-dot--done {
  background: var(--color-ok);
  box-shadow: 0 0 0 3px rgba(63, 185, 138, 0.15);
}
.status-dot--error {
  background: var(--color-error);
  box-shadow: 0 0 0 3px rgba(224, 102, 102, 0.15);
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
