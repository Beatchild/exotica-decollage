import type { AudioEngine } from './AudioEngine'
import type { LoudnessReport } from './loudness'
import type { SourceUsage } from './OfflineRenderer'
import { formatRanges, originalsUsed } from './provenance'
import type { SourceOrigin } from './provenance'

/** Named one-click forms the engine already ships — used as track characters. */
export const PRESETS: Array<{ key: string; label: string; hint: string; apply: (e: AudioEngine) => void }> = [
  { key: 'pekler', label: 'Pekler', hint: 'phrase loop + dubbed decoration', apply: (e) => e.applyPeklerPreset() },
  { key: 'afrika', label: 'Space Afrika', hint: 'submerged pads, dark & wide', apply: (e) => e.applyAfrikaPreset() },
  { key: 'templeton', label: 'Templeton', hint: 'stuttering micro-loops, tape warble', apply: (e) => e.applyTempletonPreset() },
  { key: 'jelinek', label: 'Jelinek', hint: 'clicking micro-loops, soft groove', apply: (e) => e.applyJelinekPreset() },
  { key: 'poirier', label: 'Poirier', hint: 'aquatic dub-jazz', apply: (e) => e.applyPoirierPreset() },
  { key: 'jeck', label: 'Jeck / Basinski', hint: 'rotting loops, no rhythm', apply: (e) => e.applyJeckPreset() },
  { key: 'caretaker', label: 'Caretaker', hint: 'distant ballroom loop', apply: (e) => e.applyCaretakerPreset() },
  { key: 'pole', label: 'Pole', hint: 'broken-filter clicks, dub lilt', apply: (e) => e.applyPolePreset() },
  { key: 'books', label: 'The Books', hint: 'hyperactive collage', apply: (e) => e.applyBooksPreset() },
  { key: 'hassell', label: 'Hassell', hint: 'fourth-world modal pads', apply: (e) => e.applyHassellPreset() },
  { key: 'loscil', label: 'Loscil', hint: 'dark slow pulse', apply: (e) => e.applyLoscilPreset() },
  { key: 'ges', label: 'G.E.S.', hint: 'holiday-recording exotica', apply: (e) => e.applyGesPreset() },
  { key: 'ielasi', label: 'Ielasi', hint: 'dusty swung miniatures', apply: (e) => e.applyIelasiPreset() },
  { key: 'microstoria', label: 'Microstoria', hint: 'digital debris, beatless', apply: (e) => e.applyMicrostoriaPreset() },
  { key: 'keszler', label: 'Keszler', hint: 'pointillist percussion flurries', apply: (e) => e.applyKeszlerPreset() },
  { key: 'budd', label: 'Harold Budd', hint: 'soft-pedal piano ambient', apply: (e) => e.applyBuddPreset() },
]

export type TrackStatus = 'idle' | 'queued' | 'rendering' | 'done' | 'error' | 'skipped' | 'cancelled'

/** What an album run produced — tells the UI how it ended. */
export interface AlbumResult {
  saved: number
  skipped: number
  failed: number
  /** stopped early (STOP NOW / STOP AFTER / Esc) */
  stopped: boolean
  /** CANCEL ALL: nothing was saved */
  discarded: boolean
}

export interface AlbumTrack {
  id: number
  title: string
  seed: number
  /** preset key, or null = the studio's current sound */
  preset: string | null
  minutes: number
  /** unticked rows are kept in the plan but left out of the render */
  include?: boolean
  status: TrackStatus
  progress: number
  report?: LoudnessReport
  error?: string
  /** album position it was rendered as (set on render) */
  number?: number
  /** which pool sources this track played (set on render) */
  usage?: SourceUsage[]
  /** a full studio patch (from COMPOSE → ADD TO ALBUM); overrides preset */
  patch?: Record<string, unknown>
}

export interface ExportFormat {
  bits: 16 | 24
  /** 44100 = CD / most distributors; 48000 = video / the live engine */
  sampleRate: 44100 | 48000
}

export const DEFAULT_FORMAT: ExportFormat = { bits: 24, sampleRate: 44100 }

export type Transition = 'gap' | 'gapless'

export interface AlbumPlan {
  title: string
  artist: string
  year?: string
  tracks: AlbumTrack[]
  targetLufs: number | null
  ceilingDb: number
  format?: ExportFormat
  /** seconds; applied to every track in 'gap' mode, to the album's ends in 'gapless' */
  fadeIn?: number
  fadeOut?: number
  /** gapless: each track's tail crossfades into the next track's head */
  transition?: Transition
  /** crossfade length for gapless, seconds */
  crossfade?: number
}

/** Filesystem-safe name that keeps Georgian/Unicode letters. */
export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled'
}

const fmtTime = (min: number) => {
  const s = Math.round(min * 60)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const fmtDb = (x: number | undefined, unit: string) =>
  x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(1)} ${unit}`

/** Human-readable sheet that ships in the ZIP next to the audio. */
export function tracklistText(plan: AlbumPlan): string {
  const lines: string[] = []
  lines.push(plan.title + (plan.artist ? ` — ${plan.artist}` : ''))
  lines.push('='.repeat(Math.min(60, lines[0].length)))
  lines.push('')
  let total = 0
  plan.tracks.forEach((t, i) => {
    total += t.minutes
    const preset = PRESETS.find((p) => p.key === t.preset)?.label ?? 'studio sound'
    lines.push(
      `${String(t.number ?? i + 1).padStart(2, '0')}. ${t.title}  (${fmtTime(t.minutes)})` +
        `  · ${preset} · seed ${t.seed}` +
        `  · ${fmtDb(t.report?.integrated, 'LUFS')} · TP ${fmtDb(t.report?.truePeak, 'dBTP')}`,
    )
  })
  lines.push('')
  lines.push(`Total ${fmtTime(total)}`)
  lines.push(
    plan.targetLufs != null
      ? `Mastered to ${plan.targetLufs} LUFS integrated, true peak ≤ ${plan.ceilingDb} dBTP (BS.1770-4).`
      : 'Not loudness-normalized.',
  )
  const f = plan.format ?? DEFAULT_FORMAT
  lines.push(`${f.bits}-bit / ${f.sampleRate / 1000} kHz WAV${f.bits === 16 ? ' (TPDF-dithered)' : ''}, tagged (INFO + ID3).`)
  if (plan.transition === 'gapless') {
    lines.push(`Gapless: ${plan.crossfade ?? 4}s crossfades run across track boundaries — play without gaps.`)
  } else if ((plan.fadeIn ?? 0) > 0 || (plan.fadeOut ?? 0) > 0) {
    lines.push(`Fades: in ${plan.fadeIn ?? 0}s · out ${plan.fadeOut ?? 0}s per track.`)
  }
  lines.push('Rendered with Exotica Décollage; same seed + same sources = same track.')
  lines.push('')
  lines.push('Sampled material in a release still needs clearance — see samples.txt.')
  return lines.join('\r\n')
}

/**
 * samples.txt: per track, every original recording it draws on, with the
 * exact time ranges used where known (YouTube cuts, uploads, mic takes).
 */
export function samplesText(plan: AlbumPlan, origins: Array<SourceOrigin | undefined>): string {
  const L: string[] = []
  L.push(`SAMPLE REPORT — ${plan.title}${plan.artist ? ` — ${plan.artist}` : ''}`)
  L.push('Which original recordings each track uses, for clearance. Times are positions')
  L.push('inside the original recording (m:ss.t). "In-app" sources need no clearance.')
  L.push('')
  const all = new Map<string, { label: string; url?: string; tracks: Set<string> }>()
  plan.tracks.forEach((t, i) => {
    const num = String(t.number ?? i + 1).padStart(2, '0')
    L.push(`${num}. ${t.title}`)
    const { originals, clean } = originalsUsed(t.usage ?? [], origins)
    if (!originals.length) L.push('    no third-party material')
    for (const o of originals) {
      L.push(`    • ${o.label}${o.url ? `  <${o.url}>` : ''}`)
      L.push(o.exact && o.ranges.length
        ? `        used: ${formatRanges(o.ranges)}`
        : '        used: (exact positions unknown — whole recording involved)')
      const key = o.url ?? o.label
      if (!all.has(key)) all.set(key, { label: o.label, url: o.url, tracks: new Set() })
      all.get(key)!.tracks.add(num)
    }
    for (const c of clean) L.push(`    ◦ in-app: ${c}`)
    L.push('')
  })
  L.push('ALL ORIGINALS')
  if (!all.size) L.push('    none — everything is in-app material')
  for (const o of all.values()) {
    L.push(`    • ${o.label}${o.url ? `  <${o.url}>` : ''}  — tracks ${[...o.tracks].join(', ')}`)
  }
  return L.join('\r\n')
}

/** Same data as samples.txt, machine-readable. */
export function samplesJson(plan: AlbumPlan, origins: Array<SourceOrigin | undefined>): string {
  return JSON.stringify({
    album: plan.title,
    artist: plan.artist,
    tracks: plan.tracks.map((t, i) => {
      const { originals, clean } = originalsUsed(t.usage ?? [], origins)
      return {
        number: t.number ?? i + 1,
        title: t.title,
        seed: t.seed,
        preset: t.preset,
        originals: originals.map((o) => ({ title: o.label, url: o.url, exact: o.exact, rangesSec: o.ranges })),
        inApp: clean,
      }
    }),
  }, null, 2)
}
