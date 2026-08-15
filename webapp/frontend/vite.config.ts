// Concern: Vite build config wiring the Vue SFC plugin and the @ -> src alias | Non-concern: app runtime or ambient types (env.d.ts owns that) | IO: none
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  }
})
