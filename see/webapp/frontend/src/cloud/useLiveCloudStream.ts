// Owns one live pair-stream socket: decodes each binary frame into buffers a
// WebGL canvas can take, and closes itself when its owner unmounts.

import { onUnmounted, readonly, ref, shallowRef, watch, type Ref } from 'vue'

/** Quantisation divisor from the packer — positions are int16 scaled to +-32000. */
const QUANT_SCALE = 32000

/** Byte layout of the header the backend prefixes to every frame (`live.py`). */
const HEADER_BYTES = 40
/** One tracked thing, appended after the points (`_BLOB` in `live.py`). */
const BLOB_BYTES = 44

/** Smoothing for the displayed rate, so the readout is legible rather than twitchy. */
const RATE_SMOOTHING = 0.15

export type LiveStatus = 'idle' | 'connecting' | 'streaming' | 'closed' | 'error'

/** What the server announces once, before any frame. */
export interface LiveStreamInfo {
  numPoints: number
  gridSide: number
  frames: number
  stride: number
  segment: boolean
  classNames: readonly string[]
  source: string
}

/**
 * One tracked moving thing, as a box on the ground.
 *
 * Everything is in the model's own frame; the decoder flips it the same way it
 * flips the points. Heading arrives as a vector rather than an angle precisely
 * because of that flip — it mirrors the ground plane, and an angle would come
 * out reflected.
 */
export interface LiveBlob {
  id: number
  kind: number
  coasting: boolean
  age: number
  /** Centre on the ground plane. */
  x: number
  z: number
  /** Units per second, same frame. */
  vx: number
  vz: number
  /** Unit heading in the ground plane. */
  hx: number
  hz: number
  length: number
  width: number
  height: number
}

/** One reconstructed pair, ready for a GPU buffer. */
export interface LiveFrame {
  index: number
  gpuMs: number
  radius: number
  numPoints: number
  /** Where the camera sits, in the same frame and axes as the points. */
  camera: readonly [number, number, number]
  /** Angular width of one grid cell: point size is this times distance from the camera. */
  pointScale: number
  /** (N*3) float, already in three.js axes. */
  positions: Float32Array
  /** (N*3) float 0..1. */
  colors: Float32Array
  /** (N) semantic class id per point; 255 where the frame carried no labels. */
  labels: Uint8Array
  /** Seconds on the producer's clock, so a box can be dead-reckoned forward. */
  at: number
  blobs: readonly LiveBlob[]
}

/** The scene with its traffic removed, rebuilt as the stream runs. */
export interface PlateState {
  /** Ready for an <img src>. */
  url: string
  samples: number
  spanSeconds: number
}

/** Levelling state, as the server reports it. */
export interface GroundState {
  levelled: boolean
  error: string | null
  tiltDegrees?: number
  inliers?: number
  roadPoints?: number
}

export interface LiveCloudStream {
  status: Readonly<Ref<LiveStatus>>
  error: Readonly<Ref<string | null>>
  info: Readonly<Ref<LiveStreamInfo | null>>
  /** Newest frame only — live means fresh, so nothing is buffered here. */
  frame: Readonly<Ref<LiveFrame | null>>
  /** Frames per second, measured at this client, smoothed. */
  fps: Readonly<Ref<number>>
  /** Server-reported GPU milliseconds for the last frame. */
  gpuMs: Readonly<Ref<number>>
  framesReceived: Readonly<Ref<number>>
  ground: Readonly<Ref<GroundState | null>>
  plate: Readonly<Ref<PlateState | null>>
  /** True between asking to level the ground and the server answering. */
  calibrating: Readonly<Ref<boolean>>
  /** Fit the ground plane on the next pair. */
  calibrate: () => void
  /** Drop the levelling and go back to the camera's own frame. */
  clearGround: () => void
}

function decodeFrame(buffer: ArrayBuffer): LiveFrame | null {
  if (buffer.byteLength < HEADER_BYTES) return null
  const header = new DataView(buffer, 0, HEADER_BYTES)
  const index = header.getUint32(0, true)
  const gpuMs = header.getFloat32(4, true)
  const radius = header.getFloat32(8, true)
  const numPoints = header.getUint32(12, true)
  // Same axis flip the points get, so the camera stays where it belongs.
  const camera: readonly [number, number, number] = [
    header.getFloat32(16, true),
    -header.getFloat32(20, true),
    -header.getFloat32(24, true),
  ]
  const pointScale = header.getFloat32(28, true)
  const at = header.getFloat32(32, true)
  const numBlobs = header.getUint32(36, true)

  const body = HEADER_BYTES + numPoints * 3 * 2 + numPoints * 3 + numPoints
  if (buffer.byteLength !== body + numBlobs * BLOB_BYTES) return null

  const quantised = new Int16Array(buffer, HEADER_BYTES, numPoints * 3)
  const rgb = new Uint8Array(buffer, HEADER_BYTES + numPoints * 6, numPoints * 3)
  const labels = new Uint8Array(buffer, HEADER_BYTES + numPoints * 9, numPoints)
  const blobs: LiveBlob[] = []
  for (let b = 0; b < numBlobs; b += 1) {
    const at = new DataView(buffer, body + b * BLOB_BYTES, BLOB_BYTES)
    blobs.push({
      id: at.getUint32(0, true),
      kind: at.getUint8(4),
      coasting: (at.getUint8(5) & 2) !== 0,
      age: at.getUint16(6, true),
      // The same flip the points get. Heading is a vector, so it passes through
      // it correctly; an angle could not.
      x: at.getFloat32(8, true),
      z: -at.getFloat32(12, true),
      vx: at.getFloat32(16, true),
      vz: -at.getFloat32(20, true),
      hx: at.getFloat32(24, true),
      hz: -at.getFloat32(28, true),
      length: at.getFloat32(32, true),
      width: at.getFloat32(36, true),
      height: at.getFloat32(40, true),
    })
  }
  const positions = new Float32Array(numPoints * 3)
  const colors = new Float32Array(numPoints * 3)

  for (let i = 0; i < numPoints * 3; i += 3) {
    // Same axis flip the packed-cloud decoder applies: the model's camera-local
    // y/z are OpenCV-down, three.js is y-up.
    positions[i] = quantised[i] / QUANT_SCALE
    positions[i + 1] = -quantised[i + 1] / QUANT_SCALE
    positions[i + 2] = -quantised[i + 2] / QUANT_SCALE
    colors[i] = rgb[i] / 255
    colors[i + 1] = rgb[i + 1] / 255
    colors[i + 2] = rgb[i + 2] / 255
  }
  return {
    index,
    gpuMs,
    radius,
    numPoints,
    camera,
    pointScale,
    positions,
    colors,
    labels: new Uint8Array(labels),
    at,
    blobs,
  }
}

/**
 * Connects whenever `url` has a value and reconnects when it changes, so stream
 * parameters are just a new URL. A null url means "do not connect" — that is how
 * the mock backend, which has no GPU behind it, declines.
 */
export function useLiveCloudStream(url: Ref<string | null>): LiveCloudStream {
  const status = ref<LiveStatus>('idle')
  const error = ref<string | null>(null)
  const info = ref<LiveStreamInfo | null>(null)
  const frame = shallowRef<LiveFrame | null>(null)
  const fps = ref(0)
  const gpuMs = ref(0)
  const framesReceived = ref(0)
  const ground = ref<GroundState | null>(null)
  const plate = ref<PlateState | null>(null)
  const calibrating = ref(false)

  let socket: WebSocket | null = null
  let lastFrameAt = 0

  function close(): void {
    if (socket) {
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      socket.close()
      socket = null
    }
  }

  function onMessage(event: MessageEvent): void {
    if (typeof event.data === 'string') {
      const parsed: unknown = JSON.parse(event.data)
      if (typeof parsed !== 'object' || parsed === null) return
      const message = parsed as Record<string, unknown>
      if (message.type === 'plate') {
        plate.value = {
          url: `data:image/jpeg;base64,${message.jpeg as string}`,
          samples: message.samples as number,
          spanSeconds: message.spanSeconds as number,
        }
        return
      }
      if (message.type === 'ground') {
        ground.value = message as unknown as GroundState
        calibrating.value = false
        return
      }
      info.value = parsed as LiveStreamInfo
      status.value = 'streaming'
      return
    }
    const decoded = decodeFrame(event.data as ArrayBuffer)
    if (!decoded) {
      error.value = 'Received a malformed frame from the stream.'
      return
    }
    const now = performance.now()
    if (lastFrameAt > 0) {
      const instant = 1000 / Math.max(1, now - lastFrameAt)
      fps.value = fps.value === 0 ? instant : fps.value + RATE_SMOOTHING * (instant - fps.value)
    }
    lastFrameAt = now
    gpuMs.value = decoded.gpuMs
    framesReceived.value += 1
    frame.value = decoded
  }

  function connect(target: string): void {
    close()
    status.value = 'connecting'
    error.value = null
    info.value = null
    frame.value = null
    fps.value = 0
    framesReceived.value = 0
    // A new clip is a new scene: whatever ground we found does not apply to it.
    ground.value = null
    plate.value = null
    // The server levels the first pair of every stream unprompted, so the view
    // should say so from the moment it connects rather than after a click.
    calibrating.value = true
    lastFrameAt = 0

    const opened = new WebSocket(target)
    opened.binaryType = 'arraybuffer'
    opened.onmessage = onMessage
    opened.onerror = () => {
      error.value = 'The live stream connection failed.'
      status.value = 'error'
    }
    opened.onclose = (event) => {
      if (status.value === 'error') return
      // Codes above 4000 are ours: the server refused with a stated reason.
      if (event.code >= 4000 && event.reason) {
        error.value = event.reason
        status.value = 'error'
        return
      }
      status.value = 'closed'
    }
    socket = opened
  }

  watch(
    url,
    (target) => {
      close()
      if (!target) {
        status.value = 'idle'
        return
      }
      connect(target)
    },
    { immediate: true },
  )

  function send(type: string): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type }))
  }

  function calibrate(): void {
    if (socket?.readyState !== WebSocket.OPEN) return
    calibrating.value = true
    send('calibrate')
  }

  function clearGround(): void {
    ground.value = null
    send('clear-ground')
  }

  onUnmounted(close)

  return {
    status: readonly(status),
    error: readonly(error),
    info: readonly(info),
    frame: frame as Readonly<Ref<LiveFrame | null>>,
    fps: readonly(fps),
    gpuMs: readonly(gpuMs),
    framesReceived: readonly(framesReceived),
    ground: readonly(ground) as Readonly<Ref<GroundState | null>>,
    plate: readonly(plate) as Readonly<Ref<PlateState | null>>,
    calibrating: readonly(calibrating),
    calibrate,
    clearGround,
  }
}
