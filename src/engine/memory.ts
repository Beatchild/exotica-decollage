import type { AudioEngine } from './AudioEngine'
import type { Scene, Slice, SongSection } from './types'

/**
 * MEMORY WEAVE — one haunted, tonal track out of many sources.
 *
 * 1 · GATHER: from every source, the warmest, most clearly pitched fragments
 *     (a few each, so every source has a voice) become the pinned material.
 * 2 · TUNE: the key is read from those fragments only, so the pads, the melody
 *     line and the pitch-correction all agree with what the material already is.
 * 3 · FORM: four sections, morphing into each other —
 *     DUST (a room tone, the bed alone) → SURFACING (a line half-heard) →
 *     THE MEMORY (everything, warm and full) → DISSOLVING (worn, backwards, gone).
 *
 * The sections live in scene slots E–H, so the user's own A–D are untouched.
 */

export const MEMORY_SLOTS = [4, 5, 6, 7] as const

export const MEMORY_SECTIONS = [
  { key: 'dust', label: 'DUST', share: 0.18, line: 'room tone, the bed alone' },
  { key: 'surfacing', label: 'SURFACING', share: 0.24, line: 'a line half-heard' },
  { key: 'memory', label: 'THE MEMORY', share: 0.36, line: 'everything, warm and full' },
  { key: 'dissolving', label: 'DISSOLVING', share: 0.22, line: 'worn, backwards, gone' },
] as const

export interface MemoryGroup {
  sourceIdx: number
  name: string
  ids: number[]
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v))

/** How "rememberable" a fragment is: pitched, warm, long enough, not a click. */
function tonalScore(s: Slice): number {
  let sc = 0
  if (s.pitch && s.pitch > 55 && s.pitch < 1400) sc += s.pitchConfidence * 1.4
  if (s.category === 'harmonic') sc += 0.6
  else if (s.category === 'texture') sc += 0.15
  else sc -= 0.4
  // warmth: a soft centroid reads as "old", a hissy one as noise
  const c = s.centroid
  if (c > 180 && c < 2200) sc += 0.4
  else if (c > 4500) sc -= 0.5
  sc += Math.min(0.4, s.duration * 0.5) // longer fragments carry a melody
  sc -= Math.max(0, s.attack - 0.6) * 0.5 // hard transients break the spell
  return sc
}

/**
 * Pick `perSource` tonal fragments from every (non-bed) source, spread across
 * each source's length, plus one soft texture each for air. Returns the groups;
 * does not change the engine.
 */
export function gatherMemories(engine: AudioEngine, perSourceBase = 6, weights: Record<number, number> = {}): MemoryGroup[] {
  const groups: MemoryGroup[] = []
  engine.sources.forEach((src, si) => {
    if (src.bed) return
    // per-source weight: 0 = leave this source out, 2 = twice as many fragments
    const w = weights[si] ?? 1
    const perSource = Math.round(perSourceBase * w)
    if (perSource <= 0) return
    const own = engine.slices.filter((s) => s.sourceIdx === si)
    if (own.length === 0) return
    // ignore near-silent slices (bottom 15% of this source's loudness)
    const rmsSorted = own.map((s) => s.rms).sort((a, b) => a - b)
    const floor = rmsSorted[Math.floor(rmsSorted.length * 0.15)] ?? 0
    const audible = own.filter((s) => s.rms >= floor && s.rms > 0.004)
    const ranked = [...audible].sort((a, b) => tonalScore(b) - tonalScore(a))
    const picked: Slice[] = []
    // not two fragments from the same moment: keep them apart in time
    const gap = Math.max(0.6, src.buffer.duration / (perSource * 3))
    for (const s of ranked) {
      if (picked.length >= perSource) break
      if (tonalScore(s) < 0.2 && picked.length >= 2) break
      if (picked.some((p) => Math.abs(p.start - s.start) < gap)) continue
      picked.push(s)
    }
    const air = perSource < 2 ? undefined : ranked.find((s) => s.category === 'texture' && !picked.includes(s) && s.centroid < 3500)
    if (air) picked.push(air)
    if (picked.length) groups.push({ sourceIdx: si, name: src.name, ids: picked.map((s) => s.id) })
  })
  return groups
}

/** Pitch class (0–11, C = 0) the given fragments agree on most. */
export function keyOf(slices: Slice[]): number {
  const w = new Array(12).fill(0)
  for (const s of slices) {
    if (s.chroma && s.chroma.length === 12) {
      s.chroma.forEach((v, i) => (w[i] += v * (0.5 + s.pitchConfidence)))
    }
    if (s.pitch && s.pitchConfidence > 0.3) {
      const pc = ((Math.round(12 * Math.log2(s.pitch / 261.626)) % 12) + 12) % 12
      w[pc] += s.pitchConfidence * 1.5
    }
  }
  // a pentatonic/major key fits its 1·5·4 degrees too: score candidate roots
  const score = (r: number) => w[r] * 1 + w[(r + 7) % 12] * 0.6 + w[(r + 4) % 12] * 0.4 + w[(r + 9) % 12] * 0.3
  let best = 0
  for (let r = 1; r < 12; r++) if (score(r) > score(best)) best = r
  return best
}

/** Section lengths (seconds) for a track of `minutes`. */
export function memorySections(minutes: number): SongSection[] {
  const total = Math.max(40, minutes * 60)
  const secs = MEMORY_SECTIONS.map((s) => Math.max(8, Math.round(total * s.share)))
  secs[3] += Math.round(total) - secs.reduce((a, b) => a + b, 0) // exact total
  return secs.map((sec, i) => ({ scene: MEMORY_SLOTS[i], sec: Math.max(8, sec) }))
}

/** Re-time section lengths to `minutes`, keeping their proportions. */
export function scaleSections(secs: number[], minutes: number): SongSection[] {
  const total = Math.max(40, minutes * 60)
  const sum = secs.reduce((x, y) => x + y, 0) || 1
  const out = secs.map((x) => Math.max(8, Math.round((x / sum) * total)))
  out[3] = Math.max(8, out[3] + Math.round(total) - out.reduce((x, y) => x + y, 0))
  return out.map((sec, i) => ({ scene: MEMORY_SLOTS[i], sec }))
}

/**
 * Build the four section scenes from the engine's current (mood-applied)
 * state and install them in slots E–H with a song sequence of `minutes`.
 * Voices: 0 bed · 1 plunder · 2 decays · 3 surface · 4 microloop · 5 sub · 6 melody.
 */
export function buildMemoryForm(engine: AudioEngine, minutes: number) {
  const base = engine.captureScene()
  const mk = (edit: (s: Scene) => void): Scene => {
    const s: Scene = {
      ...base,
      macros: { ...base.macros },
      voices: base.voices.map((v) => ({ ...v })),
    }
    edit(s)
    return s
  }
  const v = (s: Scene, i: number, p: Partial<Scene['voices'][number]>) => {
    if (s.voices[i]) Object.assign(s.voices[i], p)
  }
  const lvl = (i: number) => base.voices[i]?.level ?? 0.5
  const den = (i: number) => base.voices[i]?.density ?? 0.3

  const dust = mk((s) => {
    v(s, 0, { level: lvl(0) * 0.5, density: den(0) * 0.5, mute: false })
    v(s, 1, { mute: true })
    v(s, 2, { level: lvl(2) * 0.4, density: den(2) * 0.35 })
    v(s, 3, { level: lvl(3) * 0.7, mute: false })
    v(s, 4, { mute: true })
    v(s, 5, { mute: true })
    v(s, 6, { mute: true })
    s.macros.tapeAging = clamp(base.macros.tapeAging + 0.1)
    s.bpm = Math.round(base.bpm * 0.92)
  })
  const surfacing = mk((s) => {
    v(s, 0, { level: lvl(0) * 0.8 })
    v(s, 1, { mute: true })
    v(s, 3, { level: lvl(3) * 0.8 })
    v(s, 4, { level: lvl(4) * 0.8, mute: false })
    v(s, 5, { level: lvl(5) * 0.6 })
    v(s, 6, { level: lvl(6) * 0.6, density: den(6) * 0.6, mute: false })
    s.macros.tapeAging = clamp(base.macros.tapeAging + 0.1)
  })
  const memory = mk((s) => {
    v(s, 0, { level: clamp(lvl(0) * 1.15), density: clamp(den(0) * 1.2) })
    v(s, 2, { level: clamp(lvl(2) * 1.25), density: clamp(den(2) * 1.3) })
    v(s, 3, { level: lvl(3) * 0.7 })
    v(s, 5, { mute: false, level: Math.max(0.3, lvl(5)) })
    v(s, 6, { mute: false, level: clamp(Math.max(0.5, lvl(6) * 1.15)), density: clamp(Math.max(0.3, den(6) * 1.25)) })
    v(s, 4, { mute: false })
  })
  const dissolving = mk((s) => {
    v(s, 0, { level: lvl(0) * 0.45, density: den(0) * 0.45 })
    v(s, 1, { mute: true })
    v(s, 2, { level: lvl(2) * 0.4, density: den(2) * 0.4 })
    v(s, 3, { level: lvl(3) * 0.5 }) // tape age already lifts the hiss
    v(s, 4, { level: lvl(4) * 0.4, density: den(4) * 0.5 })
    v(s, 5, { mute: true })
    v(s, 6, { mute: true })
    // worn, not louder: more tape age, the same room (longer decays pile up energy)
    s.macros.tapeAging = clamp(base.macros.tapeAging + 0.25)
    s.macros.chaos = clamp(base.macros.chaos + 0.1)
    s.bpm = Math.round(base.bpm * 0.85)
  })
  // a form the user has re-proportioned keeps its proportions
  const prev = isMemoryForm(engine) ? engine.songSections.map((x) => x.sec) : null
  ;[dust, surfacing, memory, dissolving].forEach((s, i) => (engine.scenes[MEMORY_SLOTS[i]] = s))
  engine.songSections = prev ? scaleSections(prev, minutes) : memorySections(minutes)
}

/** True when the engine's song is a MEMORY WEAVE form. */
export function isMemoryForm(engine: AudioEngine): boolean {
  const s = engine.songSections
  return s.length === 4 && s.every((x, i) => x.scene === MEMORY_SLOTS[i])
}

/** Remove the memory form (leaves the user's own scenes A–D alone). */
export function clearMemoryForm(engine: AudioEngine) {
  if (!isMemoryForm(engine)) return
  engine.stopSong()
  engine.songSections = []
  for (const slot of MEMORY_SLOTS) engine.scenes[slot] = null
}
