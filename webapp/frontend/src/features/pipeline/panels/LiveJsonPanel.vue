<!-- Concern: render the live scene graph as pretty JSON each frame, with LIVE indicator, index/nFrames and msg/s | Non-concern: transport (useLiveStream owns) | IO: (live) -> panel -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { Radio } from 'lucide-vue-next'
import PanelFrame from '@/components/layout/PanelFrame.vue'
import { LIVE_KEY } from '@/types/pipeline'
import { injectStrict } from '@/composables/injectStrict'

const live = injectStrict(LIVE_KEY)

// public = the privacy-preserved vocabulary the world sees; agent = the unrestricted local
// detection feed (labels WITH image-space positions) the local agent consumes. Same instant, aligned by seq.
type Feed = 'public' | 'agent'
const feed = ref<Feed>('public')
const feedPath = computed(() => (feed.value === 'public' ? 'public/vocabulary-stream' : 'local/detection-stream'))

// render each array element (one detected object) on a single line so many objects fit on screen at once
function formatScene(scene: Record<string, unknown>): string {
  const keys = Object.keys(scene)
  const lines: string[] = ['{']
  keys.forEach((key, ki) => {
    const tail = ki < keys.length - 1 ? ',' : ''
    const val = scene[key]
    if (Array.isArray(val)) {
      if (val.length === 0) { lines.push(`  "${key}": []${tail}`); return }
      lines.push(`  "${key}": [`)
      val.forEach((item, ii) => lines.push(`    ${JSON.stringify(item)}${ii < val.length - 1 ? ',' : ''}`))
      lines.push(`  ]${tail}`)
    } else {
      lines.push(`  "${key}": ${JSON.stringify(val)}${tail}`)
    }
  })
  lines.push('}')
  return lines.join('\n')
}

const pretty = computed(() => {
  if (feed.value === 'agent') {
    // the local/agent feed: detections with image-space positions, aligned to the shown frame
    return formatScene({ frame: live.index.value, boxes: live.displayedBoxes.value })
  }
  const scene = live.displayedScene.value
  if (scene === null) return ''
  try {
    return formatScene(scene as Record<string, unknown>)
  } catch {
    return '// scene not serializable'
  }
})

const counter = computed(() => `${live.index.value} / ${Math.max(live.nFrames.value, 0)}`)
</script>

<template>
  <PanelFrame title="Live Scene Graph" :subtitle="feedPath">
    <template #actions>
      <div class="seg" role="group" aria-label="feed">
        <button class="seg__btn" :class="{ 'is-on': feed === 'public' }" @click="feed = 'public'">Public</button>
        <button class="seg__btn" :class="{ 'is-on': feed === 'agent' }" @click="feed = 'agent'">Agent</button>
      </div>
      <span class="live-badge" :class="{ 'is-on': live.connected.value }">
        <Radio :size="13" :stroke-width="2" />
        {{ live.connected.value ? 'LIVE' : 'connecting' }}
      </span>
      <span class="live-meta tabular">{{ counter }}</span>
      <span class="live-meta tabular">{{ live.messagesPerSec.value }} msg/s</span>
    </template>

    <div class="live-json">
      <pre v-if="pretty" class="live-json__pre">{{ pretty }}</pre>
      <div v-else class="live-json__empty">
        <Radio :size="24" :stroke-width="1.5" class="pulse" />
        <span>{{ live.connected.value ? 'Awaiting first frame…' : 'Connecting to live stream…' }}</span>
      </div>
    </div>
  </PanelFrame>
</template>

<style scoped>
.seg {
  display: inline-flex;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.seg__btn {
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.03em;
  padding: 2px 9px;
  color: var(--color-text-dim);
  background: var(--color-surface);
  cursor: pointer;
  border: none;
}
.seg__btn + .seg__btn {
  border-left: 1px solid var(--color-border);
}
.seg__btn.is-on {
  color: var(--color-text);
  background: var(--color-accent-soft);
}
.live-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  color: var(--color-text-dim);
  border: 1px solid var(--color-border);
}
.live-badge.is-on {
  color: #ff4d4d;
  border-color: rgba(255, 77, 77, 0.5);
  background: rgba(255, 77, 77, 0.08);
  animation: livepulse 1.4s ease-in-out infinite;
}
.live-meta {
  font-size: var(--text-xs);
  color: var(--color-text-dim);
}
.live-json {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: auto;
  background: #0b0f14;
}
.live-json__pre {
  margin: 0;
  padding: var(--space-3);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.5;
  color: #9cdcfe;
  white-space: pre;
  tab-size: 2;
}
.live-json__empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-dim);
  font-size: var(--text-xs);
}
.pulse {
  color: #ff4d4d;
  animation: livepulse 1.4s ease-in-out infinite;
}
@keyframes livepulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
</style>
