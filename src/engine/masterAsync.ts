import { measureLoudness, normalizeLoudness } from './loudness'
import type { LoudnessReport } from './loudness'
import { encodeWavBuffer } from './WavRecorder'
import type { WavFormat } from './WavRecorder'
import { crc32 } from './zip'
import { applyMasterChain } from './mastering'
import type { MasterChain } from './mastering'

export interface MasterRequest {
  id: number
  L: Float32Array
  R: Float32Array
  sampleRate: number
  targetLufs: number | null
  ceilingDb: number
  format?: WavFormat
  chain?: MasterChain
}

export interface MasterResponse {
  id: number
  wav?: Blob
  crc?: number
  before?: LoudnessReport
  after?: LoudnessReport
  error?: string
}

export interface MasterResult {
  wav: Blob
  crc: number
  before: LoudnessReport
  after: LoudnessReport
}

let worker: Worker | null = null
let broken = false
let nextId = 1
const pending = new Map<number, { resolve: (r: MasterResult) => void; reject: (e: Error) => void }>()

function getWorker(): Worker | null {
  if (broken) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./master.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<MasterResponse>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      if (e.data.error || !e.data.wav) p.reject(new Error(e.data.error ?? 'master failed'))
      else p.resolve({ wav: e.data.wav, crc: e.data.crc!, before: e.data.before!, after: e.data.after! })
    }
    worker.onerror = (ev) => {
      console.warn('master worker failed, falling back to main thread', ev.message)
      broken = true
      worker = null
      for (const [id, p] of pending) {
        pending.delete(id)
        p.reject(new Error('worker-crash'))
      }
    }
  } catch {
    broken = true
    return null
  }
  return worker
}

function runSync(L: Float32Array, R: Float32Array, sampleRate: number, targetLufs: number | null, ceilingDb: number, format?: WavFormat, chain?: MasterChain): MasterResult {
  if (chain) applyMasterChain(L, R, sampleRate, chain)
  const before = measureLoudness(L, R, sampleRate)
  const after =
    targetLufs != null && Number.isFinite(before.integrated)
      ? normalizeLoudness(L, R, sampleRate, targetLufs, ceilingDb, before)
      : before
  const bytes = encodeWavBuffer(L, R, sampleRate, format)
  return { wav: new Blob([bytes], { type: 'audio/wav' }), crc: crc32(new Uint8Array(bytes)), before, after }
}

/**
 * Measure (and optionally normalize) a stereo master, then encode a WAV —
 * in a Worker. The channel arrays are copied first, so callers keep theirs.
 */
export async function masterAsync(
  L: Float32Array,
  R: Float32Array,
  sampleRate: number,
  targetLufs: number | null = null,
  ceilingDb = -1,
  signal?: AbortSignal,
  format?: WavFormat,
  chain?: MasterChain,
): Promise<MasterResult> {
  const cancelled = () => new DOMException('Render cancelled', 'AbortError')
  if (signal?.aborted) throw cancelled()
  const w = getWorker()
  if (!w) return runSync(new Float32Array(L), new Float32Array(R), sampleRate, targetLufs, ceilingDb, format, chain)
  const l = new Float32Array(L)
  const r = new Float32Array(R)
  const id = nextId++
  // cancel = kill the worker mid-job (a fresh one spawns on the next call);
  // any other job it held is failed with the same AbortError
  const onAbort = () => {
    w.terminate()
    if (worker === w) worker = null
    for (const [pid, p] of pending) {
      pending.delete(pid)
      p.reject(cancelled())
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await new Promise<MasterResult>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      w.postMessage({ id, L: l, R: r, sampleRate, targetLufs, ceilingDb, format, chain } satisfies MasterRequest, [l.buffer, r.buffer])
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    if (e instanceof Error && e.message === 'worker-crash') {
      return runSync(new Float32Array(L), new Float32Array(R), sampleRate, targetLufs, ceilingDb, format, chain)
    }
    throw e
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
