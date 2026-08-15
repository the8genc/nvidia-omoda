<!-- Concern: binds the rgb.jpg asset URL for currentFrame into a panel | Non-concern: loading or rendering the image (FrameImage owns that) | IO: (job+playback context) -> panel -->
<script setup lang="ts">
import { computed } from 'vue'
import PanelFrame from '@/components/layout/PanelFrame.vue'
import FrameImage from '@/components/media/FrameImage.vue'
import { JOB_KEY, PLAYBACK_KEY } from '@/types/pipeline'
import { injectStrict } from '@/composables/injectStrict'

const playback = injectStrict(PLAYBACK_KEY)
const job = injectStrict(JOB_KEY)

const hasJob = computed(() => job.jobId.value !== null)
const url = computed(() => job.frameAssetUrl(playback.currentFrame.value, 'rgb.jpg'))
</script>

<template>
  <PanelFrame title="Raw RGB" subtitle="rgb.jpg">
    <FrameImage :url="url" :has-job="hasJob" alt="Raw RGB frame" />
  </PanelFrame>
</template>
