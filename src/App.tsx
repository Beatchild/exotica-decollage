import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Play, Pause, RotateCcw, Circle, Square, Volume2, VolumeX, Upload, Dices, Mic, X, Plus,
  Clapperboard, Snowflake, Radio, Disc3, Search, HelpCircle, Package,
} from 'lucide-react'
import { useAudioEngine } from './hooks/useAudioEngine'
import { AudioVisualizer } from './components/AudioVisualizer'
import { ArrangeView } from './components/ArrangeView'
import { MixerRack } from './components/MixerRack'
import { AlbumPanel } from './components/AlbumPanel'
import { ComposePanel } from './components/ComposePanel'
import { LoudnessMeterView } from './components/LoudnessMeterView'
import { BUNDLED_STEMS } from './engine/stems'
import { LOUDNESS_TARGETS } from './engine/loudness'
import { PRESETS } from './engine/album'
import { MOODS } from './engine/moods'
import { MixMasterPanel } from './components/MixMasterPanel'
import { MASTER_PRESETS } from './engine/mastering'
import { Section } from './ui/Section'
import { setSectionOpen } from './ui/sectionEvents'
import { ExportMenu } from './ui/ExportMenu'
import { CommandPalette } from './ui/CommandPalette'
import type { Command } from './ui/CommandPalette'
import { HelpOverlay } from './ui/HelpOverlay'
import { Toasts } from './ui/Toasts'

const CHARCOAL = '#1A1A1A'
const BURNT = '#D35400'
const CREAM = '#F4EFEA'

const SECTIONS = [
  { id: 'sources', label: 'SOURCES', hint: 'what the music is made from' },
  { id: 'waveform', label: 'WAVEFORM', hint: 'slices, timbre map, regions' },
  { id: 'compose', label: 'COMPOSE', hint: 'pinned dots · mood · three knobs' },
  { id: 'arrange', label: 'ARRANGE', hint: 'place clips on a timeline' },
  { id: 'mixer', label: 'MIXER', hint: 'voices, macros, characters, scenes' },
  { id: 'master', label: 'MASTER', hint: 'mix buses · release chain · loudness · final render' },
] as const

const PRESET_API = {
  pekler: 'peklerPreset', afrika: 'afrikaPreset', templeton: 'templetonPreset', jelinek: 'jelinekPreset',
  poirier: 'poirierPreset', jeck: 'jeckPreset', caretaker: 'caretakerPreset', pole: 'polePreset',
  books: 'booksPreset', hassell: 'hassellPreset', loscil: 'loscilPreset', ges: 'gesPreset',
  ielasi: 'ielasiPreset', microstoria: 'microstoriaPreset', keszler: 'keszlerPreset', budd: 'buddPreset',
} as const

const chip = 'flex items-center gap-1.5 text-[9px] tracking-widest border border-charcoal/60 px-2 py-1 hover:bg-charcoal/10 disabled:opacity-40'

export default function App() {
  const api = useAudioEngine()
  const { state } = api
  const [dragOver, setDragOver] = useState(false)
  const [renderMin, setRenderMin] = useState(2)
  const [loopBars, setLoopBars] = useState(8)
  const [albumOpen, setAlbumOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [remixCount, setRemixCount] = useState(3)
  const [freezeSec, setFreezeSec] = useState(12)
  const [ytUrl, setYtUrl] = useState('')
  const [crateName, setCrateName] = useState('')
  const [ytMode, setYtMode] = useState<'collage' | 'mixtape' | 'interleave'>('collage')
  const [autoMix, setAutoMix] = useState(false)
  const [active, setActive] = useState<string>('sources')
  const scroller = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const ytInput = useRef<HTMLTextAreaElement>(null)

  const jump = useCallback((id: string) => {
    setSectionOpen(id, true)
    // timeout, not rAF: rAF is paused in background tabs/panes, which made tabs do nothing
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
  }, [])

  const overlayOpen = albumOpen || paletteOpen || helpOpen

  // keyboard: palette, help, sections, transport, armed-slice performance
  useEffect(() => {
    const PERF_KEYS: Record<string, number> = {
      KeyA: 0, KeyS: 2, KeyD: 4, KeyF: 5, KeyG: 7, KeyH: 9, KeyJ: 11, KeyK: 12, KeyL: 14,
    }
    const onKey = (e: KeyboardEvent) => {
      if (!api.state.started) return
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      // Esc: stop a render first; otherwise close the topmost overlay
      if (e.key === 'Escape') {
        if (api.state.rendering || api.state.bouncing) {
          e.preventDefault()
          api.cancelRender()
        }
        return
      }
      const t = e.target as HTMLElement
      if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return
      if (overlayOpen) return
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) api.redo()
        else api.undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
        e.preventDefault()
        api.redo()
        return
      }
      if (e.ctrlKey || e.metaKey) return
      if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(true)
      } else if (e.altKey && /^Digit[1-6]$/.test(e.code)) {
        e.preventDefault()
        jump(SECTIONS[Number(e.code.slice(5)) - 1].id)
      } else if (e.altKey) {
        return
      } else if (e.code === 'Space') {
        e.preventDefault()
        if (api.state.playing) api.pause()
        else api.play()
      } else if (e.code === 'KeyR' && !e.repeat) {
        api.toggleRecording()
      } else if (/^Digit[1-4]$/.test(e.code) && !e.repeat) {
        const slot = Number(e.code.slice(5)) - 1
        if (api.state.scenesFilled[slot]) api.morphScene(slot, 10)
        else api.saveScene(slot)
      } else if (e.code in PERF_KEYS && !e.repeat) {
        api.playArmedAt(PERF_KEYS[e.code] + (e.shiftKey ? -12 : 0))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api, overlayOpen, jump])

  // highlight the nav tab of the section in view
  useEffect(() => {
    const root = scroller.current
    if (!root || !state.started) return
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (vis[0]) setActive((vis[0].target as HTMLElement).dataset.section ?? 'sources')
      },
      { root, rootMargin: '-110px 0px -55% 0px' },
    )
    root.querySelectorAll('[data-section]').forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [state.started])

  const ytOpts = useCallback(
    () => ({ mode: ytMode, auto: autoMix, remixCount, minutes: renderMin }),
    [ytMode, autoMix, remixCount, renderMin],
  )

  const submitYt = useCallback(() => {
    const url = ytUrl.trim()
    if (!url) return
    setYtUrl('')
    void api.addYouTube(url, ytOpts())
  }, [api, ytUrl, ytOpts])

  const openFile = (f: File) => {
    if (f.name.endsWith('.crate')) void api.crateImport(f)
    else if (f.type.startsWith('image/')) void api.loadImage(f)
    else void api.loadFile(f)
  }

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files?.[0]
      if (file) {
        if (file.name.endsWith('.crate')) void api.crateImport(file)
        else if (file.type.startsWith('image/')) void api.loadImage(file)
        else void api.loadFile(file)
        return
      }
      // dropped link(s) — e.g. dragged from a browser tab or a text selection
      const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
      if (text && /youtube\.com|youtu\.be/.test(text)) void api.addYouTube(text, ytOpts())
    },
    [api, ytOpts],
  )

  // every action, searchable from Ctrl+K
  const commands = useMemo<Command[]>(() => {
    const idle = state.rendering
    const noSrc = state.slices.length === 0
    const list: Command[] = [
      { id: 'play', group: 'TRANSPORT', label: state.playing ? 'Pause' : 'Play', keys: 'SPACE', run: () => (state.playing ? api.pause() : api.play()) },
      { id: 'reset', group: 'TRANSPORT', label: 'Restart from the seed', run: api.reset },
      { id: 'rec', group: 'TRANSPORT', label: state.recording ? 'Stop live recording → WAV' : 'Start live recording', keys: 'R', run: api.toggleRecording },
      { id: 'reseed', group: 'TRANSPORT', label: 'New seed (reroll)', hint: 'same sound, a different take', run: api.reseed },
      { id: 'radio', group: 'TRANSPORT', label: state.radio ? 'Radio mode off' : 'Radio mode on', hint: 'endless stream', run: () => api.setRadio(!state.radio) },
      { id: 'mute', group: 'TRANSPORT', label: state.masterMuted ? 'Unmute master' : 'Mute master', run: api.toggleMasterMute },
      { id: 'render', group: 'EXPORT', label: `Render track (${renderMin} min)`, disabled: idle || noSrc, run: () => void api.renderToWav(renderMin) },
      { id: 'stems', group: 'EXPORT', label: 'Render stems', disabled: idle || noSrc, run: () => void api.renderStemsToWav(renderMin) },
      { id: 'loop', group: 'EXPORT', label: `Render loop (${loopBars} bars)`, disabled: idle || noSrc, run: () => void api.renderLoop(loopBars) },
      { id: 'remix', group: 'EXPORT', label: `Remix ×${remixCount}`, hint: 'YouTube / Freeze material', disabled: idle || noSrc, run: () => void api.remixCollages(remixCount, renderMin) },
      { id: 'album', group: 'EXPORT', label: 'Album builder…', disabled: idle, run: () => setAlbumOpen(true) },
      { id: 'report', group: 'EXPORT', label: 'Sample report for the last export', disabled: !state.hasSampleReport, run: api.downloadSampleReport },
      { id: 'stop', group: 'EXPORT', label: 'Stop the render', keys: 'ESC', disabled: !state.rendering && !state.bouncing, run: api.cancelRender },
      ...LOUDNESS_TARGETS.map((t) => ({
        id: `lufs${t.lufs}`, group: 'EXPORT SETTINGS', label: `Loudness: ${t.lufs == null ? 'off' : `${t.lufs} LUFS`}`, hint: t.label.toLowerCase(),
        run: () => api.setLoudnessTarget(t.lufs),
      })),
      { id: 'b24', group: 'EXPORT SETTINGS', label: 'Bit depth: 24-bit', run: () => api.setExportFormat({ bits: 24 }) },
      { id: 'b16', group: 'EXPORT SETTINGS', label: 'Bit depth: 16-bit (CD)', run: () => api.setExportFormat({ bits: 16 }) },
      { id: 'sr441', group: 'EXPORT SETTINGS', label: 'Sample rate: 44.1 kHz', run: () => api.setExportFormat({ sampleRate: 44100 }) },
      { id: 'sr48', group: 'EXPORT SETTINGS', label: 'Sample rate: 48 kHz', run: () => api.setExportFormat({ sampleRate: 48000 }) },
      ...MOODS.map((m) => ({
        id: `mood-${m.key}`, group: 'COMPOSE', label: `Mood: ${m.label.toLowerCase()}`, hint: m.line,
        disabled: noSrc,
        run: () => { api.applyMood(m.key, m.knobs); api.listenFromTop() },
      })),
      { id: 'pin-all', group: 'COMPOSE', label: 'Material: all slices', run: () => api.setPinMode('all') },
      { id: 'pin-favor', group: 'COMPOSE', label: 'Material: favour pinned dots', run: () => api.setPinMode('favor') },
      { id: 'pin-only', group: 'COMPOSE', label: 'Material: pinned dots only', run: () => api.setPinMode('only') },
      { id: 'pin-clear', group: 'COMPOSE', label: 'Clear all pins', disabled: state.pinnedCount === 0, run: api.clearPins },
      { id: 'weave', group: 'COMPOSE', label: 'Weave a memory — one haunted track from all sources', disabled: noSrc,
        run: () => api.weaveMemory(renderMin, MOODS.find((m) => m.key === 'memory')!.knobs) },
      ...MASTER_PRESETS.map((p) => ({
        id: `master-${p.key}`, group: 'MASTER', label: `Master: ${p.label.toLowerCase()}`, hint: p.line,
        run: () => api.setMaster({ preset: p.key }),
      })),
      { id: 'master-ab', group: 'MASTER', label: state.masterBypass ? 'Switch the master on' : 'Switch the master off (A/B)', run: () => api.setMasterBypass(!state.masterBypass) },
      { id: 'undo', group: 'EDIT', label: 'Undo', keys: 'CTRL+Z', disabled: !state.canUndo, run: () => api.undo() },
      { id: 'redo', group: 'EDIT', label: 'Redo', keys: 'CTRL+SHIFT+Z', disabled: !state.canRedo, run: () => api.redo() },
      { id: 'exact-heart', group: 'MASTER', label: 'Exact preview — 30 s of the heart, mastered exactly like the export', disabled: noSrc, run: () => void api.exactPreview('heart') },
      { id: 'weave-album', group: 'COMPOSE', label: 'Weave an album — 8 related tracks from all sources (replaces the album plan)', disabled: noSrc,
        run: () => api.weaveAlbum({ count: 8, minutes: 4, knobs: MOODS.find((m) => m.key === 'memory')!.knobs, perSource: 6, weights: {} }) },
      { id: 'sketch', group: 'COMPOSE', label: 'Sketch 8 bars onto the arrangement', disabled: noSrc, run: () => api.sketchArrangement(8) },
      ...PRESETS.map((p) => ({
        id: `preset-${p.key}`, group: 'CHARACTER', label: `Character: ${p.label}`, hint: p.hint,
        run: () => (api[PRESET_API[p.key as keyof typeof PRESET_API]] as () => void)(),
      })),
      ...['A', 'B', 'C', 'D'].map((s, i) => ({
        id: `scene${s}`, group: 'SCENES', keys: String(i + 1),
        label: state.scenesFilled[i] ? `Morph to scene ${s}` : `Save scene ${s}`,
        run: () => (state.scenesFilled[i] ? api.morphScene(i, 10) : api.saveScene(i)),
      })),
      ...BUNDLED_STEMS.filter((s) => !state.sources.some((x) => x.stemKey === s.key)).map((s) => ({
        id: `stem-${s.key}`, group: 'SOURCES', label: `Add stem: ${s.name}`, run: () => void api.addStem(s.key),
      })),
      { id: 'upload', group: 'SOURCES', label: 'Upload audio / image / .crate…', run: () => fileInput.current?.click() },
      { id: 'mic', group: 'SOURCES', label: 'Sample 8s from the microphone', run: () => void api.sampleFromMic(8) },
      { id: 'yt', group: 'SOURCES', label: 'Paste YouTube / Spotify links…', disabled: !state.ytAvailable, run: () => { jump('sources'); setTimeout(() => ytInput.current?.focus(), 350) } },
      { id: 'freeze', group: 'SOURCES', label: `Freeze ${freezeSec}s of the output into the pool`, disabled: !state.playing, run: () => void api.freeze(freezeSec) },
      { id: 'crate', group: 'SOURCES', label: 'Download the pool as a .crate file', disabled: state.sources.length === 0, run: api.crateExport },
      ...SECTIONS.map((s, i) => ({ id: `go-${s.id}`, group: 'GO TO', label: `Go to ${s.label.toLowerCase()}`, hint: s.hint, keys: `ALT+${i + 1}`, run: () => jump(s.id) })),
      { id: 'help', group: 'HELP', label: 'Keyboard shortcuts & how it works', keys: '?', run: () => setHelpOpen(true) },
    ]
    return list
  }, [api, state, renderMin, loopBars, remixCount, freezeSec, jump])

  if (!state.started) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-8 p-8 text-center">
        <div>
          <h1 className="text-3xl tracking-[0.35em] font-bold">EXOTICA DÉCOLLAGE</h1>
          <p className="mt-3 text-[11px] tracking-[0.2em] opacity-60 max-w-md mx-auto leading-relaxed">
            GENERATIVE PLUNDERPHONICS &amp; MUSIQUE CONCRÈTE STUDIO
            <br />
            AFTER PEKLER'S <em>COVER VERSIONS</em> · JELINEK'S <em>LOOP-FINDING-JAZZ-RECORDS</em>
          </p>
        </div>
        <button
          onClick={() => void api.start()}
          disabled={state.loading}
          className="px-10 py-4 border-2 text-sm tracking-[0.3em] transition-colors hover:!bg-[#D35400] hover:!border-[#D35400] hover:!text-[#F4EFEA]"
          style={{
            borderColor: CHARCOAL,
            background: state.loading ? CHARCOAL : 'transparent',
            color: state.loading ? CREAM : CHARCOAL,
          }}
        >
          {state.loading ? 'PREPARING BUFFERS…' : 'START STUDIO'}
        </button>
        <p className="text-[9px] tracking-widest opacity-40">
          AUDIO STARTS ONLY AFTER THIS EXPLICIT GESTURE — BROWSER POLICY
        </p>
      </div>
    )
  }

  const busyLabel = state.rendering && state.renderProgress != null

  return (
    <div
      ref={scroller}
      className="h-full flex flex-col relative overflow-y-auto"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {dragOver && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center border-4 border-dashed pointer-events-none"
          style={{ borderColor: BURNT, background: 'rgba(244,239,234,0.9)' }}
        >
          <span className="text-sm tracking-[0.3em] text-center leading-relaxed" style={{ color: BURNT }}>
            DROP AUDIO — WAV / MP3 / AIFF / FLAC
            <br />
            OR A COVER IMAGE — IT WILL BE SONIFIED · OR A .CRATE
          </span>
        </div>
      )}

      {/* ===== sticky top bar ===== */}
      <header className="sticky top-0 z-30 border-b-2 border-charcoal/70" style={{ background: CREAM }}>
        <div className="px-3 py-2 flex items-center gap-x-4 gap-y-2 flex-wrap">
          <span className="text-xs tracking-[0.3em] font-bold whitespace-nowrap">EXOTICA DÉCOLLAGE</span>

          {/* transport */}
          <div className="flex items-center gap-1.5" role="group" aria-label="Transport">
            <button
              onClick={state.playing ? api.pause : api.play}
              className="p-1.5 border border-charcoal/60 hover:bg-charcoal/10"
              title={state.playing ? 'Pause (Space)' : 'Play (Space)'}
              aria-label={state.playing ? 'Pause' : 'Play'}
              style={state.playing ? { background: CHARCOAL, color: CREAM } : undefined}
            >
              {state.playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button onClick={api.reset} className="p-1.5 border border-charcoal/60 hover:bg-charcoal/10"
              title="Restart from the seed" aria-label="Restart">
              <RotateCcw size={14} />
            </button>
            <button
              onClick={api.toggleRecording}
              className="p-1.5 border border-charcoal/60 hover:bg-charcoal/10 flex items-center gap-1.5"
              title={state.recording ? 'Stop the live recording and save it as a WAV (R)' : 'Record what you hear, live, for as long as you like (R). For a composed track use EXPORT → RENDER.'}
              style={state.recording ? { background: BURNT, color: CREAM } : undefined}
            >
              {state.recording ? <Square size={14} /> : <Circle size={14} />}
              <span className="text-[9px] tracking-widest">{state.recording ? 'STOP→WAV' : 'REC'}</span>
            </button>
            <button onClick={api.reseed} className={chip} title="New seed: same sound, a different take. The URL always holds the current patch.">
              <Dices size={12} /> {state.seed}
            </button>
            <label className="flex items-center gap-1 text-[9px] tracking-widest border border-charcoal/60 px-1.5 py-1" title="Pulse tempo">
              <input type="number" min={40} max={160} value={state.bpm} onChange={(e) => api.setBpm(Number(e.target.value))}
                className="w-9 bg-transparent text-[10px]" aria-label="BPM" />
              BPM
            </label>
            <span className="flex items-center gap-1">
              <button onClick={api.toggleMasterMute} className="p-1 hover:opacity-70" title="Master mute" aria-label="Master mute">
                {state.masterMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              </button>
              <input type="range" min={0} max={1} step={0.01} value={state.masterVolume}
                onChange={(e) => api.setMasterVolume(Number(e.target.value))} className="w-16" aria-label="Master volume" />
            </span>
            <button onClick={() => api.setRadio(!state.radio)} className={chip}
              title="Radio: endless stream, new seed + stems every 3 minutes"
              style={state.radio ? { background: BURNT, color: CREAM, borderColor: BURNT } : undefined}>
              <Radio size={12} /> RADIO
            </button>
          </div>

          <span className="flex-1" />

          {/* output side */}
          <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Output">
            <LoudnessMeterView target={state.loudnessTarget} lastReport={state.lastReport} playing={state.playing} />
            <ExportMenu
              api={api}
              minutes={renderMin} setMinutes={setRenderMin}
              loopBars={loopBars} setLoopBars={setLoopBars}
              remixCount={remixCount} setRemixCount={setRemixCount}
              onAlbum={() => setAlbumOpen(true)}
            />
            <button
              onClick={() => setAlbumOpen(true)}
              disabled={state.rendering}
              className="flex items-center gap-1.5 border-2 px-2.5 py-1 text-[9px] tracking-[0.2em] font-bold disabled:opacity-40"
              style={{ borderColor: BURNT, background: BURNT, color: CREAM }}
              title="Album builder: name the tracks, pick a character for each, listen, render everything as a release"
            >
              <Disc3 size={13} /> ALBUM
            </button>
            <button onClick={() => setPaletteOpen(true)} className={chip} title="Find any action by name (Ctrl/⌘+K)">
              <Search size={12} /> <span className="hidden sm:inline">CTRL+K</span>
            </button>
            <button onClick={() => setHelpOpen(true)} className="p-1 hover:opacity-70" title="How it works & shortcuts (?)" aria-label="Help">
              <HelpCircle size={16} />
            </button>
          </div>
        </div>

        {/* section tabs */}
        <nav className="px-3 flex items-end gap-1 overflow-x-auto" aria-label="Sections">
          {SECTIONS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => jump(s.id)}
              className="px-3 py-1.5 text-[9px] tracking-[0.25em] border-b-2 -mb-[2px] whitespace-nowrap hover:opacity-100"
              style={{
                borderColor: active === s.id ? BURNT : 'transparent',
                color: active === s.id ? BURNT : undefined,
                opacity: active === s.id ? 1 : 0.6,
                fontWeight: active === s.id ? 700 : 400,
              }}
              title={`${s.hint} (Alt+${i + 1})`}
              aria-current={active === s.id ? 'true' : undefined}
            >
              {s.label}
              {s.id === 'sources' && <span className="ml-1 opacity-60">{state.sources.length}</span>}
            </button>
          ))}
          <span className="flex-1" />
          {state.loading && (
            <span className="text-[9px] tracking-widest pb-1.5" style={{ color: BURNT }}>ANALYZING…</span>
          )}
        </nav>

        {/* render progress strip — always reachable STOP */}
        {(busyLabel || state.bouncing) && (
          <div className="flex items-center gap-2 px-3 py-1 text-[9px] tracking-widest" style={{ background: CHARCOAL, color: CREAM }} role="status">
            <span className="whitespace-nowrap">{state.bouncing ? 'BOUNCING ARRANGEMENT' : state.renderLabel}</span>
            {busyLabel && (
              <>
                <span className="flex-1 h-1.5 bg-white/15">
                  <span className="block h-full" style={{ width: `${Math.round(state.renderProgress! * 100)}%`, background: BURNT, transition: 'width .3s' }} />
                </span>
                <span className="tabular-nums w-8 text-right">{Math.round(state.renderProgress! * 100)}%</span>
              </>
            )}
            {!busyLabel && <span className="flex-1" />}
            <button
              onClick={api.cancelRender}
              className="flex items-center gap-1 border px-2 py-0.5 font-bold hover:bg-white/10"
              style={{ borderColor: BURNT, color: BURNT }}
              title="Stop (Esc). Nothing half-finished is saved; an album keeps its finished tracks."
            >
              <Square size={9} fill={BURNT} /> STOP <span className="opacity-60 font-normal">ESC</span>
            </button>
          </div>
        )}
      </header>

      <div className="flex flex-col gap-4 p-3">
        {/* ===== sources ===== */}
        <Section id="sources" title="SOURCES" hint="the pool every voice draws from · drop files anywhere on the page"
          right={state.poolNeedsClearance && state.sources.length > 0 ? (
            <span className="text-[8px] tracking-widest opacity-60" title="The pool holds third-party material — album exports include samples.txt with every original and timestamp">
              THIRD-PARTY MATERIAL · TRACKED
            </span>
          ) : undefined}>
          <div className="border border-charcoal/60 px-3 py-2 flex flex-col gap-2">
            {/* pool */}
            <div className="flex items-center gap-2 flex-wrap min-h-7">
              {state.sources.length === 0 && (
                <span className="text-[10px] tracking-widest opacity-50">EMPTY — ADD A STEM, UPLOAD, MIC OR YOUTUBE BELOW</span>
              )}
              {state.sources.map((s, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1 border border-charcoal/40 px-1.5 py-0.5 text-[9px] tracking-wider max-w-60"
                  style={s.bed ? { borderColor: BURNT } : undefined}
                  title={s.origin ? `${s.origin.label}${s.origin.url ? `\n${s.origin.url}` : ''}` : s.name}
                >
                  <span className="opacity-50 tabular-nums">{i + 1}</span>
                  <button onClick={() => api.toggleBed(i)} className="hover:opacity-60"
                    title="Ambience bed: loop this source continuously under everything, heavily filtered"
                    style={{ color: s.bed ? BURNT : undefined, opacity: s.bed ? 1 : 0.4 }}>◉</button>
                  <span className="truncate">{s.name}</span>
                  {s.origin?.needsClearance === false && <span className="opacity-40" title="In-app material: nothing to clear">✓</span>}
                  <button onClick={() => api.removeSource(i)} className="hover:opacity-60" title="Remove from pool" aria-label={`Remove ${s.name}`}>
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>

            {/* add */}
            <div className="flex items-center gap-2 flex-wrap border-t border-charcoal/20 pt-2">
              <span className="text-[8px] tracking-[0.3em] opacity-50 w-8">ADD</span>
              <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-0.5">
                <Plus size={10} />
                <select value="" onChange={(e) => e.target.value && void api.addStem(e.target.value)}
                  className="bg-transparent text-[9px] tracking-widest max-w-40" aria-label="Add a bundled stem">
                  <option value="">BUNDLED STEM…</option>
                  {BUNDLED_STEMS.filter((s) => !state.sources.some((x) => x.stemKey === s.key)).map((s) => (
                    <option key={s.key} value={s.key}>{s.name}</option>
                  ))}
                </select>
              </span>
              <button onClick={() => fileInput.current?.click()} className={chip} title="Audio (WAV/MP3/AIFF/FLAC), a cover image to sonify, or a .crate">
                <Upload size={11} /> UPLOAD
              </button>
              <input ref={fileInput} type="file" accept=".wav,.mp3,.aiff,.aif,.flac,.crate,audio/*,image/*" className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) openFile(f)
                  e.target.value = ''
                }} />
              <button onClick={() => void api.sampleFromMic(8)} disabled={state.micState === 'recording'} className={chip}
                title="Sample 8 seconds from the microphone / line input"
                style={state.micState === 'recording' ? { background: BURNT, color: CREAM } : undefined}>
                <Mic size={11} /> {state.micState === 'recording' ? 'SAMPLING 8S…' : 'MIC'}
              </button>
              {state.ytAvailable && (
                <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-0.5 flex-1 min-w-64">
                  <Clapperboard size={11} />
                  <textarea
                    ref={ytInput}
                    rows={1}
                    value={ytUrl}
                    onChange={(e) => setYtUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        submitYt()
                      }
                    }}
                    placeholder="PASTE YOUTUBE / SPOTIFY LINK(S) — ENTER"
                    className="bg-transparent text-[9px] tracking-wider flex-1 outline-none placeholder:opacity-40 resize-none leading-tight"
                    title="YouTube links, playlists, or Spotify track/album/playlist links (matched on YouTube). Up to 8 tracks. Enter = go, Shift+Enter = new line. Every cut's original timestamp is tracked for the sample report."
                    aria-label="YouTube or Spotify links"
                  />
                  <select value={ytMode} onChange={(e) => setYtMode(e.target.value as typeof ytMode)}
                    className="bg-transparent text-[9px] tracking-widest border-l border-charcoal/30 pl-1"
                    title="COLLAGE = hard splice of best windows · MIXTAPE = crossfaded segments (also saved as WAV) · WEAVE = tracks interleaved">
                    <option value="collage">COLLAGE</option>
                    <option value="mixtape">MIXTAPE</option>
                    <option value="interleave">WEAVE</option>
                  </select>
                  <button onClick={() => setAutoMix(!autoMix)} className="text-[9px] tracking-widest border-l border-charcoal/30 pl-1.5 px-1"
                    title="After ingestion, render parallel remixes automatically"
                    style={autoMix ? { background: BURNT, color: CREAM, borderRadius: 2 } : undefined}>
                    AUTO
                  </button>
                  <button onClick={submitYt} className="text-[9px] tracking-widest hover:opacity-70 border-l border-charcoal/30 pl-1.5 font-bold">CUT</button>
                </span>
              )}
            </div>

            {/* tools */}
            <div className="flex items-center gap-2 flex-wrap border-t border-charcoal/20 pt-2">
              <span className="text-[8px] tracking-[0.3em] opacity-50 w-8">KEEP</span>
              <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-0.5">
                <select value={freezeSec} onChange={(e) => setFreezeSec(Number(e.target.value))}
                  className="bg-transparent text-[9px] tracking-widest" disabled={state.freezing} aria-label="Freeze length">
                  {[12, 30, 60, 120].map((s) => <option key={s} value={s}>{s}S</option>)}
                </select>
                <button onClick={() => void api.freeze(freezeSec)} disabled={state.freezing || !state.playing}
                  className="flex items-center gap-1.5 text-[9px] tracking-widest hover:opacity-70 disabled:opacity-40"
                  title={state.playing ? 'Resample the output back into the pool' : 'Press play first — FREEZE captures what is playing'}
                  style={state.freezing ? { color: BURNT } : undefined}>
                  <Snowflake size={11} /> {state.freezing ? 'FREEZING…' : 'FREEZE'}
                </button>
              </span>
              <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-0.5">
                <Package size={11} className="opacity-70" />
                <input type="text" value={crateName} onChange={(e) => setCrateName(e.target.value)}
                  placeholder="CRATE NAME" aria-label="Crate name"
                  className="bg-transparent text-[9px] tracking-wider w-24 outline-none placeholder:opacity-40" />
                <button onClick={() => { void api.crateSave(crateName); setCrateName('') }}
                  disabled={state.sources.length === 0}
                  className="text-[9px] tracking-widest hover:opacity-70 disabled:opacity-40"
                  title="Save the whole pool (audio, slice edits, provenance) in this browser">SAVE</button>
                <button onClick={api.crateExport} disabled={state.sources.length === 0}
                  className="text-[9px] tracking-widest hover:opacity-70 border-l border-charcoal/30 pl-1 disabled:opacity-40"
                  title="Download the pool as a portable .crate file">FILE ↓</button>
                {state.crates.length > 0 && (
                  <select value=""
                    onChange={(e) => {
                      if (!e.target.value) return
                      const [op, name] = e.target.value.split(':', 2)
                      if (op === 'load') void api.crateLoad(name)
                      else if (op === 'del' && confirm(`Delete crate "${name}"?`)) void api.crateDelete(name)
                    }}
                    className="bg-transparent text-[9px] tracking-widest max-w-28 border-l border-charcoal/30 pl-1" aria-label="Saved crates">
                    <option value="">LOAD…</option>
                    {state.crates.map((c) => <option key={c} value={`load:${c}`}>{c}</option>)}
                    <option value="" disabled>— delete —</option>
                    {state.crates.map((c) => <option key={`d${c}`} value={`del:${c}`}>✕ {c}</option>)}
                  </select>
                )}
              </span>
            </div>
          </div>
        </Section>

        {/* ===== waveform ===== */}
        <Section id="waveform" title="WAVEFORM" hint="click: boundary · drag: select · double-click: play here · click a dot: arm it, then play A–L">
          <AudioVisualizer
            sources={state.sources}
            slices={state.slices}
            firesRef={api.firesRef}
            onAudition={api.auditionSlice}
            onEditBoundary={api.editBoundary}
            onCycleCategory={api.cycleCategory}
            onPreview={api.previewToggle}
            previewSource={state.previewSource}
            onRegionLoop={api.regionLoop}
            onRegionSource={api.regionToSource}
            onRegionSplice={api.regionSplice}
            onPreviewFrom={api.previewFrom}
            onPreviewRegions={api.previewRegions}
            getPreviewPos={api.getPreviewPos}
            getPhraseInfo={api.getPhraseInfo}
            onTogglePin={api.togglePin}
            onPinSimilar={api.pinSimilar}
            onSendToArrange={(id, track) => api.arrAppendSlices([id], track)}
            onRegionArrange={(sourceIdx, regions) => {
              let at = api.getArrPos()
              for (const r of regions) {
                api.arrAddClip(sourceIdx, r.start, r.dur, at, 0)
                at += r.dur
              }
            }}
          />
        </Section>

        {/* ===== compose ===== */}
        <Section id="compose" title="COMPOSE" hint="pick the dots · choose a mood · shape it with three knobs · keep it">
          <ComposePanel api={api} minutes={renderMin} setMinutes={setRenderMin} />
        </Section>

        {/* ===== arrange ===== */}
        <Section id="arrange" title="ARRANGE" hint="a hand-made timeline next to the generative engine">
          <ArrangeView api={api} />
        </Section>

        {/* ===== mixer ===== */}
        <Section id="mixer" title="MIXER" hint="voices · macros · one-click characters · scenes & song">
          <MixerRack api={api} />
        </Section>

        {/* ===== mix & master ===== */}
        <Section id="master" title="MIX & MASTER" hint="balance the buses · finish with a release chain you can hear live · render the final file">
          <MixMasterPanel api={api} minutes={renderMin} setMinutes={setRenderMin} />
        </Section>

        <footer className="text-[8px] tracking-[0.2em] opacity-40 px-1 flex justify-between flex-wrap gap-1 pb-2">
          <span>
            {state.slices.length} SLICES · {state.sources.length} SOURCES · SEED {state.seed}
            {state.armedSliceId !== null && (
              <span style={{ color: BURNT, opacity: 1 }}> · ARMED #{state.armedSliceId} — PLAY A–L (SHIFT = −OCT)</span>
            )}
          </span>
          <span>CTRL+K ACTIONS · ? HELP · SPACE PLAY · ESC STOP RENDER</span>
        </footer>
      </div>

      {albumOpen && <AlbumPanel api={api} onClose={() => setAlbumOpen(false)} />}
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      <Toasts />
    </div>
  )
}
