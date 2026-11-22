import { useEffect, useRef, useState } from 'react'
import { Dices, Disc3, Download, GripVertical, ListMusic, Play, Pin, PinOff, X } from 'lucide-react'
import type { useAudioEngine } from '../hooks/useAudioEngine'
import { MemoryWeave } from './MemoryWeave'
import { midi } from '../ui/midi'
import { MOODS } from '../engine/moods'
import type { MoodKnobs } from '../engine/moods'
import type { PinMode } from '../engine/types'
import { SLICE_MIME, hasSlices, readSliceIds } from '../ui/dnd'

type Api = ReturnType<typeof useAudioEngine>

const CHARCOAL = '#1A1A1A'
const BURNT = '#D35400'
const CREAM = '#F4EFEA'
const STORE = 'exotica.compose.v1'
const MODE_KEY = 'exotica.compose.mode'

const CAT_COLOR = { transient: BURNT, harmonic: CHARCOAL, texture: '#8A7F72' } as const

interface Saved {
  mood: string
  knobs: MoodKnobs
}

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Saved | null
    if (v && MOODS.some((m) => m.key === v.mood)) return v
  } catch { /* ignore */ }
  return { mood: 'ritual', knobs: MOODS.find((m) => m.key === 'ritual')!.knobs }
}

const PIN_MODES: Array<{ key: PinMode; label: string; hint: string }> = [
  { key: 'all', label: 'ALL SLICES', hint: 'Pins are ignored — every voice draws on the whole pool' },
  { key: 'favor', label: 'FAVOUR PINNED', hint: 'The whole pool, but your pinned dots come up four times as often' },
  { key: 'only', label: 'PINNED ONLY', hint: 'The composition is built from your pinned dots and nothing else' },
]

function Knob({ label, low, high, value, onChange }: {
  label: string; low: string; high: string; value: number; onChange: (v: number) => void
}) {
  return (
    <label className="flex flex-col gap-1 flex-1 min-w-40">
      <span className="flex justify-between text-[9px] tracking-widest">
        <b>{label}</b>
        <span className="opacity-60 tabular-nums">{Math.round(value * 100)}</span>
      </span>
      <input type="range" min={0} max={1} step={0.01} value={value}
        onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[#D35400]" aria-label={label} />
      <span className="flex justify-between text-[8px] tracking-wider opacity-50">
        <span>{low}</span><span>{high}</span>
      </span>
    </label>
  )
}

/**
 * Quick compose: 1) pick the dots the piece is made of, 2) a mood, 3) three
 * knobs, 4) listen / another take / sketch / render / send to the album.
 */
export function ComposePanel({ api, minutes, setMinutes }: {
  api: Api
  minutes: number
  setMinutes: (v: number) => void
}) {
  const { state } = api
  const [init] = useState(load)
  const [mood, setMood] = useState(init.mood)
  const [knobs, setKnobs] = useState<MoodKnobs>(init.knobs)
  const [stripHover, setStripHover] = useState(false)
  const [sketchBars, setSketchBars] = useState(8)
  const [title, setTitle] = useState('')
  const [advanced, setAdvancedState] = useState(() => {
    try { return localStorage.getItem(MODE_KEY) === 'advanced' } catch { return false }
  })
  const setAdvanced = (v: boolean) => {
    setAdvancedState(v)
    try { localStorage.setItem(MODE_KEY, v ? 'advanced' : 'simple') } catch { /* storage */ }
  }
  const applyTimer = useRef(0)
  const noSrc = state.slices.length === 0

  const pinned = state.slices.filter((s) => s.pinned)
  const moodDef = MOODS.find((m) => m.key === mood)!

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ mood, knobs } satisfies Saved))
    } catch { /* ignore */ }
  }, [mood, knobs])

  const chooseMood = (key: string) => {
    const m = MOODS.find((x) => x.key === key)!
    setMood(key)
    setKnobs(m.knobs)
    api.applyMood(key, m.knobs)
    if (!state.playing) api.listenFromTop()
  }

  // knobs re-apply live, lightly debounced so dragging a slider stays smooth
  const turn = (k: Partial<MoodKnobs>) => {
    const next = { ...knobs, ...k }
    setKnobs(next)
    window.clearTimeout(applyTimer.current)
    applyTimer.current = window.setTimeout(() => api.applyMood(mood, next), 150)
  }

  // MIDI: DARKNESS / SPACE / MOTION from a controller
  useEffect(() => midi.on((t, v) => {
    if (t === 'darkness' || t === 'space' || t === 'motion') turn({ [t]: v })
  }))

  const listen = () => {
    api.applyMood(mood, knobs)
    api.listenFromTop()
  }

  const memKnobs = mood === 'memory' ? knobs : MOODS.find((m) => m.key === 'memory')!.knobs
  const changeMinutes = (v: number) => {
    setMinutes(v)
    if (state.memoryForm) api.setMemoryMinutes(v)
  }

  const takeTitle = title.trim() || `${moodDef.label[0]}${moodDef.label.slice(1).toLowerCase()} ${state.seed}`

  return (
    <div className={`border border-charcoal/60 flex flex-col ${advanced ? '' : 'hide-adv'}`} style={{ background: CREAM }}>
      {/* SIMPLE: weave · mood · three knobs · listen / render — ADVANCED: everything */}
      <div className="px-3 py-1 flex items-center gap-2 border-b border-charcoal/20 text-[9px] tracking-widest">
        <span className="opacity-60">{advanced ? 'EVERY CONTROL' : 'ONLY WHAT YOU NEED FOR A GOOD RESULT'}</span>
        <span className="ml-auto flex border border-charcoal/60" role="radiogroup" aria-label="Compose mode">
          {([false, true] as const).map((adv) => (
            <button key={String(adv)} role="radio" aria-checked={advanced === adv} onClick={() => setAdvanced(adv)}
              className="px-2 py-0.5 border-r last:border-r-0 border-charcoal/40"
              style={advanced === adv ? { background: CHARCOAL, color: CREAM } : undefined}
              title={adv ? 'Sources & eras, layers, pins, takes, album, sketch' : 'Weave, mood, three knobs, listen, render'}>
              {adv ? 'ADVANCED' : 'SIMPLE'}
            </button>
          ))}
        </span>
      </div>
      <MemoryWeave api={api} minutes={minutes} setMinutes={setMinutes} knobs={memKnobs}
        onWeave={() => { setMood('memory'); setKnobs(memKnobs) }} />

      {/* 1 · material */}
      <div data-adv className="px-3 py-2 flex flex-col gap-2 border-b border-charcoal/20">
        <div className="flex items-center gap-2 flex-wrap">
          <b className="text-[10px] tracking-[0.25em]"><span style={{ color: BURNT }}>1</span> MATERIAL</b>
          <span className="flex border border-charcoal/60" role="radiogroup" aria-label="Which slices the composition uses">
            {PIN_MODES.map((m) => (
              <button key={m.key} role="radio" aria-checked={state.pinMode === m.key}
                onClick={() => api.setPinMode(m.key)} title={m.hint}
                className="px-2 py-1 text-[9px] tracking-widest border-r last:border-r-0 border-charcoal/40"
                style={state.pinMode === m.key ? { background: CHARCOAL, color: CREAM } : undefined}>
                {m.label}
              </button>
            ))}
          </span>
          <span className="text-[9px] tracking-widest opacity-60">
            {pinned.length} PINNED{state.pinMode !== 'all' && pinned.length === 0 ? ' — NOTHING PINNED YET, ALL SLICES PLAY' : ''}
          </span>
          {pinned.length > 0 && (
            <button onClick={api.clearPins} className="ml-auto flex items-center gap-1 text-[9px] tracking-widest hover:opacity-60">
              <PinOff size={11} /> CLEAR PINS
            </button>
          )}
        </div>

        {/* pin strip: drop dots here, drag them on to the arrangement */}
        <div
          onDragOver={(e) => {
            if (!hasSlices(e.dataTransfer)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            if (!stripHover) setStripHover(true)
          }}
          onDragLeave={() => setStripHover(false)}
          onDrop={(e) => {
            if (!hasSlices(e.dataTransfer)) return
            e.preventDefault()
            setStripHover(false)
            api.setPinned(readSliceIds(e.dataTransfer), true)
          }}
          className="min-h-11 border-2 border-dashed px-2 py-1.5 flex items-center gap-1.5 flex-wrap"
          style={{ borderColor: stripHover ? BURNT : 'rgba(26,26,26,0.25)', background: stripHover ? 'rgba(211,84,0,0.06)' : undefined }}
          aria-label="Pinned dots"
        >
          <Pin size={12} className="opacity-50 shrink-0" />
          {pinned.length === 0 && (
            <span className="text-[9px] tracking-widest opacity-50">
              DRAG DOTS FROM THE TIMBRE MAP HERE — OR SHIFT-CLICK THEM · ALT-CLICK PINS A DOT + ITS SOUND-ALIKES
            </span>
          )}
          {pinned.map((s) => (
            <span key={s.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(SLICE_MIME, JSON.stringify([s.id]))
                e.dataTransfer.effectAllowed = 'copy'
              }}
              className="flex items-center gap-1 border px-1.5 py-0.5 text-[9px] tracking-wider cursor-grab active:cursor-grabbing"
              style={{ borderColor: CAT_COLOR[s.category] }}
              title={`${state.sources[s.sourceIdx]?.name ?? ''} @ ${s.start.toFixed(2)}s — click to listen, drag onto ARRANGE`}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: CAT_COLOR[s.category] }} />
              <button onClick={() => api.auditionSlice(s.id)} className="hover:opacity-60 tabular-nums">
                #{s.id} · {s.duration.toFixed(2)}S
              </button>
              <button onClick={() => api.setPinned([s.id], false)} className="hover:opacity-60" aria-label={`Unpin ${s.id}`}>
                <X size={9} />
              </button>
            </span>
          ))}
          {pinned.length > 1 && (
            <span
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(SLICE_MIME, JSON.stringify(pinned.map((s) => s.id)))
                e.dataTransfer.effectAllowed = 'copy'
              }}
              className="ml-auto flex items-center gap-1 border border-charcoal/60 px-1.5 py-0.5 text-[9px] tracking-widest cursor-grab"
              title="Drag every pinned dot onto an ARRANGE track — they land end to end"
            >
              <GripVertical size={10} /> DRAG ALL → ARRANGE
            </span>
          )}
        </div>
      </div>

      {/* 2 · mood */}
      <div className="px-3 py-2 flex flex-col gap-2 border-b border-charcoal/20">
        <b className="text-[10px] tracking-[0.25em]"><span style={{ color: BURNT }}>2</span> MOOD</b>
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))' }} role="radiogroup" aria-label="Mood">
          {MOODS.map((m) => (
            <button key={m.key} role="radio" aria-checked={mood === m.key} disabled={noSrc}
              onClick={() => chooseMood(m.key)}
              className="text-left border-2 px-2.5 py-2 flex flex-col gap-1 disabled:opacity-40 hover:border-[#D35400]"
              style={mood === m.key ? { borderColor: BURNT, background: 'rgba(211,84,0,0.07)' } : { borderColor: 'rgba(26,26,26,0.35)' }}>
              <span className="text-[11px] tracking-[0.2em] font-bold" style={mood === m.key ? { color: BURNT } : undefined}>{m.label}</span>
              <span className="text-[9px] leading-snug opacity-70">{m.line}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 3 · knobs */}
      <div className="px-3 py-2 flex flex-col gap-2 border-b border-charcoal/20">
        <b className="text-[10px] tracking-[0.25em]"><span style={{ color: BURNT }}>3</span> SHAPE IT <span className="font-normal opacity-50 tracking-wider">— changes play live</span></b>
        <div className="flex flex-wrap gap-4">
          <Knob label="DARKNESS" low="pale" high="black" value={knobs.darkness} onChange={(v) => turn({ darkness: v })} />
          <Knob label="SPACE" low="close" high="cavern" value={knobs.space} onChange={(v) => turn({ space: v })} />
          <Knob label="MOTION" low="frozen" high="restless" value={knobs.motion} onChange={(v) => turn({ motion: v })} />
        </div>
      </div>

      {/* 4 · actions */}
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
        <b className="text-[10px] tracking-[0.25em] mr-1"><span style={{ color: BURNT }}>4</span> KEEP IT</b>
        <button onClick={listen} disabled={noSrc}
          className="flex items-center gap-1.5 border-2 px-3 py-1.5 text-[10px] tracking-[0.2em] font-bold disabled:opacity-40"
          style={{ borderColor: BURNT, background: BURNT, color: CREAM }} title="Apply the mood and play from the top">
          <Play size={12} /> LISTEN
        </button>
        <button onClick={() => { api.reseed(); api.listenFromTop() }} disabled={noSrc}
          className="flex items-center gap-1.5 border border-charcoal/60 px-2.5 py-1.5 text-[9px] tracking-widest hover:bg-charcoal/10 disabled:opacity-40"
          title="Same mood and dots, a different take (new seed)">
          <Dices size={12} /> ANOTHER TAKE
        </button>
        <span data-adv className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-1">
          <button onClick={() => api.sketchArrangement(sketchBars)} disabled={noSrc}
            className="flex items-center gap-1 text-[9px] tracking-widest hover:opacity-70 disabled:opacity-40"
            title="Lay the pinned dots (or the best of the pool) onto ARRANGE as a short piece to edit by hand">
            <ListMusic size={12} /> SKETCH TO ARRANGE
          </button>
          <select value={sketchBars} onChange={(e) => setSketchBars(Number(e.target.value))}
            className="bg-transparent text-[9px] tracking-widest border-l border-charcoal/30 pl-1" aria-label="Sketch length">
            {[4, 8, 16].map((b) => <option key={b} value={b}>{b} BARS</option>)}
          </select>
        </span>
        <span className="flex-1" />
        <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-1">
          <input type="number" min={0.5} max={45} step={0.5} value={minutes}
            onChange={(e) => changeMinutes(Math.min(45, Math.max(0.5, Number(e.target.value) || 2)))}
            className="w-10 bg-transparent text-[10px]" aria-label="Length in minutes" />
          <span className="text-[9px] opacity-60">MIN</span>
          <button onClick={() => void api.renderToWav(minutes)} disabled={noSrc || state.rendering}
            className="flex items-center gap-1 text-[9px] tracking-widest border-l border-charcoal/30 pl-1.5 hover:opacity-70 disabled:opacity-40"
            title="Render this sound to a WAV now (uses the EXPORT format & loudness)">
            <Download size={12} /> RENDER
          </button>
        </span>
        <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-1">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={takeTitle}
            className="w-32 bg-transparent text-[10px] outline-none placeholder:opacity-45" aria-label="Track title for the album" />
          <button onClick={() => { api.addToAlbum(takeTitle, minutes); setTitle('') }} disabled={noSrc}
            className="flex items-center gap-1 text-[9px] tracking-widest border-l border-charcoal/30 pl-1.5 hover:opacity-70 disabled:opacity-40"
            title="Add exactly this sound (mood, knobs, seed, mixer) to the album as a new track">
            <Disc3 size={12} /> + ALBUM
          </button>
        </span>
      </div>
    </div>
  )
}
