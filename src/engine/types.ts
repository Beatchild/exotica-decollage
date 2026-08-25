export type SliceCategory = 'transient' | 'harmonic' | 'texture'

export type ScaleName =
  | 'free'
  | 'pentatonic'
  | 'wholetone'
  | 'fifths'
  | 'dorian'
  | 'minor'
  | 'lydian'

export const SCALES: Record<ScaleName, number[] | null> = {
  free: null,
  pentatonic: [0, 2, 4, 7, 9],
  wholetone: [0, 2, 4, 6, 8, 10],
  fifths: [0, 7],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
}

export interface Slice {
  id: number
  /** index into the engine's source pool */
  sourceIdx: number
  /** start offset in the source buffer, seconds */
  start: number
  /** duration, seconds (80ms – 1200ms) */
  duration: number
  rms: number
  /** spectral centroid, Hz */
  centroid: number
  zcr: number
  /** autocorrelation pitch estimate, Hz (null = unpitched) */
  pitch: number | null
  /** 0–1 confidence of the pitch estimate */
  pitchConfidence: number
  /** normalized 12-bin chroma (pitch-class energy) for harmonic matching */
  chroma?: number[]
  /** onset flux strength at slice start */
  attack: number
  category: SliceCategory
}

export interface VoiceParams {
  level: number // 0–1
  mute: boolean
  solo: boolean
  density: number // 0–1, event rate / grain overlap
  pitchRange: number // 0–1, how far playback may stray from unison
  reverbSend: number // 0–1
}

export interface MacroParams {
  decayFactor: number // 0–1 grain length + reverb wet
  tapeAging: number // 0–1 wow/flutter, hiss, filter warmth
  chaos: number // 0–1 markov jumps + trigger jitter
}

export interface FiredEvent {
  voice: number // 0..3
  sliceId: number
  /** audio-context time the event was scheduled for */
  time: number
  durationSec: number
}

/** One scheduled slice playback, relative to a cycle/step origin. */
export interface SliceEvent {
  voice: number
  sliceId: number
  /** offset from the cycle origin, seconds */
  t: number
  rate: number
  gain: number
  pan: number
  attack?: number
  release?: number
  grainDur?: number
  grainOffset?: number
  filter?: { freq0: number; freq1: number; q: number; sweepDur: number }
  /** microsampling: loop a tiny window of the slice for the cell duration */
  micro?: { loopDur: number; cellDur: number }
  /** tape language: play the slice backwards */
  reverse?: boolean
  /** rate already encodes the exact target note — skip chord correction */
  noCorrect?: boolean
}

export const VOICE_NAMES = [
  'Harmonic Bed',
  'Plunder Frag',
  'Resonant Decay',
  'Surface Noise',
  'Microloop',
  'Sub Pulse',
  'Melody',
] as const

/** a captured, verbatim-repeating loop cell for one voice (loop-lock mode) */
export interface LoopCell {
  events: SliceEvent[]
  dur: number
  reps: number
}

export const NUM_VOICES = VOICE_NAMES.length
/** voice index of the continuous surface-noise loop */
export const NOISE_VOICE = 3

/** a saved mixer/macro state for scene morphing */
export interface Scene {
  macros: MacroParams
  voices: VoiceParams[]
  scale: ScaleName
  telephony: boolean
  crush: boolean
  bpm: number
}

export interface SongSection {
  scene: number // scene slot index
  sec: number
}
