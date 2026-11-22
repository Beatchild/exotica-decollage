import { useEffect, useReducer } from 'react'
import { Cable, X } from 'lucide-react'
import type { useAudioEngine } from '../hooks/useAudioEngine'
import { MIDI_TARGETS, faderToGain, midi } from '../ui/midi'
import type { MidiBinding } from '../ui/midi'

type Api = ReturnType<typeof useAudioEngine>

const BURNT = '#D35400'
const CREAM = '#F4EFEA'

const fmt = (b?: MidiBinding) => (b ? `${b.type === 'cc' ? 'CC' : 'NOTE'} ${b.num} · CH ${b.ch + 1}` : '—')

/**
 * MIDI CONTROL: connect a controller, LEARN each target by moving a control.
 * Mix faders, layers, master and transport are driven here; COMPOSE and
 * WEAVE listen for their own targets.
 */
export function MidiPanel({ api }: { api: Api }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => midi.onStatus(redraw), [])

  // the targets this panel owns
  useEffect(() => midi.on((t, v) => {
    if (t.startsWith('mix.')) api.setMix({ [t.slice(4)]: faderToGain(v) })
    else if (t === 'layer.stretch') api.setMemoryLayers({ stretch: v })
    else if (t === 'layer.motif') api.setMemoryLayers({ motif: v })
    else if (t === 'layer.ghosts') api.setMemoryLayers({ ghosts: v })
    else if (t === 'layer.loop') api.setMemoryLayers({ loop: v })
    else if (t === 'master.toggle') api.setMasterBypass(!api.state.masterBypass)
    else if (t === 'transport.toggle') {
      if (api.state.playing) api.pause()
      else api.play()
    }
  }), [api])

  const st = midi.status
  return (
    <div className="px-3 py-2 flex flex-col gap-2 border-t border-charcoal/20">
      <div className="flex items-center gap-2 flex-wrap">
        <b className="text-[10px] tracking-[0.25em]"><span style={{ color: BURNT }}>4</span> MIDI CONTROL</b>
        {st !== 'ready' ? (
          <button onClick={() => void midi.connect()}
            className="flex items-center gap-1 border border-charcoal/60 px-2 py-1 text-[9px] tracking-widest hover:bg-charcoal/10"
            title="Use a hardware controller: faders, knobs and pads drive the studio live">
            <Cable size={11} /> {st === 'connecting' ? 'CONNECTING…' : 'CONNECT A CONTROLLER'}
          </button>
        ) : (
          <span className="text-[9px] tracking-widest">
            <b style={{ color: BURNT }}>●</b> {midi.inputs.length ? midi.inputs.join(' · ') : 'NO DEVICE PLUGGED IN'}
          </span>
        )}
        {st === 'unsupported' && <span className="text-[9px] tracking-wider opacity-70">this browser has no Web MIDI — use Chrome or Edge</span>}
        {st === 'denied' && <span className="text-[9px] tracking-wider opacity-70">MIDI access was refused — allow it in the site settings</span>}
        {midi.last && <span className="ml-auto text-[9px] tracking-widest opacity-50 tabular-nums">LAST: {midi.last}</span>}
      </div>
      {st === 'ready' && (
        <>
          <span className="text-[9px] tracking-wider opacity-60">
            {midi.learning
              ? `LEARNING ${MIDI_TARGETS.find((t) => t.key === midi.learning)?.label} — move a knob or fader, or hit a pad…`
              : 'click LEARN next to a control, then move the knob / fader / pad you want for it'}
          </span>
          <div className="grid gap-x-4 gap-y-1" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))' }}>
            {MIDI_TARGETS.map((t) => {
              const b = midi.bindings[t.key]
              const learning = midi.learning === t.key
              return (
                <div key={t.key} className="flex items-center gap-2 text-[9px] tracking-widest border-b border-charcoal/10 py-0.5">
                  <span className="flex-1 truncate">{t.label}</span>
                  <span className="tabular-nums opacity-60 w-24 text-right">{fmt(b)}</span>
                  <button onClick={() => midi.learn(learning ? null : t.key)}
                    className="border px-1.5 py-0.5"
                    style={learning ? { borderColor: BURNT, background: BURNT, color: CREAM } : { borderColor: 'rgba(26,26,26,0.4)' }}>
                    {learning ? 'WAITING…' : 'LEARN'}
                  </button>
                  {b && (
                    <button onClick={() => midi.unbind(t.key)} className="hover:opacity-60" aria-label={`Unmap ${t.label}`}><X size={10} /></button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
