import Meyda from 'meyda'
import type { Slice, SliceCategory } from './types'

const FRAME = 512
const MIN_SLICE = 0.08
const MAX_SLICE = 1.2
/** manual boundary edits may go finer than auto-slicing */
const MIN_MANUAL = 0.03

export interface FrameFeatures {
  rms: number
  flux: number
  centroid: number // Hz
  zcr: number
  chroma?: number[]
}

/** Cached per-source analysis so boundary edits re-slice instantly. */
export interface SourceAnalysis {
  mono: Float32Array
  frames: FrameFeatures[]
  sampleRate: number
  duration: number
}

/** Mix an AudioBuffer down to a single Float32Array. */
function monoMix(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length)
  const scale = 1 / buffer.numberOfChannels
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) out[i] += data[i] * scale
  }
  return out
}

/**
 * Per-frame RMS / centroid / ZCR via Meyda; spectral flux computed here as the
 * half-wave-rectified frame-to-frame difference of Meyda's amplitude spectrum
 * (Meyda 5's own spectralFlux extractor throws "x is not defined"), plus an
 * RMS-derivative term so energy-only onsets register too.
 */
export function analyzeSource(buffer: AudioBuffer): SourceAnalysis {
  const sampleRate = buffer.sampleRate
  const mono = monoMix(buffer)
  Meyda.bufferSize = FRAME
  Meyda.sampleRate = sampleRate
  const frames: FrameFeatures[] = []
  let prevSpec: Float32Array | null = null
  for (let pos = 0; pos + FRAME <= mono.length; pos += FRAME) {
    const frame = mono.subarray(pos, pos + FRAME)
    interface Extracted {
      rms?: number
      spectralCentroid?: number
      zcr?: number
      amplitudeSpectrum?: Float32Array
      chroma?: number[]
    }
    let f: Extracted | null = null
    try {
      f = Meyda.extract(
        ['rms', 'spectralCentroid', 'zcr', 'amplitudeSpectrum', 'chroma'],
        frame,
      ) as Extracted | null
    } catch {
      f = null
    }
    const spec = f?.amplitudeSpectrum ?? null
    let flux = 0
    if (spec && prevSpec) {
      for (let k = 0; k < spec.length; k++) flux += Math.max(0, spec[k] - prevSpec[k])
      flux /= spec.length
    }
    const rms = Number.isFinite(f?.rms) ? f!.rms! : 0
    const prevRms = frames.length ? frames[frames.length - 1].rms : 0
    flux += Math.max(0, rms - prevRms) * 8
    const centroid = f?.spectralCentroid
    frames.push({
      rms,
      flux: frames.length ? flux : 0,
      // Meyda centroid is in bins → Hz
      centroid: Number.isFinite(centroid) ? centroid! * (sampleRate / FRAME) : 0,
      zcr: Number.isFinite(f?.zcr) ? f!.zcr! : 0,
      chroma: Array.isArray(f?.chroma) && f!.chroma!.length === 12 ? f!.chroma! : undefined,
    })
    prevSpec = spec ? new Float32Array(spec) : prevSpec
  }
  return { mono, frames, sampleRate, duration: buffer.duration }
}

/** Adaptive-threshold peak picking over the novelty curve → boundary times (s). */
export function detectBounds(a: SourceAnalysis): number[] {
  const flux = a.frames.map((f) => f.flux)
  const win = 16
  const minGapFrames = Math.ceil((MIN_SLICE * a.sampleRate) / FRAME)
  // global floor keeps low-level ripple (vibrato, tremolo) from reading as onsets
  const globalMax = flux.reduce((m, v) => Math.max(m, v), 0)
  const floor = globalMax * 0.08
  const onsets: number[] = []
  let last = -minGapFrames
  for (let i = 1; i < flux.length - 1; i++) {
    const s0 = Math.max(0, i - win)
    const s1 = Math.min(flux.length, i + win)
    let mean = 0
    for (let j = s0; j < s1; j++) mean += flux[j]
    mean /= s1 - s0
    let variance = 0
    for (let j = s0; j < s1; j++) variance += (flux[j] - mean) ** 2
    const std = Math.sqrt(variance / (s1 - s0))
    const threshold = mean + 1.0 * std + floor
    const isPeak = flux[i] > threshold && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1]
    if (isPeak && i - last >= minGapFrames) {
      onsets.push(i)
      last = i
    }
  }
  return onsets.map((f) => (f * FRAME) / a.sampleRate)
}

/** Simple autocorrelation pitch estimate on a slice window. */
function estimatePitch(
  signal: Float32Array,
  sampleRate: number,
): { pitch: number | null; confidence: number } {
  const N = Math.min(signal.length, 2048)
  if (N < 512) return { pitch: null, confidence: 0 }
  let energy = 0
  for (let i = 0; i < N; i++) energy += signal[i] * signal[i]
  if (energy / N < 1e-6) return { pitch: null, confidence: 0 }

  const minLag = Math.floor(sampleRate / 1000)
  const maxLag = Math.min(Math.floor(sampleRate / 60), N - 1)
  let bestLag = -1
  let bestCorr = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0
    for (let i = 0; i < N - lag; i++) corr += signal[i] * signal[i + lag]
    corr /= energy
    if (corr > bestCorr) {
      bestCorr = corr
      bestLag = lag
    }
  }
  if (bestLag < 0 || bestCorr < 0.3) return { pitch: null, confidence: bestCorr }
  return { pitch: sampleRate / bestLag, confidence: bestCorr }
}

function categorize(s: Omit<Slice, 'category' | 'id' | 'sourceIdx'>, attackRef: number): SliceCategory {
  // strong onset + short → percussive; pitched + sustained → harmonic; rest → texture.
  // attack judged relative to the buffer's own onset strengths (attackRef ≈ p75).
  const rel = attackRef > 0 ? s.attack / attackRef : 0
  const transientScore =
    Math.min(1.2, rel) + (s.duration < 0.35 ? 0.8 : 0) + (s.zcr > 60 ? 0.4 : 0)
  const harmonicScore =
    s.pitchConfidence * 1.6 + (s.duration > 0.3 ? 0.6 : 0) + (s.zcr < 40 ? 0.3 : 0)
  if (transientScore >= 1.5 && transientScore > harmonicScore) return 'transient'
  if (harmonicScore >= 1.0) return 'harmonic'
  return 'texture'
}

/**
 * Build featured slices from a boundary list (inner boundaries, seconds).
 * `manual: true` keeps user-placed bounds verbatim (only a 30ms sanity floor);
 * otherwise segments are normalized into the 80ms–1.2s micro-slice range.
 * ids/sourceIdx are assigned by the engine when the pool is flattened.
 */
export function buildSlices(
  a: SourceAnalysis,
  innerBounds: number[],
  manual = false,
  maxSlice = MAX_SLICE,
  minSlice = MIN_SLICE,
): Array<Omit<Slice, 'id' | 'sourceIdx'>> {
  const minLen = manual ? MIN_MANUAL : minSlice
  const bounds: number[] = [0]
  for (const t of [...innerBounds].sort((x, y) => x - y)) {
    if (t > 0 && t < a.duration && t - bounds[bounds.length - 1] >= minLen) bounds.push(t)
  }
  if (a.duration - bounds[bounds.length - 1] >= minLen) bounds.push(a.duration)
  else bounds[bounds.length - 1] = a.duration

  const segments: Array<[number, number]> = []
  for (let i = 0; i < bounds.length - 1; i++) {
    let s0 = bounds[i]
    const s1 = bounds[i + 1]
    if (!manual) {
      while (s1 - s0 > maxSlice) {
        segments.push([s0, s0 + maxSlice])
        s0 += maxSlice
      }
    }
    if (s1 - s0 >= minLen) segments.push([s0, s1])
  }

  const slices: Array<Omit<Slice, 'id' | 'sourceIdx'>> = []
  for (const [start, end] of segments) {
    const f0 = Math.floor((start * a.sampleRate) / FRAME)
    const f1 = Math.max(f0 + 1, Math.floor((end * a.sampleRate) / FRAME))
    let rms = 0
    let centroid = 0
    let zcr = 0
    let n = 0
    const chromaSum = new Array(12).fill(0)
    let chromaN = 0
    for (let i = f0; i < Math.min(f1, a.frames.length); i++) {
      rms += a.frames[i].rms
      centroid += a.frames[i].centroid
      zcr += a.frames[i].zcr
      const c = a.frames[i].chroma
      if (c) {
        // weight louder frames more
        for (let k = 0; k < 12; k++) chromaSum[k] += c[k] * (0.2 + a.frames[i].rms * 5)
        chromaN++
      }
      n++
    }
    if (n === 0) continue
    rms /= n
    centroid /= n
    zcr /= n
    let chroma: number[] | undefined
    if (chromaN > 0) {
      const total = chromaSum.reduce((x, y) => x + y, 0)
      chroma = total > 1e-9 ? chromaSum.map((v) => v / total) : undefined
    }
    const p0 = Math.floor(start * a.sampleRate)
    const p1 = Math.min(Math.floor(end * a.sampleRate), a.mono.length)
    const { pitch, confidence } = estimatePitch(a.mono.subarray(p0, p1), a.sampleRate)
    const attack =
      (a.frames[f0]?.flux ?? 0) +
      Math.max(0, (a.frames[f0]?.rms ?? 0) - (a.frames[f0 - 1]?.rms ?? 0)) * 8
    slices.push({
      start,
      duration: end - start,
      rms,
      centroid,
      zcr,
      pitch,
      pitchConfidence: confidence,
      chroma,
      attack,
      category: 'texture', // assigned below once attackRef is known
    })
  }

  const attacks = slices.map((s) => s.attack).sort((x, y) => x - y)
  const attackRef = attacks[Math.floor(attacks.length * 0.75)] ?? 0
  for (const s of slices) s.category = categorize(s, attackRef)

  // guarantee each category has at least one member so every voice can play
  if (slices.length > 0) {
    const byCat = (c: SliceCategory) => slices.filter((s) => s.category === c)
    if (byCat('harmonic').length === 0) {
      ;[...slices].sort((x, y) => y.duration - x.duration)[0].category = 'harmonic'
    }
    if (byCat('transient').length === 0) {
      ;[...slices].sort((x, y) => y.attack - x.attack)[0].category = 'transient'
    }
    if (byCat('texture').length === 0) {
      ;[...slices].sort((x, y) => x.rms - y.rms)[0].category = 'texture'
    }
  }
  return slices
}
