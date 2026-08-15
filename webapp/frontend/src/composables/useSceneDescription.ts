// Concern: periodically poll the VLM scene-description endpoint and expose the latest terse text | Non-concern: rendering (banner owns), the VLM call itself (backend owns) | IO: () -> reactive description
import { onUnmounted, readonly, ref } from 'vue'
import { describeUrl } from '@/api/config'

const POLL_MS = 5000

export function useSceneDescription() {
  const text = ref<string | null>(null)
  const pending = ref(false)

  let inFlight = false

  async function poll(): Promise<void> {
    if (inFlight) return // the VLM call takes ~1-2s; never stack requests
    inFlight = true
    pending.value = true
    try {
      const res = await fetch(describeUrl())
      if (res.ok) {
        const data = await res.json()
        const content = data?.choices?.[0]?.message?.content
        if (typeof content === 'string') text.value = content.trim()
      }
    } catch {
      // keep the last description on a transient failure
    } finally {
      inFlight = false
      pending.value = false
    }
  }

  poll()
  const timer = window.setInterval(poll, POLL_MS)
  onUnmounted(() => clearInterval(timer))

  return { text: readonly(text), pending: readonly(pending) }
}
