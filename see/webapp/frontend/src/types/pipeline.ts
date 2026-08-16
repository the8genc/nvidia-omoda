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

// one message per concern stream. seq is a global monotonic frame id (never resets on loop) shared
// across streams, so the overlay can align to the rgb frame actually painted, not whatever arrived last.
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
  // main feed: false = privacy-obfuscated frame, true = raw frame (a hazard unlocked it). Backend-decided.
  unlocked?: boolean
}

export interface LiveContext {
  enabled: Readonly<Ref<boolean>>
  connected: Readonly<Ref<boolean>>
  // boxes resolved to the frame actually painted (see commitDisplayedFrame) so the overlay stays coherent
  displayedBoxes: Readonly<Ref<DetectionBox[]>>
  latestRgb: Readonly<Ref<RgbMessage | null>>
  running: Readonly<Ref<boolean>>
  commitDisplayedFrame: (seq: number) => void
  pause: () => Promise<void>
  resume: () => Promise<void>
  nextDefault: () => Promise<void>
  toggle: () => void
  setEnabled: (value: boolean) => void
  setBoxesShown: (value: boolean) => void
  submitSource: (file: File) => Promise<void>
}

export const LIVE_KEY: InjectionKey<LiveContext> = Symbol('live')

// the VLM scene description + public-hazard flag, provided once at the app root and consumed by the
// banner (to display) and the main feed (to decide obfuscated-vs-raw)
export interface SceneContext {
  text: Readonly<Ref<string | null>>
  danger: Readonly<Ref<boolean>>
  pending: Readonly<Ref<boolean>>
  reset: () => void
}

export const SCENE_KEY: InjectionKey<SceneContext> = Symbol('scene')
