import type { Chord } from './Harmony'
import type { Era } from './eras'
import { eraChain } from './eras'
import { mulberry32 } from './rng'
import type { Rng } from './rng'
import type { Slice, SongSection } from './types'
import { cachedStretch, stretchRegion } from './stretch'
import type { FormPos, KinPlan } from './kin'
import { kinLane } from './kin'
import { linesLane } from './lines'

/**
 * MEMORY LAYERS — three things that make a woven track feel *remembered*:
 *
 * STRETCH  a few tonal fragments slowed 15–40× into breathing clouds at the
 *          same pitch (strongest in DUST and DISSOLVING).
 * MOTIF    one short melody that returns: half-heard and far in SURFACING,
 *          whole and clear in THE MEMORY, back again slower, sinking, broken
 *          and partly backwards in DISSOLVING — remembering, then losing it.
 * GHOSTS   the most voice-like fragments of the pool, as if heard through a
 *          wall or an old telephone: distant, muffled, sometimes backwards.
 *
 * The lanes are generators of schedule times, shared by the live engine and
 * the offline renderer (same seed → same events).
 */

export interface MemoryLayerParams {
  stretch: number
  motif: number
  ghosts: number
  /** a phrase looping on worn tape, falling apart a little more every pass */
  loop: number
  /** the motif's own seed — kept apart from the take seed so an album can quote it */
  motifSeed: number
  /** MELODIC LINES: lead · counter · ostinato · bell, made of the material */
  lines?: number
  /** TEXTURE KIN: the same texture from many sources, staged as drama */
  kin?: KinPlan
}

export const LAYERS_OFF: MemoryLayerParams = { stretch: 0, motif: 0, ghosts: 0, loop: 0, lines: 0, motifSeed: 1 }
export const LAYERS_WEAVE = { stretch: 0.6, motif: 0.6, ghosts: 0.4, loop: 0.7, lines: 0.65 }

/** any layer switched on? */
export const layersActive = (p: MemoryLayerParams) =>
  p.stretch > 0.02 || p.motif > 0.02 || p.ghosts > 0.02 || (p.loop ?? 0) > 0.02 || (p.kin?.amt ?? 0) > 0.02 || (p.lines ?? 0) > 0.02

/** per form section (DUST · SURFACING · THE MEMORY · DISSOLVING), and with no form */
const STRETCH_W = [0.8, 0.5, 0.35, 0.9]
const GHOST_W = [0.12, 1, 0.35, 0.7]
const FREE = -1

interface SourceLike {
  buffer: AudioBuffer
  era?: Era
  bed?: boolean
}

export type LayerKind = 'clouds' | 'melody' | 'ghosts' | 'loop' | 'kin'

export interface LayerEnv {
  ctx: BaseAudioContext
  /** per layer: dry destination (pre master chain) and reverb send — the MIX faders */
  buses: Record<LayerKind, { dry: AudioNode; send: AudioNode }>
  /** context time of t = 0 and of the end (Infinity live) */
  start: number
  end: number
  seed: number
  params: MemoryLayerParams
  keyRoot: number
  slices: Slice[]
  sources: SourceLike[]
  chordAt: (when: number) => Chord | null
  /** form section (0–3) sounding at a context time, −1 without a memory form */
  sectionAt: (when: number) => number
  /** the form section around a context time, in context time; null without a form */
  sectionSpan?: (when: number) => { index: number; start: number; end: number } | null
  /** seconds into the form (and its length) at a context time; null without a form */
  formPos?: FormPos
  markUsed?: (sourceIdx: number, from: number, to: number) => void
  /** live: register sources so pause() can stop them */
  track?: (src: AudioBufferSourceNode) => void
}

// ---------- pickers ----------

/** How much a fragment sounds like a voice (speech or singing). */
export function voiceScore(s: Slice): number {
  let sc = 0
  if (s.pitch && s.pitch > 80 && s.pitch < 420) sc += 0.6 + Math.min(0.4, s.pitchConfidence * 0.5)
  if (s.pitchConfidence > 0.2 && s.pitchConfidence < 0.85) sc += 0.3 // voices waver
  if (s.centroid > 500 && s.centroid < 3200) sc += 0.5
  if (s.zcr > 0.03 && s.zcr < 0.22) sc += 0.3
  if (s.duration > 0.25) sc += Math.min(0.4, s.duration * 0.4)
  if (s.category === 'transient') sc -= 0.5
  return sc
}

export function ghostCandidates(slices: Slice[], sources: SourceLike[], n = 8): Slice[] {
  return slices
    .filter((s) => !sources[s.sourceIdx]?.bed && s.rms > 0.004)
    .map((s) => ({ s, v: voiceScore(s) }))
    .filter((x) => x.v > 0.9)
    .sort((a, b) => b.v - a.v)
    .slice(0, n)
    .map((x) => x.s)
}

const tonal = (s: Slice) =>
  (s.pitch ? s.pitchConfidence * 1.4 : 0) + (s.category === 'harmonic' ? 0.6 : 0) + Math.min(0.4, s.duration * 0.5) -
  (s.centroid > 4000 ? 0.5 : 0)

/** Fragments worth stretching: the most tonal pinned ones (else of the pool), one per source first. */
export function stretchCandidates(slices: Slice[], sources: SourceLike[], n = 4): Slice[] {
  const pins = slices.filter((s) => s.pinned)
  const pool = (pins.length >= 2 ? pins : slices).filter((s) => !sources[s.sourceIdx]?.bed && s.rms > 0.004)
  const ranked = [...pool].sort((a, b) => tonal(b) - tonal(a))
  const out: Slice[] = []
  const seen = new Set<number>()
  for (const s of ranked) if (out.length < n && !seen.has(s.sourceIdx)) { out.push(s); seen.add(s.sourceIdx) }
  for (const s of ranked) if (out.length < n && !out.includes(s)) out.push(s)
  return out
}

/** The motif's instrument: the clearest pitched pinned fragment (else of the pool). */
export function motifInstrument(slices: Slice[], sources: SourceLike[]): Slice | null {
  const pins = slices.filter((s) => s.pinned)
  const pool = (pins.length ? pins : slices).filter((s) => !sources[s.sourceIdx]?.bed && s.duration >= 0.2)
  let best: Slice | null = null
  let bs = -1
  for (const s of pool) {
    const sc = (s.pitch ? s.pitchConfidence * 2 : 0) + (s.category === 'harmonic' ? 0.5 : 0) + Math.min(0.5, s.duration * 0.5)
    if (sc > bs) { bs = sc; best = s }
  }
  return best
}

const STRETCH_SEC = 18
export const stretchKey = (s: Slice) => `${s.sourceIdx}:${s.start.toFixed(3)}:${s.duration.toFixed(3)}:${STRETCH_SEC}`

/** Compute (or reuse) the stretched clouds; resolves when they are ready. */
export async function prepareStretches(slices: Slice[], sources: SourceLike[]): Promise<number> {
  const cands = stretchCandidates(slices, sources)
  const done = await Promise.all(cands.map((s) => {
    const src = sources[s.sourceIdx]
    return src ? stretchRegion(stretchKey(s), src.buffer, s.start, s.duration, STRETCH_SEC) : Promise.resolve(null)
  }))
  return done.filter(Boolean).length
}

// ---------- the motif ----------

const PENTA = [0, 2, 4, 7, 9]

export interface MotifNote { deg: number; oct: number; beats: number }

/** A short, singable pentatonic phrase: stepwise, ends on a long note. */
export function makeMotif(seed: number): MotifNote[] {
  const rng = mulberry32(seed * 7 + 99)
  const n = 4 + Math.floor(rng() * 3)
  const notes: MotifNote[] = []
  let idx = 2 + Math.floor(rng() * 3) // start mid-range
  const rhythm = [[1, 0.5, 0.5, 1, 2], [1.5, 0.5, 1, 1, 2], [0.5, 0.5, 1, 2, 2], [1, 1, 0.5, 0.5, 3]][Math.floor(rng() * 4)]
  for (let i = 0; i < n; i++) {
    const step = [-2, -1, -1, 1, 1, 2, 0][Math.floor(rng() * 7)]
    idx = Math.max(0, Math.min(9, idx + (i === 0 ? 0 : step)))
    notes.push({ deg: PENTA[idx % 5], oct: Math.floor(idx / 5), beats: rhythm[i % rhythm.length] })
  }
  notes[n - 1].beats = Math.max(2, notes[n - 1].beats) // land
  notes[n - 1].deg = [0, 4, 7][Math.floor(rng() * 3)] // and land at home
  return notes
}

// ---------- helpers ----------

const regionCache = new WeakMap<AudioBuffer, Map<string, AudioBuffer>>()
/** A copy of one region of a buffer, optionally reversed (small, cached). */
export function region(buffer: AudioBuffer, start: number, dur: number, reverse: boolean): AudioBuffer {
  let m = regionCache.get(buffer)
  if (!m) regionCache.set(buffer, (m = new Map()))
  const key = `${start.toFixed(4)}:${dur.toFixed(4)}:${reverse ? 1 : 0}`
  const hit = m.get(key)
  if (hit) return hit
  const sr = buffer.sampleRate
  const a = Math.max(0, Math.floor(start * sr))
  const len = Math.max(32, Math.min(buffer.length - a, Math.floor(dur * sr)))
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: len, sampleRate: sr })
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const s = buffer.getChannelData(ch)
    const d = out.getChannelData(ch)
    for (let i = 0; i < len; i++) d[i] = s[a + (reverse ? len - 1 - i : i)] ?? 0
  }
  m.set(key, out)
  return out
}

const C4 = 261.626
/** Semitones from C4 for a frequency. */
const semisOf = (hz: number) => 12 * Math.log2(hz / C4)

/** Rate that moves a pitched fragment onto the nearest chord / key tone (±6 st). */
export function snapRate(pitch: number | null, keyRoot: number, chord: Chord | null): number {
  if (!pitch) return 1
  const cur = semisOf(pitch)
  const pcs = chord ? chord.pcs : PENTA.map((d) => (d + keyRoot) % 12)
  let best = 0
  let bd = 99
  for (let n = Math.floor(cur) - 7; n <= Math.ceil(cur) + 7; n++) {
    if (!pcs.includes(((n % 12) + 12) % 12)) continue
    const d = Math.abs(n - cur)
    if (d < bd) { bd = d; best = n }
  }
  return bd > 6.5 ? 1 : Math.pow(2, (best - cur) / 12)
}

export function voiceOut(env: LayerEnv, kind: LayerKind, when: number, pan: number, sendAmt: number, era: Era | undefined, src: AudioBufferSourceNode, rng: Rng, lowpass?: number) {
  const { ctx } = env
  let head: AudioNode = src
  if (era && era !== 'none') head = eraChain(ctx, head, src, era, rng, when)
  if (lowpass) {
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = lowpass
    lp.Q.value = 0.5
    head.connect(lp)
    head = lp
  }
  const g = ctx.createGain()
  g.gain.value = 0
  const p = ctx.createStereoPanner()
  p.pan.value = Math.max(-1, Math.min(1, pan))
  head.connect(g)
  g.connect(p)
  p.connect(env.buses[kind].dry)
  if (sendAmt > 0) {
    const s = ctx.createGain()
    s.gain.value = sendAmt
    p.connect(s)
    s.connect(env.buses[kind].send)
  }
  env.track?.(src)
  return g
}

// ---------- the lanes ----------

export function memoryLanes(env: LayerEnv): Array<Generator<number, void, void>> {
  const lanes: Array<Generator<number, void, void>> = []
  const { params } = env
  if (params.stretch > 0.02) lanes.push(stretchLane(env))
  if (params.motif > 0.02) lanes.push(motifLane(env))
  if (params.ghosts > 0.02) lanes.push(ghostLane(env))
  if ((params.loop ?? 0) > 0.02) lanes.push(loopLane(env))
  if ((params.kin?.amt ?? 0) > 0.02) lanes.push(kinLane(env))
  if ((params.lines ?? 0) > 0.02) lanes.push(linesLane(env))
  return lanes
}

function* stretchLane(env: LayerEnv): Generator<number, void, void> {
  const rng = mulberry32(env.seed + 31337)
  const clouds = stretchCandidates(env.slices, env.sources)
    .map((s) => ({ s, buf: cachedStretch(stretchKey(s)) }))
    .filter((x): x is { s: Slice; buf: AudioBuffer } => !!x.buf)
  if (clouds.length === 0) return
  let t = env.start + 0.5 + rng() * 2
  while (t < env.end) {
    const sec = env.sectionAt(t)
    const amt = env.params.stretch * (sec === FREE ? 0.6 : STRETCH_W[sec])
    const c = clouds[Math.floor(rng() * clouds.length)]
    const len = Math.min(c.buf.duration - 0.5, 9 + rng() * 8)
    if (amt > 0.03 && len > 2) {
      const src = env.ctx.createBufferSource()
      src.buffer = c.buf
      let rate = snapRate(c.s.pitch, env.keyRoot, env.chordAt(t))
      if (rng() < 0.3) rate *= 0.5 // an octave down: the floor of the memory
      src.playbackRate.value = rate
      const g = voiceOut(env, 'clouds', t, (rng() - 0.5) * 0.9, 0.55, env.sources[c.s.sourceIdx]?.era, src, rng, 3200)
      const peak = 0.13 * amt
      const fadeIn = Math.min(4, len * 0.35)
      const fadeOut = Math.min(4.5, len * 0.4)
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(peak, t + fadeIn)
      g.gain.setValueAtTime(peak, t + len - fadeOut)
      g.gain.linearRampToValueAtTime(0, t + len)
      const off = rng() * Math.max(0, c.buf.duration - len * rate - 0.1)
      src.start(t, off)
      src.stop(t + len + 0.1)
      env.markUsed?.(c.s.sourceIdx, c.s.start, c.s.start + c.s.duration)
    }
    t += len * (0.5 + rng() * 0.35) + (sec === 2 ? 4 + rng() * 6 : 0)
    yield t
  }
}

function* motifLane(env: LayerEnv): Generator<number, void, void> {
  const inst = motifInstrument(env.slices, env.sources)
  if (!inst) return
  const buffer = env.sources[inst.sourceIdx]?.buffer
  if (!buffer) return
  const era = env.sources[inst.sourceIdx]?.era
  const motif = makeMotif(env.params.motifSeed)
  const rng = mulberry32(env.seed + 4711)
  const beat = 0.78
  const instHz = inst.pitch ?? C4
  let t = env.start + 5 + rng() * 4
  let lastSec = -2
  let inSec = 0 // phrases already played in this section
  while (t < env.end) {
    const sec = env.sectionAt(t)
    if (sec !== lastSec) { lastSec = sec; inSec = 0 }
    // DUST: the melody has not come back yet
    if (sec === 0) { t += 3; yield t; continue }
    let distance: number
    let broken: number
    if (sec === 1) { distance = 0.75; broken = 0.15 }
    else if (sec === 2) { distance = 0; broken = 0 }
    else if (sec === 3) { distance = 0.5; broken = 0.55 + Math.min(0.4, inSec * 0.15) }
    else { distance = rng() * 0.6; broken = rng() * 0.6 }
    const amt = env.params.motif
    let cum = 0
    const stretch = 1 + broken * 0.45 // memories slow down as they fade
    const doubled = sec === 2 && rng() < 0.4
    motif.forEach((note, i) => {
      const nt = t + cum * beat * stretch
      cum += note.beats
      const drop = sec === 1 ? 0.4 : broken * 0.45
      if (i > 0 && i < motif.length - 1 && rng() < drop) return
      const target = C4 * Math.pow(2, (env.keyRoot + note.deg) / 12 + note.oct - 1)
      // keep the instrument near its own register
      let rate = target / instHz
      while (rate > 2.2) rate /= 2
      while (rate < 0.45) rate *= 2
      rate *= Math.pow(2, (-broken * 1.2 * (i / motif.length) + (rng() - 0.5) * broken * 0.5) / 12)
      const noteDur = Math.min(note.beats * beat * stretch * 1.15, 2.8)
      const reverse = broken > 0.5 && rng() < 0.3
      const reps = broken > 0.6 && rng() < 0.2 ? 2 : 1
      for (let r = 0; r < reps; r++) {
        for (const oct of doubled && i === motif.length - 1 ? [1, 2] : [1]) {
          const at = nt + r * 0.16
          const src = env.ctx.createBufferSource()
          const len = Math.min(inst.duration, buffer.duration - inst.start)
          src.buffer = region(buffer, inst.start, len, reverse)
          src.loop = true // sustain short fragments under long notes
          src.loopStart = Math.min(len * 0.3, 0.1)
          src.loopEnd = len
          src.playbackRate.value = rate * oct
          const lp = 600 + 7000 * (1 - distance * 0.85) * (1 - broken * 0.5)
          const g = voiceOut(env, 'melody', at, (rng() - 0.5) * (0.3 + distance * 0.6), 0.25 + distance * 0.55, era, src, rng, lp)
          // the memory is clearest in THE MEMORY; fading, it gets quieter, not louder
          const peak = 1.2 * amt * (sec === 3 ? 0.5 : 1) * (1 - distance * 0.55) * (oct === 2 ? 0.4 : 1) * (r ? 0.5 : 1)
          const a = Math.min(0.06, noteDur * 0.2)
          g.gain.setValueAtTime(0, at)
          g.gain.linearRampToValueAtTime(peak, at + a)
          g.gain.setTargetAtTime(peak * 0.6, at + a, noteDur * 0.5)
          g.gain.setTargetAtTime(0, at + noteDur, 0.25)
          src.start(at, 0)
          src.stop(at + noteDur + 1.5)
        }
      }
      env.markUsed?.(inst.sourceIdx, inst.start, inst.start + inst.duration)
    })
    inSec++
    const phrase = cum * beat * stretch
    const gap = sec === 2 ? 3 + rng() * 5 : sec === 1 ? 9 + rng() * 10 : sec === 3 ? 7 + rng() * 9 : 22 + rng() * 20
    t += phrase + gap
    yield t
  }
}

function* ghostLane(env: LayerEnv): Generator<number, void, void> {
  const ghosts = ghostCandidates(env.slices, env.sources)
  if (ghosts.length === 0) return
  const rng = mulberry32(env.seed + 666)
  let t = env.start + 6 + rng() * 6
  while (t < env.end) {
    const sec = env.sectionAt(t)
    const amt = env.params.ghosts * (sec === FREE ? 0.6 : GHOST_W[sec])
    if (amt > 0.03) {
      const s = ghosts[Math.floor(rng() * ghosts.length)]
      const buffer = env.sources[s.sourceIdx]?.buffer
      if (buffer) {
        const reverse = rng() < 0.4
        const phone = rng() < 0.25
        const rate = 0.9 + rng() * 0.12
        const len = Math.min(s.duration, buffer.duration - s.start)
        const dur = len / rate
        const echoes = rng() < 0.5 ? 2 : 1
        const pan = (rng() - 0.5) * 1.6
        for (let e = 0; e < echoes; e++) {
          const at = t + e * (0.32 + rng() * 0.2)
          const src = env.ctx.createBufferSource()
          src.buffer = region(buffer, s.start, len, reverse)
          src.playbackRate.value = rate
          // behind a wall (muffled) or down a telephone line (thin)
          const era: Era = phone ? 'phone' : (env.sources[s.sourceIdx]?.era ?? 'none')
          const g = voiceOut(env, 'ghosts', at, pan * (e ? -0.6 : 1), 0.85, era, src, rng, phone ? 3000 : 800 + rng() * 700)
          const peak = 0.6 * amt * (e ? 0.45 : 1)
          g.gain.setValueAtTime(0, at)
          g.gain.linearRampToValueAtTime(peak, at + Math.min(0.08, dur * 0.25))
          g.gain.setValueAtTime(peak, at + dur * 0.7)
          g.gain.linearRampToValueAtTime(0, at + dur)
          src.start(at)
          src.stop(at + dur + 0.05)
        }
        env.markUsed?.(s.sourceIdx, s.start, s.start + len)
      }
    }
    t += (7 + rng() * 15) / (0.45 + amt)
    yield t
  }
}

/**
 * TAPE LOOP DISINTEGRATION: one phrase loops; every pass the tape sheds a
 * little more — holes open (and never heal), the top darkens, the speed sags —
 * until only scattered fragments remain. Fills DISSOLVING to its end; without
 * a form, a 60–90 s disintegration now and then.
 */
function* loopLane(env: LayerEnv): Generator<number, void, void> {
  const cands = stretchCandidates(env.slices, env.sources, 4)
  if (cands.length === 0) return
  const rng = mulberry32(env.seed + 1987)
  let t = env.start + 1
  let cycle = 0
  while (t < env.end) {
    const span = env.sectionSpan?.(t) ?? null
    let from: number
    let to: number
    if (span) {
      if (span.index !== 3) { t = Math.min(span.end + 0.01, t + 4); yield t; continue } // wait for DISSOLVING
      from = Math.max(t, span.start + 0.5)
      to = span.end
    } else {
      from = t
      to = t + 60 + rng() * 30
    }
    const s = cands[cycle++ % cands.length]
    const buffer = env.sources[s.sourceIdx]?.buffer
    const room = buffer ? buffer.duration - s.start : 0
    const phrase = Math.min(room, 3 + rng() * 2.5)
    if (!buffer || phrase < 0.8 || to - from < phrase * 2) { t = to + 1; yield t; continue }
    const era = env.sources[s.sourceIdx]?.era
    const keyRate = snapRate(s.pitch, env.keyRoot, env.chordAt(from))
    const pan = (rng() - 0.5) * 0.5
    const estReps = Math.max(2, Math.floor((to - from) / phrase))
    const damage: Array<[number, number]> = [] // fractions of the loop that are gone
    let rt = from
    let k = 0
    while (rt + 0.4 < Math.min(to, env.end)) {
      const p = Math.min(1, k / (estReps - 1))
      // wear: old holes widen a little, new ones open until the target is gone
      for (const d of damage) {
        const grow = (d[1] - d[0]) * 0.07
        d[0] = Math.max(0, d[0] - grow / 2)
        d[1] = Math.min(1, d[1] + grow / 2)
      }
      const target = 0.85 * Math.pow(p, 1.4)
      let gone = merged(damage).reduce((n, d) => n + d[1] - d[0], 0)
      let guard = 0
      while (gone < target && guard++ < 12) {
        const w = 0.025 + rng() * 0.08
        const a = rng() * (1 - w)
        damage.push([a, a + w])
        gone = merged(damage).reduce((n, d) => n + d[1] - d[0], 0)
      }
      const rate = keyRate * (1 - 0.07 * p) // the tape sags
      const dur = phrase / rate
      const src = env.ctx.createBufferSource()
      src.buffer = region(buffer, s.start, phrase, false)
      src.playbackRate.value = rate
      const lp = 350 + 7500 * Math.pow(1 - p, 1.5)
      const g = voiceOut(env, 'loop', rt, pan, 0.3 + p * 0.4, era, src, rng, lp)
      const G = 0.45 * env.params.loop * (1 - p * 0.45)
      const gp = g.gain
      gp.setValueAtTime(0, rt)
      gp.linearRampToValueAtTime(G, rt + 0.012)
      for (const [a, b] of merged(damage)) {
        const ta = rt + a * dur
        const tb = rt + b * dur
        if (ta > rt + 0.03) {
          gp.setValueAtTime(G, ta - 0.02)
          gp.linearRampToValueAtTime(0.0001, ta)
        } else {
          gp.setValueAtTime(0.0001, rt + 0.012)
        }
        if (tb < rt + dur - 0.03) {
          gp.setValueAtTime(0.0001, tb)
          gp.linearRampToValueAtTime(G, tb + 0.02)
        }
      }
      const tailGone = merged(damage).some(([, e]) => e >= 1 - 0.03 / dur)
      gp.setValueAtTime(tailGone ? 0.0001 : G, Math.max(rt + 0.02, rt + dur - 0.015))
      gp.linearRampToValueAtTime(0, rt + dur)
      src.start(rt, 0, phrase)
      src.stop(rt + dur + 0.05)
      env.markUsed?.(s.sourceIdx, s.start, s.start + phrase)
      rt += dur
      k++
      yield rt
    }
    t = span ? to + 0.01 : to + 20 + rng() * 30
    yield t
  }
}

function merged(d: Array<[number, number]>): Array<[number, number]> {
  const a = [...d].sort((x, y) => x[0] - y[0])
  const out: Array<[number, number]> = []
  for (const [s, e] of a) {
    const last = out[out.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** The form section at song-time `t` (looping), with its bounds in song-time. */
export function sectionSpanAt(sections: SongSection[], t: number): { index: number; start: number; end: number } | null {
  if (sections.length !== 4) return null
  const total = sections.reduce((n, s) => n + s.sec, 0)
  if (total <= 0) return null
  const base = Math.floor(t / total) * total
  const tt = t - base
  let acc = 0
  for (let i = 0; i < 4; i++) {
    if (tt < acc + sections[i].sec) return { index: i, start: base + acc, end: base + acc + sections[i].sec }
    acc += sections[i].sec
  }
  return { index: 3, start: base + total - sections[3].sec, end: base + total }
}

/** Section index of a form at song-time `t` (seconds), looping; −1 without a form. */
export function sectionIndexAt(sections: SongSection[], t: number): number {
  if (sections.length !== 4) return FREE
  const total = sections.reduce((n, s) => n + s.sec, 0)
  if (total <= 0) return FREE
  let tt = ((t % total) + total) % total
  for (let i = 0; i < 4; i++) {
    if (tt < sections[i].sec) return i
    tt -= sections[i].sec
  }
  return 3
}
