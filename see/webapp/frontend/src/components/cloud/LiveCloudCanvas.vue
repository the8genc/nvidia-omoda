<!-- LiveCloudCanvas: renders a stream of pushed pair clouds with Three.js. Owns the GPU resources, nothing else. -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'

import type { StaticWorld } from '@/cloud/staticWorld'
import type { LiveFrame } from '@/cloud/useLiveCloudStream'

import {
  createLiveCloudScene,
  type LiveCloudScene,
  type LiveColorMode,
  type LiveView,
} from './useLiveCloudScene'

const props = defineProps<{
  /** Fixed for the life of the socket; a change means new buffers. */
  numPoints: number
  frame: LiveFrame | null
  colorMode: LiveColorMode
  /** Draw the y=0 plane, so the levelling has something to be level against. */
  showGround: boolean
  /** The clip's static world, as built by the backend; null while it loads. */
  world: StaticWorld | null
  /** Show the measurement or the model. */
  view: LiveView
  /** Incrementing counter that requests a camera reset — props down, not a method call. */
  resetToken: number
}>()

const emit = defineEmits<{
  /** WebGL context creation failed — the parent decides what to show instead. */
  unsupported: [message: string]
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let scene: LiveCloudScene | null = null

function release(): void {
  scene?.dispose()
  scene = null
}

function build(): void {
  release()
  const canvas = canvasRef.value
  if (!canvas || props.numPoints <= 0) return
  try {
    scene = createLiveCloudScene(canvas, props.numPoints, props.colorMode)
    scene.setShowGround(props.showGround)
    scene.setView(props.view)
    scene.setWorld(props.world)
    if (props.frame) scene.push(props.frame)
  } catch (error) {
    emit(
      'unsupported',
      error instanceof Error ? error.message : 'WebGL is unavailable in this browser.',
    )
  }
}

onMounted(build)
onUnmounted(release)

watch(() => props.numPoints, build)
watch(() => props.world, (world) => scene?.setWorld(world))
watch(
  () => props.frame,
  (frame) => {
    if (frame) scene?.push(frame)
  },
)
watch(() => props.colorMode, (mode) => scene?.setColorMode(mode))
watch(() => props.showGround, (show) => scene?.setShowGround(show))
watch(() => props.view, (view) => scene?.setView(view))
watch(() => props.resetToken, () => scene?.resetView())
</script>

<template>
  <canvas ref="canvasRef" class="live-canvas" aria-label="Live 3D point cloud, drag to orbit" />
</template>

<style scoped>
.live-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
  background: linear-gradient(180deg, var(--surface-2), var(--surface));
}

.live-canvas:active {
  cursor: grabbing;
}
</style>
