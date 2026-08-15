<!-- Concern: drag-and-drop plus click-to-pick target that emits the selected video File | Non-concern: uploading it (AppHeader owns that) | IO: (busy) -> select(File) -->
<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { Loader, UploadCloud } from 'lucide-vue-next'

defineProps<{
  busy: boolean
}>()

const emit = defineEmits<{
  select: [file: File]
}>()

const inputEl = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
let dragDepth = 0

function openPicker(): void {
  inputEl.value?.click()
}

function emitFirstVideo(files: FileList | null): void {
  if (!files || files.length === 0) return
  const file = Array.from(files).find((f) => f.type.startsWith('video/')) ?? files[0]
  emit('select', file)
}

function onInputChange(event: Event): void {
  const target = event.target as HTMLInputElement
  emitFirstVideo(target.files)
  target.value = ''
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  dragDepth = 0
  dragging.value = false
  emitFirstVideo(event.dataTransfer?.files ?? null)
}

function onDragEnter(event: DragEvent): void {
  event.preventDefault()
  dragDepth += 1
  dragging.value = true
}

function onDragOver(event: DragEvent): void {
  event.preventDefault()
}

function onDragLeave(event: DragEvent): void {
  event.preventDefault()
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

onUnmounted(() => {
  dragDepth = 0
  dragging.value = false
})
</script>

<template>
  <button
    type="button"
    class="dropzone"
    :class="{ 'is-dragging': dragging, 'is-busy': busy }"
    :disabled="busy"
    @click="openPicker"
    @drop="onDrop"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
  >
    <Loader v-if="busy" :size="17" :stroke-width="1.75" class="spin" />
    <UploadCloud v-else :size="17" :stroke-width="1.75" />
    <span class="dropzone__label">
      {{ busy ? 'Uploading video' : 'Drop video or click to upload' }}
    </span>
    <input
      ref="inputEl"
      name="video"
      type="file"
      accept="video/*"
      class="dropzone__input"
      @change="onInputChange"
    />
  </button>
</template>

<style scoped>
.dropzone {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  height: 34px;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface-2);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.dropzone:hover:not(:disabled) {
  color: var(--color-text);
  border-color: var(--color-accent-border);
}
.dropzone.is-dragging {
  color: var(--color-accent);
  border-color: var(--color-accent);
  border-style: solid;
  background: var(--color-accent-soft);
}
.dropzone.is-busy {
  cursor: progress;
  opacity: 0.85;
}
.dropzone__label {
  white-space: nowrap;
}
.dropzone__input {
  display: none;
}
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
