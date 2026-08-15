<!-- Concern: fetches cloud.bin per frame and drives the three.js scene with an rgb/label toggle | Non-concern: WebGL setup or decoding (usePointCloudScene/cloud.ts) | IO: (context) -> canvas panel -->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { Loader, Maximize, Move3d, Palette, Rotate3d } from 'lucide-vue-next'
import PanelFrame from '@/components/layout/PanelFrame.vue'
import IconButton from '@/ui/IconButton.vue'
import { parseCloudBin } from '@/api/cloud'
import { JOB_KEY, PLAYBACK_KEY } from '@/types/pipeline'
import { injectStrict } from '@/composables/injectStrict'
import { usePointCloudScene, type ColorMode } from '@/features/pipeline/usePointCloudScene'

const playback = injectStrict(PLAYBACK_KEY)
const job = injectStrict(JOB_KEY)

const container = ref<HTMLElement | null>(null)
const { setCloud, setColorMode, resetView } = usePointCloudScene(container)

const colorMode = ref<ColorMode>('rgb')
const loading = ref(false)
const failed = ref(false)
const loaded = ref(false)
const pointCount = ref(0)

const hasJob = computed(() => job.jobId.value !== null)
let controller: AbortController | null = null

async function loadFrame(index: number): Promise<void> {
  if (!hasJob.value) return
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  loading.value = true
  failed.value = false
  try {
    const response = await fetch(job.cloudUrl(index), { signal })
    if (!response.ok) throw new Error(`Cloud request failed (${response.status})`)
    const buffer = await response.arrayBuffer()
    const cloud = parseCloudBin(buffer)
    setCloud(cloud)
    pointCount.value = cloud.count
    loaded.value = true
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return
    failed.value = true
  } finally {
    if (!signal.aborted) loading.value = false
  }
}

function toggleColorMode(): void {
  colorMode.value = colorMode.value === 'rgb' ? 'label' : 'rgb'
  setColorMode(colorMode.value)
}

watch(
  () => [playback.currentFrame.value, job.jobId.value] as const,
  ([index]) => {
    void loadFrame(index)
  },
  { immediate: true }
)

const countLabel = computed(() => (loaded.value ? `${pointCount.value.toLocaleString()} pts` : ''))

onUnmounted(() => {
  controller?.abort()
  controller = null
})
</script>

<template>
  <PanelFrame title="Point Cloud" :subtitle="countLabel">
    <template #actions>
      <IconButton
        label="Reset view"
        :disabled="!loaded"
        variant="ghost"
        size="sm"
        @activate="resetView"
      >
        <Maximize :size="15" :stroke-width="1.75" />
      </IconButton>
      <IconButton
        :label="colorMode === 'rgb' ? 'Show label colors' : 'Show RGB colors'"
        :active="colorMode === 'label'"
        :disabled="!loaded"
        variant="ghost"
        size="sm"
        @activate="toggleColorMode"
      >
        <Palette :size="15" :stroke-width="1.75" />
      </IconButton>
    </template>

    <div class="cloud">
      <div ref="container" class="cloud__canvas" />

      <div v-if="!hasJob" class="cloud__state">
        <Rotate3d :size="26" :stroke-width="1.5" />
        <span>Awaiting source video</span>
      </div>
      <div v-else-if="failed && !loaded" class="cloud__state cloud__state--error">
        <Rotate3d :size="26" :stroke-width="1.5" />
        <span>Cloud unavailable</span>
      </div>
      <div v-else-if="loading && !loaded" class="cloud__state">
        <Loader :size="24" :stroke-width="1.5" class="spin" />
        <span>Loading point cloud</span>
      </div>

      <span v-if="loaded && hasJob" class="cloud__hint">
        <Move3d :size="13" :stroke-width="1.75" />
        drag to orbit
      </span>
    </div>
  </PanelFrame>
</template>

<style scoped>
.cloud {
  position: relative;
  width: 100%;
  height: 100%;
}
.cloud__canvas {
  position: absolute;
  inset: 0;
}
.cloud__canvas :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
.cloud__state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-dim);
  font-size: var(--text-xs);
  letter-spacing: 0.03em;
  background: var(--color-inset);
  pointer-events: none;
}
.cloud__state--error {
  color: var(--color-error);
}
.cloud__hint {
  position: absolute;
  bottom: var(--space-2);
  right: var(--space-2);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--color-text);
  letter-spacing: 0.04em;
  background: color-mix(in srgb, var(--color-inset) 78%, transparent);
  pointer-events: none;
}
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
