<!-- Concern: icon-only button primitive with size/active/variant styling, emits activate | Non-concern: which icon or action (callers supply that) | IO: (label, variant, size) -> activate -->
<script setup lang="ts">
defineProps<{
  label: string
  active?: boolean
  disabled?: boolean
  variant?: 'ghost' | 'solid'
  size?: 'sm' | 'md'
}>()

const emit = defineEmits<{
  activate: []
}>()
</script>

<template>
  <button
    type="button"
    class="icon-btn"
    :class="[
      `icon-btn--${variant ?? 'ghost'}`,
      `icon-btn--${size ?? 'md'}`,
      { 'is-active': active }
    ]"
    :disabled="disabled"
    :aria-label="label"
    :title="label"
    @click="emit('activate')"
  >
    <slot />
  </button>
</template>

<style scoped>
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
.icon-btn--sm {
  width: 28px;
  height: 28px;
}
.icon-btn--md {
  width: 34px;
  height: 34px;
}
.icon-btn:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-surface-3);
}
.icon-btn--solid {
  background: var(--color-surface-2);
  border-color: var(--color-border);
  color: var(--color-text);
}
.icon-btn.is-active {
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border-color: var(--color-accent-border);
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
