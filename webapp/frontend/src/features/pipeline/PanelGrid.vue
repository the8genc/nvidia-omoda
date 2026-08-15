<!-- Concern: lays out the four pipeline panels in a responsive 2x2 grid | Non-concern: each panel's content (the panels own that) | IO: none -->
<script setup lang="ts">
import RawRgbPanel from '@/features/pipeline/panels/RawRgbPanel.vue'
import DepthPanel from '@/features/pipeline/panels/DepthPanel.vue'
import SegPanel from '@/features/pipeline/panels/SegPanel.vue'
import PrimitiveTwinPanel from '@/features/pipeline/panels/PrimitiveTwinPanel.vue'
</script>

<template>
  <div class="grid">
    <RawRgbPanel class="grid__cell" />
    <DepthPanel class="grid__cell" />
    <SegPanel class="grid__cell" />
    <PrimitiveTwinPanel class="grid__cell" />
  </div>
</template>

<style scoped>
.grid {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}
.grid__cell {
  min-width: 0;
  min-height: 0;
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: repeat(4, minmax(240px, 1fr));
  }
}
</style>
