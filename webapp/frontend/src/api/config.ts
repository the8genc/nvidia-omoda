// Concern: holds the API base URL and builds process/job/frame endpoint URLs | Non-concern: making the requests (useJob owns fetching) | IO: (jobId, index, asset) -> URL strings
export const API_BASE = 'http://100.71.143.26:8091/api'

export function processUrl(): string {
  return `${API_BASE}/process`
}

export function jobUrl(jobId: string): string {
  return `${API_BASE}/jobs/${jobId}`
}

export function frameUrl(jobId: string, index: number, asset: string): string {
  return `${API_BASE}/jobs/${jobId}/frames/${index}/${asset}`
}

export function renderUrl(jobId: string, index: number): string {
  return frameUrl(jobId, index, 'render.json')
}
