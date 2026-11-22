import type { AudioEngine } from './AudioEngine'
import type { ScaleName, VoiceParams } from './types'

/**
 * Quick-compose moods: a whole desk setting from one choice, then three
 * plain-language knobs (DARKNESS · SPACE · MOTION) that bend it. Built for
 * eerie / mythic material — drones, ghosts, rituals — rather than grooves.
 *
 * Voices: 0 bed · 1 plunder hits · 2 resonant decays · 3 surface noise ·
 * 4 microloops · 5 sub pulse · 6 melody line.
 */

export interface MoodKnobs {
  /** 0 = pale & bright … 1 = black, low, worn */
  darkness: number
  /** 0 = close & dry … 1 = cavernous, submerged */
  space: number
  /** 0 = frozen, glacial … 1 = restless, shifting */
  motion: number
}

interface MoodDef {
  key: string
  label: string
  /** one line for the card */
  line: string
  knobs: MoodKnobs
  scale: ScaleName
  /** chord engine + voice-led pads (choir-like) */
  pads: boolean
  frag: 'fine' | 'mid' | 'long'
  reverse: number
  pings: number
  dub: boolean
  tape: boolean
  telephony: boolean
  bpm: number
  voices: Array<Partial<VoiceParams>>
}

export const MOODS: MoodDef[] = [
  {
    key: 'memory',
    label: 'FORGOTTEN MEMORY',
    line: 'Warm, tonal and worn: a pentatonic lullaby on old tape, a memory you never had.',
    knobs: { darkness: 0.4, space: 0.65, motion: 0.3 },
    scale: 'pentatonic', pads: true, frag: 'long', reverse: 0.12, pings: 0.16,
    dub: false, tape: true, telephony: false, bpm: 64,
    voices: [
      { level: 0.85, density: 0.45, pitchRange: 0.35, mute: false },
      { level: 0.12, density: 0.05, pitchRange: 0.3, mute: true },
      { level: 0.5, density: 0.3, mute: false },
      { level: 0.5, mute: false },
      { level: 0.3, density: 0.2, pitchRange: 0.3, mute: false },
      { level: 0.35, density: 0.15, mute: false },
      { level: 0.5, density: 0.3, mute: false },
    ],
  },
  {
    key: 'eerie',
    label: 'EERIE',
    line: 'Unresolved whole-tone haze, backwards ghosts, sparse cold chimes.',
    knobs: { darkness: 0.65, space: 0.7, motion: 0.3 },
    scale: 'wholetone', pads: false, frag: 'long', reverse: 0.45, pings: 0.15,
    dub: false, tape: true, telephony: false, bpm: 52,
    voices: [
      { level: 0.8, density: 0.35, pitchRange: 0.9, mute: false },
      { level: 0.2, density: 0.08, pitchRange: 0.6, mute: false },
      { level: 0.65, density: 0.45, mute: false },
      { level: 0.5, mute: false },
      { level: 0.35, density: 0.2, pitchRange: 0.8, mute: false },
      { level: 0.45, density: 0.12, mute: false },
      { level: 0.4, mute: true },
    ],
  },
  {
    key: 'mythic',
    label: 'MYTHIC',
    line: 'Dorian choir-pads, a slow ancient line, ritual bells and a deep pulse.',
    knobs: { darkness: 0.45, space: 0.85, motion: 0.35 },
    scale: 'dorian', pads: true, frag: 'long', reverse: 0.15, pings: 0.3,
    dub: true, tape: false, telephony: false, bpm: 60,
    voices: [
      { level: 0.85, density: 0.5, pitchRange: 0.5, mute: false },
      { level: 0.25, density: 0.1, mute: false },
      { level: 0.55, density: 0.35, mute: false },
      { level: 0.3, mute: false },
      { level: 0.25, density: 0.2, mute: false },
      { level: 0.7, density: 0.3, mute: false },
      { level: 0.45, density: 0.35, mute: false },
    ],
  },
  {
    key: 'ritual',
    label: 'HAUNTED RITUAL',
    line: 'Eerie + mythic: an open-fifth drone, reversed voices, a slow ceremonial drum.',
    knobs: { darkness: 0.75, space: 0.75, motion: 0.4 },
    scale: 'fifths', pads: true, frag: 'long', reverse: 0.35, pings: 0.22,
    dub: true, tape: true, telephony: false, bpm: 56,
    voices: [
      { level: 0.85, density: 0.45, pitchRange: 0.7, mute: false },
      { level: 0.3, density: 0.12, mute: false },
      { level: 0.6, density: 0.4, mute: false },
      { level: 0.45, mute: false },
      { level: 0.3, density: 0.2, pitchRange: 0.7, mute: false },
      { level: 0.8, density: 0.35, mute: false },
      { level: 0.35, density: 0.25, mute: false },
    ],
  },
  {
    key: 'sunken',
    label: 'SUNKEN TEMPLE',
    line: 'A ruin under water: minor pads, muffled bells, everything far away.',
    knobs: { darkness: 0.6, space: 1, motion: 0.2 },
    scale: 'minor', pads: true, frag: 'long', reverse: 0.25, pings: 0.25,
    dub: false, tape: true, telephony: false, bpm: 50,
    voices: [
      { level: 0.85, density: 0.4, pitchRange: 0.5, mute: false },
      { level: 0.15, density: 0.06, mute: false },
      { level: 0.5, density: 0.3, mute: false },
      { level: 0.55, mute: false },
      { level: 0.2, density: 0.15, mute: false },
      { level: 0.6, density: 0.2, mute: false },
      { level: 0.3, density: 0.2, mute: true },
    ],
  },
]

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v))

/** Set the whole desk for a mood, bent by the three knobs. */
export function applyMood(engine: AudioEngine, key: string, k: MoodKnobs) {
  const m = MOODS.find((x) => x.key === key)
  if (!m) return
  const d = clamp(k.darkness)
  const s = clamp(k.space)
  const mo = clamp(k.motion)

  // structure: free-flowing, unlooped — moods breathe instead of repeating
  engine.setPhraseMode(false)
  engine.setLooped(false)
  engine.setBlockSec(0)
  engine.setGroove(false)
  engine.setDuck(false)
  engine.setCrush(false)
  engine.setVoicing(false)
  engine.setTelephony(m.telephony)
  engine.setScale(m.scale)
  engine.setKeyLock(m.pads)
  engine.setPadMode(m.pads)
  engine.setFragLen(m.frag)
  engine.setDub(m.dub)
  engine.setTape(m.tape)
  engine.setPings(m.pings * (0.6 + s * 0.6))
  engine.setReverseProb(clamp(m.reverse + (d - 0.5) * 0.2))

  // DARKNESS: tilt down, more wear, heavier sub
  engine.setTilt(0.25 - d * 0.85)
  engine.setSub(0.1 + d * 0.4)

  // SPACE: room size, blur, width
  engine.setPlateShort(s < 0.3)
  engine.setAqua(s * 0.6)
  engine.setWidth(0.45 + s * 0.5)

  // MOTION: tempo, chaos, densities, autonomous drift
  engine.bpm = Math.round(m.bpm * (0.8 + mo * 0.5))
  engine.setMacro('decayFactor', clamp(0.45 + s * 0.5))
  engine.setMacro('tapeAging', clamp(0.15 + d * 0.65))
  engine.setMacro('chaos', clamp(0.04 + mo * 0.45))
  m.voices.forEach((v, i) => {
    engine.setVoiceParam(i, 'level', v.level ?? 0.5)
    engine.setVoiceParam(i, 'mute', v.mute ?? false)
    engine.setVoiceParam(i, 'solo', false)
    if (v.density != null) engine.setVoiceParam(i, 'density', clamp(v.density * (0.55 + mo * 0.9)))
    if (v.pitchRange != null) engine.setVoiceParam(i, 'pitchRange', v.pitchRange)
    engine.setVoiceParam(i, 'reverbSend', clamp(0.15 + s * 0.7))
  })
  engine.setDrift(mo > 0.55)
}
