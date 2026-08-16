<!-- Concern: render the live D4RT reconstruction — the static world + moving blobs as a MODEL when locked, the raw point cloud when a hazard unlocks it | Non-concern: the socket/wire format (useLiveCloudStream owns), the scene's GPU resources (LiveCloudCanvas owns), the unlock decision (backend firewall owns) | IO: (enabled, unlocked) -> canvas -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'

import LiveCloudCanvas from '@/components/cloud/LiveCloudCanvas.vue'
import type { LiveView } from '@/components/cloud/useLiveCloudScene'
import { decodeStaticWorld, type StaticWorld } from '@/cloud/staticWorld'
import { useLiveCloudStream } from '@/cloud/useLiveCloudStream'
import { d4rtWorldUrl, d4rtWsUrl } from '@/api/config'

const props = defineProps<{
  enabled: boolean
  // the backend firewall's decision, mirrored from rgb-stream: false = obfuscated
  // (show the reconstructed MODEL), true = hazard (reveal the raw point cloud).
  unlocked?: boolean
}>()

// null url means "do not connect"; the stream reconnects whenever the url flips to a value
const url = computed(() => (props.enabled ? d4rtWsUrl() : null))
const stream = useLiveCloudStream(url)

// the socket is self-describing: numPoints/gridSide/classNames arrive in the hello
// before any frame, so the canvas is only built once that fixed capacity is known
const numPoints = computed(() => stream.info.value?.numPoints ?? 0)
const hasFrame = computed(() => stream.frame.value !== null)

// Phase B: the D4RT tab mimics the main feed — the model while obfuscated, the
// point cloud once a hazard makes the raw geometry available.
const view = computed<LiveView>(() => (props.unlocked ? 'points' : 'model'))

const world = shallowRef<StaticWorld | null>(null)
const glError = ref<string | null>(null)
// bumped on connect and on a view switch, so the camera reframes rather than
// keeping an orbit that suited the other mode
const resetToken = ref(0)

// The world is built lazily on the backend the first time a client connects, so
// the first fetch usually 404s. Keep asking until it lands; once it has, it never
// changes for the life of the clip.
let worldTimer: ReturnType<typeof setTimeout> | undefined
async function fetchWorld(): Promise<boolean> {
  try {
    const res = await fetch(d4rtWorldUrl(), { cache: 'no-store' })
    if (!res.ok) return false
    world.value = decodeStaticWorld(await res.arrayBuffer())
    return true
  } catch {
    return false
  }
}
function pollWorld(): void {
  void fetchWorld().then((ok) => {
    if (!ok && props.enabled) worldTimer = setTimeout(pollWorld, 2500)
  })
}

watch(view, () => (resetToken.value += 1))
watch(numPoints, (n, prev) => {
  if (n > 0 && prev === 0) resetToken.value += 1
})

onMounted(() => {
  if (props.enabled) pollWorld()
})
onUnmounted(() => {
  if (worldTimer) clearTimeout(worldTimer)
})

function onUnsupported(message: string): void {
  glError.value = message
}

const hint = computed(() => {
  if (glError.value) return glError.value
  if (stream.error.value) return stream.error.value
  if (stream.status.value === 'connecting') return 'Connecting…'
  if (!hasFrame.value) return 'Reconstructing… (building the world on first view)'
  return null
})
</script>

<template>
  <div class="viewer">
    <LiveCloudCanvas
      v-if="numPoints > 0 && !glError"
      :num-points="numPoints"
      :frame="stream.frame.value"
      color-mode="rgb"
      :show-ground="true"
      :world="world"
      :view="view"
      :reset-token="resetToken"
      class="viewer__canvas"
      @unsupported="onUnsupported"
    />
    <div v-if="hint" class="viewer__hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.viewer {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0b0f14;
}
.viewer__canvas {
  width: 100%;
  height: 100%;
}
.viewer__hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-dim);
  font-size: var(--text-xs);
  letter-spacing: 0.03em;
  pointer-events: none;
  text-align: center;
  padding: 0 var(--space-4);
}
</style>
