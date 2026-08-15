<!-- Concern: 4th pipeline cell toggling the Primitive Twin (default) and Point Cloud, synced to currentFrame | Non-concern: WebGL/decode (useTwinScene/usePointCloudScene) | IO: (context) -> panel -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { Boxes, Loader, Maximize, Move3d, Palette, Rotate3d } from 'lucide-vue-next'
import PanelFrame from '@/components/layout/PanelFrame.vue'
import IconButton from '@/ui/IconButton.vue'
import { parseCloudBin } from '@/api/cloud'
import { parseRenderFrame } from '@/api/render'
import { JOB_KEY, PLAYBACK_KEY } from '@/types/pipeline'
import { injectStrict } from '@/composables/injectStrict'
import { usePointCloudScene, type ColorMode } from '@/features/pipeline/usePointCloudScene'
import { useTwinScene } from '@/features/pipeline/useTwinScene'

type ViewMode = 'twin' | 'cloud'

const playback = injectStrict(PLAYBACK_KEY)
const job = injectStrict(JOB_KEY)

const twinContainer = ref<HTMLElement | null>(null)
const cloudContainer = ref<HTMLElement | null>(null)
const twin = useTwinScene(twinContainer)
const cloud = usePointCloudScene(cloudContainer)

// The anonymized twin is the default public-facing view
const mode = ref<ViewMode>('twin')
const colorMode = ref<ColorMode>('rgb')

const twinLoaded = ref(false)
const twinCount = ref(0)
const cloudLoaded = ref(false)
const cloudCount = ref(0)
const loading = ref(false)
const failed = ref(false)

const hasJob = computed(() => job.jobId.value !== null)
let controller: AbortController | null = null

// Fetch and draw the render frame; a failure propagates so the panel shows "Scene unavailable" rather than fabricated data
async function loadTwin(index: number, signal: AbortSignal): Promise<void> {
  const response = await fetch(job.renderUrl(index), { signal })
  if (!response.ok) throw new Error(`Render request failed (${response.status})`)
  const data = parseRenderFrame(await response.json(), index)
  twin.setFrame(data)
  twinCount.value = data.primitives.length
  twinLoaded.value = true
}

async function loadCloud(index: number, signal: AbortSignal): Promise<void> {
  const response = await fetch(job.cloudUrl(index), { signal })
  if (!response.ok) throw new Error(`Cloud request failed (${response.status})`)
  const parsed = parseCloudBin(await response.arrayBuffer())
  cloud.setCloud(parsed)
  cloudCount.value = parsed.count
  cloudLoaded.value = true
}

async function loadFrame(index: number): Promise<void> {
  if (!hasJob.value) return
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  loading.value = true
  failed.value = false
  try {
    if (mode.value === 'twin') await loadTwin(index, signal)
    else await loadCloud(index, signal)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return
    failed.value = true
  } finally {
    if (!signal.aborted) loading.value = false
  }
}

async function setMode(next: ViewMode): Promise<void> {
  if (mode.value === next) return
  mode.value = next
  // Let v-show reveal the target canvas before it resizes and (re)loads its frame
  await nextTick()
  if (next === 'twin') twin.resize()
  else cloud.resize()
  await loadFrame(playback.currentFrame.value)
}

function toggleColorMode(): void {
  colorMode.value = colorMode.value === 'rgb' ? 'label' : 'rgb'
  cloud.setColorMode(colorMode.value)
}

function resetView(): void {
  if (mode.value === 'twin') twin.resetView()
  else cloud.resetView()
}

watch(
  () => [playback.currentFrame.value, job.jobId.value] as const,
  ([index]) => {
    void loadFrame(index)
  },
  { immediate: true }
)

const activeLoaded = computed(() => (mode.value === 'twin' ? twinLoaded.value : cloudLoaded.value))

const subtitle = computed(() => {
  if (mode.value === 'twin') return twinLoaded.value ? `${twinCount.value} primitives` : ''
  return cloudLoaded.value ? `${cloudCount.value.toLocaleString()} pts` : ''
})

onUnmounted(() => {
  controller?.abort()
  controller = null
})
</script>

<template>
  <PanelFrame :title="mode === 'twin' ? 'Primitive Twin' : 'Point Cloud'" :subtitle="subtitle">
    <template #actions>
      <div class="seg" role="group" aria-label="View mode">
        <IconButton
          label="Primitive Twin (anonymized)"
          :active="mode === 'twin'"
          variant="ghost"
          size="sm"
          @activate="setMode('twin')"
        >
          <Boxes :size="15" :stroke-width="1.75" />
        </IconButton>
        <IconButton
          label="Raw Point Cloud"
          :active="mode === 'cloud'"
          variant="ghost"
          size="sm"
          @activate="setMode('cloud')"
        >
          <Rotate3d :size="15" :stroke-width="1.75" />
        </IconButton>
      </div>
      <IconButton
        label="Reset view"
        :disabled="!activeLoaded"
        variant="ghost"
        size="sm"
        @activate="resetView"
      >
        <Maximize :size="15" :stroke-width="1.75" />
      </IconButton>
      <IconButton
        v-if="mode === 'cloud'"
        :label="colorMode === 'rgb' ? 'Show label colors' : 'Show RGB colors'"
        :active="colorMode === 'label'"
        :disabled="!cloudLoaded"
        variant="ghost"
        size="sm"
        @activate="toggleColorMode"
      >
        <Palette :size="15" :stroke-width="1.75" />
      </IconButton>
    </template>

    <div class="twin">
      <div v-show="mode === 'twin'" ref="twinContainer" class="twin__canvas" />
      <div v-show="mode === 'cloud'" ref="cloudContainer" class="twin__canvas" />

      <div v-if="!hasJob" class="twin__state">
        <Boxes :size="26" :stroke-width="1.5" />
        <span>Awaiting source video</span>
      </div>
      <div v-else-if="failed && !activeLoaded" class="twin__state twin__state--error">
        <Boxes :size="26" :stroke-width="1.5" />
        <span>Scene unavailable</span>
      </div>
      <div v-else-if="loading && !activeLoaded" class="twin__state">
        <Loader :size="24" :stroke-width="1.5" class="spin" />
        <span>Loading {{ mode === 'twin' ? 'twin' : 'point cloud' }}</span>
      </div>

      <span v-if="activeLoaded && hasJob" class="twin__hint">
        <Move3d :size="13" :stroke-width="1.75" />
        drag to orbit
      </span>
    </div>
  </PanelFrame>
</template>

<style scoped>
.seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  margin-right: var(--space-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-inset);
}
.twin {
  position: relative;
  width: 100%;
  height: 100%;
}
.twin__canvas {
  position: absolute;
  inset: 0;
}
.twin__canvas :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
.twin__state {
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
.twin__state--error {
  color: var(--color-error);
}
.twin__hint {
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
