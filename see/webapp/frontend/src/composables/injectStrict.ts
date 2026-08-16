// Concern: injects a provided value by typed key, throwing if no provider is present | Non-concern: what value each key carries (pipeline.ts owns the keys) | IO: (InjectionKey<T>) -> T
import { inject, type InjectionKey } from 'vue'

export function injectStrict<T>(key: InjectionKey<T>): T {
  const value = inject(key)
  if (value === undefined) {
    throw new Error(`Missing provider for injection key: ${String(key.description ?? key)}`)
  }
  return value
}
