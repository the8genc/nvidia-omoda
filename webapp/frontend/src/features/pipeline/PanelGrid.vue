<!-- Concern: lay out the live view — the raw RGB frame with its detection overlay | Non-concern: the panel's content (RawRgbPanel owns it) | IO: none -->
<script setup lang="ts">
import RawRgbPanel from '@/features/pipeline/panels/RawRgbPanel.vue'
</script>

<template>
  <div class="grid">
    <RawRgbPanel class="grid__cell" />
  </div>
</template>

<style scoped>
.grid {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}
.grid__cell {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
</style>
