<!-- Concern: top bar showing product identity, job status readout, and the dropzone | Non-concern: drag/pick mechanics or upload (VideoDropzone/useJob own that) | IO: (job context) -> header -->
<script setup lang="ts">
import { computed } from 'vue'
import { Boxes } from 'lucide-vue-next'
import StatusDot from '@/ui/StatusDot.vue'
import VideoDropzone from '@/features/pipeline/VideoDropzone.vue'
import { JOB_KEY } from '@/types/pipeline'
import { injectStrict } from '@/composables/injectStrict'

const job = injectStrict(JOB_KEY)

const statusText = computed(() => {
  switch (job.status.value) {
    case 'idle':
      return 'No job'
    case 'queued':
      return 'Queued'
    case 'processing':
      return `Processing ${Math.round((job.progress.value ?? 0) * 100)}%`
    case 'done':
      return 'Ready'
    case 'error':
      return 'Error'
    default:
      return ''
  }
})

const resolution = computed(() => {
  const m = job.manifest.value
  return m && m.width && m.height ? `${m.width}x${m.height}` : ''
})

async function onSelect(file: File): Promise<void> {
  try {
    await job.submitVideo(file)
  } catch {
    // Surface handled in job.error; nothing further needed here.
  }
}
</script>

<template>
  <header class="header">
    <div class="header__brand">
      <span class="header__mark">
        <Boxes :size="18" :stroke-width="1.75" />
      </span>
      <div class="header__names">
        <h1 class="header__title">Pipeline Viewer</h1>
        <span class="header__tag">perception stages</span>
      </div>
    </div>

    <div class="header__status">
      <StatusDot :status="job.status.value" />
      <span class="header__status-text">{{ statusText }}</span>
      <span v-if="resolution" class="header__meta tabular">{{ resolution }}</span>
      <span v-if="job.error.value" class="header__error">{{ job.error.value }}</span>
    </div>

    <div class="header__actions">
      <VideoDropzone :busy="job.uploading.value" @select="onSelect" />
    </div>
  </header>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  padding: var(--space-3) var(--space-5);
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
}
.header__brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: none;
}
.header__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent-border);
  color: var(--color-accent);
}
.header__names {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}
.header__title {
  font-size: var(--text-lg);
  font-weight: 600;
  letter-spacing: -0.01em;
}
.header__tag {
  font-size: var(--text-xs);
  color: var(--color-text-dim);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.header__status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-width: 0;
}
.header__status-text {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
.header__meta {
  font-size: var(--text-xs);
  color: var(--color-text-dim);
  padding-left: var(--space-2);
  border-left: 1px solid var(--color-border);
}
.header__error {
  font-size: var(--text-xs);
  color: var(--color-error);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.header__actions {
  flex: none;
}
</style>
