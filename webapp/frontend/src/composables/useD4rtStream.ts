// Concern: own the binary D4RT point-cloud websocket — connect only while enabled, parse the self-describing wire frame into typed arrays, reconnect, RAII-dispose | Non-concern: rendering (D4rtViewer owns) | IO: (enabled) -> reactive latest cloud
import { onUnmounted, readonly, ref, shallowRef, watch, type Ref } from 'vue'
import { d4rtWsUrl } from '@/api/config'

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 5000
const QUANT = 32000

// wire frame: header "<IffI" (index u32, gpuMs f32, radius f32, numPoints u32),
// then int16[N*3] xyz quantised to +/-32000 of radius, then uint8[N*3] rgb.
export interface PointCloud {
  positions: Float32Array // N*3, normalised to the unit sphere (shape preserved), centred at origin
  colors: Uint8Array // N*3
  count: number
  index: number
  gpuMs: number
}

function parse(buf: ArrayBuffer): PointCloud | null {
  if (buf.byteLength < 16) return null
  const dv = new DataView(buf)
  const index = dv.getUint32(0, true)
  const gpuMs = dv.getFloat32(4, true)
  const count = dv.getUint32(12, true)
  const xyzBytes = count * 3 * 2
  const rgbBytes = count * 3
  if (buf.byteLength < 16 + xyzBytes + rgbBytes) return null
  // q/32000 == offset/radius, so this is already the shape normalised to [-1, 1]; radius (dv @8) is metadata
  const q = new Int16Array(buf, 16, count * 3)
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < positions.length; i++) positions[i] = q[i] / QUANT
  const colors = new Uint8Array(buf.slice(16 + xyzBytes, 16 + xyzBytes + rgbBytes))
  return { positions, colors, count, index, gpuMs }
}

export function useD4rtStream(enabled: Ref<boolean>) {
  const connected = ref(false)
  const latest = shallowRef<PointCloud | null>(null)

  let socket: WebSocket | null = null
  let reconnectTimer: number | null = null
  let backoff = RECONNECT_MIN_MS
  let closedByUs = false

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function onMessage(event: MessageEvent): void {
    if (!(event.data instanceof ArrayBuffer)) return
    const cloud = parse(event.data)
    if (cloud) latest.value = cloud
  }

  function scheduleReconnect(): void {
    if (closedByUs) return
    clearReconnect()
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, backoff)
    backoff = Math.min(RECONNECT_MAX_MS, backoff * 2)
  }

  function connect(): void {
    closedByUs = false
    clearReconnect()
    if (socket) return
    try {
      socket = new WebSocket(d4rtWsUrl())
    } catch {
      scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      connected.value = true
      backoff = RECONNECT_MIN_MS
    }
    socket.onmessage = onMessage
    socket.onerror = () => {
      // close handler drives reconnect
    }
    socket.onclose = () => {
      connected.value = false
      socket = null
      scheduleReconnect()
    }
  }

  function disconnect(): void {
    closedByUs = true
    clearReconnect()
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
      socket = null
    }
    connected.value = false
    latest.value = null
  }

  watch(enabled, (on) => (on ? connect() : disconnect()), { immediate: true })
  onUnmounted(disconnect)

  return { connected: readonly(connected), latest }
}
