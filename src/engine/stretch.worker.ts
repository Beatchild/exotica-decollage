/// <reference lib="webworker" />
// Extreme-stretch clouds off the main thread: two decorrelated takes (L/R).
import { paulStretch } from './stretch'

export interface StretchRequest {
  id: number
  mono: Float32Array
  sampleRate: number
  outSec: number
  seed: number
}

export interface StretchResponse {
  id: number
  L?: Float32Array
  R?: Float32Array
  error?: string
}

self.onmessage = async (e: MessageEvent<StretchRequest>) => {
  const { id, mono, sampleRate, outSec, seed } = e.data
  try {
    const L = await paulStretch(mono, sampleRate, outSec, seed, undefined, false)
    const R = await paulStretch(mono, sampleRate, outSec, seed ^ 0x5bd1e995, undefined, false)
    const res: StretchResponse = { id, L, R }
    ;(self as unknown as Worker).postMessage(res, [L.buffer, R.buffer])
  } catch (err) {
    const res: StretchResponse = { id, error: err instanceof Error ? err.message : String(err) }
    ;(self as unknown as Worker).postMessage(res)
  }
}
