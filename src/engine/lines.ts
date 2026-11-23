import type { Chord } from './Harmony'
import { mulberry32 } from './rng'
import type { Rng } from './rng'
import type { Slice } from './types'
import type { LayerEnv } from './memoryLayers'
import { makeMotif, region, voiceOut } from './memoryLayers'

/**
 * MELODIC LINES — several real melodies at once, made of the material itself,
 * in the exotica / hauntology manner: a slightly too-sweet tune heard through
 * the wrong decade.
 *
 * LEAD      long phrases in periods (A · A′ · B · A″): A asks, A′ answers, B
 *           quotes the returning motif, A″ comes home. Strong beats sit on
 *           chord tones, weak beats pass; now and then a glide into a note.
 * COUNTER   a slow line below, moving against the lead, on the 3rds and 7ths.
 * OSTINATO  a vibraphone / marimba figure: the chord broken in eighths, with
 *           motor tremolo — the lounge that is no longer there.
 * BELL      in the lead's rests, its last notes an octave up, further away.
 *
 * Per section of the woven form: DUST — only the ostinato, far; SURFACING —
 * the lead half-heard; THE MEMORY — everything; DISSOLVING — slower, notes
 * missing, some backwards, the bell answering into nothing.
 */

const MODES: Array<{ name: string; steps: number[] }> = [
  { name: 'lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  { name: 'dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'pentatonic', steps: [0, 2, 4, 7, 9] },
  { name: 'harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { name: 'major', steps: [0, 2, 4, 5, 7, 9, 11] },
]

const C4 = 261.626
type Role = 'lead' | 'counter' | 'ostinato' | 'bell'

interface Inst { s: Slice; hz: number; sustain: boolean }

const pitched = (s: Slice) => !!s.pitch && s.pitch > 60 && s.pitch < 1600 && s.pitchConfidence > 0.3 && s.duration >= 0.12

/** One fragment per role, each a different sound where the material allows. */
export function lineInstruments(slices: Slice[], sources: Array<{ bed?: boolean }>): Partial<Record<Role, Inst>> {
  const pins = slices.filter((s) => s.pinned && pitched(s) && !sources[s.sourceIdx]?.bed)
  const pool = pins.length >= 3 ? pins : slices.filter((s) => pitched(s) && !sources[s.sourceIdx]?.bed && s.rms > 0.004)
  if (pool.length === 0) return {}
  const used = new Set<number>()
  const pick = (score: (s: Slice) => number): Inst | undefined => {
    let best: Slice | undefined
    let bs = -Infinity
    for (const s of pool) {
      const sc = score(s) - (used.has(s.id) ? 3 : 0)
      if (sc > bs) { bs = sc; best = s }
    }
    if (!best) return undefined
    used.add(best.id)
    return { s: best, hz: best.pitch!, sustain: best.attack < 0.9 && best.duration > 0.3 }
  }
  const lead = pick((s) => s.pitchConfidence * 2 + Math.min(1, s.duration) + (s.category === 'harmonic' ? 0.5 : 0) - Math.max(0, s.attack - 1) * 0.3)
  const ostinato = pick((s) => Math.min(2, s.attack) * 0.8 + s.pitchConfidence + (s.duration < 0.6 ? 0.3 : 0))
  const counter = pick((s) => s.pitchConfidence + Math.min(1, s.duration) - Math.log2(Math.max(80, s.pitch!) / 200) * 0.4)
  const bell = pick((s) => s.pitchConfidence + Math.log(Math.max(200, s.centroid)) * 0.3 + Math.min(1.5, s.attack) * 0.4)
  return { lead, ostinato, counter, bell }
}

// ---------- composition ----------

interface Note { beat: number; beats: number; deg: number; glide?: boolean }

const RHYTHMS: number[][] = [
  [1, 1, 2, 1, 1, 2],
  [1.5, 0.5, 1, 1, 2, 2],
  [0.5, 0.5, 1, 2, 1, 1, 2],
  [2, 1, 1, 1.5, 0.5, 2],
  [1, 0.5, 0.5, 2, 1, 3],
  [3, 1, 1, 1, 2],
]

/** A two-bar phrase (8 beats) of scale degrees; `end` is where it lands. */
function phrase(rng: Rng, start: number, end: number, len = 8): Note[] {
  const r = RHYTHMS[Math.floor(rng() * RHYTHMS.length)]
  const out: Note[] = []
  let b = 0
  let d = start
  let i = 0
  while (b < len - 0.01) {
    const beats = Math.min(r[i % r.length], len - b)
    const last = b + beats >= len - 0.01
    if (i > 0) {
      // mostly steps, sometimes a leap that then turns back
      const prev = out[out.length - 1].deg - (out[out.length - 2]?.deg ?? out[out.length - 1].deg)
      const leap = Math.abs(prev) >= 3
      const step = leap ? -Math.sign(prev) : [-1, -1, 1, 1, 2, -2, 0, 3, -3][Math.floor(rng() * 9)]
      d = Math.max(-3, Math.min(10, d + step + (d > 7 ? -1 : d < 0 ? 1 : 0)))
    }
    if (last) d = end
    out.push({ beat: b, beats, deg: d, glide: i > 0 && rng() < 0.12 })
    b += beats
    i++
  }
  return out
}

/** The lead's period: A (asks) · A′ (answers) · B (the motif) · A″ (home). */
function period(rng: Rng, motifSeed: number, steps: number): Note[][] {
  const home = 0
  const a = phrase(rng, 2 + Math.floor(rng() * 3), 1 + Math.floor(rng() * 3))
  const a2 = a.map((n, i) => ({ ...n, deg: i === a.length - 1 ? home : i > a.length / 2 && rng() < 0.4 ? n.deg + [-1, 1][Math.floor(rng() * 2)] : n.deg }))
  // B: the returning motif, in this mode's degrees
  const m = makeMotif(motifSeed)
  let b = 0
  const pent = [0, 2, 4, 7, 9]
  const B: Note[] = m.map((x) => {
    const pc = pent.indexOf(x.deg) >= 0 ? x.deg : 0
    // nearest degree of the mode to the motif's pitch
    const st = [0, 2, 4, 5, 7, 9, 11].indexOf(pc)
    const n: Note = { beat: b, beats: x.beats, deg: (st < 0 ? 0 : Math.round((st / 7) * steps)) + x.oct * steps }
    b += x.beats
    return n
  }).filter((n) => n.beat < 8)
  if (B.length) B[B.length - 1].beats = Math.max(1, 8 - B[B.length - 1].beat)
  const a3 = phrase(rng, a[0].deg, home)
  return [a, a2, B.length >= 3 ? B : phrase(rng, 4, 2), a3]
}

// ---------- the lane ----------

const BEAT = 0.68

/** pitch (Hz) of scale degree `deg` (may be <0 or ≥ steps) in `mode`, octave `oct` around C4 */
function degHz(keyRoot: number, steps: number[], deg: number, oct: number): number {
  const n = steps.length
  const o = Math.floor(deg / n)
  const st = steps[((deg % n) + n) % n] + 12 * (o + oct)
  return C4 * Math.pow(2, (keyRoot + st) / 12)
}

/** Move a degree onto the nearest chord tone (strong beats). */
function toChord(keyRoot: number, steps: number[], deg: number, chord: Chord | null): number {
  if (!chord) return deg
  const n = steps.length
  for (const d of [0, -1, 1, -2, 2]) {
    const pc = (keyRoot + steps[(((deg + d) % n) + n) % n]) % 12
    if (chord.pcs.includes(pc)) return deg + d
  }
  return deg
}

function play(env: LayerEnv, rng: Rng, inst: Inst, o: {
  at: number; hz: number; dur: number; peak: number; pan: number; lp: number; send: number
  glideFrom?: number; reverse?: boolean; tremolo?: number
}) {
  const buffer = env.sources[inst.s.sourceIdx]?.buffer
  if (!buffer) return
  let rate = o.hz / inst.hz
  while (rate > 2.4) rate /= 2
  while (rate < 0.4) rate *= 2
  const len = Math.min(inst.s.duration, buffer.duration - inst.s.start)
  if (len < 0.05) return
  const src = env.ctx.createBufferSource()
  src.buffer = region(buffer, inst.s.start, len, !!o.reverse)
  if (inst.sustain && o.dur > len / rate) {
    src.loop = true // hold long notes on a sustaining sound
    src.loopStart = Math.min(len * 0.3, 0.12)
    src.loopEnd = len
  }
  // a slight, slow detune: the tape never quite at speed
  const cents = (rng() - 0.5) * 18
  const r = rate * Math.pow(2, cents / 1200)
  if (o.glideFrom) {
    let gr = o.glideFrom / inst.hz
    while (gr > 2.4) gr /= 2
    while (gr < 0.4) gr *= 2
    src.playbackRate.setValueAtTime(gr * Math.pow(2, cents / 1200), o.at)
    src.playbackRate.linearRampToValueAtTime(r, o.at + Math.min(0.12, o.dur * 0.3))
  } else src.playbackRate.value = r
  const g = voiceOut(env, 'melody', o.at, o.pan, o.send, env.sources[inst.s.sourceIdx]?.era, src, rng, o.lp)
  const a = inst.sustain ? Math.min(0.05, o.dur * 0.2) : 0.004
  const gp = g.gain
  gp.setValueAtTime(0, o.at)
  gp.linearRampToValueAtTime(o.peak, o.at + a)
  if (o.tremolo) {
    // vibraphone motor: amplitude dips at ~5 Hz
    const half = 1 / (2 * o.tremolo)
    let t = o.at + a
    let up = false
    while (t + half < o.at + o.dur) {
      t += half
      gp.linearRampToValueAtTime(o.peak * (up ? 1 : 0.55), t)
      up = !up
    }
  } else if (inst.sustain) {
    gp.setTargetAtTime(o.peak * 0.7, o.at + a, o.dur * 0.6)
  }
  const tail = inst.sustain ? 0.18 : 0.06
  gp.setTargetAtTime(0, o.at + o.dur, tail)
  src.start(o.at, 0)
  src.stop(o.at + o.dur + tail * 6)
  env.markUsed?.(inst.s.sourceIdx, inst.s.start, inst.s.start + len)
}

/** what each section does: [lead, counter, ostinato, bell] presence, gaps, distance, tempo stretch */
const SECTION = [
  { on: [0, 0, 0.3, 0], gaps: 0.15, far: 0.85, slow: 1 },
  { on: [0.65, 0, 0.8, 0.4], gaps: 0.35, far: 0.55, slow: 1 },
  { on: [1, 1, 1, 0.8], gaps: 0, far: 0, slow: 1 },
  { on: [0.75, 0.6, 0.45, 1], gaps: 0.45, far: 0.45, slow: 1.25 },
]
const FREE_SEC = { on: [0.85, 0.7, 0.8, 0.6], gaps: 0.1, far: 0.2, slow: 1 }

export function* linesLane(env: LayerEnv): Generator<number, void, void> {
  // × 0.6: measured, the lines otherwise sit ~8 dB over the rest of the weave in THE MEMORY; now ~4 dB — in front, not on top
  const amt = (env.params.lines ?? 0) * 0.6
  const want0 = env.params.lines ?? 0
  const inst = lineInstruments(env.slices, env.sources)
  if (!inst.lead) return
  const seed = (env.params.motifSeed || 1) * 31 + 5
  const prng = mulberry32(seed) // the composition: same seed → same tune
  const rng = mulberry32(env.seed + 8128) // the performance
  const mode = MODES[Math.floor(prng() * MODES.length)]
  const steps = mode.steps
  // how many lines, by amount
  const want = { lead: true, ostinato: want0 > 0.02, counter: want0 > 0.45, bell: want0 > 0.7 }
  let per = period(prng, env.params.motifSeed || 1, steps.length)
  let periodN = 0
  let t = env.start + 2 + rng() * 2
  while (t < env.end) {
    const sec = env.sectionAt(t)
    const S = sec < 0 ? FREE_SEC : SECTION[sec]
    // every third period: a new tune grown from the old one (a memory revised)
    if (periodN > 0 && periodN % 3 === 0) per = period(prng, env.params.motifSeed || 1, steps.length)
    const beat = BEAT * S.slow * (sec === 3 ? 1 + Math.min(0.3, periodN * 0.04) : 1)
    for (let p = 0; p < per.length && t < env.end; p++) {
      const ph = per[p]
      const s0 = env.sectionAt(t)
      const SS = s0 < 0 ? FREE_SEC : SECTION[s0]
      const far = SS.far
      const lp = 900 + 8000 * (1 - far)
      const chordAt = (b: number) => env.chordAt(t + b * beat)
      // LEAD
      let prevHz = 0
      if (want.lead && SS.on[0] > 0 && rng() < 0.4 + SS.on[0] * 0.6) {
        for (const n of ph) {
          if (n.beat > 0 && rng() < SS.gaps) { prevHz = 0; continue } // a gap in the memory
          const strong = n.beat % 2 === 0
          const deg = strong ? toChord(env.keyRoot, steps, n.deg, chordAt(n.beat)) : n.deg
          const hz = degHz(env.keyRoot, steps, deg, 0)
          const dur = Math.min(2.6, n.beats * beat * 0.95)
          play(env, rng, inst.lead, {
            at: t + n.beat * beat + (rng() - 0.5) * 0.02, hz, dur,
            peak: 0.52 * amt * SS.on[0] * (1 - far * 0.5) * (strong ? 1 : 0.85),
            pan: -0.15 + (rng() - 0.5) * 0.2, lp, send: 0.3 + far * 0.5,
            glideFrom: n.glide && prevHz ? prevHz : undefined,
            reverse: s0 === 3 && rng() < 0.15,
          })
          prevHz = hz
        }
      }
      // COUNTER: half notes on chord 3rds / 7ths, moving against the lead
      if (want.counter && inst.counter && SS.on[1] > 0) {
        let deg = -2
        for (let b = 0; b < 8; b += 2) {
          if (rng() < SS.gaps * 0.8) continue
          const leadNow = ph.find((n) => n.beat <= b && n.beat + n.beats > b)
          const leadNext = ph.find((n) => n.beat > b)
          const dir = leadNext && leadNow ? Math.sign(leadNext.deg - leadNow.deg) : 0
          deg = toChord(env.keyRoot, steps, deg - dir * (1 + Math.floor(rng() * 2)), chordAt(b))
          deg = Math.max(-5, Math.min(2, deg))
          play(env, rng, inst.counter, {
            at: t + b * beat, hz: degHz(env.keyRoot, steps, deg, -1), dur: 2 * beat * 0.96,
            peak: 0.3 * amt * SS.on[1] * (1 - far * 0.5), pan: 0.3, lp: lp * 0.7, send: 0.45 + far * 0.4,
          })
        }
      }
      // OSTINATO: the chord broken in eighths, a bar pattern, motor tremolo
      if (want.ostinato && inst.ostinato && SS.on[2] > 0) {
        const shape = [0, 2, 1, 3, 2, 1, 0, 2]
        for (let b = 0; b < 8; b += 0.5) {
          if (rng() < 0.18 + SS.gaps * 0.5) continue
          const ch = chordAt(b)
          const tones = ch ? ch.semis : [0, 4, 7, 11]
          const k = shape[(b * 2) % shape.length] % tones.length
          const hz = C4 * Math.pow(2, (env.keyRoot + tones[k]) / 12)
          play(env, rng, inst.ostinato, {
            at: t + b * beat, hz, dur: Math.min(1.1, beat * 1.4),
            peak: 0.2 * amt * SS.on[2] * (b % 2 === 0 ? 1 : 0.7) * (1 - far * 0.4),
            pan: 0.45 * Math.sin(b * 0.8), lp: lp * 0.85, send: 0.4 + far * 0.4, tremolo: 5.2,
          })
        }
      }
      // BELL: the last two notes of the lead, an octave up, in the rest after it
      if (want.bell && inst.bell && SS.on[3] > 0 && p % 2 === 1 && rng() < 0.75) {
        const tailNotes = ph.slice(-2)
        tailNotes.forEach((n, i) => {
          const at = t + 8 * beat - 1.2 * beat + i * beat * 0.75
          play(env, rng, inst.bell!, {
            at, hz: degHz(env.keyRoot, steps, n.deg, 1), dur: 1.4,
            peak: 0.16 * amt * SS.on[3], pan: 0.6 - i * 1.1, lp: 6000, send: 0.85, tremolo: 4.4,
            reverse: s0 === 3 && rng() < 0.3,
          })
        })
      }
      t += 8 * beat
      yield t
    }
    periodN++
    // between periods a breath — longer when the memory fades
    t += (sec === 2 ? 0.5 : sec === 3 ? 4 + rng() * 6 : 2 + rng() * 3) * beat
    yield t
  }
}

export const modeOf = (motifSeed: number) => MODES[Math.floor(mulberry32((motifSeed || 1) * 31 + 5)() * MODES.length)].name
