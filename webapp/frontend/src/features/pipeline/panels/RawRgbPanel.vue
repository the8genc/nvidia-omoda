<!-- Concern: render the live rgb frame with an optional generic bbox overlay, kept in sync by seq | Non-concern: what a box means — it draws rectangles + label strings the backend sends, no domain branching | IO: (live) -> panel -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ImageOff } from 'lucide-vue-next'
import PanelFrame from '@/components/layout/PanelFrame.vue'
import D4rtViewer from '@/features/pipeline/panels/D4rtViewer.vue'
import { LIVE_KEY } from '@/types/pipeline'
import { injectStrict } from '@/composables/injectStrict'

const live = injectStrict(LIVE_KEY)

type Mode = 'main' | 'boxes' | 'd4rt'
const mode = ref<Mode>('main')
// the backend firewall decides obfuscated-vs-raw on rgb-stream; the frontend just reflects its flag
const unlocked = computed(() => live.latestRgb.value?.unlocked === true)
watch(mode, (m) => live.setBoxesShown(m === 'boxes'), { immediate: true })
const subtitle = computed(() =>
  mode.value === 'd4rt'
    ? '3D reconstruction'
    : mode.value === 'boxes'
      ? 'detections'
      : unlocked.value
        ? 'hazard · full feed unlocked'
        : 'privacy · obfuscated',
)

// the main feed always points at rgb-stream (which the backend serves obfuscated or raw)
const displayUrl = computed(() => live.latestRgb.value?.rgb ?? '')
const hasFrame = computed(() => displayUrl.value !== '')
const shownBoxes = computed(() => live.displayedBoxes.value)

// confidence -> rainbow ramp: blue (low) through green/yellow to red (high), rankable at a glance
function boxColor(conf: number): string {
  const c = Math.min(Math.max(conf, 0), 1)
  return `hsl(${Math.round(240 * (1 - c))}, 90%, 50%)`
}

// the image src is always the latest frame; committing its seq once it actually paints is what
// drives every view (boxes here, scene json in the other panel) to describe this same instant
function onImgLoad(): void {
  live.commitDisplayedFrame(live.latestRgb.value?.seq ?? -1)
}
</script>

<template>
  <PanelFrame title="Main feed" :subtitle="subtitle">
    <template #actions>
      <div v-if="mode === 'boxes'" class="legend" aria-label="confidence scale">
        <span>low</span><i class="legend__bar"></i><span>high</span>
      </div>
      <div class="seg" role="group" aria-label="view mode">
        <button class="seg__btn" :class="{ 'is-on': mode === 'main' }" @click="mode = 'main'">Main feed</button>
        <button class="seg__btn" :class="{ 'is-on': mode === 'boxes' }" @click="mode = 'boxes'">Boxes</button>
        <button class="seg__btn" :class="{ 'is-on': mode === 'd4rt' }" @click="mode = 'd4rt'">D4RT</button>
      </div>
    </template>

    <div class="stage">
      <D4rtViewer v-if="mode === 'd4rt'" :enabled="true" class="d4rt" />

      <!-- boxes: shrink-wrapped so the 0..1 overlay maps exactly onto the pixels -->
      <div v-else-if="mode === 'boxes' && hasFrame" class="frame">
        <img :src="displayUrl" class="frame__img" alt="detections" draggable="false" @load="onImgLoad" />
        <svg class="frame__overlay" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <rect
            v-for="(b, i) in shownBoxes"
            :key="i"
            class="frame__box"
            :x="b.x1"
            :y="b.y1"
            :width="b.x2 - b.x1"
            :height="b.y2 - b.y1"
            :style="{ stroke: boxColor(b.conf) }"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <div class="frame__labels">
          <span
            v-for="(b, i) in shownBoxes"
            :key="i"
            class="frame__label"
            :style="{ left: b.x1 * 100 + '%', top: b.y1 * 100 + '%', background: boxColor(b.conf) }"
            >{{ b.label }} {{ Math.round(b.conf * 100) }}</span
          >
        </div>
      </div>

      <!-- main feed: fills the panel; crossfades obfuscated <-> raw on the hazard unlock -->
      <div v-else-if="mode === 'main' && hasFrame" class="feed">
        <Transition name="reveal">
          <img
            :key="unlocked ? 'raw' : 'obfuscated'"
            :src="displayUrl"
            class="feed__img"
            alt="main feed"
            draggable="false"
            @load="onImgLoad"
          />
        </Transition>
      </div>

      <div v-else class="stage__empty">
        <ImageOff :size="26" :stroke-width="1.5" />
        <span>Awaiting source video</span>
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
  padding: 3px 10px;
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
.stage {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.d4rt {
  width: 100%;
  height: 100%;
}
/* main feed fills the panel; the two crossfading imgs stack absolutely during the reveal */
.feed {
  position: relative;
  width: 100%;
  height: 100%;
}
.feed__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.reveal-enter-active,
.reveal-leave-active {
  transition: opacity 0.5s ease;
}
.reveal-enter-from,
.reveal-leave-to {
  opacity: 0;
}
/* shrink-wraps the letterboxed image so the overlay maps 0..1 exactly onto the pixels */
.frame {
  position: relative;
  display: inline-block;
  max-width: 100%;
  max-height: 100%;
  line-height: 0;
}
.frame__img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.frame__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.frame__box {
  fill: none;
  stroke-width: 1.5;
}
.legend {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--text-xs);
  color: var(--color-text-dim);
}
.legend__bar {
  width: 64px;
  height: 8px;
  border-radius: 2px;
  background: linear-gradient(
    90deg,
    hsl(240, 90%, 50%),
    hsl(180, 90%, 50%),
    hsl(120, 90%, 50%),
    hsl(60, 90%, 50%),
    hsl(0, 90%, 50%)
  );
}
.frame__labels {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.frame__label {
  position: absolute;
  transform: translateY(-100%);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.3;
  padding: 0 3px;
  white-space: nowrap;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
}
.stage__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-dim);
  font-size: var(--text-xs);
  letter-spacing: 0.03em;
}
</style>
