<!-- Concern: render the live rgb frame with an optional generic bbox overlay, kept in sync by seq | Non-concern: what a box means — it draws rectangles + label strings the backend sends, no domain branching | IO: (live) -> panel -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ImageOff } from 'lucide-vue-next'
import PanelFrame from '@/components/layout/PanelFrame.vue'
import { LIVE_KEY } from '@/types/pipeline'
import { injectStrict } from '@/composables/injectStrict'

const live = injectStrict(LIVE_KEY)

const showBoxes = ref(false)
// only run detection (YOLOE) while boxes are actually on screen
watch(showBoxes, (on) => live.setBoxesShown(on), { immediate: true })

const hasFrame = computed(() => live.latestRgb.value !== null)
const rgbUrl = computed(() => live.latestRgb.value?.rgb ?? '')
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
  <PanelFrame title="Raw RGB" :subtitle="showBoxes ? 'detections' : 'live'">
    <template #actions>
      <div v-if="showBoxes" class="legend" aria-label="confidence scale">
        <span>low</span><i class="legend__bar"></i><span>high</span>
      </div>
      <div class="seg" role="group" aria-label="overlay mode">
        <button class="seg__btn" :class="{ 'is-on': !showBoxes }" @click="showBoxes = false">RGB</button>
        <button class="seg__btn" :class="{ 'is-on': showBoxes }" @click="showBoxes = true">Boxes</button>
      </div>
    </template>

    <div class="stage">
      <div v-if="hasFrame" class="frame">
        <img :src="rgbUrl" class="frame__img" alt="Raw RGB frame" draggable="false" @load="onImgLoad" />
        <svg
          v-if="showBoxes"
          class="frame__overlay"
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
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
        <div v-if="showBoxes" class="frame__labels">
          <span
            v-for="(b, i) in shownBoxes"
            :key="i"
            class="frame__label"
            :style="{ left: b.x1 * 100 + '%', top: b.y1 * 100 + '%', background: boxColor(b.conf) }"
            >{{ b.label }} {{ Math.round(b.conf * 100) }}</span
          >
        </div>
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
