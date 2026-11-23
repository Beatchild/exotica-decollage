/// <reference lib="webworker" />
// Era surface noise (crackle, hiss, hum, static) off the main thread.
import { eraSurfaceData } from './eras'
import type { Era } from './eras'

self.onmessage = (e: MessageEvent<{ key: string; sampleRate: number; era: Era }>) => {
  const { key, sampleRate, era } = e.data
  try {
    const [L, R] = eraSurfaceData(sampleRate, era)
    ;(self as unknown as Worker).postMessage({ key, L, R }, [L.buffer, R.buffer])
  } catch {
    ;(self as unknown as Worker).postMessage({ key })
  }
}
