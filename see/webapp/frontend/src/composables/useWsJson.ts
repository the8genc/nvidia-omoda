// Concern: own one JSON websocket for a single concern — connect, parse+validate, reconnect with backoff, live fps, RAII-dispose | Non-concern: what the payload means (callers own that) | IO: (url, validator, enabled) -> reactive latest value
import { onUnmounted, readonly, ref, watch, type Ref } from 'vue'

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 5000
const FPS_WINDOW_MS = 1000

export interface WsJsonStream<T> {
  connected: Readonly<Ref<boolean>>
  latest: Readonly<Ref<T | null>>
  messagesPerSec: Readonly<Ref<number>>
}

export function useWsJson<T>(
  url: () => string,
  isValid: (value: unknown) => value is T,
  enabled: Ref<boolean>,
): WsJsonStream<T> {
  const connected = ref(false)
  const latest = ref<T | null>(null) as Ref<T | null>
  const messagesPerSec = ref(0)

  let socket: WebSocket | null = null
  let reconnectTimer: number | null = null
  let backoff = RECONNECT_MIN_MS
  let closedByUs = false
  let ticks = 0

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function onMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (!isValid(parsed)) return
    latest.value = parsed
    ticks += 1
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
      socket = new WebSocket(url())
    } catch {
      scheduleReconnect()
      return
    }
    socket.onopen = () => {
      connected.value = true
      backoff = RECONNECT_MIN_MS
    }
    socket.onmessage = onMessage
    socket.onerror = () => {
      // close handler drives reconnect; nothing to do here
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
  }

  const fpsTimer = window.setInterval(() => {
    messagesPerSec.value = Math.round((ticks * 1000) / FPS_WINDOW_MS)
    ticks = 0
  }, FPS_WINDOW_MS)

  watch(
    enabled,
    (on) => {
      if (on) connect()
      else disconnect()
    },
    { immediate: true },
  )

  onUnmounted(() => {
    disconnect()
    clearInterval(fpsTimer)
  })

  return {
    connected: readonly(connected),
    latest: readonly(latest) as Readonly<Ref<T | null>>,
    messagesPerSec: readonly(messagesPerSec),
  }
}
