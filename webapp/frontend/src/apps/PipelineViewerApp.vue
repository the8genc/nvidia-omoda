<!-- Concern: root that creates playback+job state and provides them as context to the shell | Non-concern: rendering panels or transport (child features own that) | IO: none -->
<script setup lang="ts">
import { provide } from 'vue'
import AppHeader from '@/features/pipeline/AppHeader.vue'
import TransportBar from '@/features/pipeline/TransportBar.vue'
import PanelGrid from '@/features/pipeline/PanelGrid.vue'
import { usePlayback } from '@/composables/usePlayback'
import { useJob } from '@/composables/useJob'
import { JOB_KEY, PLAYBACK_KEY, type JobManifest } from '@/types/pipeline'

const playback = usePlayback()

function onManifest(manifest: JobManifest): void {
  playback.setFrameCount(manifest.n_frames ?? 0)
  if (manifest.fps && manifest.fps > 0) playback.setFps(manifest.fps)
}

const job = useJob(onManifest)

provide(PLAYBACK_KEY, playback)
provide(JOB_KEY, job)
</script>

<template>
  <div class="shell">
    <AppHeader />
    <main class="shell__main">
      <TransportBar />
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
