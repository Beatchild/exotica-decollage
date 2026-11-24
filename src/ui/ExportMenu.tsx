import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Disc3, Download, FileText, Layers, Repeat, Shuffle } from 'lucide-react'
import type { useAudioEngine } from '../hooks/useAudioEngine'
import { LOUDNESS_TARGETS } from '../engine/loudness'

type Api = ReturnType<typeof useAudioEngine>

const BURNT = '#D35400'
const CREAM = '#F4EFEA'

const row = 'flex items-center gap-2 w-full px-2.5 py-2 text-left text-[10px] tracking-widest hover:bg-charcoal/10 disabled:opacity-35'

/**
 * Everything that writes files, in one place: format, loudness and the
 * render actions. Settings apply to every export (the album has its own).
 */
export function ExportMenu({
  api, minutes, setMinutes, loopBars, setLoopBars, remixCount, setRemixCount, onAlbum,
}: {
  api: Api
  minutes: number
  setMinutes: (v: number) => void
  loopBars: number
  setLoopBars: (v: number) => void
  remixCount: number
  setRemixCount: (v: number) => void
  onAlbum: () => void
}) {
  const { state } = api
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  const disabled = state.rendering || state.slices.length === 0
  const remixable = state.sources.some((s) => /^(YT|Mixtape|Weave|Freeze)/.test(s.name))
  const f = state.exportFormat

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 border border-charcoal/60 px-2 py-1 text-[9px] tracking-[0.2em] hover:bg-charcoal/10"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Export: render to WAV, stems, loops, remixes — format and loudness"
      >
        <Download size={12} /> EXPORT <ChevronDown size={11} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-50 w-72 border-2 shadow-lg"
          style={{ background: CREAM, borderColor: '#1A1A1A' }}
        >
          {/* settings */}
          <div className="px-2.5 py-2 border-b border-charcoal/30 grid grid-cols-2 gap-2 text-[9px] tracking-widest">
            <label className="flex flex-col gap-0.5 col-span-2">
              <span className="opacity-60">LOUDNESS</span>
              <select
                value={state.loudnessTarget == null ? 'off' : String(state.loudnessTarget)}
                onChange={(e) => api.setLoudnessTarget(e.target.value === 'off' ? null : Number(e.target.value))}
                className="border border-charcoal/60 bg-transparent px-1 py-1"
                title="Integrated LUFS target, true peak ≤ −1 dBTP. Stems are never normalized."
              >
                {LOUDNESS_TARGETS.map((t) => (
                  <option key={t.label} value={t.lufs == null ? 'off' : String(t.lufs)}>
                    {t.lufs == null ? 'OFF (RAW LEVEL)' : `${t.label} LUFS`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="opacity-60">BIT DEPTH</span>
              <select
                value={f.bits}
                onChange={(e) => api.setExportFormat({ bits: Number(e.target.value) as 16 | 24 })}
                className="border border-charcoal/60 bg-transparent px-1 py-1"
              >
                <option value={24}>24-BIT</option>
                <option value={16}>16-BIT</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="opacity-60">SAMPLE RATE</span>
              <select
                value={f.sampleRate}
                onChange={(e) => api.setExportFormat({ sampleRate: Number(e.target.value) as 44100 | 48000 })}
                className="border border-charcoal/60 bg-transparent px-1 py-1"
              >
                <option value={44100}>44.1 KHZ</option>
                <option value={48000}>48 KHZ</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5 col-span-2">
              <span className="opacity-60">TRACK LENGTH (RENDER · STEMS · REMIX)</span>
              <span className="flex items-center gap-1 border border-charcoal/60 px-1 py-0.5">
                <input
                  type="number" min={0.2} max={45} step={0.5} value={minutes}
                  onChange={(e) => setMinutes(Math.min(45, Math.max(0.2, Number(e.target.value) || 2)))}
                  className="w-14 bg-transparent text-[11px]"
                  aria-label="Render length in minutes"
                />
                <span className="opacity-60">MIN</span>
              </span>
            </label>
          </div>

          {/* actions */}
          <div className="py-1" role="none">
            <button role="menuitem" className={row} disabled={disabled} onClick={run(() => void api.renderToWav(minutes))}
              title="Compose the track offline from the current settings — the same seed always gives the same track">
              <Download size={13} /> RENDER TRACK
              <span className="ml-auto opacity-50">{minutes} MIN</span>
            </button>
            <button role="menuitem" className={row} disabled={disabled} onClick={run(() => void api.renderStemsToWav(minutes))}
              title="One WAV per voice from the same seed — for mixing in a DAW (not loudness-normalized)">
              <Layers size={13} /> STEMS
              <span className="ml-auto opacity-50">7 WAVS</span>
            </button>
            <div className={row + ' hover:bg-transparent'}>
              <Repeat size={13} />
              <button role="menuitem" className="hover:opacity-70 disabled:opacity-35" disabled={disabled}
                onClick={run(() => void api.renderLoop(loopBars))}
                title="Bar-exact loop at the pulse BPM with the reverb tail folded onto the start">
                LOOP
              </button>
              <select value={loopBars} onChange={(e) => setLoopBars(Number(e.target.value))}
                className="ml-auto bg-transparent border border-charcoal/40 px-1" aria-label="Loop length">
                {[4, 8, 16].map((b) => <option key={b} value={b}>{b} BARS</option>)}
              </select>
            </div>
            <div className={row + ' hover:bg-transparent'}>
              <Shuffle size={13} />
              <button role="menuitem" className="hover:opacity-70 disabled:opacity-35" disabled={disabled || !remixable}
                onClick={run(() => void api.remixCollages(remixCount, minutes))}
                title={remixable ? 'Parallel variants of the YouTube / Freeze material' : 'Needs YouTube or Freeze sources in the pool'}>
                REMIX
              </button>
              <select value={remixCount} onChange={(e) => setRemixCount(Number(e.target.value))}
                className="ml-auto bg-transparent border border-charcoal/40 px-1" aria-label="Number of remixes">
                {[2, 3, 4].map((n) => <option key={n} value={n}>×{n}</option>)}
              </select>
            </div>
            <div className="border-t border-charcoal/20 my-1" />
            <button role="menuitem" className={row} disabled={state.rendering} onClick={run(onAlbum)} style={{ color: BURNT }}>
              <Disc3 size={13} /> ALBUM BUILDER…
            </button>
            <button role="menuitem" className={row} disabled={!state.hasSampleReport} onClick={run(api.downloadSampleReport)}
              title="samples.txt for the last export: every original recording it used, with timestamps">
              <FileText size={13} /> SAMPLE REPORT (LAST EXPORT)
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
