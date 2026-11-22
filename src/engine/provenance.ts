/**
 * Provenance: where every second of a pool source came from, and which of
 * those seconds a render actually played. Feeds the album's samples.txt /
 * samples.json so clearance work starts from exact timestamps, not memory.
 */
import type { SourceUsage } from './OfflineRenderer'

/** One stretch of a source buffer that maps back to an original recording. */
export interface OriginSeg {
  /** seconds inside this pool source */
  at: number
  len: number
  /** the original: video/file title */
  label: string
  url?: string
  /** seconds inside the original */
  srcStart: number
}

export type OriginKind = 'stem' | 'file' | 'youtube' | 'mic' | 'image' | 'resample' | 'cut' | 'unknown'

export interface SourceOrigin {
  kind: OriginKind
  label: string
  url?: string
  /** exact mapping back into originals (YouTube cuts, region cuts of them) */
  segments?: OriginSeg[]
  /** originals involved when exact timestamps aren't known (mixtape, weave) */
  tracks?: Array<{ label: string; url?: string }>
  /** does this need clearance before release? */
  needsClearance: boolean
}

export const STEM_ORIGIN = (name: string): SourceOrigin => ({
  kind: 'stem', label: `${name} (synthesized in-app, royalty-free)`, needsClearance: false,
})

/** Sub-range [start, start+dur) of a parent source → origin of the cut. */
export function cutOrigin(parent: SourceOrigin | undefined, parentName: string, start: number, dur: number): SourceOrigin {
  if (!parent) return { kind: 'cut', label: `cut of ${parentName}`, needsClearance: true }
  const segments = parent.segments
    ?.map((s) => {
      const a = Math.max(s.at, start)
      const b = Math.min(s.at + s.len, start + dur)
      return b > a ? { ...s, at: a - start, len: b - a, srcStart: s.srcStart + (a - s.at) } : null
    })
    .filter((s): s is OriginSeg => s !== null)
  return { ...parent, kind: parent.kind === 'stem' ? 'stem' : 'cut', label: `cut of ${parentName}`, segments }
}

/** Splice several parent ranges (in order) into one origin. */
export function spliceOrigin(parent: SourceOrigin | undefined, parentName: string, parts: Array<{ start: number; dur: number }>): SourceOrigin {
  let at = 0
  const segments: OriginSeg[] = []
  for (const p of parts) {
    const c = cutOrigin(parent, parentName, p.start, p.dur)
    for (const s of c.segments ?? []) segments.push({ ...s, at: s.at + at })
    at += p.dur
  }
  return {
    ...(parent ?? { kind: 'cut', needsClearance: true }),
    kind: parent?.kind === 'stem' ? 'stem' : 'cut',
    label: `splice of ${parentName}`,
    segments: parent?.segments ? segments : undefined,
  }
}

/** h:mm:ss.t — tenths matter: a 0.3s grain at 0:07 must not read "0:07–0:07" */
const ts = (sec: number) => {
  const t = Math.max(0, Math.round(sec * 10)) / 10
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const ss = (t % 60).toFixed(1).padStart(4, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export interface UsedOriginal {
  label: string
  url?: string
  /** [start, end] seconds in the original */
  ranges: Array<[number, number]>
  exact: boolean
}

/** Map a render's per-source usage back to original recordings. */
export function originalsUsed(usage: SourceUsage[], origins: Array<SourceOrigin | undefined>): {
  originals: UsedOriginal[]
  clean: string[]
} {
  const byKey = new Map<string, UsedOriginal>()
  const clean: string[] = []
  const add = (label: string, url: string | undefined, r: [number, number] | null) => {
    const key = url ?? label
    let o = byKey.get(key)
    if (!o) byKey.set(key, (o = { label, url, ranges: [], exact: !!r }))
    if (r) o.ranges.push(r)
  }
  for (const u of usage) {
    const org = origins[u.sourceIdx]
    if (!org || !org.needsClearance) {
      clean.push(org?.label ?? u.name)
      continue
    }
    if (org.segments?.length) {
      for (const [a, b] of u.ranges) {
        for (const s of org.segments) {
          const x = Math.max(a, s.at)
          const y = Math.min(b, s.at + s.len)
          if (y > x) add(s.label, s.url, [s.srcStart + (x - s.at), s.srcStart + (y - s.at)])
        }
      }
    } else if (org.tracks?.length) {
      for (const t of org.tracks) add(t.label, t.url, null)
    } else {
      // file / mic / resample: ranges are in the source's own timeline
      for (const r of u.ranges) add(org.label, org.url, r)
    }
  }
  for (const o of byKey.values()) {
    const sorted = o.ranges.sort((p, q) => p[0] - q[0])
    const merged: Array<[number, number]> = []
    for (const [a, b] of sorted) {
      const last = merged[merged.length - 1]
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
      else merged.push([a, b])
    }
    o.ranges = merged
  }
  return { originals: [...byKey.values()], clean: [...new Set(clean)] }
}

export function formatRanges(r: Array<[number, number]>): string {
  return r.map(([a, b]) => `${ts(a)}–${ts(b)}`).join(', ')
}
