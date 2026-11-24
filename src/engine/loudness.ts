/**
 * Loudness measurement & normalization (ITU-R BS.1770-4 / EBU R128).
 *
 * - measureLoudness: K-weighted, gated integrated loudness (LUFS), max
 *   short-term loudness, sample peak and 4× oversampled true peak (dBTP).
 * - normalizeLoudness: gain to a target LUFS, then a look-ahead brickwall
 *   limiter so the true peak stays under the ceiling (default −1 dBTP, the
 *   Spotify / Apple Music / YouTube recommendation).
 * - LoudnessMeter: live momentary / short-term / integrated meter on the
 *   master tap (native biquads approximate the K-weighting prefilter).
 */

export interface LoudnessReport {
  /** integrated loudness, LUFS (−Infinity for silence) */
  integrated: number
  /** max short-term (3s) loudness, LUFS */
  shortTermMax: number
  /** 4× oversampled true peak, dBTP */
  truePeak: number
  /** sample peak, dBFS */
  samplePeak: number
}

export const LOUDNESS_TARGETS = [
  { label: 'OFF', lufs: null },
  { label: '−14 STREAMING', lufs: -14 },
  { label: '−16 APPLE / PODCAST', lufs: -16 },
  { label: '−23 BROADCAST', lufs: -23 },
  { label: '−9 CLUB', lufs: -9 },
] as const

const dB = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity)

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** BS.1770 K-weighting coefficients for any sample rate (two cascaded biquads). */
function kWeighting(fs: number): [Biquad, Biquad] {
  // stage 1: high shelf (head acoustics)
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * f0) / fs)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  let a0 = 1 + K / Q + K * K
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  // stage 2: RLB high-pass
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / fs)
  a0 = 1 + K / Q + K * K
  const hp: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  return [shelf, hp]
}

/** Sum of K-weighted squared samples per 100ms hop, for one channel. */
function hopEnergies(x: Float32Array, fs: number, hop: number): Float64Array {
  const [s, h] = kWeighting(fs)
  const nHops = Math.floor(x.length / hop)
  const out = new Float64Array(nHops)
  // direct form I, both stages inline
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  let u1 = 0, u2 = 0, z1 = 0, z2 = 0
  let i = 0
  for (let k = 0; k < nHops; k++) {
    let acc = 0
    const end = i + hop
    for (; i < end; i++) {
      const xn = x[i]
      const yn = s.b0 * xn + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2
      x2 = x1; x1 = xn; y2 = y1; y1 = yn
      const zn = h.b0 * yn + h.b1 * u1 + h.b2 * u2 - h.a1 * z1 - h.a2 * z2
      u2 = u1; u1 = yn; z2 = z1; z1 = zn
      acc += zn * zn
    }
    out[k] = acc
  }
  return out
}

const lufsOf = (meanSquare: number) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity)

/** 4× polyphase windowed-sinc kernel for inter-sample peak estimation. */
const TP_TAPS = 8 // per side
const TP_KERNEL: Float64Array[] = [1, 2, 3].map((p) => {
  const frac = p / 4
  const k = new Float64Array(TP_TAPS * 2)
  for (let j = 0; j < TP_TAPS * 2; j++) {
    const t = j - (TP_TAPS - 1) - frac // tap offset relative to the interpolated point
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
    const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / TP_TAPS) // Hann
    k[j] = sinc * w
  }
  // unity DC gain so the window doesn't inflate the estimate
  const sum = k.reduce((a, b) => a + b, 0)
  for (let j = 0; j < k.length; j++) k[j] /= sum
  return k
})

function channelPeaks(x: Float32Array): { sample: number; truePeak: number } {
  let sample = 0
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i])
    if (a > sample) sample = a
  }
  // inter-sample overs only matter near the loudest samples
  const thr = sample * 0.6
  let tp = sample
  const n = x.length
  for (let i = TP_TAPS; i < n - TP_TAPS; i++) {
    if (Math.abs(x[i]) < thr && Math.abs(x[i + 1]) < thr) continue
    for (const ker of TP_KERNEL) {
      let acc = 0
      const base = i - (TP_TAPS - 1)
      for (let j = 0; j < ker.length; j++) acc += x[base + j] * ker[j]
      const a = Math.abs(acc)
      if (a > tp) tp = a
    }
  }
  return { sample, truePeak: tp }
}

export function measureLoudness(L: Float32Array, R: Float32Array, fs: number): LoudnessReport {
  const hop = Math.round(fs * 0.1)
  const eL = hopEnergies(L, fs, hop)
  const eR = hopEnergies(R, fs, hop)
  const nHops = Math.min(eL.length, eR.length)

  // 400ms momentary blocks (4 hops, 75% overlap)
  const blocks: number[] = []
  for (let k = 0; k + 4 <= nHops; k++) {
    let sum = 0
    for (let j = k; j < k + 4; j++) sum += eL[j] + eR[j]
    blocks.push(sum / (hop * 4))
  }
  // gating: absolute −70 LUFS, then relative −10 LU
  const abs = blocks.filter((z) => lufsOf(z) > -70)
  let integrated = -Infinity
  if (abs.length) {
    const rel = lufsOf(abs.reduce((a, b) => a + b, 0) / abs.length) - 10
    const gated = abs.filter((z) => lufsOf(z) > rel)
    if (gated.length) integrated = lufsOf(gated.reduce((a, b) => a + b, 0) / gated.length)
  }
  // 3s short-term max
  let shortTermMax = -Infinity
  for (let k = 0; k + 30 <= nHops; k += 1) {
    let sum = 0
    for (let j = k; j < k + 30; j++) sum += eL[j] + eR[j]
    shortTermMax = Math.max(shortTermMax, lufsOf(sum / (hop * 30)))
  }
  if (nHops < 30 && blocks.length) shortTermMax = Math.max(...blocks.map(lufsOf))

  const pL = channelPeaks(L)
  const pR = channelPeaks(R)
  return {
    integrated,
    shortTermMax,
    truePeak: dB(Math.max(pL.truePeak, pR.truePeak)),
    samplePeak: dB(Math.max(pL.sample, pR.sample)),
  }
}

/**
 * Look-ahead brickwall limiter (in place). Gain reduction is the sliding
 * minimum of the required gain over the next `look` seconds, box-smoothed
 * over the same span (so the attack ramp lands exactly on the peak), with
 * an exponential release.
 */
function limit(L: Float32Array, R: Float32Array, fs: number, ceiling: number, look = 0.005, release = 0.12) {
  const n = L.length
  const W = Math.max(1, Math.round(look * fs))
  const cap = W + 2
  const dqI = new Int32Array(cap)
  const dqV = new Float32Array(cap)
  let head = 0
  let tail = 0 // monotonic counters, index % cap
  const box = new Float32Array(W).fill(1)
  let boxSum = W
  const k = 1 - Math.exp(-1 / (release * fs))
  let r = 1
  for (let i = 0; i < n + W; i++) {
    let v = 1
    if (i < n) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]))
      v = a > ceiling ? ceiling / a : 1
    }
    while (tail > head && dqV[(tail - 1) % cap] >= v) tail--
    dqI[tail % cap] = i
    dqV[tail % cap] = v
    tail++
    const j = i - W
    if (j < 0) continue
    while (dqI[head % cap] < j) head++
    const m = dqV[head % cap]
    const slot = j % W
    boxSum += m - box[slot]
    box[slot] = m
    const a = Math.min(m, boxSum / W)
    r = Math.min(a, r + (1 - r) * k)
    L[j] *= r
    R[j] *= r
  }
}

/**
 * Normalize to `targetLufs` in place, keeping the true peak ≤ `ceilingDb`.
 * Returns the re-measured report.
 */
export function normalizeLoudness(
  L: Float32Array,
  R: Float32Array,
  fs: number,
  targetLufs: number,
  ceilingDb = -1,
  measured?: LoudnessReport,
): LoudnessReport {
  const before = measured ?? measureLoudness(L, R, fs)
  if (!Number.isFinite(before.integrated)) return before
  // sample-domain ceiling leaves 0.5dB of room for inter-sample overs
  const ceil = Math.pow(10, ceilingDb / 20) * Math.pow(10, -0.5 / 20)
  let after = before
  // limiting eats loudness, so loud targets need a few gain+limit passes
  for (let pass = 0; pass < 4; pass++) {
    const miss = targetLufs - after.integrated
    if (pass > 0 && Math.abs(miss) < 0.15) break
    const g = Math.pow(10, miss / 20)
    for (let i = 0; i < L.length; i++) {
      L[i] *= g
      R[i] *= g
    }
    limit(L, R, fs, ceil)
    after = measureLoudness(L, R, fs)
  }
  if (after.truePeak > ceilingDb) {
    // rare residual over: trim the whole thing down
    const trim = Math.pow(10, (ceilingDb - after.truePeak - 0.05) / 20)
    for (let i = 0; i < L.length; i++) {
      L[i] *= trim
      R[i] *= trim
    }
    after = measureLoudness(L, R, fs)
  }
  return after
}

/** Live meter on an audio node (post-master). Poll read() ~10×/s. */
export class LoudnessMeter {
  private aL: AnalyserNode
  private aR: AnalyserNode
  private bufL: Float32Array<ArrayBuffer>
  private bufR: Float32Array<ArrayBuffer>
  private hist: number[] = [] // momentary mean-squares, one per read()
  private gatedBlocks: number[] = []
  private fs: number

  constructor(ctx: BaseAudioContext, source: AudioNode) {
    this.fs = ctx.sampleRate
    // K-weighting approximation with native biquads
    const shelf = ctx.createBiquadFilter()
    shelf.type = 'highshelf'
    shelf.frequency.value = 1681
    shelf.gain.value = 4
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 38
    hp.Q.value = 0.5
    const split = ctx.createChannelSplitter(2)
    this.aL = ctx.createAnalyser()
    this.aR = ctx.createAnalyser()
    this.aL.fftSize = this.aR.fftSize = 32768
    source.connect(shelf)
    shelf.connect(hp)
    hp.connect(split)
    split.connect(this.aL, 0)
    split.connect(this.aR, 1)
    this.bufL = new Float32Array(32768)
    this.bufR = new Float32Array(32768)
  }

  reset() {
    this.hist = []
    this.gatedBlocks = []
  }

  /** momentary (400ms), short-term (~3s) and running integrated LUFS. */
  read(): { momentary: number; shortTerm: number; integrated: number } {
    this.aL.getFloatTimeDomainData(this.bufL)
    this.aR.getFloatTimeDomainData(this.bufR)
    const n = Math.min(this.bufL.length, Math.round(this.fs * 0.4))
    const start = this.bufL.length - n
    let sum = 0
    for (let i = start; i < this.bufL.length; i++) {
      sum += this.bufL[i] * this.bufL[i] + this.bufR[i] * this.bufR[i]
    }
    const ms = sum / n
    this.hist.push(ms)
    if (this.hist.length > 30) this.hist.shift()
    if (lufsOf(ms) > -70) {
      this.gatedBlocks.push(ms)
      if (this.gatedBlocks.length > 36000) this.gatedBlocks.shift() // ~1h at 10Hz
    }
    const st = this.hist.reduce((a, b) => a + b, 0) / this.hist.length
    let integrated = -Infinity
    if (this.gatedBlocks.length) {
      const rel = lufsOf(this.gatedBlocks.reduce((a, b) => a + b, 0) / this.gatedBlocks.length) - 10
      const g = this.gatedBlocks.filter((z) => lufsOf(z) > rel)
      if (g.length) integrated = lufsOf(g.reduce((a, b) => a + b, 0) / g.length)
    }
    return { momentary: lufsOf(ms), shortTerm: lufsOf(st), integrated }
  }
}
