<!-- Concern: displays a per-frame image URL with empty/loading/error states | Non-concern: building the URL or which frame (panels/useJob own that) | IO: (url, alt, hasJob) -> img -->
<script setup lang="ts">
import { ref, watch } from 'vue'
import { ImageOff, Loader } from 'lucide-vue-next'

const props = defineProps<{
  url: string
  alt: string
  hasJob: boolean
}>()

const loading = ref(false)
const failed = ref(false)
const everLoaded = ref(false)

watch(
  () => props.url,
  (next) => {
    failed.value = false
    if (next) {
      loading.value = true
    } else {
      loading.value = false
    }
  }
)

function onLoad(): void {
  loading.value = false
  everLoaded.value = true
}

function onError(): void {
  loading.value = false
  failed.value = true
}
</script>

<template>
  <div class="frame-image">
    <img
      v-if="url"
      :src="url"
      :alt="alt"
      class="frame-image__img"
      draggable="false"
      @load="onLoad"
      @error="onError"
    />

    <div v-if="!hasJob" class="frame-image__state">
      <ImageOff :size="26" :stroke-width="1.5" />
      <span>Awaiting source video</span>
    </div>

    <div v-else-if="failed" class="frame-image__state frame-image__state--error">
      <ImageOff :size="26" :stroke-width="1.5" />
      <span>Frame unavailable</span>
    </div>

    <div v-else-if="loading && !everLoaded" class="frame-image__state">
      <Loader :size="24" :stroke-width="1.5" class="spin" />
      <span>Decoding frame</span>
    </div>
  </div>
</template>

<style scoped>
.frame-image {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.frame-image__img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  image-rendering: auto;
  display: block;
}
.frame-image__state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-dim);
  font-size: var(--text-xs);
  letter-spacing: 0.03em;
  background: var(--color-inset);
}
.frame-image__state--error {
  color: var(--color-error);
}
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
