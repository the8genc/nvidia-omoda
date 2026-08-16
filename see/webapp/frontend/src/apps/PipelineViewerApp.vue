<!-- Concern: root that creates the always-on live stream and provides it to the shell | Non-concern: rendering panels (child features own that) | IO: none -->
<script setup lang="ts">
import { provide, ref } from 'vue'
import AppHeader from '@/features/pipeline/AppHeader.vue'
import SceneBanner from '@/features/pipeline/SceneBanner.vue'
import PanelGrid from '@/features/pipeline/PanelGrid.vue'
import { useLiveStream } from '@/composables/useLiveStream'
import { LIVE_KEY } from '@/types/pipeline'

// live is always on: connect the websocket immediately and never toggle off
const liveEnabled = ref(true)
const live = useLiveStream(liveEnabled)

provide(LIVE_KEY, live)
</script>

<template>
  <div class="shell">
    <SceneBanner />
    <AppHeader />
    <main class="shell__main">
      <PanelGrid />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.shell__main {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5) var(--space-5);
}
</style>
