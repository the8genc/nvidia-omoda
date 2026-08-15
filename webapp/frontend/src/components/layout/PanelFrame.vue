<!-- Concern: shared panel chrome — titled header, actions slot, and body slot | Non-concern: the frame content (each panel supplies its body) | IO: (title, subtitle, slots) -> layout -->
<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
}>()
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <div class="panel__titles">
        <h3 class="panel__title">{{ title }}</h3>
        <span v-if="subtitle" class="panel__subtitle tabular">{{ subtitle }}</span>
      </div>
      <div class="panel__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="panel__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-panel);
  overflow: hidden;
}
.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface-2);
  flex: none;
}
.panel__titles {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}
.panel__title {
  font-size: var(--text-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--color-text);
  white-space: nowrap;
}
.panel__subtitle {
  font-size: var(--text-xs);
  color: var(--color-text-dim);
}
.panel__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
}
.panel__body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  background: var(--color-inset);
  display: flex;
}
</style>
