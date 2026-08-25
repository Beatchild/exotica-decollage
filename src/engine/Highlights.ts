import { analyzeSource } from './Slicer'
import type { SourceAnalysis } from './Slicer'

/**
 * Track-level material shaping:
 * - extractHighlights: best percussive/harmonic/texture windows spliced into
 *   a compact buffer (the plain "collage" cut)
 * - buildMixtape: role-ordered segments (texture intro → percussive middle →
 *   harmonic outro) joined with long equal-power crossfades — a continuous,
 *   recognizable mix rather than a hard splice
 * - buildInterleave: the cut buffers of several tracks woven chunk by chunk
 *   (A1-B1-C1-A2…) so tracks bleed into each other at the source level
 */

const WINDOW_SEC = 12
const HOP_SEC = 3
const FADE_SEC = 0.05

export type Role = 'percussive' | 'harmonic' | 'texture'

interface Win {
  startFrame: number
  frames: number
  onset: number
  energy: number
  steadiness: number
  zcr: number
}

function analyzeWindows(a: SourceAnalysis): Win[] {
  const frameDur = 512 / a.sampleRate
  const winFrames = Math.floor(WINDOW_SEC / frameDur)
  const hopFrames = Math.floor(HOP_SEC / frameDur)
  const wins: Win[] = []
  for (let f0 = 0; f0 + winFrames <= a.frames.length; f0 += hopFrames) {
    let onset = 0
    let energy = 0
    let zcr = 0
    for (let i = f0; i < f0 + winFrames; i++) {
      onset += a.frames[i].flux
      energy += a.frames[i].rms
      zcr += a.frames[i].zcr
    }
    energy /= winFrames
    zcr /= winFrames
    let variance = 0
    for (let i = f0; i < f0 + winFrames; i++) variance += (a.frames[i].rms - energy) ** 2
    const std = Math.sqrt(variance / winFrames)
    wins.push({ startFrame: f0, frames: winFrames, onset, energy, steadiness: 1 / (1 + std * 30), zcr })
  }
  return wins
}

function roleScorers(wins: Win[]) {
  const maxEnergy = Math.max(...wins.map((w) => w.energy), 1e-6)
  return {
    percussive: (w: Win) => w.onset * (0.3 + w.energy / maxEnergy),
    harmonic: (w: Win) => (w.energy / maxEnergy) * w.steadiness * (w.zcr < 60 ? 1 : 0.5),
    texture: (w: Win) => {
      const e = w.energy / maxEnergy
      return e > 0.03 ? w.steadiness * e * (1 - e) : 0
    },
  } as Record<Role, (w: Win) => number>
}

/** Best non-overlapping window per role, in seconds. */
export function extractRoleSegments(
  a: SourceAnalysis,
): Partial<Record<Role, { start: number; sec: number }>> {
  const wins = analyzeWindows(a)
  if (wins.length === 0) return {}
  const score = roleScorers(wins)
  const frameDur = 512 / a.sampleRate
  const winFrames = wins[0].frames
  const chosen: Array<{ role: Role; win: Win }> = []
  for (const role of ['percussive', 'harmonic', 'texture'] as Role[]) {
    const ranked = [...wins].sort((x, y) => score[role](y) - score[role](x))
    const pick = ranked.find(
      (w) => !chosen.some((c) => Math.abs(c.win.startFrame - w.startFrame) < winFrames),
    )
    if (pick) chosen.push({ role, win: pick })
  }
  const out: Partial<Record<Role, { start: number; sec: number }>> = {}
  for (const { role, win } of chosen) {
    out[role] = { start: win.startFrame * frameDur, sec: WINDOW_SEC }
  }
  return out
}

export function extractHighlights(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  count = 3,
  precomputed?: SourceAnalysis,
): AudioBuffer {
  count = Math.max(1, Math.min(3, count))
  if (buffer.duration <= WINDOW_SEC * count + 2) return buffer

  const a = precomputed ?? analyzeSource(buffer)
  const wins = analyzeWindows(a)
  if (wins.length === 0) return buffer
  const score = roleScorers(wins)
  const winFrames = wins[0].frames

  const chosen: Win[] = []
  const roles = (['percussive', 'harmonic', 'texture'] as Role[]).slice(0, count)
  for (const role of roles) {
    const ranked = [...wins].sort((x, y) => score[role](y) - score[role](x))
    const pick = ranked.find(
      (w) => !chosen.some((c) => Math.abs(c.startFrame - w.startFrame) < winFrames),
    )
    if (pick) chosen.push(pick)
  }
  if (chosen.length === 0) return buffer
  chosen.sort((x, y) => x.startFrame - y.startFrame)

  const segLen = Math.floor(WINDOW_SEC * buffer.sampleRate)
  const fade = Math.floor(FADE_SEC * buffer.sampleRate)
  const out = ctx.createBuffer(buffer.numberOfChannels, segLen * chosen.length, buffer.sampleRate)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch)
    const dst = out.getChannelData(ch)
    chosen.forEach((w, k) => {
      const from = Math.floor(w.startFrame * 512)
      const to = k * segLen
      for (let i = 0; i < segLen && from + i < src.length; i++) {
        let g = 1
        if (i < fade) g = i / fade
        else if (i > segLen - fade) g = (segLen - i) / fade
        dst[to + i] = src[from + i] * g
      }
    })
  }
  return out
}

// ---------- mixtape ----------

interface MixSegment {
  buffer: AudioBuffer
  start: number
  sec: number
}

/** Equal-power crossfaded sequence of segments into one stereo buffer. */
function crossfadeConcat(
  ctx: BaseAudioContext,
  segs: MixSegment[],
  fadeSec = 5,
): AudioBuffer {
  const sr = segs[0].buffer.sampleRate
  const fade = Math.floor(fadeSec * sr)
  const lens = segs.map((s) => Math.floor(s.sec * sr))
  const total = lens.reduce((n, l) => n + l, 0) - fade * (segs.length - 1)
  const out = ctx.createBuffer(2, Math.max(total, sr), sr)
  let cursor = 0
  segs.forEach((seg, k) => {
    const from = Math.floor(seg.start * sr)
    const len = lens[k]
    const tailFade = k === segs.length - 1 ? Math.min(len, Math.floor(2 * sr)) : fade
    for (let ch = 0; ch < 2; ch++) {
      const src = seg.buffer.getChannelData(Math.min(ch, seg.buffer.numberOfChannels - 1))
      const dst = out.getChannelData(ch)
      for (let i = 0; i < len && from + i < src.length; i++) {
        let g = 1
        if (k > 0 && i < fade) g *= Math.sin((Math.PI / 2) * (i / fade)) // equal-power in
        if (i > len - tailFade) g *= Math.cos((Math.PI / 2) * (1 - (len - i) / tailFade))
        const at = cursor + i
        if (at < dst.length) dst[at] += src[from + i] * g
      }
    }
    cursor += len - fade
  })
  return out
}

/**
 * Role-ordered mixtape: texture intro from the first track, every track's
 * percussive window through the middle, harmonic windows as the outro —
 * all joined with 5s equal-power crossfades.
 */
export function buildMixtape(
  ctx: BaseAudioContext,
  tracks: Array<{ full: AudioBuffer; a: SourceAnalysis }>,
): AudioBuffer {
  const segs: MixSegment[] = []
  const roleMaps = tracks.map((t) => extractRoleSegments(t.a))
  const push = (ti: number, role: Role) => {
    const seg = roleMaps[ti][role]
    if (seg) segs.push({ buffer: tracks[ti].full, start: seg.start, sec: seg.sec })
  }
  push(0, 'texture')
  for (let i = 0; i < tracks.length; i++) push(i, 'percussive')
  for (let i = 0; i < tracks.length; i++) push(i, 'harmonic')

  if (segs.length === 0) {
    // very short tracks: run them whole, in order
    for (const t of tracks) segs.push({ buffer: t.full, start: 0, sec: t.full.duration })
  }
  return crossfadeConcat(ctx, segs, 5)
}

// ---------- interleave / weave ----------

/**
 * Weave several cut buffers into one: short chunks taken round-robin
 * (A1-B1-C1-A2-B2-C2…) with 40ms edge fades — tracks bleed into each other
 * at the source level.
 */
export function buildInterleave(ctx: BaseAudioContext, cuts: AudioBuffer[]): AudioBuffer {
  const sr = cuts[0].sampleRate
  const chunk = Math.floor(1.2 * sr)
  const fade = Math.floor(0.04 * sr)
  const chunksOf = (b: AudioBuffer) => Math.floor(b.length / chunk)
  const rounds = Math.max(...cuts.map(chunksOf))
  const pieces: Array<{ b: AudioBuffer; off: number }> = []
  for (let r = 0; r < rounds; r++) {
    for (const b of cuts) {
      if (r < chunksOf(b)) pieces.push({ b, off: r * chunk })
    }
  }
  const out = ctx.createBuffer(2, Math.max(pieces.length * chunk, sr), sr)
  pieces.forEach((p, k) => {
    for (let ch = 0; ch < 2; ch++) {
      const src = p.b.getChannelData(Math.min(ch, p.b.numberOfChannels - 1))
      const dst = out.getChannelData(ch)
      const to = k * chunk
      for (let i = 0; i < chunk && p.off + i < src.length; i++) {
        let g = 1
        if (i < fade) g = i / fade
        else if (i > chunk - fade) g = (chunk - i) / fade
        dst[to + i] = src[p.off + i] * g
      }
    }
  })
  return out
}

/** Track personality features for auto-scene generation. */
export function trackCharacter(a: SourceAnalysis) {
  const n = a.frames.length || 1
  let energy = 0
  let centroid = 0
  for (const f of a.frames) {
    energy += f.rms
    centroid += f.centroid
  }
  energy /= n
  centroid /= n
  let variance = 0
  for (const f of a.frames) variance += (f.rms - energy) ** 2
  const contrast = Math.sqrt(variance / n) / (energy + 1e-6)
  const fluxes = a.frames.map((f) => f.flux)
  const fluxMean = fluxes.reduce((x, y) => x + y, 0) / n
  const onsetRate =
    fluxes.filter((f) => f > fluxMean * 2).length / Math.max(1, a.duration)
  return {
    energy: Math.min(1, energy * 6),
    brightness: centroid, // Hz
    contrast: Math.min(1, contrast * 0.5),
    onsetRate: Math.min(1, onsetRate / 4),
  }
}
