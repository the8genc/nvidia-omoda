// Concern: compose the detection + rgb websocket streams into one LiveContext, aligning boxes to the painted frame (by seq), plus source upload and play/stop | Non-concern: socket mechanics (useWsJson owns), rendering (panels own) | IO: (enabled) -> LiveContext
import { computed, readonly, ref, watch, type Ref } from 'vue'
import {
  detectionWsUrl,
  liveNextDefaultUrl,
  livePauseUrl,
  liveResumeUrl,
  liveSourceUrl,
  rgbWsUrl,
} from '@/api/config'
import { useWsJson } from '@/composables/useWsJson'
import type { DetectionBox, DetectionMessage, LiveContext, RgbMessage } from '@/types/pipeline'

// how many recent detection frames to retain for seq-alignment against the painted rgb frame
const BUFFER = 180

function isDetection(value: unknown): value is DetectionMessage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.seq === 'number' && Array.isArray(v.boxes)
}

function isRgb(value: unknown): value is RgbMessage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.seq === 'number' && typeof v.rgb === 'string'
}

function bufferBySeq<T extends { seq: number }>(source: Readonly<Ref<T | null>>): Map<number, T> {
  const map = new Map<number, T>()
  watch(source, (msg) => {
    if (!msg) return
    map.set(msg.seq, msg)
    if (map.size > BUFFER) map.delete(map.keys().next().value as number)
  })
  return map
}

// newest buffered entry whose seq is at or before target — never ahead of the painted frame
function atOrBefore<T>(map: Map<number, T>, target: number): T | null {
  let bestSeq = -1
  let best: T | null = null
  for (const [seq, value] of map) {
    if (seq <= target && seq > bestSeq) {
      bestSeq = seq
      best = value
    }
  }
  return best
}

export function useLiveStream(enabled: Ref<boolean>): LiveContext {
  // the detection socket connects only while boxes are shown; with no subscriber the backend skips YOLOE
  const wantDetection = ref(false)
  const detectionEnabled = ref(false)
  watch([enabled, wantDetection], ([e, w]) => (detectionEnabled.value = e && w), { immediate: true })

  const detection = useWsJson(detectionWsUrl, isDetection, detectionEnabled)
  const rgb = useWsJson(rgbWsUrl, isRgb, enabled)

  const detBySeq = bufferBySeq(detection.latest)

  // seq of the rgb frame the browser has actually painted; the overlay aligns to it
  const displayedSeq = ref(-1)
  function commitDisplayedFrame(seq: number): void {
    displayedSeq.value = seq
  }

  const displayedBoxes = computed<DetectionBox[]>(() => {
    void detection.latest.value // recompute when a fresh detection lands, not only on paint
    return atOrBefore(detBySeq, displayedSeq.value)?.boxes ?? []
  })

  const connected = computed(() => detection.connected.value || rgb.connected.value)

  // play/stop the whole inference loop; server-owned, mirror the confirmed 200
  const running = ref(true)

  async function pause(): Promise<void> {
    const res = await fetch(livePauseUrl(), { method: 'POST' })
    if (!res.ok) throw new Error(`Pause failed (${res.status})`)
    running.value = false
  }

  async function resume(): Promise<void> {
    const res = await fetch(liveResumeUrl(), { method: 'POST' })
    if (!res.ok) throw new Error(`Resume failed (${res.status})`)
    running.value = true
  }

  async function nextDefault(): Promise<void> {
    const res = await fetch(liveNextDefaultUrl(), { method: 'POST' })
    if (!res.ok) throw new Error(`Next default failed (${res.status})`)
    running.value = true
  }

  function toggle(): void {
    enabled.value = !enabled.value
  }

  function setEnabled(value: boolean): void {
    enabled.value = value
  }

  function setBoxesShown(value: boolean): void {
    wantDetection.value = value
  }

  async function submitSource(file: File): Promise<void> {
    const form = new FormData()
    form.append('video', file)
    const response = await fetch(liveSourceUrl(), { method: 'POST', body: form })
    if (!response.ok) throw new Error(`Live source upload failed (${response.status})`)
    running.value = true // backend auto-resumes the new source
  }

  return {
    enabled: readonly(enabled),
    connected,
    displayedBoxes,
    latestRgb: rgb.latest,
    running: readonly(running),
    commitDisplayedFrame,
    pause,
    resume,
    nextDefault,
    toggle,
    setEnabled,
    setBoxesShown,
    submitSource,
  }
}
