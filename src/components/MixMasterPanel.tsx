import { useEffect, useRef, useState } from 'react'
import { Download, FileAudio, Headphones, Package, Power, RotateCcw, Square } from 'lucide-react'
import type { useAudioEngine } from '../hooks/useAudioEngine'
import { MASTER_PRESETS } from '../engine/mastering'
import type { MasterChain } from '../engine/mastering'
import { LOUDNESS_TARGETS } from '../engine/loudness'
import { MidiPanel } from './MidiPanel'
import type { MixLevels } from '../engine/AudioEngine'

type Api = ReturnType<typeof useAudioEngine>

const CHARCOAL = '#1A1A1A'
const BURNT = '#D35400'
const CREAM = '#F4EFEA'

const KIT_KEY = 'exotica.release.v1'
const toDb = (g: number) => (g <= 0.0001 ? -60 : 20 * Math.log10(g))
const fromDb = (db: number) => (db <= -59.5 ? 0 : Math.pow(10, db / 20))
const fmtDb = (db: number) => (db <= -59.5 ? '−∞' : `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)}`)

const BUSES: Array<{ key: keyof MixLevels; label: string; hint: string }> = [
  { key: 'voices', label: 'VOICES', hint: 'the generative desk: bed, fragments, decays, loops, sub, melody line' },
  { key: 'clouds', label: 'CLOUDS', hint: 'MEMORY WEAVE stretch clouds' },
  { key: 'melody', label: 'MELODY', hint: 'the returning melody' },
  { key: 'ghosts', label: 'GHOSTS', hint: 'ghost voices' },
  { key: 'loop', label: 'LOOP', hint: 'the disintegrating tape loop' },
  { key: 'surface', label: 'SURFACE', hint: 'the eras’ crackle, hiss, hum and static' },
]

const KNOBS: Array<{ key: keyof MasterChain; label: string; min: number; max: number; step: number; unit: string; hint: string }> = [
  { key: 'lowCut', label: 'LOW CUT', min: 0, max: 60, step: 1, unit: 'Hz', hint: 'removes sub-rumble you cannot hear but the limiter can' },
  { key: 'monoBass', label: 'MONO BASS', min: 0, max: 250, step: 5, unit: 'Hz', hint: 'below this, the low end is centred — tight on speakers, safe for vinyl' },
  { key: 'warmth', label: 'WARMTH', min: -3, max: 4, step: 0.5, unit: 'dB', hint: 'low shelf at 140 Hz' },
  { key: 'mud', label: 'MUD CUT', min: -5, max: 0, step: 0.5, unit: 'dB', hint: 'bell at 320 Hz — clears boxiness' },
  { key: 'air', label: 'AIR', min: -4, max: 4, step: 0.5, unit: 'dB', hint: 'high shelf at 9 kHz' },
  { key: 'glue', label: 'GLUE', min: 0, max: 1, step: 0.01, unit: '', hint: 'gentle bus compression: holds the mix together' },
  { key: 'tape', label: 'TAPE', min: 0, max: 1, step: 0.01, unit: '', hint: 'tape saturation: density and soft edges' },
  { key: 'width', label: 'WIDTH', min: 0, max: 1.5, step: 0.01, unit: '×', hint: '0 = mono · 1 = as mixed · 1.5 = wide' },
]

function fmtKnob(k: (typeof KNOBS)[number], v: number) {
  if (k.unit === 'Hz') return v <= 0 ? 'OFF' : `${v} Hz`
  if (k.unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
  if (k.unit === '×') return `${v.toFixed(2)}×`
  return v < 0.01 ? 'OFF' : String(Math.round(v * 100))
}

/**
 * MIX & MASTER: five bus faders, the release chain (heard live, A/B with the
 * power switch — what you hear is what exports), loudness, and the final render.
 */
export function MixMasterPanel({ api, minutes, setMinutes }: { api: Api; minutes: number; setMinutes: (v: number) => void }) {
  const { state } = api
  const noSrc = state.slices.length === 0
  const c = state.masterChain
  const on = !state.masterBypass
  const rep = state.lastReport
  const refInput = useRef<HTMLInputElement>(null)
  const [kit, setKit] = useState(() => {
    try {
      return { title: '', artist: '', year: String(new Date().getFullYear()), video: false, ...JSON.parse(localStorage.getItem(KIT_KEY) ?? '{}') }
    } catch {
      return { title: '', artist: '', year: String(new Date().getFullYear()), video: false }
    }
  })
  useEffect(() => {
    try { localStorage.setItem(KIT_KEY, JSON.stringify(kit)) } catch { /* storage */ }
  }, [kit])
  const ex = state.exactReady

  return (
    <div className="border border-charcoal/60 flex flex-col" style={{ background: CREAM }}>
      {/* 1 · mix */}
      <div className="px-3 py-2 flex flex-col gap-2 border-b border-charcoal/20">
        <div className="flex items-center gap-2">
          <b className="text-[10px] tracking-[0.25em]"><span style={{ color: BURNT }}>1</span> MIX</b>
          <span className="text-[9px] tracking-wider opacity-60">the balance between the desk and the memory layers — saved with each track</span>
          <button onClick={() => api.setMix({ voices: 1, clouds: 1, melody: 1, ghosts: 1, loop: 1, surface: 1 })}
            className="ml-auto flex items-center gap-1 text-[9px] tracking-widest hover:opacity-60" title="All faders to 0 dB">
            <RotateCcw size={11} /> RESET
          </button>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))' }}>
          {BUSES.map((b) => {
            const db = toDb(state.mix[b.key])
            return (
              <label key={b.key} className="flex flex-col gap-0.5" title={b.hint}>
                <span className="flex justify-between text-[9px] tracking-widest">
                  <b>{b.label}</b>
                  <span className="tabular-nums opacity-70">{fmtDb(db)} dB</span>
                </span>
                <input type="range" min={-60} max={6} step={0.5} value={Math.max(-60, db)} aria-label={`${b.label} level`}
                  onChange={(e) => api.setMix({ [b.key]: fromDb(Number(e.target.value)) })}
                  onDoubleClick={() => api.setMix({ [b.key]: 1 })}
                  className="w-full accent-[#D35400]" />
                <span className="text-[8px] tracking-wider opacity-50 leading-tight">{b.hint}</span>
              </label>
            )
          })}
        </div>
      </div>

      {/* 2 · master */}
      <div className="px-3 py-2 flex flex-col gap-2 border-b border-charcoal/20">
        <div className="flex items-center gap-2 flex-wrap">
          <b className="text-[10px] tracking-[0.25em]"><span style={{ color: BURNT }}>2</span> MASTER</b>
          <button onClick={() => api.setMasterBypass(on)} aria-pressed={on}
            className="flex items-center gap-1 border-2 px-2 py-0.5 text-[9px] tracking-widest font-bold"
            style={on ? { borderColor: BURNT, background: BURNT, color: CREAM } : { borderColor: CHARCOAL }}
            title="Switch the master chain on/off — live and in every export: what you hear is what you get. Flip it while playing to compare (A/B).">
            <Power size={11} /> {on ? 'MASTER ON' : 'MASTER OFF'}
          </button>
          <span className="text-[9px] tracking-wider opacity-60">heard live · applied to every export and the album</span>
        </div>
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))' }} role="radiogroup" aria-label="Master preset">
          {MASTER_PRESETS.map((p) => {
            const sel = state.masterPreset === p.key
            return (
              <button key={p.key} role="radio" aria-checked={sel} onClick={() => api.setMaster({ preset: p.key })}
                className="text-left border-2 px-2 py-1.5 flex flex-col gap-0.5 hover:border-[#D35400]"
                style={sel ? { borderColor: BURNT, background: 'rgba(211,84,0,0.07)' } : { borderColor: 'rgba(26,26,26,0.35)' }}>
                <span className="text-[10px] tracking-[0.18em] font-bold" style={sel ? { color: BURNT } : undefined}>{p.label}</span>
                <span className="text-[9px] leading-snug opacity-70">{p.line}</span>
              </button>
            )
          })}
        </div>
        <div className="grid gap-x-4 gap-y-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))', opacity: on ? 1 : 0.5 }}>
          {KNOBS.map((k) => (
            <label key={k.key} className="flex flex-col gap-0.5" title={k.hint}>
              <span className="flex justify-between text-[9px] tracking-widest">
                <b>{k.label}</b>
                <span className="tabular-nums opacity-70">{fmtKnob(k, c[k.key])}</span>
              </span>
              <input type="range" min={k.min} max={k.max} step={k.step} value={c[k.key]} aria-label={k.label}
                onChange={(e) => api.setMaster({ chain: { [k.key]: Number(e.target.value) } })}
                className="w-full accent-[#D35400]" />
            </label>
          ))}
        </div>
        {state.masterPreset === 'custom' && <span className="text-[9px] tracking-widest opacity-60">CUSTOM — pick a preset to start over</span>}

        {/* reference matching */}
        <div className="flex items-center gap-2 flex-wrap">
          <input ref={refInput} type="file" accept="audio/*" className="hidden" aria-label="Reference track file"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void api.matchReference(f)
              e.target.value = ''
            }} />
          <button onClick={() => refInput.current?.click()} disabled={noSrc || state.rendering}
            className="flex items-center gap-1 border border-charcoal/60 px-2 py-1 text-[9px] tracking-widest hover:bg-charcoal/10 disabled:opacity-40"
            title="Load a finished track whose sound you like: the master's tone, width, density and loudness are set to land near it">
            <FileAudio size={11} /> MATCH A REFERENCE…
          </button>
          {state.referenceReport && (
            <span className="text-[9px] tracking-wider opacity-75 flex flex-col">
              <b className="tracking-widest">{state.referenceReport.name}</b>
              {state.referenceReport.lines.map((l) => <span key={l}>{l}</span>)}
            </span>
          )}
        </div>

        {/* exact preview */}
        <div className="flex items-center gap-2 flex-wrap border-t border-charcoal/15 pt-2">
          <b className="text-[9px] tracking-[0.2em]">EXACT PREVIEW</b>
          <span className="text-[9px] tracking-wider opacity-60">30 s rendered and mastered by the export code itself</span>
          <button onClick={() => void api.exactPreview('heart')} disabled={noSrc || state.rendering}
            className="flex items-center gap-1 border border-charcoal/60 px-2 py-1 text-[9px] tracking-widest hover:bg-charcoal/10 disabled:opacity-40"
            title="Render 30 s from the heart of the track (THE MEMORY, if woven) and play it exactly as it will export">
            <Headphones size={11} /> THE HEART
          </button>
          <button onClick={() => void api.exactPreview('start')} disabled={noSrc || state.rendering}
            className="flex items-center gap-1 border border-charcoal/60 px-2 py-1 text-[9px] tracking-widest hover:bg-charcoal/10 disabled:opacity-40">
            <Headphones size={11} /> THE START
          </button>
          {ex && (
            <>
              <span className="flex border-2" style={{ borderColor: CHARCOAL }} role="radiogroup" aria-label="Exact preview A/B">
                {(['mastered', 'raw'] as const).map((w) => (
                  <button key={w} role="radio" aria-checked={state.exactPlaying === w} onClick={() => api.playExact(w)}
                    className="px-2 py-0.5 text-[9px] tracking-widest font-bold"
                    style={state.exactPlaying === w ? { background: BURNT, color: CREAM } : undefined}
                    title={w === 'raw' ? 'The same 30 s without the master, at the same loudness — compare tone, not level' : 'Exactly what the export will sound like'}>
                    {w === 'mastered' ? 'A · MASTERED' : 'B · UNMASTERED'}
                  </button>
                ))}
              </span>
              {state.exactPlaying && (
                <button onClick={api.stopExact} className="flex items-center gap-1 text-[9px] tracking-widest hover:opacity-60">
                  <Square size={10} /> STOP
                </button>
              )}
              <span className="text-[9px] tracking-widest opacity-60">
                {ex.label}{ex.lufs != null && Number.isFinite(ex.lufs) ? ` · ${ex.lufs.toFixed(1)} LUFS · TP ${ex.truePeak?.toFixed(1)} dBTP` : ''}
              </span>
            </>
          )}
        </div>
      </div>

      {/* 3 · finish */}
      <div className="px-3 py-2 flex items-center gap-3 flex-wrap">
        <b className="text-[10px] tracking-[0.25em]"><span style={{ color: BURNT }}>3</span> FINISH</b>
        <label className="flex items-center gap-1 text-[9px] tracking-widest" title="Integrated loudness of the final file; true peak is held at −1 dBTP">
          LOUDNESS
          <select value={state.loudnessTarget == null ? 'off' : String(state.loudnessTarget)}
            onChange={(e) => api.setLoudnessTarget(e.target.value === 'off' ? null : Number(e.target.value))}
            className="bg-transparent border border-charcoal/40 px-1 py-0.5 text-[9px] tracking-widest" aria-label="Loudness target">
            {LOUDNESS_TARGETS.map((t) => <option key={t.label} value={t.lufs == null ? 'off' : String(t.lufs)}>{t.label}</option>)}
            {state.loudnessTarget != null && !LOUDNESS_TARGETS.some((t) => t.lufs === state.loudnessTarget) && (
              <option value={String(state.loudnessTarget)}>{state.loudnessTarget} REFERENCE</option>
            )}
          </select>
        </label>
        <span className="text-[9px] tracking-widest opacity-60">CEILING −1 dBTP · {state.exportFormat.bits}-BIT / {state.exportFormat.sampleRate / 1000} kHz</span>
        <span className="flex-1" />
        <span className="flex items-center gap-1 border border-charcoal/60 px-1.5 py-1">
          <input type="number" min={0.5} max={45} step={0.5} value={minutes}
            onChange={(e) => {
              const v = Math.min(45, Math.max(0.5, Number(e.target.value) || 2))
              setMinutes(v)
              if (state.memoryForm) api.setMemoryMinutes(v)
            }}
            className="w-10 bg-transparent text-[10px]" aria-label="Final length in minutes" />
          <span className="text-[9px] opacity-60">MIN</span>
        </span>
        <button onClick={() => void api.renderToWav(minutes)} disabled={noSrc || state.rendering}
          className="flex items-center gap-1.5 border-2 px-3 py-1.5 text-[10px] tracking-[0.2em] font-bold disabled:opacity-40"
          style={{ borderColor: BURNT, background: BURNT, color: CREAM }}
          title="Render the finished track: mix → master chain → loudness → true-peak limit → dithered WAV with metadata">
          <Download size={12} /> RENDER FINAL MASTER
        </button>
        {rep && Number.isFinite(rep.integrated) && (
          <span className="w-full text-[9px] tracking-widest opacity-70">
            LAST EXPORT: {rep.integrated.toFixed(1)} LUFS · TRUE PEAK {rep.truePeak.toFixed(1)} dBTP · SHORT-TERM MAX {rep.shortTermMax.toFixed(1)} LUFS
          </span>
        )}
      </div>
      {/* release kit */}
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap border-t border-charcoal/20">
        <b className="text-[9px] tracking-[0.2em]">RELEASE KIT</b>
        <input value={kit.title} onChange={(e) => setKit({ ...kit, title: e.target.value })} placeholder="title"
          className="w-40 bg-transparent border border-charcoal/40 px-1.5 py-0.5 text-[10px] outline-none placeholder:opacity-45" aria-label="Release title" />
        <input value={kit.artist} onChange={(e) => setKit({ ...kit, artist: e.target.value })} placeholder="artist"
          className="w-32 bg-transparent border border-charcoal/40 px-1.5 py-0.5 text-[10px] outline-none placeholder:opacity-45" aria-label="Artist" />
        <input value={kit.year} onChange={(e) => setKit({ ...kit, year: e.target.value })} placeholder="year"
          className="w-14 bg-transparent border border-charcoal/40 px-1.5 py-0.5 text-[10px] outline-none" aria-label="Year" />
        <label className="flex items-center gap-1 text-[9px] tracking-widest" title="A 1280×720 WebM for YouTube — recorded in real time, so it takes as long as the track; keep this tab visible">
          <input type="checkbox" checked={kit.video} onChange={(e) => setKit({ ...kit, video: e.target.checked })} className="accent-[#D35400]" />
          + YOUTUBE VIDEO (REAL TIME)
        </label>
        <button onClick={() => void api.releaseKit({ minutes, ...kit })} disabled={noSrc || state.rendering}
          className="flex items-center gap-1 border-2 px-2 py-1 text-[9px] tracking-widest font-bold disabled:opacity-40"
          style={{ borderColor: CHARCOAL }}
          title="One ZIP: the final master WAV (cover in its tags), a 3000×3000 cover made from your fragments, release.txt for Bandcamp / distributors / YouTube (with chapters), samples.txt">
          <Package size={11} /> MAKE RELEASE KIT
        </button>
        <span className="text-[8px] tracking-wider opacity-50 w-full">master WAV · cover 3000×3000 · Bandcamp / DistroKid / YouTube texts with chapters · sample report — the album gets its cover and texts in its ZIP too</span>
      </div>

      <MidiPanel api={api} />
    </div>
  )
}
