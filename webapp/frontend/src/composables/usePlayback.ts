// Concern: owns playback state and a rAF loop advancing currentFrame at fps | Non-concern: which frames exist or their assets (useJob owns that) | IO: () -> PlaybackContext
import { onMounted, onUnmounted, readonly, ref } from 'vue'
import type { PlaybackContext } from '@/types/pipeline'

const MIN_FPS = 1
const MAX_FPS = 60

export function usePlayback(): PlaybackContext {
  const currentFrame = ref(0)
  const playing = ref(false)
  const fps = ref(12)
  const frameCount = ref(0)

  let rafId: number | null = null
  let lastTs: number | null = null
  let accumulator = 0

  function clampFrame(index: number): number {
    if (frameCount.value <= 0) return 0
    const max = frameCount.value - 1
    return Math.min(Math.max(index, 0), max)
  }

  function tick(ts: number): void {
    if (lastTs === null) lastTs = ts
    const delta = ts - lastTs
    lastTs = ts

    if (playing.value && frameCount.value > 0) {
      accumulator += delta
      const interval = 1000 / fps.value
      while (accumulator >= interval) {
        accumulator -= interval
        currentFrame.value = (currentFrame.value + 1) % frameCount.value
      }
    } else {
      accumulator = 0
    }

    rafId = requestAnimationFrame(tick)
  }

  function togglePlaying(): void {
    playing.value = !playing.value
  }

  function setPlaying(value: boolean): void {
    playing.value = value
  }

  function setFrame(index: number): void {
    currentFrame.value = clampFrame(index)
  }

  function stepFrame(delta: number): void {
    if (frameCount.value <= 0) return
    playing.value = false
    const next = (currentFrame.value + delta + frameCount.value) % frameCount.value
    currentFrame.value = next
  }

  function setFps(value: number): void {
    fps.value = Math.min(Math.max(Math.round(value), MIN_FPS), MAX_FPS)
  }

  function setFrameCount(value: number): void {
    frameCount.value = Math.max(0, Math.floor(value))
    currentFrame.value = clampFrame(currentFrame.value)
  }

  onMounted(() => {
    rafId = requestAnimationFrame(tick)
  })

  onUnmounted(() => {
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
    lastTs = null
  })

  return {
    currentFrame: readonly(currentFrame),
    playing: readonly(playing),
    fps: readonly(fps),
    frameCount: readonly(frameCount),
    togglePlaying,
    setPlaying,
    setFrame,
    stepFrame,
    setFps,
    setFrameCount
  }
}
