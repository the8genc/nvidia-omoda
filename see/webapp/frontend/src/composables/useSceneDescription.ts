// Concern: periodically poll the VLM for a terse description + a public-danger flag, expose both | Non-concern: rendering (banner owns), the VLM call itself (backend owns) | IO: () -> reactive { text, danger }
import { onUnmounted, readonly, ref } from 'vue'
import { describeUrl } from '@/api/config'

const POLL_MS = 5000
const DANGER_QUESTION =
  'Is there an imminent danger to the public? Or is someone in urgent need of EMS/Police assistance?'

function pollUrl(): string {
  const u = new URL(describeUrl())
  u.searchParams.set('followup', DANGER_QUESTION)
  u.searchParams.set('followup_bool', 'true')
  return u.toString()
}

export function useSceneDescription() {
  const text = ref<string | null>(null)
  const danger = ref(false)
  const pending = ref(false)

  let inFlight = false
  let disposed = false
  let controller: AbortController | null = null

  async function poll(): Promise<void> {
    if (inFlight || disposed) return // the VLM call takes ~1-2s; never stack requests
    inFlight = true
    pending.value = true
    controller = new AbortController()
    try {
      const res = await fetch(pollUrl(), { signal: controller.signal })
      if (disposed) return // unmounted mid-flight — don't write to a dead component
      if (res.ok) {
        const data = await res.json()
        if (typeof data?.description === 'string') text.value = data.description
        danger.value = data?.followup?.answer === true
      }
    } catch {
      // keep the last description/flag on a transient failure or an abort
    } finally {
      inFlight = false
      pending.value = false
      controller = null
    }
  }

  // clear on a clip change: drop the stale description and abort any in-flight read (it's the old clip)
  function reset(): void {
    text.value = null
    danger.value = false
    controller?.abort()
  }

  // setInterval callbacks are inherently un-awaitable — void the promise explicitly; errors are handled inside poll
  void poll()
  const timer = window.setInterval(() => void poll(), POLL_MS)

  onUnmounted(() => {
    disposed = true
    clearInterval(timer)
    controller?.abort()
  })

  return { text: readonly(text), danger: readonly(danger), pending: readonly(pending), reset }
}
