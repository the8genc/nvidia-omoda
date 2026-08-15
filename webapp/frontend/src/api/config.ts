// Concern: derive the backend host and build the live websocket + live source URLs | Non-concern: making the requests (useLiveStream owns fetching) | IO: () -> URL strings
// derive the backend host from the page origin so the app works on whatever DGX interface it is reached through (tailnet, LAN, localhost)
const API_HOST = typeof window !== 'undefined' && window.location.hostname ? window.location.hostname : '100.71.143.26'
const API_BASE = `http://${API_HOST}:8091/api`

// live streaming: one path per concern (need-to-know), source upload reuses API_BASE.
// consumers subscribe only to the streams they need.
const WS_BASE = `ws://${API_HOST}:8091/api`

export function vocabularyWsUrl(): string {
  return `${WS_BASE}/public/vocabulary-stream`
}

export function detectionWsUrl(): string {
  return `${WS_BASE}/local/detection-stream`
}

export function rgbWsUrl(): string {
  return `${WS_BASE}/local/rgb-stream`
}

// on-demand VLM description of the latest frame (polled by the banner)
export function describeUrl(): string {
  return `${API_BASE}/describe`
}

export function liveSourceUrl(): string {
  return `${API_BASE}/live/source`
}
