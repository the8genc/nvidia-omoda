<!-- Concern: lay out the live panels — the raw RGB frame as the large hero plus the streamed scene vocabulary | Non-concern: each panel's content (the panels own that) | IO: none -->
<script setup lang="ts">
import RawRgbPanel from '@/features/pipeline/panels/RawRgbPanel.vue'
import LiveJsonPanel from '@/features/pipeline/panels/LiveJsonPanel.vue'
</script>

<template>
  <div class="grid">
    <RawRgbPanel class="grid__cell grid__cell--hero" />
    <LiveJsonPanel class="grid__cell" />
  </div>
</template>

<style scoped>
.grid {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  gap: var(--space-3);
  grid-template-columns: minmax(0, 1.8fr) minmax(0, 1fr);
}
.grid__cell {
  min-width: 0;
  min-height: 0;
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: repeat(2, minmax(240px, 1fr));
  }
  .grid__cell--hero {
    min-height: 360px;
  }
}
</style>
