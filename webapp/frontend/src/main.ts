// Concern: bootstraps the app — mounts PipelineViewerApp and imports global styles | Non-concern: state and context wiring (PipelineViewerApp owns that) | IO: (#app element) -> mounted app
import { createApp } from 'vue'
import PipelineViewerApp from '@/apps/PipelineViewerApp.vue'
import '@/assets/styles/tokens.css'
import '@/assets/styles/base.css'

createApp(PipelineViewerApp).mount('#app')
