import { useState } from 'react'
import type { EngineApi } from '../hooks/useAudioEngine'
import { VOICE_NAMES } from '../engine/types'
import type { MacroParams, ScaleName, VoiceParams } from '../engine/types'

const CHARCOAL = '#1A1A1A'
const BURNT = '#D35400'
const CREAM = '#F4EFEA'

const SLIDER_KEYS: Array<{ key: keyof VoiceParams; label: string }> = [
  { key: 'level', label: 'LVL' },
  { key: 'density', label: 'DNS' },
  { key: 'pitchRange', label: 'PIT' },
  { key: 'reverbSend', label: 'REV' },
]

const MACROS: Array<{ key: keyof MacroParams; label: string; hint: string }> = [
  { key: 'decayFactor', label: 'DECAY FACTOR', hint: 'grain length · reverb wet' },
  { key: 'tapeAging', label: 'TAPE AGING', hint: 'wow/flutter · hiss · warmth' },
  { key: 'chaos', label: 'CHAOS / ENTROPY', hint: 'markov jumps · trigger jitter' },
]

const SCALE_OPTIONS: Array<{ value: ScaleName; label: string }> = [
  { value: 'free', label: 'FREE' },
  { value: 'pentatonic', label: 'PENTA' },
  { value: 'dorian', label: 'DORIAN' },
  { value: 'minor', label: 'MINOR' },
  { value: 'lydian', label: 'LYDIAN' },
  { value: 'wholetone', label: 'WHOLE' },
  { value: 'fifths', label: '5THS' },
]

function VSlider({
  value,
  onChange,
  label,
}: {
  value: number
  onChange: (v: number) => void
  label: string
}) {
  return (
    <label className="flex flex-col items-center gap-1 text-[9px] tracking-widest">
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-16"
      />
      <span>{label}</span>
    </label>
  )
}

export function MixerRack({ api }: { api: EngineApi }) {
  const {
    state, setVoiceParam, setMacro, setTelephony, setCrush, setScale, setDrift, setDuck,
    setGroove, setWidth, setTilt, setAqua, setLooped, setBlockSec, setKeyLock, setPadMode,
    setVoicing, setPlateShort, setSub, setFragLen, setPhraseMode, loopArmed, peklerPreset, afrikaPreset, templetonPreset, jelinekPreset, poirierPreset,
    jeckPreset, caretakerPreset, polePreset, booksPreset, hassellPreset, loscilPreset, gesPreset, ielasiPreset, microstoriaPreset, keszlerPreset, buddPreset,
    setDubMode, setTapeMode, setReverseProb, setPings, toggleRouting, saveScene, morphScene, clearScene, playSong, stopSong,
  } = api
  const [songText, setSongText] = useState('A:45 B:45')

  return (
    <div className="border border-charcoal/60 grid grid-cols-1 lg:grid-cols-[1fr_auto] divide-y lg:divide-y-0 lg:divide-x divide-charcoal/30">
      {/* channel strips */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 divide-x divide-charcoal/30">
        {state.voices.map((v, i) => {
          const mask = state.sourceMasks[i]
          return (
            <div key={i} className="p-3 flex flex-col gap-2">
              <div className="text-[10px] tracking-[0.15em]">
                V{i + 1} <span className="opacity-60">{VOICE_NAMES[i]}</span>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => setVoiceParam(i, 'mute', !v.mute)}
                  className="px-2 py-0.5 text-[9px] border border-charcoal/60 hover:bg-charcoal/10"
                  style={v.mute ? { background: CHARCOAL, color: CREAM } : undefined}
                >
                  M
                </button>
                <button
                  onClick={() => setVoiceParam(i, 'solo', !v.solo)}
                  className="px-2 py-0.5 text-[9px] border border-charcoal/60 hover:bg-charcoal/10"
                  style={v.solo ? { background: BURNT, color: CREAM } : undefined}
                >
                  S
                </button>
              </div>
              {/* source routing: which pool sources this voice may draw from */}
              {state.sources.length > 1 && (
                <div className="flex gap-0.5 flex-wrap" title="Source routing — highlighted sources feed this voice; none highlighted = all">
                  {state.sources.map((s, si) => {
                    const active = !mask || mask.includes(si)
                    return (
                      <button
                        key={si}
                        onClick={() => toggleRouting(i, si)}
                        title={s.name}
                        className="w-4 h-4 text-[8px] border border-charcoal/40 leading-none"
                        style={
                          active
                            ? { background: mask ? BURNT : CHARCOAL, color: CREAM }
                            : { opacity: 0.35 }
                        }
                      >
                        {si + 1}
                      </button>
                    )
                  })}
                </div>
              )}
              <div className="flex gap-2 flex-wrap">
                {SLIDER_KEYS.map(({ key, label }) => (
                  <VSlider
                    key={key}
                    label={label}
                    value={v[key] as number}
                    onChange={(val) => setVoiceParam(i, key, val as VoiceParams[typeof key])}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* macros + rack switches + scenes/song */}
      <div className="p-3 flex flex-col gap-3 lg:w-72">
        {MACROS.map(({ key, label, hint }) => (
          <div key={key}>
            <div className="flex justify-between text-[10px] tracking-[0.15em]">
              <span>{label}</span>
              <span style={{ color: BURNT }}>{Math.round(state.macros[key] * 100)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={state.macros[key]}
              onChange={(e) => setMacro(key, Number(e.target.value))}
              className="w-full"
            />
            <div className="text-[8px] opacity-50 tracking-wider">{hint}</div>
          </div>
        ))}

        <div className="flex gap-1.5 pt-1 flex-wrap">
          <button
            onClick={peklerPreset}
            title="One-click Pekler form: PHRASE loop backbone, sparse groove plunder, quiet decay, no melody, PLATE+VOICING+DUB+TAPE, sub pulse on the root. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            PEKLER
          </button>
          <button
            onClick={afrikaPreset}
            title="One-click Space Afrika form: submerged voice-led minor chord pads, long chamber reverb, heavy −12st sub layer, AQUA blur, street ambience up, sparse dub decoration, dark tilt, wide stereo. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            AFRIKA
          </button>
          <button
            onClick={templetonPreset}
            title="One-click Mark Templeton form: stuttering V5 micro-loop edits, heavy tape warble, 35% reversals, abrupt 45s block cuts, pentatonic melody fragments, dry short plate — folktronica concrète. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            TMPLTN
          </button>
          <button
            onClick={jelinekPreset}
            title="One-click Jan Jelinek form: tiny clicking micro-loops phasing endlessly (BLK OFF), soft grooved pulse at 96, warm dorian bed, deep sub bass, dry intimate plate, near-zero chaos. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            JELINEK
          </button>
          <button
            onClick={poirierPreset}
            title="One-click Roméo Poirier form: verbatim phrase loop submerged in heavy AQUA blur + long wet chamber, dub gestures, sonar swells, warm lydian float at 76 — aquatic dub-jazz. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            POIRIER
          </button>
          <button
            onClick={jeckPreset}
            title="One-click Philip Jeck / Basinski form: long loops rotting on the turntable — endless LOOPLOCK, tape aging 85 + DRIFT disintegration, crackle way up, 25% reversed grains, dead-speaker VOICING, nothing rhythmic. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            JECK
          </button>
          <button
            onClick={caretakerPreset}
            title="One-click Caretaker form: one verbatim ballroom PHRASE loop through TELEPHONY and a huge empty room, buried in shellac crackle — CHORDLOCK off, no rhythm voices, no decoration. The record remembers itself."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            CARETAKER
          </button>
          <button
            onClick={polePreset}
            title="One-click Pole form: broken-filter clicks on a dubby GROOVE lilt at 106 with DUCK pumping, fine crackling fragments, deep dub bass, dry short plate, no tape — digital rot, not tape rot. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            POLE
          </button>
          <button
            onClick={booksPreset}
            title="One-click The Books form: hyperactive speech-and-string collage — chaos 55, FRAG FINE everywhere, free unlooped flow, dry close plate, bright tilt, chattering plunder + plucked melody fragments. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            BOOKS
          </button>
          <button
            onClick={hassellPreset}
            title="One-click Jon Hassell fourth-world form: voice-led dorian PADs in humid dub echo, a winding V7 line as the trumpet, jungle swells, wide and unlooped — possible musics. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            HASSELL
          </button>
          <button
            onClick={loscilPreset}
            title="One-click Loscil form: submerged minor PADs on a barely-there 60bpm sub pulse with slow DUCK breathing, AQUA 45, dark tilt, very wide, chaos near zero — far below the surface. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            LOSCIL
          </button>
          <button
            onClick={gesPreset}
            title="One-click G.E.S. form (Gesellschaft zur Emanzipation des Samples): found loops circulating in 90s blocks, busy plunder collage, warm pentatonic bed, dead-speaker VOICING, shortwave static up, dry close plate — holiday-recording exotica. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            GES
          </button>
          <button
            onClick={ielasiPreset}
            title="One-click Giuseppe Ielasi form (Aix): dusty loop miniatures on a soft swung GROOVE at 84 with DUCK breathing, granular V5 smears, surface dust up, close dry plate, warm blur — head-nod concrète. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            IELASI
          </button>
          <button
            onClick={microstoriaPreset}
            title="One-click Microstoria form (init ding / _snd): weightless wholetone PADs smeared with 12-BIT digital debris — unlooped, beatless, bright sheen, glitch micro-fragments floating. No tape, purely digital rot. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            MCRSTRIA
          </button>
          <button
            onClick={keszlerPreset}
            title="One-click Eli Keszler form (Stadium): pointillist drumming — dense un-gridded Poisson flurries of tiny transient hits (V2 at 80/70) + micro-rattles, chaos 50, dry close plate, bright detail, soft PAD haze far underneath. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            KESZLER
          </button>
          <button
            onClick={buddPreset}
            title="One-click Harold Budd form (The Pearl): soft-pedal piano ambient — a slow luminous V7 line over lydian voice-led PADs in a huge gauzy chamber (decay 85), no rhythm, no dust, no plunder. The reverb is the instrument. Sets the whole desk."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal"
            style={{ background: CHARCOAL, color: CREAM }}
          >
            BUDD
          </button>
          <button
            onClick={() => setTelephony(!state.telephony)}
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.telephony ? { background: CHARCOAL, color: CREAM } : undefined}
          >
            TELEPHONY
          </button>
          <button
            onClick={() => setCrush(!state.crush)}
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.crush ? { background: CHARCOAL, color: CREAM } : undefined}
          >
            12-BIT
          </button>
          <button
            onClick={() => setDrift(!state.drift)}
            title="Slow autonomous random-walk of the three macros"
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.drift ? { background: BURNT, color: CREAM } : undefined}
          >
            DRIFT
          </button>
          <button
            onClick={() => setDuck(!state.duck)}
            title="Sidechain: plunder hits duck the harmonic bed"
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.duck ? { background: BURNT, color: CREAM } : undefined}
          >
            DUCK
          </button>
          <button
            onClick={() => setGroove(!state.groove)}
            title="V2 timing: euclidean 16th grid with swing at the pulse BPM instead of the Poisson stream"
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.groove ? { background: BURNT, color: CREAM } : undefined}
          >
            GROOVE
          </button>
        </div>

        {/* Pekler / Templeton / Poirier layer */}
        <div className="flex gap-1.5 flex-wrap">
          <button
            onClick={() => setLooped(!state.looped)}
            title="Loop-lock: every voice freezes into a verbatim-repeating cell of its own length — the loops phase against each other (Pekler / Jelinek / Poirier)"
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.looped ? { background: BURNT, color: CREAM } : undefined}
          >
            LOOPLOCK
          </button>
          <select
            value={state.blockSec}
            onChange={(e) => setBlockSec(Number(e.target.value))}
            title="Block structure: abruptly find new loops every N seconds (loop-lock only)"
            className="bg-transparent text-[9px] tracking-widest border border-charcoal/60 px-1"
          >
            <option value={0}>BLK OFF</option>
            <option value={45}>45S</option>
            <option value={90}>90S</option>
            <option value={120}>120S</option>
          </select>
          <button
            onClick={() => setKeyLock(!state.keyLock)}
            title="CHORDLOCK: a slow chord progression every voice obeys — chroma-matched slice choice, chord-tone transposition, cadence breathing. The current chord shows on the button."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.keyLock ? { background: BURNT, color: CREAM } : undefined}
          >
            {state.keyLock && state.chordName ? `♪ ${state.chordName}` : 'CHORDLOCK'}
          </button>
          <button
            onClick={() => setPhraseMode(!state.phraseMode)}
            title="PHRASE: V1 loops one continuous onset-aligned region of a source verbatim (2-8s by FRAG) — the loop is the piece. Re-picks at BLK boundaries."
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.phraseMode ? { background: BURNT, color: CREAM } : undefined}
          >
            PHRASE
          </button>
          <button
            onClick={loopArmed}
            disabled={state.armedSliceId === null}
            title="LOOP THIS: the armed slice (timbre-map click) becomes the V1 phrase — you choose the loop, the machine keeps it"
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10 disabled:opacity-35"
          >
            ARM→LOOP
          </button>
          <button
            onClick={() => setPadMode(!state.padMode)}
            title="V1 becomes a voice-led chord pad: sustained tones on the chord, each moving to its nearest note when the chord changes (needs CHORDLOCK)"
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.padMode ? { background: BURNT, color: CREAM } : undefined}
          >
            PAD
          </button>
          <button
            onClick={() => setDubMode(!state.dub)}
            title="Dub gestures: occasional delay throws, filter drops, reverb splashes, mute drops"
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.dub ? { background: BURNT, color: CREAM } : undefined}
          >
            DUB
          </button>
          <button
            onClick={() => setTapeMode(!state.tape)}
            title="Tape language: reversed grains, slow swells, dropout holes, wow dips"
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.tape ? { background: BURNT, color: CREAM } : undefined}
          >
            TAPE
          </button>
          <button
            onClick={() => setVoicing(!state.voicing)}
            title="Vintage voicing: Butterworth HP 320Hz + resonant bell +2.5dB@1.2kHz + 24dB/oct LP 5.5kHz — the old-record frequency curve"
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.voicing ? { background: BURNT, color: CREAM } : undefined}
          >
            VOICING
          </button>
          <button
            onClick={() => setPlateShort(!state.plateShort)}
            title="Short dark plate reverb: 1.7s decay damped above 3.5kHz, instead of the long chamber"
            className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.plateShort ? { background: BURNT, color: CREAM } : undefined}
          >
            PLATE
          </button>
        </div>

        <div className="flex gap-3 flex-wrap">
          <label className="flex-1 min-w-[28%]">
            <div className="flex justify-between text-[9px] tracking-widest">
              <span className="opacity-60">WIDTH</span>
              <span style={{ color: BURNT }}>{Math.round(state.width * 200)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={state.width}
              onChange={(e) => setWidth(Number(e.target.value))}
              className="w-full"
              title="Stereo image: 0 = mono, 100% = as recorded, 200% = extra wide"
            />
          </label>
          <label className="flex-1">
            <div className="flex justify-between text-[9px] tracking-widest">
              <span className="opacity-60">AQUA</span>
              <span style={{ color: BURNT }}>{Math.round(state.aqua * 100)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={state.aqua}
              onChange={(e) => setAqua(Number(e.target.value))}
              className="w-full"
              title="Submerged: chorus wobble + steep muffle + narrowed image (Poirier)"
            />
          </label>
          <label className="flex-1">
            <div className="flex justify-between text-[9px] tracking-widest">
              <span className="opacity-60">SUB</span>
              <span style={{ color: BURNT }}>{Math.round(state.sub * 200)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={0.5}
              step={0.01}
              value={state.sub}
              onChange={(e) => setSub(Number(e.target.value))}
              className="w-full"
              title="Parallel sub-octave layer: the whole mix pitched −12st and blended back under itself"
            />
          </label>
          <label className="flex-1 min-w-[28%]">
            <div className="flex justify-between text-[9px] tracking-widest">
              <span className="opacity-60">RVRS</span>
              <span style={{ color: BURNT }}>{Math.round(state.reverseProb * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={state.reverseProb}
              onChange={(e) => setReverseProb(Number(e.target.value))}
              className="w-full"
              title="Reverse-grain probability: how often V1 grains play backwards (TAPE adds its own +18%)"
            />
          </label>
          <label className="flex-1 min-w-[28%]">
            <div className="flex justify-between text-[9px] tracking-widest">
              <span className="opacity-60">PINGS</span>
              <span style={{ color: BURNT }}>{Math.round(state.pings * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={state.pings}
              onChange={(e) => setPings(Number(e.target.value))}
              className="w-full"
              title="V8 PINGS: West Coast FM chimes at random intervals, tuned to the chord clock, run through the tape chain — the Buchla droplets between the pads. 0 = off"
            />
          </label>
          <label className="flex-1 min-w-[28%]">
            <div className="flex justify-between text-[9px] tracking-widest">
              <span className="opacity-60">TILT</span>
              <span style={{ color: BURNT }}>{state.tilt > 0 ? '+' : ''}{Math.round(state.tilt * 6)}dB</span>
            </div>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={state.tilt}
              onChange={(e) => setTilt(Number(e.target.value))}
              className="w-full"
              title="Spectral tilt: left = dark, right = bright (±6dB shelves)"
            />
          </label>
        </div>

        <div className="flex items-center gap-1">
          <span className="text-[9px] tracking-widest opacity-60 mr-1">FRAG</span>
          {(['fine', 'mid', 'long'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setFragLen(m)}
              title="Fragment length: FINE = short confetti grains (slices max 1.2s) · MID = up to 2.8s · LONG = sustained harmonic loops up to 6s. Re-slices auto-cut sources."
              className="flex-1 px-1 py-0.5 text-[9px] tracking-wider border border-charcoal/60 hover:bg-charcoal/10"
              style={state.fragLen === m ? { background: BURNT, color: CREAM } : undefined}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[9px] tracking-widest opacity-60 mr-1">SCALE</span>
          {SCALE_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setScale(value)}
              title="Quantize voice detune to this scale"
              className="flex-1 px-1 py-0.5 text-[9px] tracking-wider border border-charcoal/60 hover:bg-charcoal/10"
              style={state.scale === value ? { background: CHARCOAL, color: CREAM } : undefined}
            >
              {label}
            </button>
          ))}
        </div>

        {/* scenes */}
        <div className="flex items-center gap-1">
          <span className="text-[9px] tracking-widest opacity-60 mr-1">SCENES</span>
          {(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const).map((name, slot) => {
            const filled = state.scenesFilled[slot]
            return (
              <button
                key={name}
                onClick={(e) => {
                  if (e.shiftKey && filled) clearScene(slot)
                  else if (filled) morphScene(slot, 10)
                  else saveScene(slot)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  saveScene(slot)
                }}
                title={
                  filled
                    ? 'Click: morph to this scene over 10s · Right-click: overwrite with current state · Shift+Click: clear the slot'
                    : 'Click: save current state into this slot'
                }
                className="flex-1 px-1 py-1 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
                style={filled ? { background: CHARCOAL, color: CREAM } : { opacity: 0.6 }}
              >
                {name}
              </button>
            )
          })}
        </div>

        {/* song mode */}
        <div className="flex items-center gap-1">
          <span className="text-[9px] tracking-widest opacity-60 mr-1">SONG</span>
          <input
            type="text"
            value={songText}
            onChange={(e) => setSongText(e.target.value)}
            placeholder="A:60 B:90 C:45"
            title="Scene sequence with durations in seconds; loops. Also shapes offline renders."
            className="flex-1 min-w-0 border border-charcoal/60 bg-transparent px-1.5 py-0.5 text-[9px] tracking-wider"
          />
          <button
            onClick={() => (state.songActive ? stopSong() : playSong(songText))}
            className="px-2 py-0.5 text-[9px] tracking-widest border border-charcoal/60 hover:bg-charcoal/10"
            style={state.songActive ? { background: BURNT, color: CREAM } : undefined}
          >
            {state.songActive ? 'STOP' : 'PLAY'}
          </button>
        </div>
      </div>
    </div>
  )
}
