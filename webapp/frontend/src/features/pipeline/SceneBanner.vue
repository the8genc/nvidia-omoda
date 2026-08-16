<!-- Concern: thin top banner showing the periodically-polled VLM scene description, with a play/stop control for the whole inference loop | Non-concern: polling/the VLM call and the pause/resume request (composables + backend own that) | IO: () -> banner -->
<script setup lang="ts">
import { Flag, Play, SkipForward, Sparkles, Square } from 'lucide-vue-next'
import { LIVE_KEY, SCENE_KEY } from '@/types/pipeline'
import { injectStrict } from '@/composables/injectStrict'

const { text, danger, pending, reset } = injectStrict(SCENE_KEY)
const live = injectStrict(LIVE_KEY)

async function toggleRun(): Promise<void> {
  try {
    if (live.running.value) await live.pause()
    else await live.resume()
  } catch {
    // on failure the running state simply does not flip — that is the feedback
  }
}

async function cycle(): Promise<void> {
  try {
    await live.nextDefault()
    reset() // clear the previous clip's description immediately
  } catch {
    // no-op on failure; the current clip keeps playing
  }
}
</script>

<template>
  <div class="banner" :class="{ 'is-pending': pending, 'is-danger': danger }">
    <Flag v-if="danger" :size="20" :stroke-width="2.5" class="banner__flag" />
    <Sparkles v-else :size="18" :stroke-width="2" class="banner__icon" />
    <span class="banner__text">{{ text ?? 'Analyzing scene…' }}</span>
    <button class="banner__btn" title="Next clip" @click="cycle">
      <SkipForward :size="16" :stroke-width="2.5" />
    </button>
    <button
      class="banner__btn"
      :title="live.running.value ? 'Stop pipeline' : 'Start pipeline'"
      @click="toggleRun"
    >
      <Square v-if="live.running.value" :size="16" :stroke-width="2.5" />
      <Play v-else :size="16" :stroke-width="2.5" />
    </button>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-5);
  background: var(--color-accent-soft);
  border-bottom: 1px solid var(--color-accent-border);
  color: var(--color-text);
  font-size: 1.25rem;
  line-height: 1.4;
  flex: none;
}
.banner__icon {
  color: var(--color-accent);
  flex: none;
}
.banner__flag {
  color: #fff;
  flex: none;
}
.banner.is-danger {
  background: #dc2626;
  border-bottom-color: #991b1b;
  color: #fff;
  font-weight: 600;
  animation: dangerpulse 1.2s ease-in-out infinite;
}
.banner.is-danger .banner__btn {
  border-color: rgba(255, 255, 255, 0.5);
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
@keyframes dangerpulse {
  0%, 100% { background: #dc2626; }
  50% { background: #b91c1c; }
}
.banner__text {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.banner__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-accent-border);
  background: var(--color-surface);
  color: var(--color-accent);
  cursor: pointer;
}
.banner__btn:hover {
  background: var(--color-accent-soft);
}
.banner.is-pending {
  opacity: 0.85;
}
</style>
