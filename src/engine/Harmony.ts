import { SCALES } from './types'
import type { ScaleName, Slice } from './types'

/**
 * The harmonic "now": a chord clock every voice obeys. Chords are stacked
 * thirds (7th chords) inside the active scale, arranged into a slow
 * progression with a cadence; everything sounding at any moment belongs to
 * the same chord, and changes happen together.
 */

export interface Chord {
  /** absolute pitch classes (0–11) of the chord tones */
  pcs: number[]
  /** chord tones as semitone offsets from the key root, ascending */
  semis: number[]
  /** dominant-function chord — tension before the resolution */
  isCadence: boolean
  name: string
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** progression as scale-degree indices; last entry is the cadence */
const PROGRESSION_DEGREES: Record<string, number[]> = {
  seven: [0, 5, 3, 4], // i — VI — iv — V(cadence) in scale-index space
  penta: [0, 3, 1, 4],
  two: [0, 1, 0, 1],
}

function stackChord(pcsOfScale: number[], degree: number, tones: number): number[] {
  const n = pcsOfScale.length
  const out: number[] = []
  for (let k = 0; k < tones; k++) {
    const idx = (degree + k * 2) % n
    const octaves = Math.floor((degree + k * 2) / n) * 12
    out.push(pcsOfScale[idx] + octaves)
  }
  return out
}

export function makeProgression(scale: ScaleName, root: number): Chord[] {
  const pcs = SCALES[scale === 'free' ? 'pentatonic' : scale] ?? [0, 2, 4, 7, 9]
  const degrees =
    pcs.length >= 7 ? PROGRESSION_DEGREES.seven :
    pcs.length >= 5 ? PROGRESSION_DEGREES.penta :
    PROGRESSION_DEGREES.two
  return degrees.map((d, i) => {
    const semis = stackChord(pcs, d, Math.min(4, pcs.length))
    const abs = semis.map((s) => (((root + s) % 12) + 12) % 12)
    const rootName = NOTE_NAMES[abs[0]]
    // rough quality label from the third
    const third = ((semis[1] ?? 4) - semis[0] + 24) % 12
    const quality = third === 3 ? 'm7' : third === 4 ? 'maj7' : '7'
    return {
      pcs: [...new Set(abs)],
      semis,
      isCadence: i === degrees.length - 1,
      name: `${rootName}${quality}`,
    }
  })
}

/** Which chord is sounding at time t (seconds since the clock started). */
export function chordAt(progression: Chord[], periodSec: number, t: number): Chord {
  const i = Math.floor(Math.max(0, t) / periodSec) % progression.length
  return progression[i]
}

/**
 * Rate multiplier that snaps a pitched slice onto the nearest chord tone
 * (falls back to 1 for unpitched material).
 */
export function chordCorrection(
  pitch: number | null,
  confidence: number,
  chord: Chord,
): number {
  if (!pitch || confidence < 0.35) return 1
  const semisFromC = 12 * Math.log2(pitch / 261.626)
  const nearestSemi = Math.round(semisFromC)
  const pc = ((nearestSemi % 12) + 12) % 12
  let best = 0
  let bestAbs = Infinity
  for (const target of chord.pcs) {
    for (const off of [-12, 0, 12]) {
      const delta = target + off - pc
      if (Math.abs(delta) < bestAbs) {
        bestAbs = Math.abs(delta)
        best = delta
      }
    }
  }
  return Math.pow(2, (nearestSemi - semisFromC + best) / 12)
}

/** How well a slice's chroma fits the chord (0–1). */
export function chordFit(chroma: number[] | undefined, chord: Chord): number {
  if (!chroma || chroma.length !== 12) return 0.5
  let inChord = 0
  let total = 0
  for (let pc = 0; pc < 12; pc++) {
    total += chroma[pc]
    if (chord.pcs.includes(pc)) inChord += chroma[pc]
  }
  return total > 1e-6 ? inChord / total : 0.5
}

/** Cosine similarity between two slice chromas (voice-leading continuity). */
export function chromaSim(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b || a.length !== 12 || b.length !== 12) return 0.5
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < 12; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const d = Math.sqrt(na * nb)
  return d > 1e-9 ? dot / d : 0.5
}

/**
 * Voice leading: move each pad voice to its nearest tone of the new chord
 * (semitone offsets from key root, may span octaves).
 */
export function voiceLead(prev: number[] | null, chord: Chord): number[] {
  const targets = chord.semis
  if (!prev || prev.length === 0) {
    return targets.slice(0, 4).map((s, i) => s + (i >= 2 ? 0 : 0))
  }
  return prev.map((p) => {
    let best = targets[0]
    let bestD = Infinity
    for (const t of targets) {
      for (const oct of [-12, 0, 12]) {
        const cand = t + oct
        if (Math.abs(cand - p) < bestD) {
          bestD = Math.abs(cand - p)
          best = cand
        }
      }
    }
    return best
  })
}

/** Estimated semitone position of a slice (from C4); root fallback. */
export function sliceSemi(slice: Slice, root: number): number {
  if (slice.pitch && slice.pitchConfidence >= 0.35) {
    return Math.round(12 * Math.log2(slice.pitch / 261.626))
  }
  return root
}

// ---------- motif engine (melody voice) ----------

export interface Motif {
  /** beat offsets within the 2-bar phrase */
  beats: number[]
  /** scale-degree indices (may exceed scale length for octaves) */
  degrees: number[]
}

export interface MelodyNote {
  beat: number
  /** absolute semitone offset from key root */
  semi: number
  lengthBeats: number
}

/** Scale degree index → semitone offset from root (octave-aware). */
function degreeSemi(pcs: number[], deg: number): number {
  const n = pcs.length
  const idx = ((deg % n) + n) % n
  const oct = Math.floor(deg / n) * 12
  return pcs[idx] + oct
}

/**
 * Motif-based phrase: mostly stepwise, one leap answered by a step back,
 * chord tones on strong beats, phrase ends on a chord tone. Returns the
 * motif so the next phrase can repeat-with-variation (what the ear reads
 * as melody).
 */
export function genMotifPhrase(
  scale: ScaleName,
  chord: Chord,
  rng: () => number,
  prev: Motif | null,
): { notes: MelodyNote[]; motif: Motif } {
  const pcs = SCALES[scale === 'free' ? 'pentatonic' : scale] ?? [0, 2, 4, 7, 9]
  const n = pcs.length

  let motif: Motif
  const mode = prev ? rng() : 1
  if (prev && mode < 0.55) {
    // vary: keep rhythm, nudge one or two pitches
    motif = { beats: [...prev.beats], degrees: [...prev.degrees] }
    const k = Math.floor(rng() * motif.degrees.length)
    motif.degrees[k] += rng() < 0.5 ? 1 : -1
    if (rng() < 0.4) {
      const k2 = Math.floor(rng() * motif.degrees.length)
      motif.degrees[k2] += rng() < 0.5 ? 1 : -1
    }
  } else if (prev && mode < 0.8) {
    // sequence: same shape shifted a scale step
    const shift = rng() < 0.5 ? 1 : -1
    motif = { beats: [...prev.beats], degrees: prev.degrees.map((d) => d + shift) }
  } else {
    // new motif: 4–6 onsets over 2 bars (8 beats)
    const count = 4 + Math.floor(rng() * 3)
    const gridPool = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5]
    const beats = [0]
    while (beats.length < count) {
      const b = gridPool[Math.floor(rng() * gridPool.length)]
      if (!beats.includes(b)) beats.push(b)
    }
    beats.sort((a, b) => a - b)
    // contour: start on a chord tone degree near the octave
    const chordDegrees = chord.semis.map((s) =>
      pcs.findIndex((p) => p === ((s % 12) + 12) % 12),
    ).filter((d) => d >= 0)
    let deg = (chordDegrees[Math.floor(rng() * chordDegrees.length)] ?? 0) + n // one octave up
    const degrees = [deg]
    let leapUsed = false
    for (let i = 1; i < beats.length; i++) {
      let step: number
      if (!leapUsed && rng() < 0.22) {
        step = (rng() < 0.5 ? 1 : -1) * (3 + Math.floor(rng() * 2))
        leapUsed = true
      } else {
        step = rng() < 0.5 ? 1 : -1
        if (leapUsed) {
          // answer the leap by stepping back toward it
          step = degrees[i - 1] > degrees[0] ? -1 : 1
          leapUsed = false
        }
      }
      deg = Math.max(n - 2, Math.min(2 * n + 3, deg + step))
      degrees.push(deg)
    }
    motif = { beats, degrees }
  }

  // realize: strong beats snap to chord tones, last note always lands on one
  const notes: MelodyNote[] = motif.beats.map((beat, i) => {
    let semi = degreeSemi(pcs, motif.degrees[i])
    const strong = beat % 2 === 0 || i === motif.beats.length - 1
    if (strong) {
      let best = semi
      let bestD = Infinity
      for (const cs of chord.semis) {
        for (const oct of [0, 12, 24]) {
          const cand = cs + oct
          if (Math.abs(cand - semi) < bestD) {
            bestD = Math.abs(cand - semi)
            best = cand
          }
        }
      }
      semi = best
    }
    const next = motif.beats[i + 1]
    return { beat, semi, lengthBeats: Math.min(next !== undefined ? next - beat : 1.5, 2) }
  })
  return { notes, motif }
}
