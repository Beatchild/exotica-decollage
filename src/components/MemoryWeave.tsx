import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Disc3, Music, Play, RefreshCw, Sparkles, Shuffle } from 'lucide-react'
import type { useAudioEngine } from '../hooks/useAudioEngine'
import { NOTE_NAMES } from '../hooks/useAudioEngine'
import { MEMORY_SECTIONS } from '../engine/memory'
import { ERAS } from '../engine/eras'
import type { Era } from '../engine/eras'
import type { MoodKnobs } from '../engine/moods'
import { randomSeed } from '../engine/rng'
import { midi } from '../ui/midi'
import { modeOf } from '../engine/lines'

type Api = ReturnType<typeof useAudioEngine>

const CHARCOAL = '#1A1A1A'
const BURNT = '#D35400'
const CREAM = '#F4EFEA'
const WEIGHTS_KEY = 'exotica.weave.weights.v1'

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
const weightLabel = (w: number) => (w === 0 ? 'OFF' : `${w.toFixed(w % 1 ? 2 : 0).replace(/0$/, '')}×`)

function loadWeights(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(WEIGHTS_KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

function Slider({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-0.5 flex-1 min-w-36" title={hint}>
      <span className="flex justify-between text-[9px] tracking-widest">
        <b>{label}</b>
        <span className="opacity-60 tabular-nums">{value < 0.02 ? 'OFF' : Math.round(value * 100)}</span>
      </span>
      <input type="range" min={0} max={1} step={0.01} value={value} aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[#D35400]" />
      <span className="text-[8px] tracking-wider opacity-50 leading-tight">{hint}</span>
    </label>
  )
}

/**
 * MEMORY WEAVE: one haunted, tonal track (or a whole album) from every source —
 * per-source weight and old medium, the memory layers, a live form timeline
 * (click to jump, drag the seams to re-proportion), three takes to compare.
 */
export function MemoryWeave({ api, minutes, setMinutes, knobs, onWeave }: {
  api: Api
  minutes: number
  setMinutes: (v: number) => void
  /** the FORGOTTEN MEMORY knobs to weave with */
  knobs: MoodKnobs
  /** tell COMPOSE the mood is now FORGOTTEN MEMORY */
  onWeave: () => void
}) {
  const { state } = api
  const noSrc = state.slices.length === 0
  const [perSource, setPerSource] = useState(6)
  const [weightsByName, setWeightsByName] = useState<Record<string, number>>(loadWeights)
  const [takes, setTakes] = useState<number[] | null>(null)
  const [takeIdx, setTakeIdx] = useState(-1)
  const [albumCount, setAlbumCount] = useState(8)
  const [albumMin, setAlbumMin] = useState(4)
  const [albumTitle, setAlbumTitle] = useState('')
  const [polledPos, setPos] = useState<number | null>(null)
  const [dragSecs, setDragSecs] = useState<number[] | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const sources = state.sources.map((src, i) => ({ src, i })).filter((x) => !x.src.bed)
  const weights: Record<number, number> = {}
  for (const { src, i } of sources) weights[i] = weightsByName[src.name] ?? 1
  const pinnedBySource = new Map<number, number>()
  for (const s of state.slices) if (s.pinned) pinnedBySource.set(s.sourceIdx, (pinnedBySource.get(s.sourceIdx) ?? 0) + 1)

  useEffect(() => {
    try {
      localStorage.setItem(WEIGHTS_KEY, JSON.stringify(weightsByName))
    } catch { /* ignore */ }
  }, [weightsByName])

  // live playhead over the form
  useEffect(() => {
    if (!state.songActive || !state.memoryForm) return
    const id = window.setInterval(() => setPos(api.getSongPos()), 250)
    return () => window.clearInterval(id)
  }, [state.songActive, state.memoryForm, api])

  const weave = (regather = true) => {
    onWeave()
    setTakes(null)
    api.weaveMemory(minutes, knobs, { regather, perSource, weights })
  }

  const pos = state.songActive && state.memoryForm ? polledPos : null
  // MIDI: a pad that weaves
  useEffect(() => midi.on((t) => {
    if (t === 'weave' && !noSrc) weave(true)
  }))

  const secs = dragSecs ?? state.memorySecs
  const total = secs.reduce((a, b) => a + b, 0)
  const sectionNow = pos == null ? -1 : (() => {
    let acc = 0
    for (let i = 0; i < secs.length; i++) {
      acc += secs[i]
      if (pos < acc) return i
    }
    return -1
  })()

  // dragging the seam between section i and i+1
  const startDrag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const el = barRef.current
    if (!el) return
    const w = el.getBoundingClientRect().width
    const x0 = e.clientX
    const base = [...state.memorySecs]
    let cur = base
    const move = (ev: PointerEvent) => {
      const d = ((ev.clientX - x0) / Math.max(1, w)) * total
      const a = Math.max(8, Math.min(base[i] + base[i + 1] - 8, base[i] + d))
      cur = [...base]
      cur[i] = a
      cur[i + 1] = base[i] + base[i + 1] - a
      setDragSecs(cur)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragSecs(null)
      api.setMemorySecs(cur)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const L = state.memLayers

  return (
    <div className="px-3 py-2.5 flex flex-col gap-2.5 border-b-2" style={{ borderColor: BURNT, background: 'rgba(211,84,0,0.05)' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <b className="text-[11px] tracking-[0.25em]" style={{ color: BURNT }}>MEMORY WEAVE</b>
        <span className="text-[9px] tracking-wider opacity-70">
          one haunted, tonal track from all your sources — a memory you don't remember having
        </span>
      </div>

      {/* sources: how much of each, and on what old medium */}
      {sources.length > 0 && (
        <div data-adv className="flex flex-col gap-1" aria-label="Sources in the weave">
          <div className="text-[8px] tracking-[0.25em] opacity-55">SOURCES — HOW MUCH OF EACH · WHAT IT WAS RECORDED ON</div>
          {sources.map(({ src, i }) => {
            const w = weights[i]
            return (
              <div key={i} className="flex items-center gap-2 text-[9px] tracking-wider flex-wrap">
                <span className="w-44 truncate" title={src.name} style={{ opacity: w === 0 ? 0.4 : 1 }}>{src.name}</span>
                <input type="range" min={0} max={2} step={0.25} value={w} aria-label={`Weight of ${src.name}`}
                  onChange={(e) => setWeightsByName({ ...weightsByName, [src.name]: Number(e.target.value) })}
                  className="w-28 accent-[#D35400]" title="0 = leave this source out · 2 = twice as many fragments" />
                <span className="w-8 tabular-nums opacity-70">{weightLabel(w)}</span>
                <select value={src.era ?? 'none'} onChange={(e) => api.setSourceEra(i, e.target.value as Era)}
                  className="bg-transparent border border-charcoal/40 px-1 py-0.5 text-[9px] tracking-widest" aria-label={`Medium of ${src.name}`}
                  title={ERAS.find((x) => x.key === (src.era ?? 'none'))?.line}>
                  {ERAS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                {state.memoryForm && <span className="opacity-60">{pinnedBySource.get(i) ?? 0} fragments</span>}
              </div>
            )
          })}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => weave(true)} disabled={noSrc}
          className="flex items-center gap-1.5 border-2 px-3 py-1.5 text-[10px] tracking-[0.2em] font-bold disabled:opacity-40"
          style={{ borderColor: BURNT, background: BURNT, color: CREAM }}
          title="Gather the most tonal fragments from every source (by weight), tune them to one key, arrange them in four sections and play">
          <Sparkles size={12} /> {state.memoryForm ? 'WEAVE AGAIN' : 'WEAVE A MEMORY'}
        </button>
        <label data-adv className="flex items-center gap-1 text-[9px] tracking-widest border border-charcoal/40 px-1.5 py-1"
          title="How many fragments to take from each source (before its weight)">
          <select value={perSource} onChange={(e) => setPerSource(Number(e.target.value))}
            className="bg-transparent" aria-label="Fragments per source">
            {[3, 4, 6, 8, 12].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          PER SOURCE
        </label>
        {state.memoryForm && (
          <>
            <button onClick={() => api.playMemory(0)}
              className="flex items-center gap-1 border border-charcoal/60 px-2 py-1 text-[9px] tracking-widest hover:bg-charcoal/10"
              title="Play the woven track from its first section">
              <Play size={11} /> FROM THE START
            </button>
            <button data-adv onClick={() => weave(false)}
              className="flex items-center gap-1 border border-charcoal/60 px-2 py-1 text-[9px] tracking-widest hover:bg-charcoal/10"
              title="Keep these fragments (and any you pinned or unpinned by hand), rebuild the form">
              <RefreshCw size={11} /> KEEP FRAGMENTS, REBUILD
            </button>
            <span data-adv className="flex items-center border border-charcoal/60 text-[9px] tracking-widest" title="The key everything is tuned to — read from the fragments">
              <button onClick={() => api.setKeyRoot(state.keyRoot + 11)} className="px-1 py-1 hover:opacity-60" aria-label="Key down"><ChevronLeft size={11} /></button>
              <span className="px-1 tabular-nums">KEY {NOTE_NAMES[state.keyRoot]}</span>
              <button onClick={() => api.setKeyRoot(state.keyRoot + 1)} className="px-1 py-1 hover:opacity-60" aria-label="Key up"><ChevronRight size={11} /></button>
            </span>
          </>
        )}
      </div>

      {state.memoryForm && (
        <>
          {/* the form, live: click a section to jump there, drag a seam to re-proportion */}
          <div ref={barRef} className="relative flex w-full border border-charcoal/50 text-[9px] select-none" aria-label="Track form">
            {MEMORY_SECTIONS.map((sec, i) => (
              <div key={sec.key}
                role="button" tabIndex={0}
                onClick={() => api.playMemory(i)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && api.playMemory(i)}
                className="relative px-1.5 py-1 border-r last:border-r-0 border-charcoal/30 min-w-0 cursor-pointer hover:bg-[rgba(211,84,0,0.08)]"
                style={{
                  flexGrow: secs[i] ?? 1, flexBasis: 0,
                  background: sectionNow === i ? 'rgba(211,84,0,0.16)' : `rgba(26,26,26,${[0.03, 0.08, 0.16, 0.06][i]})`,
                }}
                title={`${sec.line} — click to play from here`}>
                <div className="tracking-widest font-bold truncate" style={sectionNow === i ? { color: BURNT } : undefined}>{sec.label}</div>
                <div className="opacity-60 truncate">{fmt(secs[i] ?? 0)} · {sec.line}</div>
                {i < 3 && (
                  <span onPointerDown={startDrag(i)} onClick={(e) => e.stopPropagation()}
                    className="absolute top-0 -right-1.5 w-3 h-full z-10 cursor-col-resize flex items-center justify-center"
                    title="Drag to make this section longer or shorter" aria-label={`Resize ${sec.label}`}>
                    <span className="w-0.5 h-3/5" style={{ background: CHARCOAL, opacity: 0.5 }} />
                  </span>
                )}
              </div>
            ))}
            {pos != null && total > 0 && (
              <span className="absolute top-0 bottom-0 w-0.5 pointer-events-none" aria-hidden
                style={{ left: `${Math.min(100, (pos / total) * 100)}%`, background: BURNT }} />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[9px] tracking-widest">
            <span className="opacity-60">TOTAL {fmt(total)}</span>
            <span className="flex items-center gap-1 border border-charcoal/40 px-1.5 py-0.5">
              <input type="number" min={1} max={45} step={0.5} value={minutes}
                onChange={(e) => {
                  const v = Math.min(45, Math.max(1, Number(e.target.value) || 2))
                  setMinutes(v)
                  api.setMemoryMinutes(v)
                }}
                className="w-10 bg-transparent" aria-label="Woven track length in minutes" />
              MIN
            </span>
            <span data-adv className="opacity-50">— shift-click dots to add fragments, × in the pin strip to remove, then KEEP FRAGMENTS, REBUILD</span>
          </div>

          {/* memory layers */}
          <div data-adv className="flex flex-wrap gap-4 items-end">
            <Slider label="STRETCH" value={L.stretch} onChange={(v) => api.setMemoryLayers({ stretch: v })}
              hint="fragments slowed into breathing clouds — strongest in DUST and DISSOLVING" />
            <Slider label="RETURNING MELODY" value={L.motif} onChange={(v) => api.setMemoryLayers({ motif: v })}
              hint="one melody: far off, then whole, then back slower and broken" />
            <Slider label="MELODIC LINES" value={L.lines ?? 0} onChange={(v) => api.setMemoryLayers({ lines: v })}
              hint={`lead · ostinato (vibes, tremolo) · counter-line from 45 · bell echoes from 70 — in ${modeOf(L.motifSeed).toUpperCase()}, quoting the melody`} />
            <Slider label="GHOST VOICES" value={L.ghosts} onChange={(v) => api.setMemoryLayers({ ghosts: v })}
              hint="the most voice-like fragments, through a wall or an old phone" />
            <Slider label="DISINTEGRATING TAPE" value={L.loop ?? 0} onChange={(v) => api.setMemoryLayers({ loop: v })}
              hint="DISSOLVING: one phrase loops and falls apart a little more every pass, until only fragments remain" />
            <button onClick={() => api.setMemoryLayers({ motifSeed: randomSeed() })}
              className="flex items-center gap-1 border border-charcoal/60 px-2 py-1 text-[9px] tracking-widest hover:bg-charcoal/10"
              title="Another melody: the returning motif and the melodic lines (and their mode)">
              <Music size={11} /> ANOTHER MELODY
            </button>
          </div>

          {/* three takes */}
          <div data-adv className="flex flex-wrap items-center gap-2">
            <button onClick={() => { setTakes([randomSeed(), randomSeed(), randomSeed()]); setTakeIdx(-1) }}
              className="flex items-center gap-1 border border-charcoal/60 px-2 py-1 text-[9px] tracking-widest hover:bg-charcoal/10"
              title="Three different takes of the same weave — compare, keep the best">
              <Shuffle size={11} /> 3 TAKES
            </button>
            {takes?.map((seed, k) => (
              <span key={seed} className="flex items-center gap-1 border px-1.5 py-1 text-[9px] tracking-widest"
                style={{ borderColor: takeIdx === k ? BURNT : 'rgba(26,26,26,0.4)', background: takeIdx === k ? 'rgba(211,84,0,0.08)' : undefined }}>
                <b style={takeIdx === k ? { color: BURNT } : undefined}>TAKE {'ABC'[k]}</b>
                <button onClick={() => { setTakeIdx(k); api.playMemory(0, seed) }} className="hover:opacity-60 px-1" title="Play this take from the start">▶ START</button>
                <button onClick={() => { setTakeIdx(k); api.playMemory(2, seed) }} className="hover:opacity-60 px-1" title="Jump straight to THE MEMORY — the heart of this take">▶ HEART</button>
              </span>
            ))}
            {takes && takeIdx >= 0 && (
              <button onClick={() => setTakes(null)}
                className="border-2 px-2 py-0.5 text-[9px] tracking-widest font-bold"
                style={{ borderColor: BURNT, color: BURNT }}
                title="Keep this take: it stays the studio's sound (+ ALBUM / RENDER use it)">
                KEEP TAKE {'ABC'[takeIdx]}
              </button>
            )}
          </div>
        </>
      )}

      {/* a whole album from the same material */}
      <div data-adv className="flex flex-wrap items-center gap-2 border-t border-charcoal/20 pt-2">
        <b className="text-[9px] tracking-[0.25em]">WEAVE AN ALBUM</b>
        <select value={albumCount} onChange={(e) => setAlbumCount(Number(e.target.value))}
          className="bg-transparent border border-charcoal/40 px-1 py-0.5 text-[9px] tracking-widest" aria-label="Number of tracks">
          {[4, 5, 6, 7, 8, 9, 10, 12].map((n) => <option key={n} value={n}>{n} TRACKS</option>)}
        </select>
        <span className="flex items-center gap-1 border border-charcoal/40 px-1.5 py-0.5 text-[9px] tracking-widest">
          ~<input type="number" min={2} max={15} step={0.5} value={albumMin}
            onChange={(e) => setAlbumMin(Math.min(15, Math.max(2, Number(e.target.value) || 4)))}
            className="w-9 bg-transparent" aria-label="Average track length in minutes" /> MIN EACH
        </span>
        <input value={albumTitle} onChange={(e) => setAlbumTitle(e.target.value)} placeholder="album title"
          className="w-36 bg-transparent border border-charcoal/40 px-1.5 py-0.5 text-[10px] outline-none placeholder:opacity-45" aria-label="Album title" />
        <button disabled={noSrc}
          onClick={() => api.weaveAlbum({ count: albumCount, minutes: albumMin, knobs, perSource, weights, title: albumTitle })}
          className="flex items-center gap-1 border-2 px-2 py-1 text-[9px] tracking-widest font-bold disabled:opacity-40"
          style={{ borderColor: CHARCOAL }}
          title="Each track leans on different sources, in related keys, light → dark → light; the last track brings back the first one's melody. Replaces the album plan (the old one is kept as a backup).">
          <Disc3 size={11} /> WEAVE ALBUM
        </button>
        <span className="text-[8px] tracking-wider opacity-50">related keys · light → dark → light · the last track remembers the first</span>
      </div>
    </div>
  )
}
