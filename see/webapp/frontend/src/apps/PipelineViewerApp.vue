<!-- Concern: root that creates the always-on live stream and provides it to the shell | Non-concern: rendering panels (child features own that) | IO: none -->
<script setup lang="ts">
import { provide, ref } from 'vue'
import AppHeader from '@/features/pipeline/AppHeader.vue'
import SceneBanner from '@/features/pipeline/SceneBanner.vue'
import PanelGrid from '@/features/pipeline/PanelGrid.vue'
import { useLiveStream } from '@/composables/useLiveStream'
import { useSceneDescription } from '@/composables/useSceneDescription'
import { LIVE_KEY, SCENE_KEY } from '@/types/pipeline'

// live is always on: connect the websocket immediately and never toggle off
const liveEnabled = ref(true)
const live = useLiveStream(liveEnabled)
provide(LIVE_KEY, live)

// one VLM poll for the whole app: the banner displays it, the main feed uses its hazard flag
const scene = useSceneDescription()
provide(SCENE_KEY, scene)
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
