import { mulberry32 } from './rng'

/**
 * EXTREME STRETCH (PaulStretch-style): a second of sound becomes a slowly
 * breathing cloud of the same pitches. Each output frame takes a windowed
 * spectrum of the input, keeps its magnitudes, throws the phases away
 * (random) and overlap-adds the result — the transients smear out, the
 * harmony stays. Runs in small chunks so the page never stalls; results are
 * cached per fragment.
 */

function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      const half = len >> 1
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

const yieldToPage = () => new Promise<void>((r) => setTimeout(r, 0))

// random phases from a table: Math.cos/sin per bin is the slow part
const PH = 4096
const COS = new Float64Array(PH)
const SIN = new Float64Array(PH)
for (let i = 0; i < PH; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / PH)
  SIN[i] = Math.sin((2 * Math.PI * i) / PH)
}

/**
 * Stretch `input` (mono samples) to `outSec` seconds. `seed` fixes the random
 * phases, so the same fragment always stretches the same way.
 */
export async function paulStretch(
  input: Float32Array,
  sampleRate: number,
  outSec: number,
  seed: number,
  signal?: AbortSignal,
  /** yield to the page between frames (main thread); a worker runs straight through */
  cooperative = true,
): Promise<Float32Array> {
  let win = 1
  while (win < sampleRate * 0.15) win <<= 1 // ≈0.17 s window: smooth, not smeared to noise
  const hopOut = win >> 2
  const outLen = Math.floor(outSec * sampleRate)
  const out = new Float32Array(outLen + win)
  const frames = Math.ceil(outLen / hopOut)
  // the input must cover at least one window: pad by mirroring
  let src = input
  if (src.length < win + 1) {
    const p = new Float32Array(win + 1)
    for (let i = 0; i < p.length; i++) {
      const k = Math.floor(i / input.length)
      const j = i % input.length
      p[i] = input[k % 2 ? input.length - 1 - j : j] ?? 0
    }
    src = p
  }
  const span = src.length - win
  const w = new Float64Array(win)
  for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win)
  const re = new Float64Array(win)
  const im = new Float64Array(win)
  const rng = mulberry32(seed)
  for (let f = 0; f < frames; f++) {
    const pos = Math.floor((span * f) / Math.max(1, frames - 1))
    for (let i = 0; i < win; i++) {
      re[i] = src[pos + i] * w[i]
      im[i] = 0
    }
    fft(re, im, false)
    for (let k = 0; k <= win / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      const ph = (rng() * PH) | 0
      re[k] = mag * COS[ph]
      im[k] = mag * SIN[ph]
      if (k > 0 && k < win / 2) {
        re[win - k] = re[k]
        im[win - k] = -im[k]
      }
    }
    im[0] = 0
    im[win / 2] = 0
    fft(re, im, true)
    const o = f * hopOut
    // hann² overlap at 75% sums to 1.5 → normalize
    for (let i = 0; i < win && o + i < out.length; i++) out[o + i] += (re[i] / win) * w[i] * (1 / 1.5)
    if (cooperative && f % 2 === 1) { // a few ms of work, then let the page breathe
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      await yieldToPage()
    }
  }
  // fade the edges and match the input's level
  const res = out.subarray(0, outLen)
  const fade = Math.min(res.length >> 3, Math.floor(sampleRate * 1.5))
  for (let i = 0; i < fade; i++) {
    const k = i / fade
    res[i] *= k
    res[res.length - 1 - i] *= k
  }
  const rms = (a: Float32Array) => {
    let q = 0
    for (let i = 0; i < a.length; i++) q += a[i] * a[i]
    return Math.sqrt(q / Math.max(1, a.length))
  }
  const gin = rms(input)
  const gout = rms(res)
  if (gout > 1e-9) {
    const g = Math.min(8, (gin / gout) * 0.9)
    for (let i = 0; i < res.length; i++) res[i] *= g
  }
  return res
}

const cache = new Map<string, AudioBuffer>()
const pending = new Map<string, Promise<AudioBuffer | null>>()

/**
 * A stereo stretched cloud of a region of `buffer` (two decorrelated takes,
 * one per side). Cached by `key`.
 */
export function stretchRegion(
  key: string,
  buffer: AudioBuffer,
  start: number,
  dur: number,
  outSec: number,
): Promise<AudioBuffer | null> {
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const running = pending.get(key)
  if (running) return running
  const job = (async () => {
    const sr = buffer.sampleRate
    // a little context around the fragment gives the cloud more body
    const a = Math.max(0, Math.floor((start - 0.05) * sr))
    const b = Math.min(buffer.length, Math.floor((start + Math.max(dur, 0.45) + 0.05) * sr))
    if (b - a < 256) return null
    const mono = new Float32Array(b - a)
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const d = buffer.getChannelData(ch)
      for (let i = 0; i < mono.length; i++) mono[i] += d[a + i] / buffer.numberOfChannels
    }
    let h = 0
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
    // off the main thread when possible; the cooperative path is the fallback
    const viaWorker = await stretchInWorker(mono, sr, outSec, h)
    const L = viaWorker?.L ?? await paulStretch(mono, sr, outSec, h)
    const R = viaWorker?.R ?? await paulStretch(mono, sr, outSec, h ^ 0x5bd1e995)
    const out = new AudioBuffer({ numberOfChannels: 2, length: L.length, sampleRate: sr })
    out.copyToChannel(L as Float32Array<ArrayBuffer>, 0)
    out.copyToChannel(R as Float32Array<ArrayBuffer>, 1)
    cache.set(key, out)
    return out
  })().finally(() => pending.delete(key))
  pending.set(key, job)
  return job
}

// ---------- worker ----------

let worker: Worker | null = null
let workerBroken = false
let nextId = 1
const waiting = new Map<number, (r: { L: Float32Array; R: Float32Array } | null) => void>()

function getWorker(): Worker | null {
  if (workerBroken) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./stretch.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; L?: Float32Array; R?: Float32Array }>) => {
      const done = waiting.get(e.data.id)
      waiting.delete(e.data.id)
      done?.(e.data.L && e.data.R ? { L: e.data.L, R: e.data.R } : null)
    }
    worker.onerror = () => {
      workerBroken = true
      worker = null
      for (const [id, done] of waiting) {
        waiting.delete(id)
        done(null)
      }
    }
  } catch {
    workerBroken = true
  }
  return worker
}

function stretchInWorker(mono: Float32Array, sampleRate: number, outSec: number, seed: number) {
  const w = getWorker()
  if (!w) return Promise.resolve(null)
  const id = nextId++
  return new Promise<{ L: Float32Array; R: Float32Array } | null>((resolve) => {
    waiting.set(id, resolve)
    const copy = new Float32Array(mono)
    w.postMessage({ id, mono: copy, sampleRate, outSec, seed }, [copy.buffer])
  })
}

export function cachedStretch(key: string): AudioBuffer | null {
  return cache.get(key) ?? null
}
