// Concern: ambient type declarations for the Vite client and *.vue imports | Non-concern: runtime code or build wiring (vite.config.ts owns that) | IO: none
/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
