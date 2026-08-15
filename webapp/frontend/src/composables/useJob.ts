// Concern: uploads video to /process, polls the manifest, exposes status + frame/cloud URLs | Non-concern: which frame shows or asset decode (usePlayback/panels own that) | IO: (cb) -> JobContext
import { onUnmounted, readonly, ref } from 'vue'
import { frameUrl, jobUrl, processUrl, renderUrl as buildRenderUrl } from '@/api/config'
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

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function pollOnce(id: string): Promise<void> {
    try {
      const response = await fetch(jobUrl(id))
      if (!response.ok) throw new Error(`Manifest request failed (${response.status})`)
      const data = (await response.json()) as JobManifest
      manifest.value = data
      status.value = data.status
      progress.value = typeof data.progress === 'number' ? data.progress : 0
      onManifest(data)
      if (data.status === 'done' || data.status === 'error') {
        stopPolling()
        if (data.status === 'error') error.value = 'Backend reported a processing error.'
      }
    } catch (e) {
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
    frameAssetUrl,
    cloudUrl,
    renderUrl
  }
}
