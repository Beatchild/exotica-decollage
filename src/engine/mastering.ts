/**
 * MASTERING — the last colour before loudness: a release chain applied to
 * the float mix of every export (single tracks and albums alike), then the
 * existing LUFS normalization + true-peak limiter + dither finish it.
 *
 * Chain: low cut → mono bass (sides high-passed) → warmth (low shelf) →
 * mud cut (bell) → air (high shelf) → glue compressor (stereo-linked) →
 * tape saturation → stereo width.
 *
 * `applyMasterChain` runs on plain arrays (deterministic, worker-safe);
 * `LiveMaster` builds the same chain from native nodes so it can be
 * previewed — A/B against bypass — while the studio plays.
 */

export interface MasterChain {
  /** high-pass, Hz (0 = off) */
  lowCut: number
  /** below this the sides are removed — tight, centred low end (0 = off) */
  monoBass: number
  /** dB at 140 Hz shelf */
  warmth: number
  /** dB at 320 Hz bell (negative = cut) */
  mud: number
  /** dB at 9 kHz shelf */
  air: number
  /** 0–1 bus compression */
  glue: number
  /** 0–1 tape saturation */
  tape: number
  /** 0 = mono … 1 = as is … 1.5 = wide */
  width: number
}

export const MASTER_PRESETS: Array<{ key: string; label: string; line: string; chain: MasterChain }> = [
  {
    key: 'transparent', label: 'TRANSPARENT', line: 'only the essentials: low cut, a centred low end',
    chain: { lowCut: 25, monoBass: 100, warmth: 0, mud: 0, air: 0, glue: 0.1, tape: 0, width: 1 },
  },
  {
    key: 'warmtape', label: 'WARM TAPE', line: 'soft, round, glued — like it came off a well-used reel',
    chain: { lowCut: 30, monoBass: 130, warmth: 2, mud: -1.5, air: -0.5, glue: 0.45, tape: 0.45, width: 1.05 },
  },
  {
    key: 'clear', label: 'CLEAR STREAMING', line: 'clean lows, open top, controlled — holds up at −14 LUFS',
    chain: { lowCut: 32, monoBass: 140, warmth: 0.5, mud: -2, air: 2, glue: 0.35, tape: 0.15, width: 1.1 },
  },
  {
    key: 'dark', label: 'DARK AMBIENT', line: 'deep and wide, the top rolled away, barely compressed',
    chain: { lowCut: 22, monoBass: 90, warmth: 2.5, mud: -1, air: -3, glue: 0.15, tape: 0.3, width: 1.3 },
  },
  {
    key: 'vinyl', label: 'VINYL CUT', line: 'mono below 160 Hz, tamed highs, a little tape — safe for a lathe',
    chain: { lowCut: 35, monoBass: 160, warmth: 1, mud: -1, air: -1.5, glue: 0.3, tape: 0.25, width: 0.95 },
  },
]

export const DEFAULT_CHAIN: MasterChain = MASTER_PRESETS[1].chain

// ---------- offline DSP ----------

interface Coefs { b0: number; b1: number; b2: number; a1: number; a2: number }

/** RBJ cookbook biquads. */
function design(type: 'hp' | 'lowshelf' | 'peak' | 'highshelf', f: number, sr: number, q: number, gainDb = 0): Coefs {
  const A = Math.pow(10, gainDb / 40)
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr
  const cw = Math.cos(w)
  const sw = Math.sin(w)
  const alpha = sw / (2 * q)
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
  switch (type) {
    case 'hp':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha
      break
    case 'peak':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A
      break
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s)
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s
      break
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s)
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s
      break
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

function run(x: Float32Array, c: Coefs) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1; x1 = x0; y2 = y1; y1 = y0
    x[i] = y0
  }
}

const dbToLin = (db: number) => Math.pow(10, db / 20)

/** Apply the chain to a stereo mix, in place. */
export function applyMasterChain(L: Float32Array, R: Float32Array, sr: number, c: MasterChain) {
  const n = Math.min(L.length, R.length)
  // 1 · low cut (24 dB/oct: two stages)
  if (c.lowCut > 0) {
    for (const ch of [L, R]) {
      run(ch, design('hp', c.lowCut, sr, 0.54))
      run(ch, design('hp', c.lowCut, sr, 1.31))
    }
  }
  // 2 · mid/side: mono bass + width
  if (c.monoBass > 0 || Math.abs(c.width - 1) > 0.01) {
    const S = new Float32Array(n)
    for (let i = 0; i < n; i++) S[i] = (L[i] - R[i]) * 0.5
    if (c.monoBass > 0) {
      run(S, design('hp', c.monoBass, sr, 0.71))
      run(S, design('hp', c.monoBass, sr, 0.71))
    }
    for (let i = 0; i < n; i++) {
      const m = (L[i] + R[i]) * 0.5
      const s = S[i] * c.width
      L[i] = m + s
      R[i] = m - s
    }
  }
  // 3 · tone
  for (const ch of [L, R]) {
    if (c.warmth) run(ch, design('lowshelf', 140, sr, 0.7, c.warmth))
    if (c.mud) run(ch, design('peak', 320, sr, 0.9, c.mud))
    if (c.air) run(ch, design('highshelf', 9000, sr, 0.7, c.air))
  }
  // 4 · glue: stereo-linked RMS compressor, threshold relative to the programme
  if (c.glue > 0.01) {
    let q = 0
    for (let i = 0; i < n; i++) q += (L[i] * L[i] + R[i] * R[i]) * 0.5
    const progDb = 10 * Math.log10(q / Math.max(1, n) + 1e-12)
    const thr = progDb + 6 - c.glue * 9
    const ratio = 1.4 + c.glue * 2.6
    const atk = Math.exp(-1 / (0.025 * sr))
    const rel = Math.exp(-1 / (0.3 * sr))
    const det = Math.exp(-1 / (0.01 * sr)) // RMS detector smoothing
    let ms = 0
    let gDb = 0
    for (let i = 0; i < n; i++) {
      const p = (L[i] * L[i] + R[i] * R[i]) * 0.5
      ms = det * ms + (1 - det) * p
      const lvl = 10 * Math.log10(ms + 1e-12)
      const over = lvl - thr
      const target = over > 0 ? -over * (1 - 1 / ratio) : 0
      gDb = target < gDb ? atk * gDb + (1 - atk) * target : rel * gDb + (1 - rel) * target
      const g = dbToLin(gDb)
      L[i] *= g
      R[i] *= g
    }
  }
  // 5 · tape: level-referenced tanh, blended (loudness normalization follows)
  if (c.tape > 0.01) {
    let q = 0
    for (let i = 0; i < n; i++) q += (L[i] * L[i] + R[i] * R[i]) * 0.5
    const rms = Math.sqrt(q / Math.max(1, n)) || 1e-6
    const pre = 0.12 / rms // programme at ≈ −18 dBFS RMS into the "tape"
    const drive = 1 + c.tape * 2.5
    const mix = Math.min(1, c.tape * 1.2)
    const norm = 1 / Math.tanh(drive)
    for (const ch of [L, R]) {
      for (let i = 0; i < n; i++) {
        const x = ch[i] * pre
        const y = Math.tanh(x * drive) * norm
        ch[i] = ((1 - mix) * x + mix * y) / pre
      }
    }
  }
}

// ---------- live preview ----------

function curveFor(tape: number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(2048)
  const drive = 1 + tape * 2.5
  const mix = Math.min(1, tape * 1.2)
  const norm = 1 / Math.tanh(drive)
  // live input sits around −18…−12 dBFS: reference the curve like the offline pass
  const pre = 2.5
  for (let i = 0; i < c.length; i++) {
    const x = (i / (c.length - 1)) * 2 - 1
    const xx = x * pre
    c[i] = ((1 - mix) * xx + mix * Math.tanh(xx * drive) * norm) / pre
  }
  return c
}

/** The chain as native nodes between the studio's output and the speakers. */
export class LiveMaster {
  readonly input: GainNode
  readonly output: GainNode
  private hp1: BiquadFilterNode
  private hp2: BiquadFilterNode
  private lowShelf: BiquadFilterNode
  private bell: BiquadFilterNode
  private highShelf: BiquadFilterNode
  private comp: DynamicsCompressorNode
  private shaper: WaveShaperNode
  private sideHp1: BiquadFilterNode
  private sideHp2: BiquadFilterNode
  private sideGain: GainNode
  private wet: GainNode
  private dry: GainNode
  private ctx: BaseAudioContext
  bypassed = false

  constructor(ctx: BaseAudioContext, chain: MasterChain) {
    this.ctx = ctx
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    const bq = (type: BiquadFilterType, f: number, q = 0.7) => {
      const n = ctx.createBiquadFilter()
      n.type = type
      n.frequency.value = f
      n.Q.value = q
      return n
    }
    this.hp1 = bq('highpass', 30, 0.54)
    this.hp2 = bq('highpass', 30, 1.31)
    // M/S: split → mid (L+R)/2 and side (L−R)/2 → side high-passed & scaled → L = m+s, R = m−s
    const split = ctx.createChannelSplitter(2)
    const merge = ctx.createChannelMerger(2)
    const mid = ctx.createGain()
    mid.gain.value = 0.5
    const side = ctx.createGain()
    side.gain.value = 0.5
    const invR = ctx.createGain()
    invR.gain.value = -1
    this.sideHp1 = bq('highpass', 120, 0.71)
    this.sideHp2 = bq('highpass', 120, 0.71)
    this.sideGain = ctx.createGain()
    const invS = ctx.createGain()
    invS.gain.value = -1
    this.lowShelf = bq('lowshelf', 140)
    this.bell = bq('peaking', 320, 0.9)
    this.highShelf = bq('highshelf', 9000)
    this.comp = ctx.createDynamicsCompressor()
    this.comp.knee.value = 6
    this.comp.attack.value = 0.025
    this.comp.release.value = 0.3
    this.shaper = ctx.createWaveShaper()
    this.shaper.oversample = '2x'
    this.wet = ctx.createGain()
    this.dry = ctx.createGain()

    this.input.connect(this.hp1)
    this.hp1.connect(this.hp2)
    this.hp2.connect(split)
    split.connect(mid, 0)
    split.connect(mid, 1)
    split.connect(side, 0)
    split.connect(invR, 1)
    invR.connect(side)
    side.connect(this.sideHp1)
    this.sideHp1.connect(this.sideHp2)
    this.sideHp2.connect(this.sideGain)
    mid.connect(merge, 0, 0)
    mid.connect(merge, 0, 1)
    this.sideGain.connect(merge, 0, 0)
    this.sideGain.connect(invS)
    invS.connect(merge, 0, 1)
    merge.connect(this.lowShelf)
    this.lowShelf.connect(this.bell)
    this.bell.connect(this.highShelf)
    this.highShelf.connect(this.comp)
    this.comp.connect(this.shaper)
    this.shaper.connect(this.wet)
    this.wet.connect(this.output)
    this.input.connect(this.dry)
    this.dry.connect(this.output)
    this.set(chain)
    this.setBypass(false)
  }

  set(c: MasterChain) {
    const t = this.ctx.currentTime
    const lc = Math.max(10, c.lowCut || 10)
    this.hp1.frequency.setTargetAtTime(lc, t, 0.05)
    this.hp2.frequency.setTargetAtTime(lc, t, 0.05)
    const mb = Math.max(10, c.monoBass || 10)
    this.sideHp1.frequency.setTargetAtTime(mb, t, 0.05)
    this.sideHp2.frequency.setTargetAtTime(mb, t, 0.05)
    this.sideGain.gain.setTargetAtTime(c.width, t, 0.05)
    this.lowShelf.gain.setTargetAtTime(c.warmth, t, 0.05)
    this.bell.gain.setTargetAtTime(c.mud, t, 0.05)
    this.highShelf.gain.setTargetAtTime(c.air, t, 0.05)
    // live has no programme measurement: a fixed threshold around studio level
    this.comp.threshold.setTargetAtTime(-14 - c.glue * 12, t, 0.05)
    this.comp.ratio.setTargetAtTime(1.4 + c.glue * 2.6, t, 0.05)
    this.shaper.curve = c.tape > 0.01 ? curveFor(c.tape) : null
  }

  setBypass(b: boolean) {
    this.bypassed = b
    const t = this.ctx.currentTime
    this.wet.gain.setTargetAtTime(b ? 0 : 1, t, 0.03)
    this.dry.gain.setTargetAtTime(b ? 1 : 0, t, 0.03)
  }
}

// ---------- reference matching ----------

/** The tonal fingerprint of a mix: band balance, width, density, loudness. */
export interface ToneProfile {
  /** band energies relative to the whole, dB: <150 · 150–500 · 500–4k · >4k Hz */
  low: number
  lowMid: number
  mid: number
  high: number
  /** side energy relative to mid, dB (−∞ = mono) */
  side: number
  /** side energy below 150 Hz relative to all side energy, dB */
  lowSide: number
  /** peak-to-loudness ratio, dB (small = dense, loud) */
  plr: number
  lufs: number
}

function energy(x: Float32Array): number {
  let q = 0
  for (let i = 0; i < x.length; i++) q += x[i] * x[i]
  return q / Math.max(1, x.length)
}

const toDb10 = (e: number) => 10 * Math.log10(e + 1e-15)

function highpassed(x: Float32Array, f: number, sr: number): Float32Array {
  const y = new Float32Array(x)
  run(y, design('hp', f, sr, 0.54))
  run(y, design('hp', f, sr, 1.31))
  return y
}

/** Analyse (up to) `maxSec` from the middle of a stereo signal. */
export function toneProfile(Lin: Float32Array, Rin: Float32Array, sr: number, lufs: number, truePeak: number, maxSec = 60): ToneProfile {
  const n = Math.min(Lin.length, Rin.length)
  const len = Math.min(n, Math.floor(maxSec * sr))
  const a = Math.floor((n - len) / 2)
  const M = new Float32Array(len)
  const S = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    M[i] = (Lin[a + i] + Rin[a + i]) * 0.5
    S[i] = (Lin[a + i] - Rin[a + i]) * 0.5
  }
  const eAll = energy(M)
  const e150 = energy(highpassed(M, 150, sr))
  const e500 = energy(highpassed(M, 500, sr))
  const e4k = energy(highpassed(M, 4000, sr))
  const eS = energy(S)
  const eS150 = energy(highpassed(S, 150, sr))
  return {
    low: toDb10(Math.max(1e-15, eAll - e150)) - toDb10(eAll),
    lowMid: toDb10(Math.max(1e-15, e150 - e500)) - toDb10(eAll),
    mid: toDb10(Math.max(1e-15, e500 - e4k)) - toDb10(eAll),
    high: toDb10(e4k) - toDb10(eAll),
    side: toDb10(eS) - toDb10(eAll),
    lowSide: toDb10(Math.max(1e-15, eS - eS150)) - toDb10(eS),
    plr: truePeak - lufs,
    lufs,
  }
}

const clampTo = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/**
 * Bend the chain so our (pre-master) mix lands near the reference's tone:
 * band differences → shelves / bell, side difference → width, density → glue.
 */
export function matchChain(ours: ToneProfile, ref: ToneProfile, base: MasterChain): { chain: MasterChain; lines: string[] } {
  const dLow = ref.low - ours.low
  const dLowMid = ref.lowMid - ours.lowMid
  const dHigh = ref.high - ours.high
  const dSide = ref.side - ours.side
  const chain: MasterChain = {
    ...base,
    warmth: Math.round(clampTo(dLow * 0.8, -3, 4) * 2) / 2,
    mud: Math.round(clampTo(Math.min(0, dLowMid * 0.8), -5, 0) * 2) / 2,
    air: Math.round(clampTo(dHigh * 0.8, -4, 4) * 2) / 2,
    width: Math.round(clampTo(Math.pow(10, dSide / 20), 0.6, 1.5) * 100) / 100,
    glue: Math.round(clampTo((15 - ref.plr) / 9, 0.05, 0.8) * 100) / 100,
    monoBass: ref.lowSide < -14 ? Math.max(base.monoBass, 150) : base.monoBass,
  }
  const sgn = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} dB`
  const lines = [
    `reference ${ref.lufs.toFixed(1)} LUFS, peak-to-loudness ${ref.plr.toFixed(1)} dB`,
    `lows ${sgn(dLow)} · low-mids ${sgn(dLowMid)} · highs ${sgn(dHigh)} · sides ${sgn(dSide)} vs your mix`,
    `→ WARMTH ${chain.warmth} · MUD ${chain.mud} · AIR ${chain.air} · WIDTH ${chain.width}× · GLUE ${Math.round(chain.glue * 100)}`,
  ]
  return { chain, lines }
}
