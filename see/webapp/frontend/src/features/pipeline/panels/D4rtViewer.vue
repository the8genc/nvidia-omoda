<!-- Concern: render the live D4RT point cloud in three.js with orbit controls | Non-concern: the websocket/wire format (useD4rtStream owns), mode selection (RawRgbPanel owns) | IO: (enabled) -> canvas -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useD4rtStream, type PointCloud } from '@/composables/useD4rtStream'

const props = defineProps<{ enabled: boolean }>()
const { connected, latest } = useD4rtStream(computed(() => props.enabled))
const hasCloud = computed(() => latest.value !== null)

const container = ref<HTMLElement | null>(null)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let geometry: THREE.BufferGeometry | null = null
let material: THREE.PointsMaterial | null = null
let raf = 0
let resizeObs: ResizeObserver | null = null
let capacity = 0

function initThree(): void {
  const el = container.value
  if (!el) return
  const w = el.clientWidth || 1
  const h = el.clientHeight || 1

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b0f14)

  camera = new THREE.PerspectiveCamera(60, w / h, 0.001, 100)
  camera.position.set(0, 0, 2.6)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(w, h)
  el.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.target.set(0, 0, 0)

  geometry = new THREE.BufferGeometry()
  material = new THREE.PointsMaterial({ size: 0.012, vertexColors: true, sizeAttenuation: true })
  scene.add(new THREE.Points(geometry, material))

  resizeObs = new ResizeObserver(onResize)
  resizeObs.observe(el)

  const animate = (): void => {
    raf = requestAnimationFrame(animate)
    controls?.update()
    if (renderer && scene && camera) renderer.render(scene, camera)
  }
  animate()
}

function updateCloud(cloud: PointCloud): void {
  if (!geometry) return
  if (cloud.count > capacity) {
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cloud.count * 3), 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(cloud.count * 3), 3, true))
    capacity = cloud.count
  }
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute
  const col = geometry.getAttribute('color') as THREE.BufferAttribute
  ;(pos.array as Float32Array).set(cloud.positions)
  ;(col.array as Uint8Array).set(cloud.colors)
  pos.needsUpdate = true
  col.needsUpdate = true
  geometry.setDrawRange(0, cloud.count)
}

function onResize(): void {
  const el = container.value
  if (!renderer || !camera || !el) return
  const w = el.clientWidth || 1
  const h = el.clientHeight || 1
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}

onMounted(() => {
  initThree()
  if (latest.value) updateCloud(latest.value)
})

watch(latest, (cloud) => {
  if (cloud) updateCloud(cloud)
})

onUnmounted(() => {
  if (raf) cancelAnimationFrame(raf)
  resizeObs?.disconnect()
  controls?.dispose()
  geometry?.dispose()
  material?.dispose()
  if (renderer) {
    renderer.dispose()
    renderer.domElement.remove()
  }
  renderer = scene = camera = null
  controls = null
  geometry = null
  material = null
})
</script>

<template>
  <div ref="container" class="viewer">
    <div v-if="!hasCloud" class="viewer__hint">
      {{ connected ? 'Reconstructing… (loading model on first view — ~1 min)' : 'Connecting…' }}
    </div>
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
.viewer :deep(canvas) {
  display: block;
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
}
</style>
