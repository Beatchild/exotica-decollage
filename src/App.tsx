import { useCallback, useEffect, useState } from 'react'
import {
  Play, Pause, RotateCcw, Circle, Square, Volume2, VolumeX, Upload, Dices, Mic, Download, X, Plus,
  Clapperboard, Snowflake, Radio, Disc3,
} from 'lucide-react'
import { useAudioEngine } from './hooks/useAudioEngine'
import { AudioVisualizer } from './components/AudioVisualizer'
import { GenerativeArtwork } from './components/GenerativeArtwork'
import { MixerRack } from './components/MixerRack'
import { BUNDLED_STEMS } from './engine/stems'

const CHARCOAL = '#1A1A1A'
const BURNT = '#D35400'
const CREAM = '#F4EFEA'

export default function App() {
  const api = useAudioEngine()
  const { state } = api
  const [dragOver, setDragOver] = useState(false)
  const [renderMin, setRenderMin] = useState(2)
  const [loopBars, setLoopBars] = useState(8)
  const [albumTracks, setAlbumTracks] = useState(4)
  const [remixCount, setRemixCount] = useState(3)
  const [freezeSec, setFreezeSec] = useState(12)
  const [ytUrl, setYtUrl] = useState('')
  const [crateName, setCrateName] = useState('')
  const [ytMode, setYtMode] = useState<'collage' | 'mixtape' | 'interleave'>('collage')
  const [autoMix, setAutoMix] = useState(false)

  // keyboard: transport shortcuts + armed-slice performance (home row)
  useEffect(() => {
    const PERF_KEYS: Record<string, number> = {
      KeyA: 0, KeyS: 2, KeyD: 4, KeyF: 5, KeyG: 7, KeyH: 9, KeyJ: 11, KeyK: 12, KeyL: 14,
    }
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      if (!api.state.started) return
      if (e.code === 'Space') {
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
        const oct = e.shiftKey ? -12 : 0
        api.playArmedAt(PERF_KEYS[e.code] + oct)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api])

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
          className="px-10 py-4 border-2 text-sm tracking-[0.3em] transition-colors"
          style={{
            borderColor: CHARCOAL,
            background: state.loading ? CHARCOAL : 'transparent',
            color: state.loading ? CREAM : CHARCOAL,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = BURNT
            e.currentTarget.style.borderColor = BURNT
            e.currentTarget.style.color = CREAM
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = state.loading ? CHARCOAL : 'transparent'
            e.currentTarget.style.borderColor = CHARCOAL
            e.currentTarget.style.color = state.loading ? CREAM : CHARCOAL
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

  return (
    <div
      className="h-full flex flex-col gap-2 p-3 relative overflow-y-auto"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {dragOver && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center border-4 border-dashed"
          style={{ borderColor: BURNT, background: 'rgba(244,239,234,0.9)' }}
        >
          <span className="text-sm tracking-[0.3em] text-center leading-relaxed" style={{ color: BURNT }}>
            DROP AUDIO — WAV / MP3 / AIFF / FLAC
            <br />
            OR A COVER IMAGE — IT WILL BE SONIFIED
          </span>
        </div>
      )}

      {/* header / transport */}
      <header className="border border-charcoal/60 px-3 py-2 flex items-center gap-3 flex-wrap">
        <span className="text-xs tracking-[0.3em] font-bold mr-2">EXOTICA DÉCOLLAGE</span>

        <button
          onClick={state.playing ? api.pause : api.play}
          className="p-1.5 border border-charcoal/60 hover:bg-charcoal/10"
          title={state.playing ? 'Pause' : 'Play'}
          style={state.playing ? { background: CHARCOAL, color: CREAM } : undefined}
        >
          {state.playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button
          onClick={api.reset}
          className="p-1.5 border border-charcoal/60 hover:bg-charcoal/10"
          title="Reset (restart the seeded streams)"
        >
          <RotateCcw size={14} />
        </button>
        <button
          onClick={api.toggleRecording}
          className="p-1.5 border border-charcoal/60 hover:bg-charcoal/10 flex items-center gap-1.5"
          title={state.recording ? 'Stop & export WAV' : 'Record master (live)'}
          style={state.recording ? { background: BURNT, color: CREAM } : undefined}
        >
          {state.recording ? <Square size={14} /> : <Circle size={14} />}
          <span className="text-[9px] tracking-widest">{state.recording ? 'EXPORT' : 'REC'}</span>
        </button>

        {/* offline render — free-form length, drives RENDER / STEMS / REMIX / ALBUM */}
        <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-1">
          <input
            type="number"
            min={0.2}
            max={45}
            step={0.5}
            value={renderMin}
            onChange={(e) => setRenderMin(Math.min(45, Math.max(0.2, Number(e.target.value) || 2)))}
            className="w-12 bg-transparent text-[9px] tracking-widest border-b border-charcoal/30"
            disabled={state.rendering}
            title="Render length in minutes (0.2–45) — applies to RENDER, STEMS, REMIX and ALBUM"
          />
          <span className="text-[9px] tracking-widest opacity-60">MIN</span>
          <button
            onClick={() => void api.renderToWav(renderMin)}
            disabled={state.rendering}
            className="flex items-center gap-1 text-[9px] tracking-widest hover:opacity-70"
            title="Deterministic offline bounce of the current seed → WAV (uses the song sequence if scenes are set)"
            style={state.rendering ? { color: BURNT } : undefined}
          >
            <Download size={12} />
            {state.rendering ? 'RENDERING…' : 'RENDER'}
          </button>
          <button
            onClick={() => void api.renderStemsToWav(renderMin)}
            disabled={state.rendering}
            className="text-[9px] tracking-widest hover:opacity-70 border-l border-charcoal/30 pl-1.5"
            title="Five per-voice stem WAVs from the same seed — mix them in your DAW"
          >
            STEMS
          </button>
        </span>

        {/* bar-locked loop */}
        <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-1">
          <select
            value={loopBars}
            onChange={(e) => setLoopBars(Number(e.target.value))}
            className="bg-transparent text-[9px] tracking-widest"
            disabled={state.rendering}
          >
            {[4, 8, 16].map((b) => (
              <option key={b} value={b}>
                {b} BARS
              </option>
            ))}
          </select>
          <button
            onClick={() => void api.renderLoop(loopBars)}
            disabled={state.rendering}
            className="text-[9px] tracking-widest hover:opacity-70"
            title="Bar-exact loop at the pulse BPM, reverb tail folded onto the start — drop straight into a sampler"
          >
            LOOP
          </button>
        </span>

        {/* album batch */}
        <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-1">
          <Disc3 size={12} />
          <select
            value={albumTracks}
            onChange={(e) => setAlbumTracks(Number(e.target.value))}
            className="bg-transparent text-[9px] tracking-widest"
            disabled={state.rendering}
          >
            {[3, 4, 6].map((n) => (
              <option key={n} value={n}>
                {n} TRK
              </option>
            ))}
          </select>
          <button
            onClick={() => void api.renderAlbum(albumTracks, renderMin)}
            disabled={state.rendering}
            className="text-[9px] tracking-widest hover:opacity-70"
            title="Batch: N tracks with derived seeds, each as a WAV + its own sleeve PNG, at the render length set on the left"
          >
            ALBUM
          </button>
        </span>

        {/* parallel remixes of the YT/Freeze material */}
        <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-1">
          <select
            value={remixCount}
            onChange={(e) => setRemixCount(Number(e.target.value))}
            className="bg-transparent text-[9px] tracking-widest"
            disabled={state.rendering}
          >
            {[2, 3, 4].map((n) => (
              <option key={n} value={n}>
                ×{n}
              </option>
            ))}
          </select>
          <button
            onClick={() => void api.remixCollages(remixCount, renderMin)}
            disabled={state.rendering}
            className="text-[9px] tracking-widest hover:opacity-70"
            title="N parallel remixes of the YouTube/Freeze material only — each variant gets its own seed, macros, scale, groove and duck, rendered simultaneously at the render length"
          >
            REMIX
          </button>
        </span>

        {/* radio mode */}
        <button
          onClick={() => api.setRadio(!state.radio)}
          className="p-1.5 border border-charcoal/60 hover:bg-charcoal/10 flex items-center gap-1.5"
          title="Endless background stream: reseed + stem rotation every 3 minutes, drift on"
          style={state.radio ? { background: BURNT, color: CREAM } : undefined}
        >
          <Radio size={13} />
          <span className="text-[9px] tracking-widest">RADIO</span>
        </button>

        {/* seed */}
        <button
          onClick={api.reseed}
          className="flex items-center gap-1.5 border border-charcoal/60 px-1.5 py-1 text-[9px] tracking-widest hover:bg-charcoal/10"
          title="New seed — the URL always encodes the current patch for sharing"
        >
          <Dices size={12} />
          {state.seed}
        </button>

        <span className="flex items-center gap-1.5">
          <button onClick={api.toggleMasterMute} className="p-1 hover:opacity-70" title="Master mute">
            {state.masterMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={state.masterVolume}
            onChange={(e) => api.setMasterVolume(Number(e.target.value))}
            className="w-20"
          />
        </span>

        <label className="flex items-center gap-1.5 text-[9px] tracking-widest">
          PULSE
          <input
            type="number"
            min={40}
            max={160}
            value={state.bpm}
            onChange={(e) => api.setBpm(Number(e.target.value))}
            className="w-14 border border-charcoal/60 bg-transparent px-1 py-0.5 text-[10px]"
          />
          BPM
        </label>

        {state.loading && (
          <span className="text-[9px] tracking-widest" style={{ color: BURNT }}>
            ANALYZING…
          </span>
        )}
      </header>

      {/* source pool */}
      <div className="border border-charcoal/60 px-3 py-1.5 flex items-center gap-2 flex-wrap">
        <span className="text-[9px] tracking-[0.2em] opacity-60">SOURCES</span>
        {state.sources.map((s, i) => (
          <span
            key={i}
            className="flex items-center gap-1 border border-charcoal/40 px-1.5 py-0.5 text-[9px] tracking-wider max-w-52"
            style={s.bed ? { borderColor: BURNT } : undefined}
          >
            <button
              onClick={() => api.toggleBed(i)}
              className="hover:opacity-60"
              title="Ambience bed: loop this source continuously under everything, heavily filtered (Poirier)"
              style={{ color: s.bed ? BURNT : undefined, opacity: s.bed ? 1 : 0.4 }}
            >
              ◉
            </button>
            <span className="truncate" title={s.name}>
              {s.name}
            </span>
            <button
              onClick={() => api.removeSource(i)}
              className="hover:opacity-60"
              title="Remove from pool"
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-0.5">
          <Plus size={10} />
          <select
            value=""
            onChange={(e) => e.target.value && void api.addStem(e.target.value)}
            className="bg-transparent text-[9px] tracking-widest max-w-40"
          >
            <option value="">ADD STEM…</option>
            {BUNDLED_STEMS.filter((s) => !state.sources.some((x) => x.stemKey === s.key)).map(
              (s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ),
            )}
          </select>
        </span>
        <label className="flex items-center gap-1.5 text-[9px] tracking-widest cursor-pointer border border-charcoal/60 px-2 py-0.5 hover:bg-charcoal/10">
          <Upload size={11} />
          UPLOAD
          <input
            type="file"
            accept=".wav,.mp3,.aiff,.aif,.flac,.crate,audio/*,image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) {
                if (f.name.endsWith('.crate')) void api.crateImport(f)
                else if (f.type.startsWith('image/')) void api.loadImage(f)
                else void api.loadFile(f)
              }
              e.target.value = ''
            }}
          />
        </label>
        <button
          onClick={() => void api.sampleFromMic(8)}
          disabled={state.micState === 'recording'}
          className="flex items-center gap-1.5 text-[9px] tracking-widest border border-charcoal/60 px-2 py-0.5 hover:bg-charcoal/10"
          title="Sample 8 seconds from the microphone / line input"
          style={state.micState === 'recording' ? { background: BURNT, color: CREAM } : undefined}
        >
          <Mic size={11} />
          {state.micState === 'recording' ? 'SAMPLING 8S…' : 'MIC'}
        </button>
        <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-0.5">
          <select
            value={freezeSec}
            onChange={(e) => setFreezeSec(Number(e.target.value))}
            className="bg-transparent text-[9px] tracking-widest"
            disabled={state.freezing}
          >
            {[12, 30, 60, 120].map((s) => (
              <option key={s} value={s}>
                {s}S
              </option>
            ))}
          </select>
          <button
            onClick={() => void api.freeze(freezeSec)}
            disabled={state.freezing || !state.playing}
            className="flex items-center gap-1.5 text-[9px] tracking-widest hover:opacity-70 disabled:opacity-40"
            title="Resample: capture the processed master back into the pool as a new source — the collage becomes its own sample material"
            style={state.freezing ? { color: BURNT } : undefined}
          >
            <Snowflake size={11} />
            {state.freezing ? 'FREEZING…' : 'FREEZE'}
          </button>
        </span>
        {state.ytAvailable && (
          <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-0.5">
            <Clapperboard size={11} />
            <textarea
              rows={1}
              value={ytUrl}
              onChange={(e) => setYtUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submitYt()
                }
              }}
              placeholder="PASTE YOUTUBE / SPOTIFY LINK(S)…"
              className="bg-transparent text-[9px] tracking-wider w-48 outline-none placeholder:opacity-40 resize-none leading-tight"
              title="YouTube links, YouTube playlists, or Spotify track/album/playlist links (Spotify audio is matched on YouTube). Up to 8 tracks total: parallel fetch, each cut down, spliced into one collage source. Enter = go, Shift+Enter = new line"
            />
            <select
              value={ytMode}
              onChange={(e) => setYtMode(e.target.value as typeof ytMode)}
              className="bg-transparent text-[9px] tracking-widest border-l border-charcoal/30 pl-1"
              title="Multi-link assembly: COLLAGE = hard splice of best windows · MIXTAPE = role-ordered segments with long crossfades (also saved as WAV) · WEAVE = tracks interleaved chunk by chunk"
            >
              <option value="collage">COLLAGE</option>
              <option value="mixtape">MIXTAPE</option>
              <option value="interleave">WEAVE</option>
            </select>
            <button
              onClick={() => setAutoMix(!autoMix)}
              className="text-[9px] tracking-widest border-l border-charcoal/30 pl-1.5 px-1"
              title="Zero-click flow: after ingestion, parallel remixes render and download automatically"
              style={autoMix ? { background: BURNT, color: CREAM, borderRadius: 2 } : undefined}
            >
              AUTO
            </button>
            <button
              onClick={submitYt}
              className="text-[9px] tracking-widest hover:opacity-70 border-l border-charcoal/30 pl-1.5"
            >
              CUT
            </button>
          </span>
        )}

        {/* crate persistence */}
        <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-0.5 ml-auto">
          <span className="text-[9px] tracking-widest opacity-60">CRATE</span>
          <input
            type="text"
            value={crateName}
            onChange={(e) => setCrateName(e.target.value)}
            placeholder="NAME"
            className="bg-transparent text-[9px] tracking-wider w-20 outline-none placeholder:opacity-40"
          />
          <button
            onClick={() => {
              void api.crateSave(crateName)
              setCrateName('')
            }}
            className="text-[9px] tracking-widest hover:opacity-70"
            title="Save the whole source pool (audio + edited boundaries) to this browser"
          >
            SAVE
          </button>
          <button
            onClick={api.crateExport}
            className="text-[9px] tracking-widest hover:opacity-70 border-l border-charcoal/30 pl-1"
            title="Download the pool as a portable .crate file — import it on another machine via UPLOAD or drag-drop"
          >
            FILE ↓
          </button>
          {state.crates.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return
                const [op, name] = e.target.value.split(':', 2)
                if (op === 'load') void api.crateLoad(name)
                else if (op === 'del' && confirm(`Delete crate "${name}"?`)) void api.crateDelete(name)
              }}
              className="bg-transparent text-[9px] tracking-widest max-w-28 border-l border-charcoal/30 pl-1"
            >
              <option value="">LOAD…</option>
              {state.crates.map((c) => (
                <option key={c} value={`load:${c}`}>
                  {c}
                </option>
              ))}
              <option value="" disabled>
                — delete —
              </option>
              {state.crates.map((c) => (
                <option key={`d${c}`} value={`del:${c}`}>
                  ✕ {c}
                </option>
              ))}
            </select>
          )}
        </span>
      </div>

      {/* central matrix */}
      <main className="flex-1 shrink-0 grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-2">
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
        />
        <GenerativeArtwork
          firesRef={api.firesRef}
          analyser={api.analyser}
          palette={state.sleevePalette}
          getAudioStream={api.getAudioStream}
        />
      </main>

      {/* mixer + macros */}
      <MixerRack api={api} />

      <footer className="text-[8px] tracking-[0.2em] opacity-40 px-1 flex justify-between flex-wrap gap-1">
        <span>
          {state.slices.length} SLICES · {state.sources.length} SOURCES · SEED {state.seed}
          {state.armedSliceId !== null && (
            <span style={{ color: BURNT, opacity: 1 }}>
              {' '}· ARMED #{state.armedSliceId} — PLAY A–L (SHIFT = −OCT)
            </span>
          )}
        </span>
        <span>SPACE PLAY · R REC · 1–4 SCENES · 5-VOICE MATRIX · PHASE-FREE</span>
      </footer>
    </div>
  )
}
