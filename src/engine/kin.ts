import type { Era } from './eras'
import { mulberry32 } from './rng'
import type { Slice } from './types'
import type { LayerEnv } from './memoryLayers'
import { region, snapRate, voiceOut } from './memoryLayers'

/**
 * TEXTURE KIN — the same texture, found in many different recordings, woven
 * into one dramatic line.
 *
 * 1 · FINGERPRINT every fragment (brightness, noise, attack, length, pitch
 *     clarity) and group the whole pool — across all sources — into FAMILIES
 *     of kin: fragments that sound alike, wherever they came from.
 * 2 · BALANCE: every family takes a few of the most typical fragments from
 *     each source that has them, so ten sources really mix and none drowns
 *     the others.
 * 3 · STAGE: a dramatic arc (acts + a tension curve) decides who speaks when:
 *     one source alone, a gesture handed from source to source (one voice,
 *     ten mouths), two families answering each other, and at the peak every
 *     source saying the same thing at once. Tension drives density,
 *     brightness, register and how far the intervals stray.
 *
 * The plan lives in the memory layers (`kin`), so it renders, stems, saves in
 * the patch and goes into album tracks like everything else.
 */

// ---------- fingerprint & families ----------

export interface KinFamily {
  name: string
  line: string
  /** slice ids, balanced across sources */
  ids: number[]
  /** sources with at least one fragment in this family */
  sources: number[]
  /** fragments per source */
  perSource: Record<number, number>
  /** feature-space centre (normalized) */
  centre: number[]
  /** mean distance to the centre: lower = more alike */
  spread: number
  /** raw mean features for naming / colour */
  bright: number
  noise: number
  tonal: number
  attack: number
  dur: number
  medianRms: number
}

const FEATS = 5
function raw(s: Slice): number[] {
  return [
    Math.log(Math.max(60, s.centroid)), // brightness
    Math.log1p(Math.max(0, s.zcr)), // noisiness (zero crossings: a count, wide range)
    Math.log1p(Math.min(6, Math.max(0, s.attack))), // how struck
    Math.log(Math.max(0.05, s.duration)), // length
    s.pitch ? s.pitchConfidence : 0, // pitch clarity
  ]
}
const WEIGHT = [1.3, 1, 0.8, 0.7, 1.1]

const dist = (a: number[], b: number[]) => {
  let d = 0
  for (let i = 0; i < FEATS; i++) d += WEIGHT[i] * (a[i] - b[i]) ** 2
  return Math.sqrt(d)
}

function nameFamily(bright: number, noise: number, tonal: number, attack: number, dur: number): { name: string; line: string } {
  const hz = Math.exp(bright)
  const tone = hz < 700 ? 'DARK' : hz < 1700 ? 'WARM' : hz < 3800 ? 'BRIGHT' : 'GLASS'
  let body: string
  let line: string
  const struck = attack > Math.log1p(1.2)
  const noisy = noise > Math.log1p(50)
  if (tonal > 0.5 && !struck) { body = dur > Math.log(0.5) ? 'SINGING' : 'TONES'; line = 'pitched, held — a voice or a string' }
  else if (struck) { body = hz > 2500 ? 'SPARKS' : 'KNOCKS'; line = 'struck, short — a touch, a click, a hit' }
  else if (noisy) { body = hz > 3000 ? 'HISS' : 'RUSTLE'; line = 'noisy, grainy — air, paper, static' }
  else if (dur > Math.log(0.6)) { body = 'BREATH'; line = 'long and soft — a swell, a room, a breath' }
  else { body = 'HUM'; line = 'soft, unpitched — a hum, a murmur' }
  return { name: `${tone} ${body}`, line }
}

/**
 * Group every usable fragment of every (non-bed) source into texture
 * families. Deterministic for a given seed. `perSource` caps how many
 * fragments one source gives each family (× its weight; 0 = left out).
 */
export function findFamilies(
  slices: Slice[],
  sources: Array<{ bed?: boolean; buffer: AudioBuffer }>,
  seed: number,
  perSource = 5,
  weights: Record<number, number> = {},
): KinFamily[] {
  // usable: not a bed, not near-silent for its source, weight > 0
  const bySrc = new Map<number, Slice[]>()
  for (const s of slices) {
    if (sources[s.sourceIdx]?.bed || (weights[s.sourceIdx] ?? 1) <= 0) continue
    const a = bySrc.get(s.sourceIdx) ?? []
    a.push(s)
    bySrc.set(s.sourceIdx, a)
  }
  const pool: Slice[] = []
  for (const own of bySrc.values()) {
    const r = own.map((s) => s.rms).sort((x, y) => x - y)
    const floor = r[Math.floor(r.length * 0.15)] ?? 0
    for (const s of own) if (s.rms >= floor && s.rms > 0.004) pool.push(s)
  }
  if (pool.length < 6) return []
  // z-score the features over the pool
  const X = pool.map(raw)
  const mean = new Array(FEATS).fill(0)
  const sd = new Array(FEATS).fill(0)
  for (const x of X) x.forEach((v, i) => (mean[i] += v / X.length))
  for (const x of X) x.forEach((v, i) => (sd[i] += (v - mean[i]) ** 2 / X.length))
  const Z = X.map((x) => x.map((v, i) => (v - mean[i]) / (Math.sqrt(sd[i]) || 1)))

  // k-means++ (seeded)
  const rng = mulberry32(seed * 13 + 7)
  const k = Math.max(3, Math.min(8, Math.round(Math.sqrt(pool.length / 5))))
  const C: number[][] = [Z[Math.floor(rng() * Z.length)]]
  while (C.length < k) {
    const d2 = Z.map((z) => Math.min(...C.map((c) => dist(z, c))) ** 2)
    const sum = d2.reduce((a, b) => a + b, 0) || 1
    let r = rng() * sum
    let pick = 0
    for (; pick < d2.length - 1; pick++) if ((r -= d2[pick]) <= 0) break
    C.push([...Z[pick]])
  }
  const asg = new Array(Z.length).fill(0)
  for (let it = 0; it < 30; it++) {
    let moved = 0
    Z.forEach((z, i) => {
      let best = 0
      let bd = Infinity
      C.forEach((c, j) => {
        const d = dist(z, c)
        if (d < bd) { bd = d; best = j }
      })
      if (asg[i] !== best) { asg[i] = best; moved++ }
    })
    for (let j = 0; j < k; j++) {
      const m = Z.filter((_, i) => asg[i] === j)
      if (m.length) C[j] = C[j].map((_, f) => m.reduce((n, z) => n + z[f], 0) / m.length)
    }
    if (moved === 0 && it > 2) break
  }

  const out: KinFamily[] = []
  for (let j = 0; j < k; j++) {
    const members = pool.map((s, i) => ({ s, z: Z[i], x: X[i] })).filter((_, i) => asg[i] === j)
    if (members.length < 3) continue
    // balanced: the most typical few from each source, spread in time
    const ids: number[] = []
    const per: Record<number, number> = {}
    const srcIds = [...new Set(members.map((m) => m.s.sourceIdx))].sort((a, b) => a - b)
    for (const si of srcIds) {
      const cap = Math.round(perSource * (weights[si] ?? 1))
      if (cap <= 0) continue
      const own = members.filter((m) => m.s.sourceIdx === si).sort((a, b) => dist(a.z, C[j]) - dist(b.z, C[j]))
      const got: Slice[] = []
      const dur = sources[si]?.buffer.duration ?? 60
      const gap = Math.max(0.4, dur / (cap * 4))
      for (const m of own) {
        if (got.length >= cap) break
        if (got.some((g) => Math.abs(g.start - m.s.start) < gap)) continue
        got.push(m.s)
      }
      if (got.length) {
        ids.push(...got.map((s) => s.id))
        per[si] = got.length
      }
    }
    if (ids.length < 3) continue
    const chosen = members.filter((m) => ids.includes(m.s.id))
    // typical values: medians (a few outliers must not rename a family)
    const avg = (f: number) => {
      const v = chosen.map((m) => m.x[f]).sort((a, b) => a - b)
      return v[Math.floor(v.length / 2)]
    }
    const rmsSorted = chosen.map((m) => m.s.rms).sort((a, b) => a - b)
    const fam = {
      ids,
      sources: Object.keys(per).map(Number),
      perSource: per,
      centre: C[j],
      spread: chosen.reduce((n, m) => n + dist(m.z, C[j]), 0) / chosen.length,
      bright: avg(0), noise: avg(1), attack: avg(2), dur: avg(3), tonal: avg(4),
      medianRms: rmsSorted[Math.floor(rmsSorted.length / 2)] ?? 0.05,
    }
    out.push({ ...fam, ...nameFamily(fam.bright, fam.noise, fam.tonal, fam.attack, fam.dur) })
  }
  // most sources first, then the most alike
  out.sort((a, b) => b.sources.length - a.sources.length || a.spread - b.spread)
  // distinct names
  const seen = new Map<string, number>()
  for (const f of out) {
    const n = (seen.get(f.name) ?? 0) + 1
    seen.set(f.name, n)
    if (n > 1) f.name = `${f.name} ${'ⅠⅡⅢⅣⅤⅥⅦⅧ'[n - 1]}`
  }
  return out
}

/** The family that contrasts most with `main` while still spanning sources. */
export function contrastOf(fams: KinFamily[], main: number, avoid: number[] = []): number {
  let best = -1
  let bs = -Infinity
  fams.forEach((f, i) => {
    if (i === main || avoid.includes(i)) return
    // far away in sound first; spanning sources second (one-source families only as a last resort)
    const cover = Math.min(1, f.sources.length / Math.max(1, fams[main].sources.length))
    const sc = dist(f.centre, fams[main].centre) * (0.8 + 0.2 * cover) * (f.sources.length >= 2 ? 1 : 0.4)
    if (sc > bs) { bs = sc; best = i }
  })
  return best
}

// ---------- dramaturgy ----------

/** speak: one source at a time, the gesture handed on · dialog: two families answer · chorus: everyone · lone: one source, alone */
export type ActMode = 'speak' | 'dialog' | 'chorus' | 'lone'

export interface KinAct {
  label: string
  share: number
  mode: ActMode
  /** roles: 0 = main family, 1 = contrast, 2 = third; first = who leads */
  fams: number[]
}

export interface KinArc {
  key: string
  label: string
  line: string
  acts: KinAct[]
  tension: number[]
  /** the four form sections (DUST · SURFACING · THE MEMORY · DISSOLVING) as shares */
  sections: [number, number, number, number]
}

export const KIN_ARCS: KinArc[] = [
  {
    key: 'classic', label: 'CLASSIC', line: 'exposition → rising → climax → falling → coda',
    acts: [
      { label: 'EXPOSITION', share: 0.18, mode: 'speak', fams: [0] },
      { label: 'RISING', share: 0.27, mode: 'dialog', fams: [0, 1] },
      { label: 'CLIMAX', share: 0.2, mode: 'chorus', fams: [0, 1, 2] },
      { label: 'FALLING', share: 0.2, mode: 'dialog', fams: [1, 0] },
      { label: 'CODA', share: 0.15, mode: 'lone', fams: [0] },
    ],
    tension: [0.12, 0.22, 0.4, 0.62, 0.95, 1, 0.55, 0.3, 0.12, 0.04],
    sections: [0.18, 0.27, 0.2, 0.35],
  },
  {
    key: 'waves', label: 'TWO WAVES', line: 'a first wave, a valley, a bigger second wave, coda',
    acts: [
      { label: 'EXPOSITION', share: 0.14, mode: 'speak', fams: [0] },
      { label: 'FIRST WAVE', share: 0.24, mode: 'dialog', fams: [0, 1] },
      { label: 'VALLEY', share: 0.14, mode: 'speak', fams: [2, 1] },
      { label: 'SECOND WAVE', share: 0.28, mode: 'chorus', fams: [0, 1, 2] },
      { label: 'CODA', share: 0.2, mode: 'lone', fams: [0] },
    ],
    tension: [0.1, 0.45, 0.75, 0.35, 0.2, 0.55, 0.9, 1, 0.35, 0.05],
    sections: [0.14, 0.38, 0.28, 0.2],
  },
  {
    key: 'slowburn', label: 'SLOW BURN', line: 'one source alone, slowly joined by all — a late peak, a sudden end',
    acts: [
      { label: 'ALONE', share: 0.22, mode: 'lone', fams: [0] },
      { label: 'GATHERING', share: 0.4, mode: 'speak', fams: [0, 1] },
      { label: 'ALL AT ONCE', share: 0.18, mode: 'chorus', fams: [0, 1, 2] },
      { label: 'AFTER', share: 0.2, mode: 'lone', fams: [1] },
    ],
    tension: [0.05, 0.1, 0.18, 0.28, 0.4, 0.55, 0.72, 0.92, 1, 0.12],
    sections: [0.22, 0.4, 0.18, 0.2],
  },
  {
    key: 'fading', label: 'FADING CHOIR', line: 'everyone at once, then fewer and fewer — one voice left',
    acts: [
      { label: 'CHOIR', share: 0.26, mode: 'chorus', fams: [0, 1] },
      { label: 'THINNING', share: 0.28, mode: 'dialog', fams: [0, 1] },
      { label: 'ECHOES', share: 0.26, mode: 'speak', fams: [1, 0] },
      { label: 'LAST VOICE', share: 0.2, mode: 'lone', fams: [0] },
    ],
    tension: [0.75, 1, 0.85, 0.65, 0.5, 0.38, 0.26, 0.16, 0.08, 0.02],
    sections: [0.08, 0.18, 0.34, 0.4],
  },
]

export const arcByKey = (k: string) => KIN_ARCS.find((a) => a.key === k) ?? KIN_ARCS[0]

/** What the kin lane plays: stored in the memory layers (and so in patches). */
export interface KinPlan {
  amt: number
  arc: string
  /** tension points, evenly spaced over the piece (the arc's own, or drawn) */
  tension: number[]
  acts: KinAct[]
  /** fragment ids per role: [main, contrast, third] */
  families: number[][]
  names: string[]
  /** 0 = every phrase a new gesture · 1 = one gesture handed through every source */
  relay: number
  /** 0 = at most three at once · 1 = at the peak every source together */
  chorus: number
  /** per family role: the median loudness the fragments are evened to */
  levels: number[]
}

export function makePlan(fams: KinFamily[], roles: number[], arc: KinArc, o: Partial<Pick<KinPlan, 'amt' | 'relay' | 'chorus' | 'tension'>> = {}): KinPlan {
  const used = roles.filter((r) => r >= 0 && fams[r])
  return {
    amt: o.amt ?? 0.8,
    arc: arc.key,
    tension: o.tension ?? [...arc.tension],
    acts: arc.acts.map((a) => ({ ...a, fams: [...a.fams] })),
    families: used.map((r) => [...fams[r].ids]),
    names: used.map((r) => fams[r].name),
    relay: o.relay ?? 0.7,
    chorus: o.chorus ?? 0.85,
    levels: used.map((r) => fams[r].medianRms),
  }
}

/** Tension (0–1) at a fraction of the piece. */
export function tensionAt(curve: number[], f: number): number {
  if (curve.length === 0) return 0.5
  if (curve.length === 1) return curve[0]
  const x = Math.min(1, Math.max(0, f)) * (curve.length - 1)
  const i = Math.min(curve.length - 2, Math.floor(x))
  return curve[i] + (curve[i + 1] - curve[i]) * (x - i)
}

export function actAt(acts: KinAct[], f: number): { act: KinAct; index: number; from: number; to: number } {
  const sum = acts.reduce((n, a) => n + a.share, 0) || 1
  let acc = 0
  for (let i = 0; i < acts.length; i++) {
    const to = acc + acts[i].share / sum
    if (f < to || i === acts.length - 1) return { act: acts[i], index: i, from: acc, to }
    acc = to
  }
  return { act: acts[0], index: 0, from: 0, to: 1 }
}

// ---------- the lane ----------

interface Gesture {
  /** onset (s from phrase start), interval (semitones), length factor */
  notes: Array<{ t: number; semi: number; len: number }>
  dur: number
}

const CONSONANT = [0, 0, 7, 12, 5, -5, -12, 0]
const TENSE = [1, -1, 6, 11, -6, 13, 2]

function makeGesture(rng: () => number, T: number): Gesture {
  const n = 2 + Math.floor(rng() * (2 + T * 4)) // more notes when tense
  const step = 0.55 - T * 0.32 + rng() * 0.25 // and faster
  const notes: Gesture['notes'] = []
  let t = 0
  for (let i = 0; i < n; i++) {
    const tense = rng() < T * 0.35
    const semi = i === 0 ? 0 : (tense ? TENSE : CONSONANT)[Math.floor(rng() * (tense ? TENSE.length : CONSONANT.length))]
    notes.push({ t, semi, len: 0.7 + rng() * 0.9 })
    t += step * [1, 1, 0.5, 1.5, 2][Math.floor(rng() * 5)]
  }
  notes[n - 1].len *= 1.6 // the gesture lands
  return { notes, dur: t + 0.6 }
}

/** Song-time position (seconds into the form, and its length) at a context time. */
export type FormPos = (when: number) => { t: number; total: number } | null

const FREE_CYCLE = 240

export function* kinLane(env: LayerEnv): Generator<number, void, void> {
  const plan = env.params.kin
  if (!plan || plan.families.length === 0) return
  const byId = new Map(env.slices.map((s) => [s.id, s]))
  const fams = plan.families.map((ids) => ids.map((id) => byId.get(id)).filter((s): s is Slice => !!s && !!env.sources[s.sourceIdx]))
  if (fams.every((f) => f.length === 0)) return
  const srcOf = fams.map((f) => [...new Set(f.map((s) => s.sourceIdx))].sort((a, b) => a - b))
  // every source keeps one place in the stereo field: the choir stands still
  const allSrc = [...new Set(srcOf.flat())].sort((a, b) => a - b)
  const panOf = (si: number) => (allSrc.length <= 1 ? 0 : -0.75 + (1.5 * allSrc.indexOf(si)) / (allSrc.length - 1))
  // the lone voice: the source with the most kin in the main family
  const lone = (fi: number) => {
    const f = fams[fi] ?? []
    const c = new Map<number, number>()
    for (const s of f) c.set(s.sourceIdx, (c.get(s.sourceIdx) ?? 0) + 1)
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1
  }
  const rng = mulberry32(env.seed + 2718)
  const pos = (w: number) => {
    const p = env.formPos?.(w)
    if (p && p.total > 0) return { f: (p.t % p.total) / p.total, at: p.t % p.total, total: p.total }
    const tt = (w - env.start) % FREE_CYCLE
    return { f: tt / FREE_CYCLE, at: tt, total: FREE_CYCLE }
  }
  let gesture: Gesture | null = null
  let gestureUses = 0
  let speaker = 0
  let lastAct = -1
  let turn = 0
  let t = env.start + 1.5 + rng() * 2
  while (t < env.end) {
    const p = pos(t)
    const { act, index } = actAt(plan.acts, p.f)
    const T = tensionAt(plan.tension, p.f)
    if (index !== lastAct) { lastAct = index; gesture = null; turn = 0 }
    // which family speaks this phrase
    const roles = act.fams.filter((r) => fams[r]?.length)
    if (roles.length === 0) { t += 2; yield t; continue }
    const role = act.mode === 'dialog' ? roles[turn % roles.length] : roles[0]
    const srcs = srcOf[role]
    // a new gesture now and then; with RELAY it goes round every source first
    const keep = Math.max(1, Math.round(1 + plan.relay * (srcs.length - 1)))
    if (!gesture || gestureUses >= keep || (act.mode === 'dialog' && turn % 2 === 0 && rng() < 0.35)) {
      gesture = makeGesture(rng, T)
      gestureUses = 0
    }
    gestureUses++
    // who speaks
    let voices: number[]
    if (act.mode === 'lone') voices = [lone(role)].filter((x) => x >= 0)
    else if (act.mode === 'chorus') {
      const maxN = Math.max(1, Math.round(1 + T * plan.chorus * (srcs.length - 1)))
      voices = srcs.slice(0).sort(() => rng() - 0.5).slice(0, maxN)
      // and in the full chorus the other families sing along, quieter
      if (T > 0.7) for (const r of roles.slice(1)) voices.push(...srcOf[r].slice(0, Math.round(T * plan.chorus * 3)).map((si) => -1000 - r * 100 - si))
    } else {
      const n = Math.max(1, Math.min(3, Math.round(1 + T * 1.6)))
      voices = []
      for (let k = 0; k < n; k++) voices.push(srcs[(speaker + k) % srcs.length])
      speaker++
    }
    if (voices.length === 0) { t += 2; yield t; continue }
    const nV = voices.length
    // tension → colour, register, distance
    const lp = 500 + 9000 * Math.pow(T, 1.2)
    const octave = T < 0.25 && rng() < 0.5 ? 0.5 : T > 0.8 && rng() < 0.25 ? 2 : 1
    const reverse = index >= plan.acts.length - 2 && act.mode !== 'chorus' ? 0.25 : 0.05
    const amt = plan.amt * (0.15 + 0.85 * T * T) // calm is far and quiet, the peak is near
    const chordNow = env.chordAt(t)
    voices.forEach((v, k) => {
      let fRole = role
      let si = v
      let quiet = 1
      if (v <= -1000) { fRole = Math.floor((-v - 1000) / 100); si = (-v - 1000) % 100; quiet = 0.5 }
      const pool = (fams[fRole] ?? []).filter((s) => s.sourceIdx === si)
      if (pool.length === 0) return
      const buffer = env.sources[si]?.buffer
      if (!buffer) return
      const era = env.sources[si]?.era as Era | undefined
      const level = plan.levels[fRole] ?? 0.05
      // chorus: everyone at nearly the same moment, a breath apart
      const lag = act.mode === 'chorus' ? k * (0.03 + rng() * 0.09) : 0
      gesture!.notes.forEach((note) => {
        const s = pool[Math.floor(rng() * pool.length)]
        const len = Math.min(s.duration, buffer.duration - s.start)
        if (len < 0.04) return
        const base = s.pitch && s.pitchConfidence > 0.35 ? snapRate(s.pitch, env.keyRoot, chordNow) : 1
        // unpitched textures follow the contour only gently
        const semi = s.pitch && s.pitchConfidence > 0.35 ? note.semi : note.semi * 0.35
        const rate = Math.min(3, Math.max(0.25, base * octave * Math.pow(2, semi / 12)))
        const dur = Math.min(len / rate, 0.2 + note.len * 0.9)
        const at = t + lag + note.t
        if (at >= env.end) return
        const src = env.ctx.createBufferSource()
        src.buffer = region(buffer, s.start, len, rng() < reverse)
        src.playbackRate.value = rate
        const pan = panOf(si) * (act.mode === 'lone' ? 0.3 : 1)
        const g = voiceOut(env, 'kin', at, pan, 0.25 + (1 - T) * 0.45, era, src, rng, lp)
        // evened: every fragment brought to its family's median loudness
        const even = Math.min(2.5, Math.max(0.3, level / Math.max(0.003, s.rms)))
        // sits with the other layers (≈ −20 dB RMS at the peak, solo), not over them
        const peak = 0.12 * amt * even * quiet / Math.pow(nV, 0.3) // a choir is louder than one voice
        const a = s.attack > 1 ? 0.004 : Math.min(0.06, dur * 0.25)
        g.gain.setValueAtTime(0, at)
        g.gain.linearRampToValueAtTime(peak, at + a)
        g.gain.setValueAtTime(peak, at + Math.max(a, dur * 0.65))
        g.gain.linearRampToValueAtTime(0, at + dur)
        src.start(at, 0)
        src.stop(at + dur + 0.05)
        env.markUsed?.(si, s.start, s.start + len)
      })
    })
    turn++
    // calm: long silences between phrases · tense: they crowd in
    const gap = (0.25 + 4.2 * Math.pow(1 - T, 1.6)) * (0.7 + rng() * 0.6)
    t += gesture.dur + gap
    yield t
  }
}
