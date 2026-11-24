/// <reference lib="webworker" />
// Final mastering pass off the main thread: loudness measurement,
// normalization + true-peak limiting, 16-bit WAV encoding and the CRC-32
// the album ZIP needs.
import { measureLoudness, normalizeLoudness } from './loudness'
import { encodeWavBuffer } from './WavRecorder'
import { crc32 } from './zip'
import { applyMasterChain } from './mastering'
import type { MasterRequest, MasterResponse } from './masterAsync'

self.onmessage = (e: MessageEvent<MasterRequest>) => {
  const { id, L, R, sampleRate, targetLufs, ceilingDb, format, chain } = e.data
  try {
    if (chain) applyMasterChain(L, R, sampleRate, chain)
    const before = measureLoudness(L, R, sampleRate)
    const after =
      targetLufs != null && Number.isFinite(before.integrated)
        ? normalizeLoudness(L, R, sampleRate, targetLufs, ceilingDb, before)
        : before
    const bytes = encodeWavBuffer(L, R, sampleRate, format)
    const crc = crc32(new Uint8Array(bytes))
    const res: MasterResponse = { id, wav: new Blob([bytes], { type: 'audio/wav' }), crc, before, after }
    ;(self as unknown as Worker).postMessage(res)
  } catch (err) {
    const res: MasterResponse = { id, error: err instanceof Error ? err.message : String(err) }
    ;(self as unknown as Worker).postMessage(res)
  }
}
