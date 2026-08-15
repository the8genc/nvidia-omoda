<!-- Concern: transport controls (play/pause, scrubber, counter, fps) driving playback context | Non-concern: the playback state and loop (usePlayback owns that) | IO: (playback context) -> controls -->
<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, ChevronRight, Gauge, Pause, Play } from 'lucide-vue-next'
import IconButton from '@/ui/IconButton.vue'
import { PLAYBACK_KEY } from '@/types/pipeline'
import { injectStrict } from '@/composables/injectStrict'

const playback = injectStrict(PLAYBACK_KEY)

const hasFrames = computed(() => playback.frameCount.value > 0)
const maxIndex = computed(() => Math.max(0, playback.frameCount.value - 1))
const displayIndex = computed(() => (hasFrames.value ? playback.currentFrame.value + 1 : 0))

function onScrub(event: Event): void {
  const target = event.target as HTMLInputElement
  playback.setFrame(Number(target.value))
}

function onFps(event: Event): void {
  const target = event.target as HTMLInputElement
  playback.setFps(Number(target.value))
}
</script>

<template>
  <div class="transport">
    <div class="transport__group">
      <IconButton
        :label="playback.playing.value ? 'Pause' : 'Play'"
        :disabled="!hasFrames"
        variant="solid"
        @activate="playback.togglePlaying()"
      >
        <Pause v-if="playback.playing.value" :size="16" :stroke-width="2" />
        <Play v-else :size="16" :stroke-width="2" />
      </IconButton>
      <IconButton label="Previous frame" :disabled="!hasFrames" size="sm" @activate="playback.stepFrame(-1)">
        <ChevronLeft :size="16" :stroke-width="2" />
      </IconButton>
      <IconButton label="Next frame" :disabled="!hasFrames" size="sm" @activate="playback.stepFrame(1)">
        <ChevronRight :size="16" :stroke-width="2" />
      </IconButton>
    </div>

    <div class="transport__scrub">
      <input
        type="range"
        name="frame-scrubber"
        class="scrubber"
        min="0"
        :max="maxIndex"
        step="1"
        :value="playback.currentFrame.value"
        :disabled="!hasFrames"
        aria-label="Frame scrubber"
        @input="onScrub"
      />
    </div>

    <div class="transport__counter tabular">
      <span class="transport__counter-value">{{ displayIndex }}</span>
      <span class="transport__counter-sep">/</span>
      <span class="transport__counter-total">{{ playback.frameCount.value }}</span>
      <span class="transport__counter-label">frames</span>
    </div>

    <label class="transport__fps" title="Playback frames per second">
      <Gauge :size="15" :stroke-width="1.75" />
      <input
        type="number"
        name="fps"
        class="fps-input tabular"
        min="1"
        max="60"
        step="1"
        :value="playback.fps.value"
        aria-label="Frames per second"
        @change="onFps"
      />
      <span class="transport__fps-unit">fps</span>
    </label>
  </div>
</template>

<style scoped>
.transport {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-4);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.transport__group {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
}
.transport__scrub {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
}
.scrubber {
  width: 100%;
  height: 4px;
  appearance: none;
  -webkit-appearance: none;
  background: var(--color-surface-3);
  border-radius: 999px;
  outline: none;
  cursor: pointer;
}
.scrubber:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.scrubber::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--color-accent);
  border: 2px solid var(--color-bg);
  cursor: pointer;
}
.scrubber::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--color-accent);
  border: 2px solid var(--color-bg);
  cursor: pointer;
}
.transport__counter {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  flex: none;
  font-size: var(--text-sm);
}
.transport__counter-value {
  color: var(--color-text);
  font-weight: 600;
}
.transport__counter-sep,
.transport__counter-total {
  color: var(--color-text-dim);
}
.transport__counter-label {
  margin-left: var(--space-1);
  color: var(--color-text-dim);
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  letter-spacing: 0.04em;
}
.transport__fps {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: 0 var(--space-2);
  height: 30px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-2);
  color: var(--color-text-muted);
}
.fps-input {
  width: 34px;
  background: transparent;
  border: none;
  color: var(--color-text);
  font-size: var(--text-sm);
  text-align: right;
  outline: none;
}
.fps-input::-webkit-outer-spin-button,
.fps-input::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}
.transport__fps-unit {
  font-size: var(--text-xs);
  color: var(--color-text-dim);
  letter-spacing: 0.04em;
}
</style>
