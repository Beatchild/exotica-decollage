import { analyzeChannels, buildSlices, channelsOf, detectBounds } from './Slicer'
import type { SourceAnalysis } from './Slicer'
import type { Slice } from './types'

type RawSlice = Omit<Slice, 'id' | 'sourceIdx'>

export interface AnalyzeRequest {
  id: number
  channels: Float32Array[]
  sampleRate: number
  duration: number
  /** fixed boundaries (crate restore); null = detect onsets */
  bounds: number[] | null
  manual: boolean
  slice: boolean
  maxSlice?: number
  minSlice?: number
}

export interface AnalyzeResponse {
  id: number
  analysis?: SourceAnalysis
  bounds?: number[]
  slices?: RawSlice[] | null
  error?: string
}

export interface AnalyzeResult {
  analysis: SourceAnalysis
  bounds: number[]
  slices: RawSlice[] | null
}

interface Pending {
  resolve: (r: AnalyzeResult) => void
  reject: (e: Error) => void
}

/** Small worker pool: YouTube collages analyze several tracks at once. */
const POOL = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1))
const workers: Array<{ w: Worker; busy: number }> = []
const pending = new Map<number, Pending>()
let nextId = 1
let workersBroken = false

function getWorker(): { w: Worker; busy: number } | null {
  if (workersBroken) return null
  try {
    while (workers.length < POOL) {
      const w = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
      const slot = { w, busy: 0 }
      w.onmessage = (e: MessageEvent<AnalyzeResponse>) => {
        slot.busy = Math.max(0, slot.busy - 1)
        const p = pending.get(e.data.id)
        if (!p) return
        pending.delete(e.data.id)
        if (e.data.error || !e.data.analysis) p.reject(new Error(e.data.error ?? 'analysis failed'))
        else p.resolve({ analysis: e.data.analysis, bounds: e.data.bounds!, slices: e.data.slices ?? null })
      }
      w.onerror = (ev) => {
        // a worker that can't even load (e.g. CSP) → fall back to main thread
        console.warn('analysis worker failed, falling back to main thread', ev.message)
        workersBroken = true
        for (const [id, p] of pending) {
          pending.delete(id)
          p.reject(new Error('worker-crash'))
        }
      }
      workers.push(slot)
    }
  } catch {
    workersBroken = true
    return null
  }
  return workers.reduce((a, b) => (b.busy < a.busy ? b : a))
}

function runSync(req: Omit<AnalyzeRequest, 'id'>): AnalyzeResult {
  const analysis = analyzeChannels(req.channels, req.sampleRate, req.duration)
  const bounds = req.bounds ?? detectBounds(analysis)
  const slices = req.slice ? buildSlices(analysis, bounds, req.manual, req.maxSlice, req.minSlice) : null
  return { analysis, bounds, slices }
}

/**
 * Analyze (and optionally slice) a buffer in a Web Worker. Channel data is
 * copied, so the AudioBuffer stays usable. Falls back to the main thread if
 * workers are unavailable.
 */
export async function analyzeAsync(
  buffer: AudioBuffer,
  opts: { bounds?: number[] | null; manual?: boolean; slice?: boolean; maxSlice?: number; minSlice?: number } = {},
): Promise<AnalyzeResult> {
  const base: Omit<AnalyzeRequest, 'id'> = {
    channels: channelsOf(buffer),
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
    bounds: opts.bounds ?? null,
    manual: opts.manual ?? false,
    slice: opts.slice ?? true,
    maxSlice: opts.maxSlice,
    minSlice: opts.minSlice,
  }
  const slot = getWorker()
  if (!slot) return runSync(base)
  const id = nextId++
  // copy the channels: the AudioBuffer keeps its own data
  const channels = base.channels.map((c) => new Float32Array(c))
  try {
    return await new Promise<AnalyzeResult>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      slot.busy++
      slot.w.postMessage({ ...base, id, channels } satisfies AnalyzeRequest, channels.map((c) => c.buffer))
    })
  } catch (e) {
    if (e instanceof Error && e.message === 'worker-crash') return runSync(base)
    throw e
  }
}
