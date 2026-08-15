// Concern: defines the live stream domain types and the typed injection key | Non-concern: providing or consuming those values (composables own that) | IO: none
import type { InjectionKey, Ref } from 'vue'

// image-space detection box, normalized to 0..1 so it overlays the rgb frame at any display size
export interface DetectionBox {
  label: string
  x1: number
  y1: number
  x2: number
  y2: number
  conf: number
}

// one message per concern stream — each socket carries only its concern.
// seq is a global monotonic frame id (never resets on loop) shared across streams, so a consumer
// can align rgb with its detections instead of showing whichever arrived last.
export interface VocabularyMessage {
  seq: number
  index: number
  n_frames: number
  scene: Record<string, unknown>
}

export interface DetectionMessage {
  seq: number
  index: number
  n_frames: number
  boxes: DetectionBox[]
}

export interface RgbMessage {
  seq: number
  index: number
  rgb: string
}

export interface LiveContext {
  enabled: Readonly<Ref<boolean>>
  connected: Readonly<Ref<boolean>>
  index: Readonly<Ref<number>>
  nFrames: Readonly<Ref<number>>
  // scene + boxes resolved to the frame actually painted (see commitDisplayedFrame), so every view is coherent
  displayedScene: Readonly<Ref<Record<string, unknown> | null>>
  displayedBoxes: Readonly<Ref<DetectionBox[]>>
  latestRgb: Readonly<Ref<RgbMessage | null>>
  messagesPerSec: Readonly<Ref<number>>
  commitDisplayedFrame: (seq: number) => void
  toggle: () => void
  setEnabled: (value: boolean) => void
  submitSource: (file: File) => Promise<void>
}

export const LIVE_KEY: InjectionKey<LiveContext> = Symbol('live')
