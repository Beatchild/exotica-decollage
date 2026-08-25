import type { MacroParams, ScaleName, Slice, SliceEvent, VoiceParams } from './types'
import { SCALES } from './types'
import type { Rng } from './rng'
import { chordFit, chromaSim, genMotifPhrase, sliceSemi, voiceLead } from './Harmony'
import type { Chord, Motif } from './Harmony'

/** Harmonic context handed to the generators when chord-lock is on. */
export interface HarmCtx {
  chord: Chord
  scale: ScaleName
  root: number
  pad: boolean
  padPrev: number[] | null
  prevChroma?: number[]
}

/** Weighted pick: probability ∝ weightFn² (sharpens preference), one rng draw. */
export function weightedChoice<T>(rng: Rng, arr: T[], weightFn: (x: T) => number): T {
  if (arr.length === 0) throw new Error('empty pool')
  const weights = arr.map((x) => Math.max(0.02, weightFn(x)) ** 2)
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i]
    if (r <= 0) return arr[i]
  }
  return arr[arr.length - 1]
}

export const TAPE_RATIOS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0]

/** Bjorklund/euclidean rhythm: `pulses` onsets spread evenly over `steps`. */
export function euclid(pulses: number, steps: number): boolean[] {
  const out: boolean[] = []
  let bucket = 0
  for (let i = 0; i < steps; i++) {
    bucket += pulses
    if (bucket >= steps) {
      bucket -= steps
      out.push(true)
    } else {
      out.push(false)
    }
  }
  return out
}

/**
 * Groove timing for voice 2: grid distance (seconds) from the current
 * 16th-note step to the next euclidean onset, plus that onset's swing offset.
 * Swing stays per-event — it never accumulates into the grid. Density sets
 * pulse count.
 */
export function grooveNext(
  step: number,
  density: number,
  bpm: number,
  swingAmt = 0.18,
): { dtGrid: number; swing: number; step: number } {
  const steps = 16
  const pulses = Math.max(1, Math.min(steps - 1, Math.round(2 + density * 9)))
  const pattern = euclid(pulses, steps)
  const stepDur = 60 / bpm / 4
  for (let k = 1; k <= steps; k++) {
    const idx = (step + k) % steps
    if (pattern[idx]) {
      return { dtGrid: k * stepDur, swing: idx % 2 === 1 ? stepDur * swingAmt : 0, step: idx }
    }
  }
  return { dtGrid: stepDur, swing: 0, step: (step + 1) % steps }
}

const centsToRate = (c: number) => Math.pow(2, c / 1200)
const rand = (rng: Rng, a: number, b: number) => a + rng() * (b - a)
const choice = <T,>(rng: Rng, arr: T[]) => arr[Math.floor(rng() * arr.length)]

/**
 * Key-lock: playback-rate multiplier that lands a pitched slice exactly on
 * the nearest scale degree of the key (root = semitones above C). Unpitched
 * or low-confidence slices pass through untouched.
 */
export function keyCorrection(
  pitch: number | null,
  confidence: number,
  scale: ScaleName,
  root: number,
): number {
  if (!pitch || confidence < 0.35) return 1
  const degrees = SCALES[scale === 'free' ? 'pentatonic' : scale]!
  const semisFromC = 12 * Math.log2(pitch / 261.626) // C4 reference
  const nearestSemi = Math.round(semisFromC)
  const pc = (((nearestSemi - root) % 12) + 12) % 12
  let best = 0
  let bestD = Infinity
  for (const d of degrees) {
    for (const off of [-12, 0, 12]) {
      const delta = d + off - pc
      if (Math.abs(delta) < Math.abs(bestD)) {
        bestD = delta
        best = delta
      }
    }
  }
  // total shift: snap the fractional detune, then move to the scale degree
  const correction = nearestSemi - semisFromC + best
  return Math.pow(2, correction / 12)
}

/** Snap a cent offset to the nearest scale degree within ±19 semitones. */
export function quantizeCents(cents: number, scale: ScaleName): number {
  const degrees = SCALES[scale]
  if (!degrees) return cents
  const semis = cents / 100
  let best = 0
  let bestD = Infinity
  for (let s = -19; s <= 19; s++) {
    if (!degrees.includes(((s % 12) + 12) % 12)) continue
    const d = Math.abs(s - semis)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best * 100
}

/**
 * Voice 1 — harmonic bed: one granular cloud cycle over a chosen slice.
 * Returns the grain events plus the cycle duration until the next call.
 */
export function genV1Cycle(
  pool: Slice[],
  v: VoiceParams,
  macros: MacroParams,
  scale: ScaleName,
  rng: Rng,
  tape = false,
  harm: HarmCtx | null = null,
  frag = 1,
  revProb = 0,
): { events: SliceEvent[]; cycleDur: number; sliceChroma?: number[]; padSemis?: number[] } {
  const rp = Math.min(1, revProb + (tape ? 0.18 : 0))
  // in MID/LONG regimes lean toward longer slices so grains can breathe
  const durW = (s: Slice) => (frag > 1 ? 0.25 + Math.min(s.duration, 6) / 6 : 1)
  const slice = harm
    ? weightedChoice(rng, pool, (s) =>
        chordFit(s.chroma, harm.chord) * (0.5 + 0.5 * chromaSim(s.chroma, harm.prevChroma)) * durW(s),
      )
    : frag > 1
      ? weightedChoice(rng, pool, durW)
      : choice(rng, pool)
  const cycleDur = rand(rng, 3.2, 7.1) * (1 + (frag - 1) * 0.35)

  // pad mode: a few sustained grains on the chord tones, voice-led
  if (harm?.pad) {
    const padSemis = voiceLead(harm.padPrev, harm.chord)
    const base = sliceSemi(slice, harm.root)
    const pans = [-0.5, -0.17, 0.17, 0.5]
    const events: SliceEvent[] = padSemis.slice(0, 4).map((target, i) => ({
      voice: 0,
      sliceId: slice.id,
      t: rand(rng, 0, 0.4),
      rate: Math.pow(2, (harm.root + target - base) / 12),
      gain: 0.13,
      pan: pans[i % pans.length],
      attack: cycleDur * 0.35,
      release: cycleDur * 0.35,
      grainDur: Math.min(slice.duration, 3),
      grainOffset: 0,
      noCorrect: true,
      reverse: rng() < rp * 0.7,
    }))
    return { events, cycleDur, sliceChroma: slice.chroma, padSemis }
  }

  const grainSize = Math.min(
    rand(rng, 0.15, 0.4) * (0.7 + macros.decayFactor * 0.9) * frag,
    Math.max(0.15, slice.duration * 0.95),
  )
  const overlap = Math.min(0.1 * frag, grainSize * 0.45)
  const step = Math.max(0.04, grainSize - overlap) / (0.5 + v.density)
  // whole-cycle interval shift: consonant set under harmony, wide otherwise
  const third = harm ? (harm.chord.semis[1] ?? 4) - harm.chord.semis[0] : 4
  const interval = harm
    ? choice(rng, [0, 0, 0, -12, -12, -24, 12, 7, third])
    : rng() < 0.25 ? (rng() < 0.5 ? -12 : 7) : 0

  const events: SliceEvent[] = []
  for (let t = 0; t < cycleDur; t += step) {
    const cents = harm
      ? interval * 100
      : quantizeCents(rand(rng, -700, 500) * v.pitchRange, scale) + interval * 100
    const maxOffset = Math.max(0, slice.duration - grainSize)
    events.push({
      voice: 0,
      sliceId: slice.id,
      t: t + rand(rng, 0, step * 0.3) * macros.chaos,
      rate: centsToRate(cents),
      gain: rand(rng, 0.1, 0.22),
      pan: rand(rng, -0.6, 0.6),
      attack: grainSize * 0.4,
      release: grainSize * 0.4,
      grainDur: grainSize,
      grainOffset: rand(rng, 0, maxOffset),
      reverse: rng() < rp,
    })
  }
  return { events, cycleDur, sliceChroma: slice.chroma }
}

/**
 * Voice 2 — plunderphonic fragment: one Markov step + Poisson inter-arrival.
 * `idx` is the incoming Markov state (index into pool); returns the new one.
 */
export function genV2Step(
  pool: Slice[],
  v: VoiceParams,
  macros: MacroParams,
  bpm: number,
  idx: number,
  rng: Rng,
): { event: SliceEvent; dt: number; idx: number } {
  // Markov: mostly walk to a timbral neighbour, chaos jumps anywhere
  if (idx < 0 || idx >= pool.length) {
    idx = Math.floor(rng() * pool.length)
  } else if (rng() < 0.25 + macros.chaos * 0.6) {
    idx = Math.floor(rng() * pool.length)
  } else {
    const cur = pool[idx]
    const ranked = pool
      .map((s, i) => ({ i, d: Math.abs(Math.log((s.centroid + 1) / (cur.centroid + 1))) }))
      .sort((a, b) => a.d - b.d)
    idx = ranked[Math.min(1 + Math.floor(rng() * 3), ranked.length - 1)].i
  }
  const slice = pool[idx]

  const ratios = TAPE_RATIOS.filter((r) => Math.abs(Math.log2(r)) <= 0.1 + v.pitchRange * 2)
  const event: SliceEvent = {
    voice: 1,
    sliceId: slice.id,
    t: 0,
    rate: choice(rng, ratios.length ? ratios : [1]),
    gain: rand(rng, 0.35, 0.7),
    pan: rand(rng, -0.9, 0.9), // wide stereo per trigger
  }

  // Poisson inter-arrival, mean set by density; low chaos snaps to the pulse clock
  const mean = 0.25 + (1 - v.density) * 2.2
  let dt = -Math.log(1 - rng()) * mean
  dt = Math.min(4.5, Math.max(0.08, dt))
  if (rng() > macros.chaos) {
    const grid = 60 / bpm / 2 // eighth-note pulse
    dt = Math.max(grid, Math.round(dt / grid) * grid)
  }
  return { event, dt, idx }
}

/**
 * Voice 5 — microloop (Jelinek-style microsampling): a 10–80ms window of a
 * slice looped into a buzzing/rhythmic cell for 0.5–3s, pitch snapped to the
 * scale. Density drives cell rate, chaos drives window jitter.
 */
export function genV5Cell(
  pool: Slice[],
  v: VoiceParams,
  macros: MacroParams,
  scale: ScaleName,
  rng: Rng,
  harm: HarmCtx | null = null,
  frag = 1,
): { events: SliceEvent[]; dt: number } {
  const slice = harm
    ? weightedChoice(rng, pool, (s) => chordFit(s.chroma, harm.chord))
    : choice(rng, pool)
  const cellDur = (0.5 + rng() * 2.5) * (1 + (frag - 1) * 0.4)
  // arp mode under harmony: cells step through chord tones;
  // free mode uses the darker −3…−12st varipitch character
  const cents = harm
    ? (choice(rng, harm.chord.semis) + choice(rng, [-12, 0, 0, 12])) * 100
    : rng() < 0.35
      ? -rand(rng, 100, 2400) * (0.35 + v.pitchRange * 0.65)
      : quantizeCents(rand(rng, -1200, 700) * v.pitchRange, scale)
  const rate = centsToRate(cents)
  const gain = rand(rng, 0.15, 0.35)
  const pan = rand(rng, -0.7, 0.7)

  // poisson-ish cell arrivals; density opens the stream up
  const mean = 0.4 + (1 - v.density) * 3.2
  let dt = -Math.log(1 - rng()) * mean
  dt = Math.min(6, Math.max(0.25, dt))

  if (rng() < 0.5) {
    // native micro loop: 10–80ms buzzing window
    const loopDur = 0.01 + rng() * 0.07
    const maxOffset = Math.max(0, slice.duration - loopDur * 1.5)
    return {
      events: [{
        voice: 4,
        sliceId: slice.id,
        t: 0,
        rate,
        gain,
        pan,
        attack: 0.02 + rng() * 0.1,
        release: cellDur * (0.2 + rng() * 0.3),
        grainOffset: rand(rng, 0, maxOffset) * (0.3 + macros.chaos * 0.7),
        micro: { loopDur, cellDur },
      }],
      dt,
    }
  }

  // spec loop: micro-loop as a grain train with equal-power crossfades
  // (15–40ms) and per-repeat spray/jitter (5–30ms); FRAG stretches the window
  const loopDur = Math.min((0.1 + rng() * 0.7) * frag, Math.max(0.1, slice.duration))
  const xfade = 0.015 + rng() * 0.025
  const baseOffset = rand(rng, 0, Math.max(0, slice.duration - loopDur)) * (0.3 + macros.chaos * 0.7)
  const spray = 0.005 + rng() * 0.025
  const step = Math.max(0.05, loopDur - xfade)
  const reps = Math.max(1, Math.ceil(cellDur / step))
  const events: SliceEvent[] = []
  for (let k = 0; k < reps; k++) {
    events.push({
      voice: 4,
      sliceId: slice.id,
      t: k * step,
      rate,
      gain,
      pan,
      attack: xfade,
      release: xfade,
      grainDur: loopDur,
      grainOffset: Math.max(0, baseOffset + (rng() - 0.5) * 2 * spray),
    })
  }
  return { events, dt: Math.max(dt, reps * step + 0.1) }
}

/**
 * Voice 7 — melody: motif-based phrases on the most tonal slice of the pool.
 * Rests are part of the phrasing; the returned motif feeds the next call so
 * phrases repeat with variation.
 */
export function genV7Phrase(
  pool: Slice[],
  v: VoiceParams,
  harm: HarmCtx,
  bpm: number,
  rng: Rng,
  prevMotif: Motif | null,
): { events: SliceEvent[]; dur: number; motif: Motif | null } {
  const beat = 60 / bpm
  const dur = 8 * beat // 2 bars
  // density opens/closes the phrasing: low density = more rests
  if (rng() < 0.55 - v.density * 0.45) return { events: [], dur, motif: prevMotif }

  const slice = weightedChoice(rng, pool, (s) => 0.1 + s.pitchConfidence)
  const base = sliceSemi(slice, harm.root)
  const { notes, motif } = genMotifPhrase(harm.scale, harm.chord, rng, prevMotif)
  const events: SliceEvent[] = notes.map((note) => ({
    voice: 6,
    sliceId: slice.id,
    t: note.beat * beat,
    rate: Math.pow(2, (harm.root + note.semi - base) / 12),
    gain: rand(rng, 0.45, 0.65),
    pan: rand(rng, -0.25, 0.25),
    attack: 0.012,
    release: Math.min(0.4, note.lengthBeats * beat * 0.35),
    grainDur: Math.min(slice.duration, note.lengthBeats * beat * 0.92),
    grainOffset: 0,
    noCorrect: true,
  }))
  return { events, dur, motif }
}

/** Voice 3 — resonant exotica decay: one swept-bandpass event + next interval.
 * With tape on, some events become slow reversed swells (pedal-steel entrances). */
export function genV3Step(
  pool: Slice[],
  v: VoiceParams,
  rng: Rng,
  tape = false,
  harm: HarmCtx | null = null,
): { event: SliceEvent; dt: number } {
  const slice = harm
    ? weightedChoice(rng, pool, (s) => chordFit(s.chroma, harm.chord))
    : choice(rng, pool)
  const rate = choice(rng, [0.5, 0.75, 1.0])
  const sweepDur = rand(rng, 2, 5)
  const f0 = rand(rng, 300, 900)
  const swell = tape && rng() < 0.35
  const event: SliceEvent = {
    voice: 2,
    sliceId: slice.id,
    t: 0,
    rate: swell ? 0.5 : rate,
    gain: rand(rng, 0.4, 0.7),
    pan: rand(rng, -0.5, 0.5),
    attack: swell ? rand(rng, 1.5, 3.5) : 0.4,
    release: Math.min(1.2, slice.duration / rate / 2),
    filter: { freq0: f0, freq1: f0 * rand(rng, 2, 6), q: rand(rng, 8, 16), sweepDur },
    reverse: swell && rng() < 0.6,
  }
  return { event, dt: rand(rng, 6, 14) * (1.3 - v.density * 0.6) }
}
