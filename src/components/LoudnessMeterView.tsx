import { useEffect, useRef, useState } from 'react'
import { engine } from '../engine/AudioEngine'
import type { LoudnessReport } from '../engine/loudness'

const BURNT = '#D35400'

// below the BS.1770 absolute gate it's silence, not a number worth reading
const fmt = (x: number) => (Number.isFinite(x) && x > -70 ? x.toFixed(1) : '—')

/**
 * Live LUFS readout of the master (momentary / short-term / integrated),
 * polled 5×/s in its own component so the rest of the app doesn't re-render.
 * The target marker shows how far the live mix sits from the export target.
 */
export function LoudnessMeterView({
  target,
  lastReport,
  playing,
}: {
  target: number | null
  lastReport: LoudnessReport | null
  playing: boolean
}) {
  const [v, setV] = useState({ momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity })
  const wasPlaying = useRef(playing)

  useEffect(() => {
    // fresh integrated reading every time playback (re)starts
    if (playing && !wasPlaying.current) engine.meter?.reset()
    wasPlaying.current = playing
  }, [playing])

  useEffect(() => {
    const id = window.setInterval(() => {
      const m = engine.meter
      if (m) setV(m.read())
    }, 200)
    return () => window.clearInterval(id)
  }, [])

  // bar: −40 … 0 LUFS
  const pct = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(100, ((x + 40) / 40) * 100)) : 0)
  const hot = target != null && Number.isFinite(v.shortTerm) && v.shortTerm > target + 1

  return (
    <span
      className="flex items-center gap-1.5 border border-charcoal/60 px-1.5 py-1 text-[9px] tracking-widest tabular-nums"
      title={
        'Live loudness of the master (BS.1770, approximate K-weighting).\n' +
        'M = momentary 0.4s · S = short-term 3s · I = integrated since play.\n' +
        (target != null
          ? `Exports are normalized to ${target} LUFS, true peak ≤ −1 dBTP.`
          : 'Export normalization is OFF.') +
        (lastReport
          ? `\nLast export: ${fmt(lastReport.integrated)} LUFS · TP ${fmt(lastReport.truePeak)} dBTP`
          : '')
      }
    >
      <span className="relative w-14 h-2 border border-charcoal/40 overflow-hidden">
        <span
          className="absolute left-0 top-0 h-full"
          style={{ width: `${pct(v.shortTerm)}%`, background: hot ? BURNT : '#1A1A1A', opacity: 0.75, transition: 'width .2s' }}
        />
        {target != null && (
          <span className="absolute top-0 h-full w-px" style={{ left: `${pct(target)}%`, background: BURNT }} />
        )}
      </span>
      <span>M {fmt(v.momentary)}</span>
      <span>S {fmt(v.shortTerm)}</span>
      <span className="opacity-60">I {fmt(v.integrated)}</span>
      <span className="opacity-60">LUFS</span>
    </span>
  )
}
