// Concern: defines shared domain types and the typed injection keys | Non-concern: providing or consuming those values (composables own that) | IO: none
import type { InjectionKey, Ref } from 'vue'

export type JobStatus = 'idle' | 'queued' | 'processing' | 'done' | 'error'

export interface JobManifest {
  status: JobStatus
  n_frames: number
  fps: number
  width: number
  height: number
  progress: number
}

export type FrameAsset = 'rgb.jpg' | 'depth.png' | 'seg.png'

export interface PointCloud {
  count: number
  positions: Float32Array
  colors: Float32Array
  labelColors: Float32Array
}

export interface PlaybackContext {
  currentFrame: Readonly<Ref<number>>
  playing: Readonly<Ref<boolean>>
  fps: Readonly<Ref<number>>
  frameCount: Readonly<Ref<number>>
  togglePlaying: () => void
  setPlaying: (value: boolean) => void
  setFrame: (index: number) => void
  stepFrame: (delta: number) => void
  setFps: (value: number) => void
  setFrameCount: (value: number) => void
}

export interface JobContext {
  jobId: Readonly<Ref<string | null>>
  manifest: Readonly<Ref<JobManifest | null>>
  status: Readonly<Ref<JobStatus>>
  progress: Readonly<Ref<number>>
  error: Readonly<Ref<string | null>>
  uploading: Readonly<Ref<boolean>>
  submitVideo: (file: File) => Promise<void>
  frameAssetUrl: (index: number, asset: FrameAsset) => string
  cloudUrl: (index: number) => string
}

export const PLAYBACK_KEY: InjectionKey<PlaybackContext> = Symbol('playback')
export const JOB_KEY: InjectionKey<JobContext> = Symbol('job')
