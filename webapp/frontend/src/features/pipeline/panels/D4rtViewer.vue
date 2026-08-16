<!-- Concern: render the live D4RT reconstruction as a raw point cloud (movers scrubbed) | Non-concern: the socket/wire format (useLiveCloudStream owns), the scene's GPU resources (LiveCloudCanvas owns) | IO: (enabled) -> canvas -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import LiveCloudCanvas from '@/components/cloud/LiveCloudCanvas.vue'
import { useLiveCloudStream } from '@/cloud/useLiveCloudStream'
import { d4rtWsUrl } from '@/api/config'

const props = defineProps<{
  enabled: boolean
}>()

// null url means "do not connect"; the stream reconnects whenever the url flips to a value
const url = computed(() => (props.enabled ? d4rtWsUrl() : null))
const stream = useLiveCloudStream(url)

// the socket is self-describing: numPoints/gridSide/classNames arrive in the hello
// before any frame, so the canvas is only built once that fixed capacity is known
const numPoints = computed(() => stream.info.value?.numPoints ?? 0)
const hasFrame = computed(() => stream.frame.value !== null)

const glError = ref<string | null>(null)
// bumped once the first frame's capacity is known so the camera frames the cloud
const resetToken = ref(0)

watch(numPoints, (n, prev) => {
  if (n > 0 && prev === 0) resetToken.value += 1
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
      :world="null"
      view="points"
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
