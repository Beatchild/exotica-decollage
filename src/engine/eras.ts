import { mulberry32 } from './rng'

/**
 * ERAS — every source can sound like it was found on a different old medium.
 * Each played fragment of that source passes through the medium's tone
 * (band limits, resonances, a little saturation) and its speed instability
 * (wow / flutter as detune), and every medium in use adds its own surface
 * (crackle, hiss, mains hum, static) under the mix. Works on any
 * BaseAudioContext, so live play and offline renders sound alike.
 */

export type Era = 'none' | 'vinyl' | 'cassette' | 'vhs' | 'radio' | 'phone'

export const ERAS: Array<{ key: Era; label: string; line: string }> = [
  { key: 'none', label: 'AS IS', line: 'untouched' },
  { key: 'vinyl', label: 'VINYL', line: 'warm lows, soft top, crackle and a slow wow' },
  { key: 'cassette', label: 'CASSETTE', line: 'dull highs, hiss, wobbling speed' },
  { key: 'vhs', label: 'VHS', line: 'narrow, boxy mids, mains hum, tracking wobble' },
  { key: 'radio', label: 'AM RADIO', line: 'thin, distant, a voice through static' },
  { key: 'phone', label: 'TELEPHONE', line: 'a message on an old answering machine' },
]

export const isEra = (v: unknown): v is Era => ERAS.some((e) => e.key === v)

const shaperCurves = new Map<number, Float32Array<ArrayBuffer>>()
function softClip(amount: number): Float32Array<ArrayBuffer> {
  let c = shaperCurves.get(amount)
  if (c) return c
  c = new Float32Array(1024)
  for (let i = 0; i < c.length; i++) {
    const x = (i / (c.length - 1)) * 2 - 1
    c[i] = Math.tanh(x * amount) / Math.tanh(amount)
  }
  shaperCurves.set(amount, c)
  return c
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.7, gain = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  f.gain.value = gain
  return f
}

/**
 * Insert the medium's colour after `head` (one fragment's chain) and wobble
 * the source's speed. Returns the new head to connect onward.
 */
export function eraChain(
  ctx: BaseAudioContext,
  head: AudioNode,
  src: AudioBufferSourceNode,
  era: Era,
  rnd: () => number,
  when: number,
): AudioNode {
  if (era === 'none') return head
  const nodes: AudioNode[] = []
  let wobble = 0 // cents, slow drift over the fragment
  let offset = 0 // cents, this fragment's speed error
  switch (era) {
    case 'vinyl':
      nodes.push(biquad(ctx, 'highpass', 35), biquad(ctx, 'lowshelf', 220, 0.7, 2.5), biquad(ctx, 'lowpass', 8500, 0.5))
      offset = (rnd() - 0.5) * 12
      wobble = (rnd() - 0.5) * 10
      break
    case 'cassette':
      nodes.push(biquad(ctx, 'highpass', 50), biquad(ctx, 'highshelf', 3800, 0.7, -5), biquad(ctx, 'lowpass', 7200, 0.6))
      offset = (rnd() - 0.5) * 22
      wobble = (rnd() - 0.5) * 26
      break
    case 'vhs':
      nodes.push(biquad(ctx, 'highpass', 90), biquad(ctx, 'peaking', 950, 0.9, 3.5), biquad(ctx, 'lowpass', 5200, 0.7))
      offset = (rnd() - 0.5) * 28
      wobble = (rnd() - 0.5) * 34
      break
    case 'radio':
      nodes.push(biquad(ctx, 'highpass', 320, 0.8), biquad(ctx, 'bandpass', 1700, 0.55), biquad(ctx, 'lowpass', 3600, 0.8))
      offset = (rnd() - 0.5) * 8
      break
    case 'phone':
      nodes.push(biquad(ctx, 'highpass', 420, 1), biquad(ctx, 'peaking', 1500, 1.2, 4), biquad(ctx, 'lowpass', 3100, 1))
      offset = (rnd() - 0.5) * 6
      break
  }
  if (era === 'radio' || era === 'phone' || era === 'vhs') {
    const sh = ctx.createWaveShaper()
    sh.curve = softClip(era === 'vhs' ? 1.6 : 2.6)
    nodes.push(sh)
  }
  if (offset || wobble) {
    try {
      src.detune.setValueAtTime(offset, when)
      if (wobble) src.detune.linearRampToValueAtTime(offset + wobble, when + 0.4 + rnd() * 0.8)
    } catch { /* detune unsupported: tone only */ }
  }
  let h = head
  for (const n of nodes) {
    h.connect(n)
    h = n
  }
  return h
}

/** How loud each medium's surface sits under the mix (linear). */
const SURFACE_LEVEL: Record<Era, number> = {
  none: 0, vinyl: 0.016, cassette: 0.011, vhs: 0.012, radio: 0.009, phone: 0.004,
}

/**
 * A looping stereo surface for a medium: crackle, hiss, hum or static.
 * Seeded, so renders repeat exactly.
 */
const surfaceCache = new Map<string, AudioBuffer>()

/** The surface noise itself, as plain samples (runs in a worker or here). */
export function eraSurfaceData(sampleRate: number, era: Era): [Float32Array, Float32Array] {
  const seed = 4049
  const len = Math.floor(sampleRate * 7)
  const out = [new Float32Array(len), new Float32Array(len)]
  const rng = mulberry32(seed + era.length * 131)
  for (let ch = 0; ch < 2; ch++) {
    const d = out[ch]
    let lp = 0
    let lp2 = 0
    for (let i = 0; i < len; i++) {
      const w = rng() * 2 - 1
      lp += (w - lp) * 0.08 // dark noise
      lp2 += (w - lp2) * 0.35 // brighter hiss
      const t = i / sampleRate
      let v = 0
      switch (era) {
        case 'vinyl': {
          v = lp * 0.25
          if (rng() < 0.00035) v += (rng() < 0.5 ? -1 : 1) * (0.4 + rng() * 0.6) // clicks
          if (rng() < 0.004) v += (rng() * 2 - 1) * 0.18 // dust
          v += Math.sin(2 * Math.PI * 0.55 * t) * lp * 0.3 // rotation rumble
          break
        }
        case 'cassette':
          v = (lp2 - lp) * 0.9
          break
        case 'vhs':
          v = (lp2 - lp) * 0.6 + Math.sin(2 * Math.PI * 50 * t) * 0.25 + Math.sin(2 * Math.PI * 150 * t) * 0.08
          break
        case 'radio': {
          const fade = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.13 * t + ch)
          v = lp2 * (0.4 + fade * 0.6) + Math.sin(2 * Math.PI * (2400 + 30 * Math.sin(t)) * t) * 0.02
          break
        }
        case 'phone':
          v = lp2 * 0.5 + Math.sin(2 * Math.PI * 50 * t) * 0.1
          break
      }
      d[i] = v
    }
    // seamless loop: short crossfade of the ends
    const x = Math.floor(sampleRate * 0.05)
    for (let i = 0; i < x; i++) {
      const k = i / x
      d[i] = d[i] * k + d[len - x + i] * (1 - k)
    }
  }
  return out as [Float32Array, Float32Array]
}

function toBuffer(sampleRate: number, d: [Float32Array, Float32Array]): AudioBuffer {
  const buf = new AudioBuffer({ numberOfChannels: 2, length: d[0].length, sampleRate })
  buf.copyToChannel(d[0] as Float32Array<ArrayBuffer>, 0)
  buf.copyToChannel(d[1] as Float32Array<ArrayBuffer>, 1)
  return buf
}

/** A cached surface, generated here if missing (blocks: prefer ensureEraSurfaces first). */
export function eraSurface(sampleRate: number, era: Era): AudioBuffer | null {
  if (era === 'none') return null
  const key = `${sampleRate}:${era}`
  const hit = surfaceCache.get(key)
  if (hit) return hit
  const buf = toBuffer(sampleRate, eraSurfaceData(sampleRate, era))
  surfaceCache.set(key, buf)
  return buf
}

export const eraSurfaceReady = (sampleRate: number, era: Era) => era === 'none' || surfaceCache.has(`${sampleRate}:${era}`)

let surfWorker: Worker | null = null
let surfBroken = false
const surfPending = new Map<string, Promise<void>>()

/** Generate the missing surfaces off the main thread (falls back to here, one per frame). */
export function ensureEraSurfaces(sampleRate: number, eras: Era[]): Promise<void> {
  const jobs = [...new Set(eras)].filter((e) => !eraSurfaceReady(sampleRate, e)).map((era) => {
    const key = `${sampleRate}:${era}`
    const run = surfPending.get(key)
    if (run) return run
    const job = new Promise<void>((resolve) => {
      const local = () => setTimeout(() => { eraSurface(sampleRate, era); resolve() }, 0)
      if (!surfBroken && !surfWorker) {
        try {
          surfWorker = new Worker(new URL('./eras.worker.ts', import.meta.url), { type: 'module' })
          surfWorker.onerror = () => { surfBroken = true; surfWorker = null }
        } catch {
          surfBroken = true
        }
      }
      const w = surfWorker
      if (!w) { local(); return }
      const onMsg = (ev: MessageEvent<{ key: string; L?: Float32Array; R?: Float32Array }>) => {
        if (ev.data.key !== key) return
        w.removeEventListener('message', onMsg)
        if (ev.data.L && ev.data.R && !surfaceCache.has(key)) surfaceCache.set(key, toBuffer(sampleRate, [ev.data.L, ev.data.R]))
        resolve()
      }
      w.addEventListener('message', onMsg)
      w.postMessage({ key, sampleRate, era })
    }).finally(() => surfPending.delete(key))
    surfPending.set(key, job)
    return job
  })
  return Promise.all(jobs).then(() => undefined)
}

/**
 * Start one looping surface per medium in use, into `dest`. `level` scales all
 * of them (0–1). Returns the sources so a live player can stop them.
 */
export function startEraSurfaces(
  ctx: BaseAudioContext,
  dest: AudioNode,
  eras: Era[],
  when: number,
  seed: number,
  level = 1,
): AudioBufferSourceNode[] {
  const out: AudioBufferSourceNode[] = []
  for (const era of new Set(eras)) {
    // only what is ready — generating here would stall the audio thread's feeder
    if (!eraSurfaceReady(ctx.sampleRate, era)) continue
    const buf = eraSurface(ctx.sampleRate, era)
    if (!buf) continue
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, when)
    g.gain.linearRampToValueAtTime(SURFACE_LEVEL[era] * level, when + 3)
    src.connect(g)
    g.connect(dest)
    src.start(when, (seed % 7) * 0.9)
    out.push(src)
  }
  return out
}

/**
 * A first suggestion: a different medium per source, darkest-sounding source
 * on vinyl, then cassette, VHS, radio (brightest). Returns eras by input order.
 */
export function suggestEras(centroids: number[]): Era[] {
  const order: Era[] = ['vinyl', 'cassette', 'vhs', 'radio']
  const rank = centroids.map((c, i) => ({ c, i })).sort((a, b) => a.c - b.c)
  const out: Era[] = new Array(centroids.length).fill('none')
  rank.forEach((r, k) => (out[r.i] = order[k % order.length]))
  return out
}
