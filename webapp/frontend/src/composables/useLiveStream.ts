// Concern: compose the per-concern websocket streams into one LiveContext, aligning scene + boxes to the frame actually painted (by seq), plus source upload | Non-concern: socket mechanics (useWsJson owns), rendering (panels own) | IO: (enabled) -> LiveContext
import { computed, ref, watch, type Ref } from 'vue'
import { detectionWsUrl, liveSourceUrl, rgbWsUrl, vocabularyWsUrl } from '@/api/config'
import { useWsJson } from '@/composables/useWsJson'
import type {
  DetectionBox,
  DetectionMessage,
  LiveContext,
  RgbMessage,
  VocabularyMessage,
} from '@/types/pipeline'

// how many recent frames of each stream to retain for seq-alignment
const BUFFER = 180

function isVocabulary(value: unknown): value is VocabularyMessage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.seq === 'number' && typeof v.scene === 'object' && v.scene !== null
}

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

// buffer keyed by seq (insertion order == seq order, since seq is monotonic); drops oldest past BUFFER
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
  const vocabulary = useWsJson(vocabularyWsUrl, isVocabulary, enabled)
  const detection = useWsJson(detectionWsUrl, isDetection, enabled)
  const rgb = useWsJson(rgbWsUrl, isRgb, enabled)

  const vocabBySeq = bufferBySeq(vocabulary.latest)
  const detBySeq = bufferBySeq(detection.latest)

  // seq of the rgb frame the browser has actually painted; every view aligns to it so the image,
  // its boxes, and the scene json always describe the same instant
  const displayedSeq = ref(-1)
  function commitDisplayedFrame(seq: number): void {
    displayedSeq.value = seq
  }

  const displayedVocab = computed(() => {
    void vocabulary.latest.value // recompute when a fresh vocab frame lands, not only on paint
    return atOrBefore(vocabBySeq, displayedSeq.value)
  })
  const displayedScene = computed(() => displayedVocab.value?.scene ?? null)
  const displayedBoxes = computed<DetectionBox[]>(() => {
    void detection.latest.value
    return atOrBefore(detBySeq, displayedSeq.value)?.boxes ?? []
  })

  const index = computed(() => displayedVocab.value?.index ?? 0)
  const nFrames = computed(() => displayedVocab.value?.n_frames ?? 0)
  const connected = computed(
    () => vocabulary.connected.value || detection.connected.value || rgb.connected.value,
  )

  function toggle(): void {
    enabled.value = !enabled.value
  }

  function setEnabled(value: boolean): void {
    enabled.value = value
  }

  async function submitSource(file: File): Promise<void> {
    const form = new FormData()
    form.append('video', file)
    const response = await fetch(liveSourceUrl(), { method: 'POST', body: form })
    if (!response.ok) throw new Error(`Live source upload failed (${response.status})`)
  }

  return {
    enabled,
    connected,
    index,
    nFrames,
    displayedScene,
    displayedBoxes,
    latestRgb: rgb.latest,
    messagesPerSec: vocabulary.messagesPerSec,
    commitDisplayedFrame,
    toggle,
    setEnabled,
    submitSource,
  }
}
