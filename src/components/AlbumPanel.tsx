import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Dices, Disc3, Download, FileText, ImagePlus, Play, Plus, X } from 'lucide-react'
import type { useAudioEngine } from '../hooks/useAudioEngine'
import { DEFAULT_FORMAT, PRESETS } from '../engine/album'
import type { AlbumPlan, AlbumResult, AlbumTrack, ExportFormat, Transition } from '../engine/album'
import { LOUDNESS_TARGETS } from '../engine/loudness'
import { randomSeed } from '../engine/rng'
import { toast } from '../ui/toast'

type Api = ReturnType<typeof useAudioEngine>

const CHARCOAL = '#1A1A1A'
const BURNT = '#D35400'
const CREAM = '#F4EFEA'
const STORE = 'exotica.album.v1'

/** Release-level settings that apply to every track. */
interface Release {
  year: string
  format: ExportFormat
  transition: Transition
  fadeIn: number
  fadeOut: number
  crossfade: number
}

const DEFAULT_RELEASE: Release = {
  year: String(new Date().getFullYear()),
  format: DEFAULT_FORMAT,
  transition: 'gap',
  fadeIn: 0.5,
  fadeOut: 4,
  crossfade: 4,
}

interface Cover {
  mime: string
  name: string
  /** data: URL — persisted when small enough, also used for the thumbnail */
  url: string
}

interface Saved {
  title: string
  artist: string
  targetLufs: number | null
  tracks: Array<Pick<AlbumTrack, 'title' | 'seed' | 'preset' | 'minutes' | 'include' | 'patch'>>
  release?: Partial<Release>
  cover?: Cover | null
}

const fresh = (i: number, minutes = 4, preset: string | null = null): AlbumTrack => ({
  id: Date.now() + i,
  title: `Track ${i + 1}`,
  seed: randomSeed(),
  preset,
  minutes,
  status: 'idle',
  progress: 0,
})

function load(defaultLufs: number | null): Omit<AlbumPlan, 'ceilingDb'> & { release: Release; cover: Cover | null } {
  try {
    const raw = localStorage.getItem(STORE)
    if (raw) {
      const s = JSON.parse(raw) as Saved
      if (Array.isArray(s.tracks) && s.tracks.length) {
        return {
          title: s.title,
          artist: s.artist,
          targetLufs: s.targetLufs,
          tracks: s.tracks.map((t, i) => ({ ...fresh(i), ...t })),
          release: { ...DEFAULT_RELEASE, ...s.release, format: { ...DEFAULT_FORMAT, ...s.release?.format } },
          cover: s.cover ?? null,
        }
      }
    }
  } catch { /* ignore */ }
  return {
    title: 'Untitled Album',
    artist: '',
    targetLufs: defaultLufs,
    tracks: Array.from({ length: 4 }, (_, i) => fresh(i)),
    release: DEFAULT_RELEASE,
    cover: null,
  }
}

function dataUrlBytes(url: string): Uint8Array {
  const bin = atob(url.slice(url.indexOf(',') + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Small numeric field used by the release settings row. */
function Num({ label, value, onChange, min, max, step, disabled, title, unit = 'S' }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number
  disabled?: boolean; title?: string; unit?: string
}) {
  return (
    <label className="flex flex-col gap-0.5" title={title}>
      <span className="text-[9px] tracking-widest opacity-60">{label}</span>
      <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-1">
        <input
          type="number" min={min} max={max} step={step} value={value} disabled={disabled}
          onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))}
          className="w-10 bg-transparent text-[11px]"
        />
        <span className="text-[9px] opacity-60">{unit}</span>
      </span>
    </label>
  )
}

const fmtLu = (x: number | undefined) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(1))
const mmss = (min: number) => {
  const s = Math.round(min * 60)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Album builder: a tracklist where each row is one track (title, character,
 * length, seed). Audition any row live, then render everything into one
 * ZIP of loudness-matched WAVs + sleeves + tracklist.
 */
export function AlbumPanel({ api, onClose }: { api: Api; onClose: () => void }) {
  const { state } = api
  const [init] = useState(() => load(state.loudnessTarget))
  const [title, setTitle] = useState(init.title)
  const [artist, setArtist] = useState(init.artist)
  const [targetLufs, setTargetLufs] = useState<number | null>(init.targetLufs)
  const [tracks, setTracks] = useState<AlbumTrack[]>(init.tracks)
  const [release, setRelease] = useState<Release>(init.release)
  const [cover, setCover] = useState<Cover | null>(init.cover)
  const rel = (p: Partial<Release>) => setRelease((r) => ({ ...r, ...p }))
  const [previewing, setPreviewing] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [stopMode, setStopMode] = useState<null | 'after' | 'now' | 'discard'>(null)
  const [output, setOutput] = useState<'zip' | 'files'>('zip')
  const stopAfter = useRef(false)
  const discard = useRef(false)
  // the studio's own sound, restored when the panel closes
  const [base] = useState(() => api.albumSnapshot())
  const touched = useRef(false)

  // persist the plan so an album-in-progress survives reloads
  useEffect(() => {
    try {
      const s: Saved = {
        title, artist, targetLufs, release,
        tracks: tracks.map(({ title, seed, preset, minutes, include, patch }) => ({ title, seed, preset, minutes, include, patch })),
        // covers over ~1.5MB would blow the storage quota: keep them for this session only
        cover: cover && cover.url.length < 2_000_000 ? cover : null,
      }
      localStorage.setItem(STORE, JSON.stringify(s))
    } catch { /* ignore */ }
  }, [title, artist, targetLufs, tracks, release, cover])

  // Esc closes the panel when nothing is rendering (while rendering, the app's
  // own Esc handler stops the render instead)
  const closeRef = useRef<() => void>(() => {})
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy])

  const pickCover = (file: File) => {
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      toast('Cover art must be a PNG or JPEG.', 'error')
      return
    }
    const r = new FileReader()
    r.onload = () => setCover({ mime: file.type, name: `cover.${file.type === 'image/png' ? 'png' : 'jpg'}`, url: String(r.result) })
    r.readAsDataURL(file)
  }

  const patch = useCallback((i: number, p: Partial<AlbumTrack>) => {
    setTracks((ts) => ts.map((t, k) => (k === i ? { ...t, ...p } : t)))
  }, [])

  const edit = (i: number, p: Partial<AlbumTrack>) => {
    // any edit invalidates a previous render result for that row
    patch(i, { ...p, status: 'idle', progress: 0, report: undefined })
  }

  const close = () => {
    if (busy) return
    if (touched.current) api.albumRestore(base)
    onClose()
  }

  useEffect(() => {
    closeRef.current = close
  })

  const preview = (i: number) => {
    touched.current = true
    setPreviewing(i)
    api.albumPreview(base, tracks[i])
  }

  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= tracks.length) return
    setTracks((ts) => {
      const n = [...ts]
      ;[n[i], n[j]] = [n[j], n[i]]
      return n
    })
  }

  const shufflePresets = () => {
    const pool = [...PRESETS].sort(() => Math.random() - 0.5)
    setTracks((ts) => ts.map((t, i) => ({ ...t, preset: pool[i % pool.length].key, status: 'idle', report: undefined })))
  }

  const allStudio = () =>
    setTracks((ts) => ts.map((t) => ({ ...t, preset: null, status: 'idle', report: undefined })))

  /** tracks that go into the album (ticked rows), with their album numbers */
  const included = tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.include !== false)
  const albumNumber = (row: number) => included.findIndex((x) => x.i === row) + 1 || row + 1

  /**
   * Render the given rows. `zip` = the album archive; `files` = plain WAVs
   * (single-track export from a row's ⬇ button).
   */
  const render = async (rows: number[], output: 'zip' | 'files') => {
    if (busy || rows.length === 0) return
    setBusy(true)
    setDone(null)
    stopAfter.current = false
    discard.current = false
    setStopMode(null)
    setPreviewing(null)
    touched.current = true
    setTracks((ts) => ts.map((t, k) =>
      rows.includes(k) ? { ...t, status: 'queued', progress: 0, report: undefined, error: undefined }
      // stale outcome labels from an earlier run would be misleading
      : t.status === 'skipped' || t.status === 'cancelled' || t.status === 'error' ? { ...t, status: 'idle', progress: 0 }
      : t))
    const plan: AlbumPlan = {
      title: title.trim() || 'Untitled Album',
      artist: artist.trim(),
      year: release.year.trim(),
      targetLufs,
      ceilingDb: -1,
      format: release.format,
      transition: release.transition,
      fadeIn: release.fadeIn,
      fadeOut: release.fadeOut,
      crossfade: release.crossfade,
      tracks: rows.map((k) => ({ ...tracks[k] })),
    }
    let res: AlbumResult | null = null
    try {
      res = await api.renderAlbumPlan(plan, base, (j, p) => patch(rows[j], p), {
        stopAfter: () => stopAfter.current,
        discard: () => discard.current,
        output,
        numbers: rows.map(albumNumber),
        cover: cover ? { mime: cover.mime, name: cover.name, data: dataUrlBytes(cover.url) } : undefined,
      })
    } finally {
      setBusy(false)
      setStopMode(null)
      // rows that never started go back to idle
      setTracks((ts) => ts.map((t) => (t.status === 'queued' ? { ...t, status: 'idle' } : t)))
    }
    if (!res) return
    const what = output === 'zip' ? `${plan.title}.zip` : `${res.saved} WAV${res.saved === 1 ? '' : 'S'}`
    setDone(
      res.discarded ? 'Cancelled — nothing was saved.'
      : res.saved === 0 ? (res.failed ? 'Failed — see the track rows.' : 'Stopped — nothing finished, nothing saved.')
      : [
          `Saved ${what}`,
          res.stopped && 'stopped early',
          res.skipped && `${res.skipped} skipped`,
          res.failed && `${res.failed} failed`,
        ].filter(Boolean).join(' · '),
    )
  }

  const total = included.reduce((n, { t }) => n + t.minutes, 0)
  const noSources = state.slices.length === 0

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-3 sm:p-8"
      style={{ background: 'rgba(26,26,26,0.45)' }}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="w-full max-w-4xl border-2 p-4 flex flex-col gap-3" style={{ background: CREAM, borderColor: CHARCOAL }}>
        {/* title bar */}
        <div className="flex items-center gap-2">
          <Disc3 size={16} />
          <span className="text-xs tracking-[0.3em] font-bold">ALBUM</span>
          <span className="text-[9px] tracking-widest opacity-50 ml-2">
            {included.length}/{tracks.length} TRACKS · {mmss(total)}
          </span>
          <button onClick={close} disabled={busy} className="ml-auto p-1 hover:opacity-60 disabled:opacity-30" title="Close (restores the studio sound)">
            <X size={16} />
          </button>
        </div>

        {/* step hints */}
        <ol className="text-[10px] tracking-wider opacity-70 flex flex-wrap gap-x-5 gap-y-1 list-none">
          <li><b style={{ color: BURNT }}>1</b> NAME IT</li>
          <li><b style={{ color: BURNT }}>2</b> PICK A CHARACTER PER TRACK</li>
          <li><b style={{ color: BURNT }}>3</b> ▶ LISTEN · 🎲 REROLL WHAT YOU DON'T LIKE</li>
          <li><b style={{ color: BURNT }}>4</b> RENDER — STOP / SKIP ANY TIME</li>
        </ol>

        {/* album meta */}
        <div className="flex flex-wrap gap-2 items-end">
          <label className="flex flex-col gap-0.5 flex-1 min-w-48">
            <span className="text-[9px] tracking-widest opacity-60">ALBUM TITLE</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              className="border border-charcoal/60 bg-transparent px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-0.5 flex-1 min-w-40">
            <span className="text-[9px] tracking-widest opacity-60">ARTIST</span>
            <input
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              disabled={busy}
              placeholder="optional"
              className="border border-charcoal/60 bg-transparent px-2 py-1 text-sm placeholder:opacity-40"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] tracking-widest opacity-60">LOUDNESS</span>
            <select
              value={targetLufs == null ? 'off' : String(targetLufs)}
              onChange={(e) => setTargetLufs(e.target.value === 'off' ? null : Number(e.target.value))}
              disabled={busy}
              className="border border-charcoal/60 bg-transparent px-1 py-1 text-[11px] tracking-wider"
              title="Every track is matched to this integrated loudness (BS.1770) with true peak ≤ −1 dBTP — the level Spotify / YouTube / Apple normalize to, so the album plays back evenly"
            >
              {LOUDNESS_TARGETS.map((t) => (
                <option key={t.label} value={t.lufs == null ? 'off' : String(t.lufs)}>
                  {t.lufs == null ? 'OFF (RAW)' : `${t.label} LUFS`}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* release settings */}
        <details className="border border-charcoal/30 px-2 py-1.5" open>
          <summary className="text-[9px] tracking-[0.25em] cursor-pointer select-none opacity-80">
            RELEASE — {release.format.bits}-BIT / {release.format.sampleRate / 1000} KHZ ·{' '}
            {release.transition === 'gapless' ? `GAPLESS ${release.crossfade}S` : `FADES ${release.fadeIn}/${release.fadeOut}S`}
            {cover ? ' · CUSTOM COVER' : ''}
          </summary>
          <div className="flex flex-wrap gap-2 items-end mt-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] tracking-widest opacity-60">YEAR</span>
              <input
                value={release.year}
                onChange={(e) => rel({ year: e.target.value.replace(/[^0-9]/g, '').slice(0, 4) })}
                disabled={busy}
                className="w-14 border border-charcoal/60 bg-transparent px-1.5 py-1 text-[11px]"
              />
            </label>
            <label className="flex flex-col gap-0.5" title="24-bit keeps the full resolution for mastering engineers and distributors; 16-bit is CD quality (dithered)">
              <span className="text-[9px] tracking-widest opacity-60">BIT DEPTH</span>
              <select
                value={release.format.bits}
                onChange={(e) => rel({ format: { ...release.format, bits: Number(e.target.value) as 16 | 24 } })}
                disabled={busy}
                className="border border-charcoal/60 bg-transparent px-1 py-1 text-[11px]"
              >
                <option value={24}>24-BIT</option>
                <option value={16}>16-BIT (CD)</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5" title="44.1 kHz is what most distributors and CDs expect; 48 kHz suits video">
              <span className="text-[9px] tracking-widest opacity-60">SAMPLE RATE</span>
              <select
                value={release.format.sampleRate}
                onChange={(e) => rel({ format: { ...release.format, sampleRate: Number(e.target.value) as 44100 | 48000 } })}
                disabled={busy}
                className="border border-charcoal/60 bg-transparent px-1 py-1 text-[11px]"
              >
                <option value={44100}>44.1 KHZ</option>
                <option value={48000}>48 KHZ</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5" title="GAPS: every track fades in and out on its own. GAPLESS: each track's tail crossfades into the next one, so the album plays as one continuous piece">
              <span className="text-[9px] tracking-widest opacity-60">TRANSITIONS</span>
              <select
                value={release.transition}
                onChange={(e) => rel({ transition: e.target.value as Transition })}
                disabled={busy}
                className="border border-charcoal/60 bg-transparent px-1 py-1 text-[11px]"
              >
                <option value="gap">SEPARATE TRACKS</option>
                <option value="gapless">GAPLESS / CONTINUOUS</option>
              </select>
            </label>
            {release.transition === 'gapless' && (
              <Num label="CROSSFADE" value={release.crossfade} min={0.5} max={15} step={0.5} disabled={busy}
                onChange={(v) => rel({ crossfade: v })} title="How long each track overlaps the next" />
            )}
            <Num label={release.transition === 'gapless' ? 'ALBUM FADE IN' : 'FADE IN'} value={release.fadeIn} min={0} max={20} step={0.5}
              disabled={busy} onChange={(v) => rel({ fadeIn: v })} />
            <Num label={release.transition === 'gapless' ? 'ALBUM FADE OUT' : 'FADE OUT'} value={release.fadeOut} min={0} max={30} step={0.5}
              disabled={busy} onChange={(v) => rel({ fadeOut: v })} />
            <span className="flex flex-col gap-0.5">
              <span className="text-[9px] tracking-widest opacity-60">COVER ART</span>
              <span className="flex items-center gap-1.5">
                {cover && <img src={cover.url} alt="" className="w-8 h-8 object-cover border border-charcoal/40" />}
                <label
                  className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-1 text-[10px] tracking-wider cursor-pointer hover:bg-charcoal/10"
                  title="Your own cover (PNG/JPEG): embedded in every WAV and saved as cover.png/jpg. Without one, each track gets its generated sleeve."
                >
                  <ImagePlus size={12} /> {cover ? 'CHANGE' : 'UPLOAD'}
                  <input
                    type="file" accept="image/png,image/jpeg" className="hidden" disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) pickCover(f)
                      e.target.value = ''
                    }}
                  />
                </label>
                {cover && (
                  <button onClick={() => setCover(null)} disabled={busy} className="p-1 hover:opacity-60" title="Back to the generated sleeves">
                    <X size={12} />
                  </button>
                )}
              </span>
            </span>
          </div>
          <p className="text-[9px] tracking-wider opacity-55 mt-2 leading-relaxed">
            EVERY WAV IS TAGGED (TITLE · ARTIST · ALBUM · TRACK N/N · YEAR · COVER).{' '}
            {state.poolNeedsClearance
              ? 'THE POOL HOLDS THIRD-PARTY MATERIAL — SAMPLES.TXT IN THE ZIP LISTS EVERY ORIGINAL WITH TIMESTAMPS.'
              : 'THE POOL IS ALL IN-APP MATERIAL — NOTHING TO CLEAR.'}
          </p>
        </details>

        {/* bulk actions */}
        <div className="flex flex-wrap gap-2 text-[9px] tracking-widest">
          <button onClick={allStudio} disabled={busy} className="border border-charcoal/60 px-2 py-1 hover:bg-charcoal/10 disabled:opacity-40"
            title="Every track uses the sound currently set up in the studio, each with its own seed">
            ALL = STUDIO SOUND
          </button>
          <button onClick={shufflePresets} disabled={busy} className="border border-charcoal/60 px-2 py-1 hover:bg-charcoal/10 disabled:opacity-40"
            title="Give every track a different one-click character — a varied album from the same source material">
            MIX CHARACTERS
          </button>
          <button
            onClick={() => setTracks((ts) => ts.map((t) => ({ ...t, seed: randomSeed(), status: 'idle', report: undefined })))}
            disabled={busy}
            className="border border-charcoal/60 px-2 py-1 hover:bg-charcoal/10 disabled:opacity-40 flex items-center gap-1"
          >
            <Dices size={11} /> REROLL ALL
          </button>
          <button
            onClick={() => setTracks((ts) => [...ts, fresh(ts.length, ts[ts.length - 1]?.minutes ?? 4)])}
            disabled={busy || tracks.length >= 16}
            className="border border-charcoal/60 px-2 py-1 hover:bg-charcoal/10 disabled:opacity-40 flex items-center gap-1 ml-auto"
          >
            <Plus size={11} /> ADD TRACK
          </button>
        </div>

        {/* tracklist */}
        <div className="flex flex-col border-t border-charcoal/30">
          {tracks.map((t, i) => {
            const active = previewing === i && state.playing
            return (
              <div
                key={t.id}
                className="grid items-center gap-2 border-b border-charcoal/20 py-1.5 relative"
                style={{
                  gridTemplateColumns: '1.1rem 1.6rem 2rem minmax(8rem,1fr) minmax(7rem,11rem) 4.2rem 6.5rem 5.5rem 1.6rem 3.2rem',
                  opacity: t.include === false ? 0.45 : 1,
                }}
              >
                {/* progress underlay */}
                {(t.status === 'rendering' || t.status === 'done') && (
                  <div
                    className="absolute left-0 bottom-0 h-0.5"
                    style={{ width: `${Math.round(t.progress * 100)}%`, background: BURNT, transition: 'width .3s' }}
                  />
                )}
                <input
                  type="checkbox"
                  checked={t.include !== false}
                  onChange={(e) => patch(i, { include: e.target.checked })}
                  disabled={busy}
                  title="Include this track in the album render (unticked rows stay in the list)"
                  className="accent-[#D35400]"
                />
                <span className="text-[11px] tabular-nums opacity-60 text-right" title="Album position">
                  {t.include === false ? '—' : String(albumNumber(i)).padStart(2, '0')}
                </span>
                <button
                  onClick={() => preview(i)}
                  disabled={busy || noSources}
                  className="p-1.5 border border-charcoal/60 hover:bg-charcoal/10 disabled:opacity-30 justify-self-center"
                  title="Listen to this track live (starts from its seed)"
                  style={active ? { background: BURNT, color: CREAM, borderColor: BURNT } : undefined}
                >
                  <Play size={11} />
                </button>
                <input
                  value={t.title}
                  onChange={(e) => edit(i, { title: e.target.value })}
                  disabled={busy}
                  className="bg-transparent border-b border-charcoal/30 px-1 py-0.5 text-[13px] min-w-0"
                />
                <select
                  value={t.patch ? '__patch' : t.preset ?? ''}
                  onChange={(e) => e.target.value !== '__patch' && edit(i, { preset: e.target.value || null, patch: undefined })}
                  disabled={busy}
                  className="bg-transparent text-[10px] tracking-wider border border-charcoal/40 px-1 py-1 min-w-0"
                  title={PRESETS.find((p) => p.key === t.preset)?.hint ?? 'The sound currently set up in the studio'}
                >
                  {t.patch && <option value="__patch">COMPOSED SOUND</option>}
                  <option value="">STUDIO SOUND</option>
                  {PRESETS.map((p) => (
                    <option key={p.key} value={p.key}>{p.label.toUpperCase()}</option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-[9px] tracking-widest opacity-80">
                  <input
                    type="number"
                    min={0.5}
                    max={30}
                    step={0.5}
                    value={t.minutes}
                    onChange={(e) => edit(i, { minutes: Math.min(30, Math.max(0.5, Number(e.target.value) || 4)) })}
                    disabled={busy}
                    className="w-10 bg-transparent border-b border-charcoal/30 text-[11px]"
                    title="Length in minutes"
                  />
                  MIN
                </label>
                <span className="flex items-center gap-1">
                  <button
                    onClick={() => {
                      const seed = randomSeed()
                      edit(i, { seed, patch: t.patch ? { ...t.patch, s: seed } : undefined })
                    }}
                    disabled={busy}
                    className="p-1 hover:opacity-60 disabled:opacity-30"
                    title="Reroll: same character, a different take"
                  >
                    <Dices size={13} />
                  </button>
                  <span className="text-[9px] tabular-nums opacity-50 truncate" title="Seed — same seed + same sources = the same track">
                    {t.seed}
                  </span>
                </span>
                <span className="text-[10px] tabular-nums tracking-wider text-right" title={t.error}>
                  {t.status === 'rendering' && <span style={{ color: BURNT }}>{Math.round(t.progress * 100)}%</span>}
                  {t.status === 'queued' && <span className="opacity-50">QUEUED</span>}
                  {t.status === 'error' && <span style={{ color: '#B03A2E' }}>FAILED</span>}
                  {t.status === 'skipped' && <span className="opacity-60">SKIPPED</span>}
                  {t.status === 'cancelled' && <span className="opacity-60">STOPPED</span>}
                  {t.status === 'done' && t.report && (
                    <span title={`True peak ${fmtLu(t.report.truePeak)} dBTP`}>{fmtLu(t.report.integrated)} LUFS</span>
                  )}
                </span>
                <button
                  onClick={() => void render([i], 'files')}
                  disabled={busy || noSources}
                  className="p-1 hover:opacity-60 disabled:opacity-25 justify-self-center"
                  title="Render just this track to a WAV (same loudness as the album)"
                >
                  <Download size={12} />
                </button>
                <span className="flex items-center justify-end">
                  <button onClick={() => move(i, -1)} disabled={busy || i === 0} className="p-0.5 hover:opacity-60 disabled:opacity-20" title="Move up">
                    <ArrowUp size={12} />
                  </button>
                  <button onClick={() => move(i, 1)} disabled={busy || i === tracks.length - 1} className="p-0.5 hover:opacity-60 disabled:opacity-20" title="Move down">
                    <ArrowDown size={12} />
                  </button>
                  <button
                    onClick={() => setTracks((ts) => ts.filter((_, k) => k !== i))}
                    disabled={busy || tracks.length <= 1}
                    className="p-0.5 hover:opacity-60 disabled:opacity-20"
                    title="Remove track"
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
            )
          })}
        </div>

        {/* render / stop controls */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {!busy ? (
            <>
              {state.hasSampleReport && (
                <button
                  onClick={api.downloadSampleReport}
                  className="order-last flex items-center gap-1 border border-charcoal/60 px-2 py-2 text-[9px] tracking-widest hover:bg-charcoal/10"
                  title="samples.txt for the last export: every original recording used, with timestamps"
                >
                  <FileText size={11} /> SAMPLE REPORT
                </button>
              )}
              <button
                onClick={() => void render(included.map(({ i }) => i), output)}
                disabled={noSources || included.length === 0}
                className="px-6 py-2.5 border-2 text-[11px] tracking-[0.3em] font-bold disabled:opacity-30"
                style={{ borderColor: BURNT, background: BURNT, color: CREAM }}
              >
                RENDER {included.length} TRACK{included.length === 1 ? '' : 'S'}
              </button>
              <select
                value={output}
                onChange={(e) => setOutput(e.target.value as 'zip' | 'files')}
                className="border border-charcoal/60 bg-transparent px-1 py-2 text-[10px] tracking-widest"
                title="ONE .ZIP = WAVs + sleeves + tracklist in one archive · SEPARATE WAVS = one download per track"
              >
                <option value="zip">→ ONE .ZIP</option>
                <option value="files">→ SEPARATE WAVS</option>
              </select>
            </>
          ) : (
            <span className="flex flex-wrap gap-1.5 text-[9px] tracking-widest">
              <button
                onClick={() => api.skipAlbumTrack()}
                className="border border-charcoal/60 px-2.5 py-2 hover:bg-charcoal/10"
                title="Drop the track being rendered and continue with the next one"
              >
                SKIP TRACK ⏭
              </button>
              <button
                onClick={() => { stopAfter.current = true; setStopMode('after') }}
                disabled={stopMode !== null}
                className="border border-charcoal/60 px-2.5 py-2 hover:bg-charcoal/10 disabled:opacity-40"
                title="Let the current track finish, then stop and save what is done"
                style={stopMode === 'after' ? { background: CHARCOAL, color: CREAM } : undefined}
              >
                {stopMode === 'after' ? 'STOPPING AFTER THIS…' : 'STOP AFTER THIS TRACK'}
              </button>
              <button
                onClick={() => { setStopMode('now'); api.cancelRender() }}
                disabled={stopMode === 'now' || stopMode === 'discard'}
                className="border-2 px-2.5 py-2 font-bold disabled:opacity-40"
                style={{ borderColor: BURNT, color: BURNT }}
                title="Stop immediately (Esc) — tracks already finished are still saved"
              >
                ■ STOP NOW · KEEP FINISHED
              </button>
              <button
                onClick={() => {
                  if (!confirm('Cancel the album render and save nothing?')) return
                  discard.current = true
                  setStopMode('discard')
                  api.cancelRender()
                }}
                disabled={stopMode === 'discard'}
                className="border border-charcoal/60 px-2.5 py-2 hover:bg-charcoal/10 disabled:opacity-40"
                title="Stop immediately and throw everything away"
              >
                ✕ CANCEL ALL
              </button>
            </span>
          )}
          <div className="flex-1 min-w-40">
            {busy && state.renderProgress != null && (
              <div className="h-1.5 border border-charcoal/40">
                <div className="h-full" style={{ width: `${Math.round(state.renderProgress * 100)}%`, background: BURNT, transition: 'width .3s' }} />
              </div>
            )}
            <p className="text-[9px] tracking-widest opacity-60 mt-1">
              {noSources
                ? 'ADD SOURCES FIRST (STEM, UPLOAD, YOUTUBE…)'
                : busy
                  ? `${state.renderLabel} — THE STUDIO IS PAUSED WHILE RENDERING`
                  : done ?? 'TICK THE TRACKS TO RENDER · ⬇ ON A ROW EXPORTS JUST THAT TRACK · ESC STOPS A RENDER'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
