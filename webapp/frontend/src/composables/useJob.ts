// Concern: attach a job (upload to /process or load the demo), poll its manifest, expose status + asset URLs | Non-concern: frame choice or decode (usePlayback/panels) | IO: (cb) -> JobContext
import { onUnmounted, readonly, ref } from 'vue'
import { demoUrl, frameUrl, jobUrl, processUrl, renderUrl as buildRenderUrl } from '@/api/config'
import type { FrameAsset, JobContext, JobManifest, JobStatus } from '@/types/pipeline'

const POLL_INTERVAL_MS = 900

export function useJob(onManifest: (manifest: JobManifest) => void): JobContext {
  const jobId = ref<string | null>(null)
  const manifest = ref<JobManifest | null>(null)
  const status = ref<JobStatus>('idle')
  const progress = ref(0)
  const error = ref<string | null>(null)
  const uploading = ref(false)

  let pollTimer: number | null = null
  let disposed = false
  // bumped on every new attach (upload or load) so an in-flight poll from a superseded job cannot clobber current state
  let generation = 0

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function pollOnce(id: string): Promise<void> {
    const gen = generation
    try {
      const response = await fetch(jobUrl(id))
      if (!response.ok) throw new Error(`Manifest request failed (${response.status})`)
      const data = (await response.json()) as JobManifest
      // a newer attach happened while this fetch was in flight: drop the result rather than clobber the current job
      if (disposed || gen !== generation) return
      manifest.value = data
      status.value = data.status
      progress.value = typeof data.progress === 'number' ? data.progress : 0
      onManifest(data)
      if (data.status === 'done' || data.status === 'error') {
        stopPolling()
        if (data.status === 'error') error.value = 'Backend reported a processing error.'
      }
    } catch (e) {
      if (disposed || gen !== generation) return
      error.value = e instanceof Error ? e.message : 'Failed to poll job manifest.'
      status.value = 'error'
      stopPolling()
    }
  }

  function startPolling(id: string): void {
    stopPolling()
    pollTimer = window.setInterval(() => {
      void pollOnce(id)
    }, POLL_INTERVAL_MS)
  }

  async function submitVideo(file: File): Promise<void> {
    stopPolling()
    generation++
    uploading.value = true
    error.value = null
    status.value = 'queued'
    progress.value = 0
    manifest.value = null
    jobId.value = null

    try {
      const form = new FormData()
      form.append('video', file)
      const response = await fetch(processUrl(), { method: 'POST', body: form })
      if (!response.ok) throw new Error(`Upload failed (${response.status})`)
      const data = (await response.json()) as { job_id: string }
      jobId.value = data.job_id
      status.value = 'processing'
      await pollOnce(data.job_id)
      if (status.value === 'processing' || status.value === 'queued') startPolling(data.job_id)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to submit video.'
      status.value = 'error'
      throw e
    } finally {
      uploading.value = false
    }
  }

  async function loadJob(id: string): Promise<void> {
    // attach to an already-processed (or processing) job without uploading; pollOnce sets status from the manifest so a done job never flashes "processing"
    stopPolling()
    generation++
    error.value = null
    jobId.value = id
    progress.value = 0
    manifest.value = null
    await pollOnce(id)
    if (!disposed && (status.value === 'processing' || status.value === 'queued')) startPolling(id)
  }

  async function loadDemo(): Promise<void> {
    // boot into the persistent demo job; a 404 (no demo) or a racing upload leaves the app on the dropzone, while any other failure surfaces as an error
    if (jobId.value || uploading.value) return
    try {
      const response = await fetch(demoUrl())
      if (response.status === 404) return
      if (!response.ok) throw new Error(`Demo request failed (${response.status})`)
      const data = (await response.json()) as { job_id: string }
      if (!jobId.value && !uploading.value && !disposed) await loadJob(data.job_id)
    } catch (e) {
      if (!disposed) error.value = e instanceof Error ? e.message : 'Failed to load demo job.'
    }
  }

  function frameAssetUrl(index: number, asset: FrameAsset): string {
    if (!jobId.value) return ''
    return frameUrl(jobId.value, index, asset)
  }

  function cloudUrl(index: number): string {
    if (!jobId.value) return ''
    return frameUrl(jobId.value, index, 'cloud.bin')
  }

  function renderUrl(index: number): string {
    if (!jobId.value) return ''
    return buildRenderUrl(jobId.value, index)
  }

  onUnmounted(() => {
    disposed = true
    stopPolling()
  })

  return {
    jobId: readonly(jobId),
    manifest: readonly(manifest),
    status: readonly(status),
    progress: readonly(progress),
    error: readonly(error),
    uploading: readonly(uploading),
    submitVideo,
    loadDemo,
    frameAssetUrl,
    cloudUrl,
    renderUrl
  }
}
