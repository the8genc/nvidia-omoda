<!-- Concern: top bar with identity, a live indicator, and the drop-video control that sets the live source | Non-concern: drag/pick (VideoDropzone owns that) | IO: (live) -> header -->
<script setup lang="ts">
import { ref } from 'vue'
import { Boxes, Radio } from 'lucide-vue-next'
import VideoDropzone from '@/features/pipeline/VideoDropzone.vue'
import { LIVE_KEY } from '@/types/pipeline'
import { injectStrict } from '@/composables/injectStrict'

const live = injectStrict(LIVE_KEY)

const uploading = ref(false)
const uploadError = ref<string | null>(null)

// dropping a video sets the shared live source everyone sees; surface any failure loudly rather than swallowing it
async function onSelect(file: File): Promise<void> {
  uploading.value = true
  uploadError.value = null
  try {
    await live.submitSource(file)
  } catch (err) {
    uploadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    uploading.value = false
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
        <span class="header__tag">live perception</span>
      </div>
    </div>

    <div class="header__status">
      <span class="header__live" :class="{ 'is-on': live.connected.value }">
        <Radio :size="15" :stroke-width="2" />
        {{ live.connected.value ? 'LIVE' : 'connecting' }}
      </span>
    </div>

    <div class="header__actions">
      <span v-if="uploadError" class="header__error" role="alert">{{ uploadError }}</span>
      <VideoDropzone :busy="uploading" @select="onSelect" />
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
.header__live {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--text-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 3px 9px;
  border-radius: var(--radius-sm);
  color: var(--color-text-dim);
  border: 1px solid var(--color-border);
}
.header__live.is-on {
  color: #ff4d4d;
  border-color: rgba(255, 77, 77, 0.5);
  background: rgba(255, 77, 77, 0.08);
  animation: livepulse 1.4s ease-in-out infinite;
}
.header__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.header__error {
  font-size: var(--text-xs);
  font-weight: 600;
  color: #ff4d4d;
  max-width: 32ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes livepulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
</style>
