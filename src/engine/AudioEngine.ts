import * as Tone from 'tone'
import { DSPChain } from './DSPChain'
import { analyzeSource, buildSlices, detectBounds } from './Slicer'
import type { SourceAnalysis } from './Slicer'
import { WavRecorder } from './WavRecorder'
import { BUNDLED_STEMS, renderSurfaceNoise } from './stems'
import { genV1Cycle, genV2Step, genV3Step, genV5Cell, genV7Phrase, grooveNext } from './generate'
import type { HarmCtx } from './generate'
import { chordAt, chordCorrection, makeProgression } from './Harmony'
import type { Chord, Motif } from './Harmony'
import { analyzeImage, sonifyImage, traitsToPatch } from './ImageSonifier'
import { buildInterleave, buildMixtape, extractHighlights, trackCharacter } from './Highlights'
import { encodeWav } from './WavRecorder'
import { ytFetchAudio } from './ytBridge'
import { mulberry32, randomSeed } from './rng'
import type { Rng } from './rng'
import {
  NOISE_VOICE,
  NUM_VOICES,
} from './types'
import type {
  FiredEvent,
  LoopCell,
  MacroParams,
  ScaleName,
  Scene,
  Slice,
  SliceEvent,
  SongSection,
  VoiceParams,
} from './types'

const LOOKAHEAD = 0.12 // seconds of scheduling headroom
const MAX_SOURCES = 6

export interface SourceRec {
  name: string
  /** bundled stem key, or null for uploads/mic/covers/youtube */
  stemKey: string | null
  buffer: AudioBuffer
  analysis: SourceAnalysis
  /** inner slice boundaries, seconds; edited by the user */
  bounds: number[]
  /** true once the user has touched the bounds */
  manual: boolean
  /** ambience bed: loops continuously, heavily filtered, under everything */
  bed?: boolean
  slices: Slice[] // ids/sourceIdx patched by rebuildSlices()
}

const defaultVoice = (level = 0.8): VoiceParams => ({
  level,
  mute: false,
  solo: false,
  density: 0.5,
  pitchRange: 0.6,
  reverbSend: 0.3,
})

const lerp = (a: number, b: number, k: number) => a + (b - a) * k

/** Category pool over an arbitrary slice set, topped up with best-ranked
 * candidates when the category is sparse (a thin pool starves the voices). */
export function poolFrom(base: Slice[], cat: Slice['category']): Slice[] {
  const hits = base.filter((s) => s.category === cat)
  const want = Math.min(3, base.length)
  if (hits.length >= want) return hits
  const rank: Record<Slice['category'], (s: Slice) => number> = {
    transient: (s) => s.attack - s.duration * 0.01,
    harmonic: (s) => s.pitchConfidence + s.duration * 0.2,
    texture: (s) => -s.rms,
  }
  const extras = base
    .filter((s) => !hits.includes(s))
    .sort((a, b) => rank[cat](b) - rank[cat](a))
    .slice(0, want - hits.length)
  return [...hits, ...extras]
}

/**
 * Master manager: owns the AudioContext + Tone graph, a pool of sliced
 * sources, and five asynchronous generative voices on independent
 * un-synchronized timers (polymetric phasing — no shared transport).
 * All stochastic choices draw from per-voice seeded streams so a seed
 * reproduces the piece's character (and offline renders exactly).
 */
export class AudioEngine {
  ctx: AudioContext | null = null
  dsp: DSPChain | null = null
  analyser: AnalyserNode | null = null
  recorder: WavRecorder | null = null

  sources: SourceRec[] = []
  slices: Slice[] = []
  /** per-voice source restriction: null = all sources, else allowed indices */
  sourceMasks: Array<number[] | null> = Array.from({ length: NUM_VOICES }, () => null)

  voices: VoiceParams[] = [
    defaultVoice(),
    defaultVoice(),
    defaultVoice(),
    defaultVoice(),
    defaultVoice(0.55),
    defaultVoice(0.6),
    defaultVoice(0.65),
  ]
  macros: MacroParams = { decayFactor: 0.45, tapeAging: 0.4, chaos: 0.35 }
  bpm = 72
  telephony = false
  crush = false
  scale: ScaleName = 'free'
  drift = false
  duck = false
  /** V2 timing: euclidean 16th grid with swing instead of Poisson */
  groove = false
  /** endless background mode: periodic reseed + stem rotation */
  radio = false
  width = 0.5
  tilt = 0
  /** submerged chorus/muffle amount (Poirier) */
  aqua = 0
  /** loop-lock: voices repeat captured cells verbatim (Pekler/Jelinek) */
  looped = false
  /** loop-lock block switching: recapture all cells every N seconds (0 = off) */
  blockSec = 0
  /** CHORDLOCK: chord clock + chroma slice choice + consonant transposition */
  keyLock = false
  keyRoot = 0
  /** V1 becomes a voice-led chord pad instead of a grain cloud */
  padMode = false
  /**
   * PHRASE: V1 loops one continuous, onset-aligned region of a source
   * verbatim — the loop IS the piece (Pekler form). Overrides pad/grains.
   */
  phraseMode = false
  phraseRegion: { sourceIdx: number; start: number; dur: number } | null = null
  /** fragment length regime: how long the slices/grains/loops run */
  fragLen: 'fine' | 'mid' | 'long' = 'fine'
  /** vintage voicing: Butterworth HP/LP + resonant bell (the "old record" curve) */
  voicing = false
  /** short dark plate (1.7s, damped) instead of the long chamber */
  plateShort = false
  /** parallel sub-octave layer amount (0–0.5) */
  sub = 0
  /** autonomous dub gestures: delay throws, filter drops, mute drops, splashes */
  dub = false
  /** tape language: reversed grains, swells, dropouts, wow dips */
  tape = false
  /** reverse-grain probability (adds to TAPE's baseline) */
  reverseProb = 0
  /** slice armed for keyboard performance (set by audition) */
  armedSliceId: number | null = null
  /** source index currently raw-previewing (clean, no DSP), or null */
  previewSource: number | null = null
  private previewNodes: AudioBufferSourceNode[] = []
  private previewGain: GainNode | null = null
  private previewStartInfo: { ctxTime: number; parts: Array<{ start: number; dur: number }> } | null = null
  playing = false
  masterMuted = false
  masterVolume = 0.8
  seed = randomSeed()
  sleevePalette: string[] | null = null

  scenes: Array<Scene | null> = Array.from({ length: 8 }, () => null)
  songSections: SongSection[] = []
  songActive = false

  private voiceRng: Rng[] = []
  /** V8 PINGS — West Coast FM chimes, level 0 (off) … 1 */
  pings = 0
  private pingRng: Rng = mulberry32(1)
  private pingTimer = 0
  private pingGain: GainNode | null = null
  private pingSend: GainNode | null = null
  private voiceGains: GainNode[] = []
  private sendGains: GainNode[] = []
  private duckGain: GainNode | null = null
  private timers: number[] = Array.from({ length: NUM_VOICES }, () => 0)
  private driftTimer = 0
  private driftTargets: MacroParams | null = null
  private morphTimer = 0
  private songTimer = 0
  private radioTimer = 0
  private grooveStep = 0
  private grooveNextTime = 0
  private loopCells: Array<LoopCell | null> = Array.from({ length: NUM_VOICES }, () => null)
  private blockTimer = 0
  private dubTimer = 0
  private tapeTimer = 0
  private pulseNextTime = 0
  private bedSources: AudioBufferSourceNode[] = []
  private bedFilter: BiquadFilterNode | null = null
  private reversedCache = new WeakMap<AudioBuffer, AudioBuffer>()
  private progression: Chord[] = makeProgression('pentatonic', 0)
  private harmStartTime = 0
  private chordUiTimer = 0
  private lastV1Chroma: number[] | undefined
  private lastPadSemis: number[] | null = null
  private melodyMotif: Motif | null = null
  private activeSources = new Set<AudioBufferSourceNode>()
  private noiseBuffer: AudioBuffer | null = null
  private noiseSource: AudioBufferSourceNode | null = null
  private listeners = new Set<(e: FiredEvent) => void>()
  private changeListeners = new Set<() => void>()
  private markovIdx = -1
  private masterGain: GainNode | null = null
  private tap: GainNode | null = null
  private avDest: MediaStreamAudioDestinationNode | null = null
  private stemCache = new Map<string, AudioBuffer>()

  constructor() {
    this.reseed(this.seed)
  }

  get started() {
    return this.ctx !== null
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  async init() {
    if (this.ctx) return
    const ctx = new AudioContext()
    await ctx.resume()
    Tone.setContext(ctx)
    this.ctx = ctx
    this.dsp = new DSPChain()

    this.masterGain = ctx.createGain()
    this.masterGain.gain.value = this.masterVolume
    Tone.connect(this.masterGain, this.dsp.input)

    // voice 0 routes through a duck gain (sidechained by voice 1 hits)
    this.duckGain = ctx.createGain()
    this.duckGain.connect(this.masterGain)

    for (let i = 0; i < NUM_VOICES; i++) {
      const g = ctx.createGain()
      g.gain.value = 0
      g.connect(i === 0 ? this.duckGain : this.masterGain)
      this.voiceGains.push(g)
      const s = ctx.createGain()
      s.gain.value = 0
      Tone.connect(s, this.dsp.reverbSend)
      this.sendGains.push(s)
    }

    // V8 pings bus: pre-DSP (so chimes pass through the tape chain) + reverb send
    this.pingGain = ctx.createGain()
    this.pingGain.gain.value = 1
    this.pingGain.connect(this.masterGain)
    this.pingSend = ctx.createGain()
    this.pingSend.gain.value = this.pings * 0.5
    Tone.connect(this.pingSend, this.dsp.reverbSend)

    // analysis + recording taps off the processed master
    const tap = ctx.createGain()
    Tone.connect(this.dsp.output, tap)
    this.tap = tap
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.85
    tap.connect(this.analyser)
    this.recorder = new WavRecorder(ctx, tap)

    this.noiseBuffer = await renderSurfaceNoise(ctx.sampleRate)
    this.applyMacros()
    this.applyVoiceGains()
  }

  /** Audio track of the processed master, for canvas+audio video capture. */
  getAudioStream(): MediaStream | null {
    if (!this.ctx || !this.tap) return null
    if (!this.avDest) {
      this.avDest = this.ctx.createMediaStreamDestination()
      this.tap.connect(this.avDest)
    }
    return this.avDest.stream
  }

  // ---------- seed ----------

  reseed(seed?: number) {
    this.seed = seed ?? randomSeed()
    this.voiceRng = Array.from({ length: NUM_VOICES }, (_, i) => mulberry32(this.seed + i * 7919))
    this.pingRng = mulberry32(this.seed + NUM_VOICES * 7919)
    this.markovIdx = -1
  }

  // ---------- source pool ----------

  async addStem(key: string) {
    if (!this.ctx) return
    const def = BUNDLED_STEMS.find((s) => s.key === key)
    if (!def) return
    if (this.sources.some((s) => s.stemKey === key)) return
    let buf = this.stemCache.get(key)
    if (!buf) {
      buf = await def.render(this.ctx.sampleRate)
      this.stemCache.set(key, buf)
    }
    this.addSource(def.name, buf, key)
  }

  async addFile(file: File) {
    if (!this.ctx) return
    const data = await file.arrayBuffer()
    const buf = await this.ctx.decodeAudioData(data)
    this.addSource(file.name, buf, null)
  }

  async addYouTube(url: string) {
    if (!this.ctx) return
    const { title, full } = await this.fetchYouTube(url)
    const cuts = extractHighlights(this.ctx, full)
    this.addSource(`YT: ${title}`, cuts, null)
  }

  /**
   * Several links at once: fetch in parallel, then assemble by mode —
   * 'collage' (hard splice of best windows), 'mixtape' (role-ordered
   * segments with long crossfades; also returned as a WAV), 'interleave'
   * (tracks woven chunk by chunk). Multi-track ingestion also auto-fills
   * scenes A–D from each track's character and sets a song sequence, so a
   * RENDER travels through the tracks' moods.
   */
  async addYouTubeCollage(
    urls: string[],
    mode: 'collage' | 'mixtape' | 'interleave' = 'collage',
  ): Promise<{ added: number; failed: string[]; wav?: Blob }> {
    if (!this.ctx) return { added: 0, failed: [] }
    urls = [...new Set(urls)].slice(0, 8)
    if (urls.length === 1 && mode === 'collage') {
      await this.addYouTube(urls[0])
      return { added: 1, failed: [] }
    }
    const results = await Promise.allSettled(urls.map((u) => this.fetchYouTube(u)))
    const ok: Array<{ title: string; full: AudioBuffer }> = []
    const failed: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') ok.push(r.value)
      else failed.push(`${urls[i]} — ${r.reason instanceof Error ? r.reason.message : r.reason}`)
    })
    if (ok.length === 0) throw new Error(failed.join('\n') || 'all fetches failed')

    const analyses = ok.map((t) => analyzeSource(t.full))
    if (ok.length >= 2) this.autoScenesFromTracks(analyses)

    let wav: Blob | undefined
    if (mode === 'mixtape') {
      const buf = buildMixtape(this.ctx, ok.map((t, i) => ({ full: t.full, a: analyses[i] })))
      this.addSource(`Mixtape — ${ok.length} track${ok.length > 1 ? 's' : ''}`, buf, null)
      wav = encodeWav(buf.getChannelData(0), buf.getChannelData(1), buf.sampleRate)
    } else if (mode === 'interleave' && ok.length >= 2) {
      const perTrack = Math.max(1, Math.floor(6 / ok.length))
      const cuts = ok.map((t, i) => extractHighlights(this.ctx!, t.full, perTrack, analyses[i]))
      this.addSource(`Weave — ${ok.length} tracks`, buildInterleave(this.ctx, cuts), null)
    } else {
      const perTrack = Math.max(1, Math.floor(6 / ok.length))
      const cuts = ok.map((t, i) => extractHighlights(this.ctx!, t.full, perTrack, analyses[i]))
      this.addSource(`YT Collage — ${ok.length} tracks`, this.concatBuffers(cuts), null)
    }
    return { added: ok.length, failed, wav }
  }

  /**
   * Scenes A–D born from each track's character (energy → densities,
   * darkness → decay/aging, contrast+onsets → chaos, brightness → scale),
   * chained into a 45s-per-track song sequence for renders.
   */
  private autoScenesFromTracks(analyses: ReturnType<typeof analyzeSource>[]) {
    const clamp = (v: number) => Math.min(1, Math.max(0, v))
    analyses.slice(0, 8).forEach((a, i) => {
      const c = trackCharacter(a)
      const brightNorm = clamp((c.brightness - 500) / 2500)
      this.scenes[i] = {
        macros: {
          decayFactor: clamp(0.25 + (1 - c.energy) * 0.55),
          tapeAging: clamp(0.2 + (1 - brightNorm) * 0.55),
          chaos: clamp(0.15 + c.contrast * 0.4 + c.onsetRate * 0.25),
        },
        voices: this.voices.map((v, vi) => ({
          ...v,
          density:
            vi === 1 ? clamp(0.25 + c.onsetRate * 0.65) :
            vi === 0 ? clamp(0.3 + c.energy * 0.5) : v.density,
        })),
        scale: brightNorm > 0.6 ? 'wholetone' : brightNorm > 0.3 ? 'pentatonic' : 'fifths',
        telephony: this.telephony,
        crush: this.crush,
        bpm: this.bpm,
      }
    })
    this.songSections = analyses.slice(0, 4).map((_, i) => ({ scene: i, sec: 45 }))
  }

  private async fetchYouTube(url: string): Promise<{ title: string; full: AudioBuffer }> {
    // routes to the Tauri Rust backend or the Vite dev middleware
    const { title, data } = await ytFetchAudio(url)
    // decodeAudioData resamples to the live context rate, so cuts always match
    const full = await this.ctx!.decodeAudioData(data)
    return { title, full }
  }

  private concatBuffers(buffers: AudioBuffer[]): AudioBuffer {
    const ctx = this.ctx!
    const length = buffers.reduce((n, b) => n + b.length, 0)
    const out = ctx.createBuffer(2, length, ctx.sampleRate)
    let off = 0
    for (const b of buffers) {
      for (let ch = 0; ch < 2; ch++) {
        out.getChannelData(ch).set(b.getChannelData(Math.min(ch, b.numberOfChannels - 1)), off)
      }
      off += b.length
    }
    return out
  }

  async addImage(file: File) {
    if (!this.ctx) return
    const analysis = await analyzeImage(file)
    const buf = await sonifyImage(analysis, this.ctx.sampleRate)
    this.addSource(`Cover: ${file.name}`, buf, null)
    const patch = traitsToPatch(analysis)
    this.macros = patch.macros
    this.scale = patch.scale
    this.sleevePalette = analysis.palette
    this.applyMacros()
  }

  /** Capture N seconds from the microphone / line input into the pool. */
  async sampleFromMic(seconds = 8): Promise<void> {
    if (!this.ctx) return
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    const ctx = this.ctx
    try {
      const src = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      const chunks: Float32Array[] = []
      const target = Math.ceil(seconds * ctx.sampleRate)
      let collected = 0
      await new Promise<void>((resolve) => {
        proc.onaudioprocess = (e) => {
          if (collected >= target) return
          chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
          collected += e.inputBuffer.length
          if (collected >= target) resolve()
        }
        const sink = ctx.createGain()
        sink.gain.value = 0
        src.connect(proc)
        proc.connect(sink)
        sink.connect(ctx.destination)
      })
      proc.disconnect()
      src.disconnect()
      const buf = ctx.createBuffer(1, Math.min(collected, target), ctx.sampleRate)
      const d = buf.getChannelData(0)
      let off = 0
      for (const c of chunks) {
        const n = Math.min(c.length, d.length - off)
        d.set(c.subarray(0, n), off)
        off += n
        if (off >= d.length) break
      }
      const n = this.sources.filter((s) => s.name.startsWith('Mic')).length + 1
      this.addSource(`Mic capture ${n}`, buf, null)
    } finally {
      for (const t of stream.getTracks()) t.stop()
    }
  }

  addSource(name: string, buffer: AudioBuffer, stemKey: string | null) {
    if (this.sources.length >= MAX_SOURCES) this.removeSource(0)
    const analysis = analyzeSource(buffer)
    const bounds = detectBounds(analysis)
    const rec: SourceRec = { name, stemKey, buffer, analysis, bounds, manual: false, slices: [] }
    rec.slices = buildSlices(
      analysis, bounds, false, this.fragMaxSlice, this.fragMinSlice,
    ) as Slice[]
    this.sources.push(rec)
    this.rebuildSlices()
  }

  /** Restore a source with saved bounds (crate loading). */
  restoreSource(name: string, buffer: AudioBuffer, stemKey: string | null, bounds: number[], manual: boolean) {
    if (this.sources.length >= MAX_SOURCES) this.removeSource(0)
    const analysis = analyzeSource(buffer)
    const rec: SourceRec = { name, stemKey, buffer, analysis, bounds, manual, slices: [] }
    rec.slices = buildSlices(analysis, bounds, manual) as Slice[]
    this.sources.push(rec)
    this.rebuildSlices()
  }

  clearSources() {
    this.sources = []
    this.sourceMasks = this.sourceMasks.map(() => null)
    this.rebuildSlices()
  }

  removeSource(idx: number) {
    if (idx < 0 || idx >= this.sources.length) return
    this.sources.splice(idx, 1)
    this.phraseRegion = null
    // shift/drop mask indices referencing the removed source
    this.sourceMasks = this.sourceMasks.map((m) => {
      if (!m) return null
      const next = m.filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i))
      return next.length ? next : null
    })
    this.rebuildSlices()
  }

  /** Toggle a source in a voice's routing mask (null mask = all sources). */
  toggleRouting(voice: number, sourceIdx: number) {
    const all = this.sources.map((_, i) => i)
    const cur = this.sourceMasks[voice] ?? all
    const next = cur.includes(sourceIdx)
      ? cur.filter((i) => i !== sourceIdx)
      : [...cur, sourceIdx].sort()
    // empty or full → back to "all"
    this.sourceMasks[voice] = next.length === 0 || next.length === all.length ? null : next
  }

  editBoundary(sourceIdx: number, time: number, tolerance = 0.05) {
    const src = this.sources[sourceIdx]
    if (!src) return
    const near = src.bounds.findIndex((b) => Math.abs(b - time) <= tolerance)
    if (near >= 0) src.bounds.splice(near, 1)
    else if (time > 0.01 && time < src.buffer.duration - 0.01) src.bounds.push(time)
    src.manual = true
    src.slices = buildSlices(src.analysis, src.bounds, true) as Slice[]
    this.rebuildSlices()
  }

  cycleCategory(sliceId: number) {
    const s = this.slices.find((x) => x.id === sliceId)
    if (!s) return
    const order: Slice['category'][] = ['transient', 'harmonic', 'texture']
    s.category = order[(order.indexOf(s.category) + 1) % order.length]
  }

  private rebuildSlices() {
    const flat: Slice[] = []
    this.sources.forEach((src, si) => {
      for (const s of src.slices) {
        s.sourceIdx = si
        s.id = flat.length
        flat.push(s)
      }
    })
    this.slices = flat
    this.markovIdx = -1
  }

  // ---------- transport ----------

  play() {
    if (!this.ctx || this.slices.length === 0 || this.playing) return
    this.playing = true
    this.scheduleVoice1()
    this.scheduleVoice2()
    this.scheduleVoice3()
    this.startVoice4()
    this.scheduleVoice5()
    this.scheduleVoice6()
    this.scheduleVoice7()
    this.startBeds()
    if (this.dub) this.scheduleDubGesture()
    if (this.tape) this.scheduleTapeGesture()
    if (this.pings > 0) this.schedulePings()
    this.applyBlockTimer()
  }

  pause() {
    this.playing = false
    for (const t of this.timers) window.clearTimeout(t)
    window.clearTimeout(this.dubTimer)
    window.clearTimeout(this.tapeTimer)
    window.clearTimeout(this.pingTimer)
    window.clearInterval(this.blockTimer)
    for (const src of this.activeSources) {
      try {
        src.stop()
      } catch { /* already stopped */ }
    }
    this.activeSources.clear()
    this.stopVoice4()
    this.stopBeds()
  }

  reset() {
    this.pause()
    this.stopSong()
    this.setRadio(false)
    this.reseed(this.seed)
    this.grooveStep = 0
    this.pulseNextTime = 0
    this.loopCells = this.loopCells.map(() => null)
  }

  setMasterVolume(v: number) {
    this.masterVolume = v
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.masterMuted ? 0 : v, this.ctx.currentTime, 0.02)
    }
  }

  setMasterMute(m: boolean) {
    this.masterMuted = m
    this.setMasterVolume(this.masterVolume)
  }

  // ---------- recording ----------

  startRecording() {
    this.recorder?.start()
  }

  stopRecording(): Blob | null {
    return this.recorder?.stop() ?? null
  }

  // ---------- params ----------

  setVoiceParam<K extends keyof VoiceParams>(voice: number, key: K, value: VoiceParams[K]) {
    this.voices[voice] = { ...this.voices[voice], [key]: value }
    this.applyVoiceGains()
  }

  setMacro(key: keyof MacroParams, value: number) {
    this.macros = { ...this.macros, [key]: value }
    this.applyMacros()
  }

  setTelephony(on: boolean) {
    this.telephony = on
    this.dsp?.setTelephony(on)
  }

  setCrush(on: boolean) {
    this.crush = on
    this.dsp?.setCrush(on)
  }

  setScale(scale: ScaleName) {
    this.scale = scale
    if (this.keyLock) this.rebuildProgression()
  }

  setDuck(on: boolean) {
    this.duck = on
  }

  setGroove(on: boolean) {
    this.groove = on
    this.grooveStep = 0
  }

  setAqua(v: number) {
    this.aqua = v
    this.dsp?.setAqua(v)
  }

  /** Loop-lock: freeze the voices into verbatim-repeating cells. */
  setLooped(on: boolean) {
    this.looped = on
    this.loopCells = this.loopCells.map(() => null) // capture fresh on next cycle
    this.applyBlockTimer()
  }

  setBlockSec(sec: number) {
    this.blockSec = sec
    this.applyBlockTimer()
  }

  private applyBlockTimer() {
    window.clearInterval(this.blockTimer)
    if (this.looped && this.blockSec > 0) {
      this.blockTimer = window.setInterval(() => {
        // abrupt block change: every voice finds a new loop, phrase re-picks
        this.loopCells = this.loopCells.map(() => null)
        this.phraseRegion = null
      }, this.blockSec * 1000)
    }
  }

  /** CHORDLOCK: auto-detect the root, build the progression, start the clock. */
  setKeyLock(on: boolean) {
    this.keyLock = on
    window.clearInterval(this.chordUiTimer)
    if (on) {
      const counts = new Array(12).fill(0)
      for (const s of this.slices) {
        if (s.pitch && s.pitchConfidence > 0.4) {
          const pc = ((Math.round(12 * Math.log2(s.pitch / 261.626)) % 12) + 12) % 12
          counts[pc] += s.pitchConfidence
        }
      }
      this.keyRoot = counts.indexOf(Math.max(...counts))
      this.rebuildProgression()
      this.harmStartTime = this.ctx?.currentTime ?? 0
      this.lastPadSemis = null
      this.chordUiTimer = window.setInterval(() => this.emitChange(), 2000)
    }
  }

  setPadMode(on: boolean) {
    this.padMode = on
    this.lastPadSemis = null
  }

  setPhraseMode(on: boolean) {
    this.phraseMode = on
    if (!on) this.phraseRegion = null
  }

  /**
   * Pick a continuous phrase window: start/end snapped to detected onsets so
   * the loop keeps the source's own rhythm. Length scales with FRAG.
   */
  pickPhraseRegion(
    rng: Rng,
    store = true,
  ): { sourceIdx: number; start: number; dur: number } | null {
    const mask = this.sourceMasks[0]
    const candidates = this.sources
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => s.buffer.duration >= 2 && (!mask || mask.includes(i)))
    if (candidates.length === 0) return null
    const { s: src, i: sourceIdx } = candidates[Math.floor(rng() * candidates.length)]
    const [minDur, maxDur] =
      this.fragLen === 'long' ? [4, 8] : this.fragLen === 'mid' ? [3, 6] : [2, 4.5]
    const grid = [0, ...[...src.bounds].sort((a, b) => a - b), src.buffer.duration]
    const startIdx = Math.floor(rng() * Math.max(1, grid.length - 1))
    const start = grid[startIdx]
    // extend across onset boundaries until the window is long enough
    let end = start
    for (let j = startIdx + 1; j < grid.length; j++) {
      end = grid[j]
      if (end - start >= minDur) break
    }
    let dur = end - start
    if (dur < 1) dur = Math.min(maxDur, src.buffer.duration - start)
    dur = Math.max(1, Math.min(maxDur, dur, src.buffer.duration - start - 0.01))
    const region = { sourceIdx, start, dur }
    if (store) this.phraseRegion = region
    return region
  }

  /** LOOP THIS: the armed slice (timbre-map click) becomes the phrase. */
  loopArmed() {
    if (this.armedSliceId === null) return
    const slice = this.slices.find((s) => s.id === this.armedSliceId)
    if (!slice) return
    const src = this.sources[slice.sourceIdx]
    if (!src) return
    // short armed slices extend forward to at least ~2s
    const dur = Math.max(
      Math.min(slice.duration, 10),
      Math.min(2, src.buffer.duration - slice.start - 0.01),
    )
    this.phraseRegion = { sourceIdx: slice.sourceIdx, start: slice.start, dur }
    this.phraseMode = true
  }

  /** One-click Pekler form: phrase loop backbone + sparse dubbed decoration. */
  applyPeklerPreset() {
    this.setPhraseMode(true)
    this.phraseRegion = null // fresh pick
    this.setLooped(true)
    this.setBlockSec(90)
    this.setKeyLock(true)
    this.setPadMode(false)
    this.setDub(true)
    this.setTape(true)
    this.setPlateShort(true)
    this.setVoicing(true)
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(true)
    this.setDuck(true)
    this.setAqua(0.25)
    this.setWidth(0.55)
    this.setSub(0.15)
    this.setDrift(false)
    this.macros = { decayFactor: 0.55, tapeAging: 0.55, chaos: 0.18 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.85, density: 0.5, mute: false, solo: false })
    set(1, { level: 0.55, density: 0.22, mute: false, solo: false })
    set(2, { level: 0.4, density: 0.3, mute: false, solo: false })
    set(3, { level: 0.55, mute: false, solo: false })
    set(4, { level: 0.3, mute: true, solo: false })
    set(5, { level: 0.65, density: 0.35, mute: false, solo: false })
    set(6, { level: 0.5, mute: true, solo: false })
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Space Afrika form: submerged voice-led chord pads over street
   * ambience — long chamber, heavy sub layer, AQUA blur, sparse dubbed
   * decoration, no melody line. Dark, wide, slow.
   */
  applyAfrikaPreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(true)
    this.setBlockSec(120)
    this.setKeyLock(true)
    this.setScale('minor')
    this.setPadMode(true)
    this.setFragLen('long')
    this.bpm = 64
    this.setDub(true)
    this.setTape(true)
    this.setPlateShort(false) // long 4.5s chamber — the room is the piece
    this.setVoicing(false) // keep the sub-bass floor intact
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(false) // hazy Poisson scatter, not a grid
    this.setDuck(true)
    this.setAqua(0.55)
    this.setWidth(0.85)
    this.setSub(0.35)
    this.setTilt(-0.3)
    this.setReverseProb(0.2)
    this.setDrift(false)
    this.macros = { decayFactor: 0.8, tapeAging: 0.45, chaos: 0.12 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.8, density: 0.45, mute: false, solo: false })
    set(1, { level: 0.35, density: 0.12, mute: false, solo: false })
    set(2, { level: 0.55, density: 0.3, mute: false, solo: false })
    set(3, { level: 0.7, mute: false, solo: false })
    set(4, { level: 0.45, density: 0.25, mute: false, solo: false })
    set(5, { level: 0.75, density: 0.25, mute: false, solo: false })
    set(6, { level: 0.5, mute: true, solo: false })
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Mark Templeton form: stuttering micro-loop edits over a modest
   * bed, heavy tape warble, frequent reversals, abrupt 45s block cuts, a shy
   * melody line — folktronica concrète. Drier and jumpier than the others.
   */
  applyTempletonPreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(true)
    this.setBlockSec(45) // abrupt editorial cuts
    this.setKeyLock(true)
    this.setScale('pentatonic')
    this.setPadMode(false)
    this.setFragLen('mid')
    this.bpm = 80
    this.setDub(false)
    this.setTape(true)
    this.setPlateShort(true) // dry, intimate room
    this.setVoicing(false)
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(false)
    this.setDuck(false)
    this.setAqua(0.1)
    this.setWidth(0.6)
    this.setSub(0.05)
    this.setTilt(0.1)
    this.setReverseProb(0.35) // tape-flip signature
    this.setDrift(false)
    this.macros = { decayFactor: 0.4, tapeAging: 0.65, chaos: 0.45 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.6, density: 0.5, mute: false, solo: false })
    set(1, { level: 0.6, density: 0.35, mute: false, solo: false })
    set(2, { level: 0.45, density: 0.3, mute: false, solo: false })
    set(3, { level: 0.6, mute: false, solo: false })
    set(4, { level: 0.8, density: 0.6, mute: false, solo: false }) // stutter engine
    set(5, { level: 0.3, mute: true, solo: false })
    set(6, { level: 0.45, mute: false, solo: false }) // shy guitar-fragment melody
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Jan Jelinek form: tiny clicking micro-loops phasing endlessly
   * over a warm dorian bed and a soft grooved pulse — no block cuts, almost
   * no chaos, deep bass, dry intimate space. Loop-finding-jazz-records.
   */
  applyJelinekPreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(true)
    this.setBlockSec(0) // endless phasing, never cut
    this.setKeyLock(true)
    this.setScale('dorian')
    this.setPadMode(false)
    this.setFragLen('fine')
    this.bpm = 96
    this.setDub(false)
    this.setTape(true)
    this.setPlateShort(true)
    this.setVoicing(false)
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(true) // soft steady grid
    this.setDuck(true)
    this.setAqua(0.2)
    this.setWidth(0.5)
    this.setSub(0.25)
    this.setTilt(-0.15)
    this.setReverseProb(0.05)
    this.setDrift(false)
    this.macros = { decayFactor: 0.45, tapeAging: 0.4, chaos: 0.08 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.7, density: 0.55, mute: false, solo: false })
    set(1, { level: 0.4, density: 0.25, mute: false, solo: false })
    set(2, { level: 0.3, density: 0.25, mute: false, solo: false })
    set(3, { level: 0.5, mute: false, solo: false })
    set(4, { level: 0.7, density: 0.5, mute: false, solo: false }) // clicking loops
    set(5, { level: 0.6, density: 0.4, mute: false, solo: false }) // warm deep bass
    set(6, { level: 0.4, mute: true, solo: false })
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Roméo Poirier form: a verbatim phrase loop submerged in AQUA
   * blur and a long wet chamber, dub gestures, sonar-like resonant swells,
   * warm lydian float — aquatic dub-jazz. Sunlit-underwater, not dark.
   */
  applyPoirierPreset() {
    this.setPhraseMode(true)
    this.phraseRegion = null // fresh pick
    this.setLooped(true)
    this.setBlockSec(90)
    this.setKeyLock(true)
    this.setScale('lydian')
    this.setPadMode(false)
    this.setFragLen('mid')
    this.bpm = 76
    this.setDub(true)
    this.setTape(true)
    this.setPlateShort(false) // long wet chamber
    this.setVoicing(false)
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(false)
    this.setDuck(false) // gentler than the dub-techno pump
    this.setAqua(0.65) // the pool itself
    this.setWidth(0.7)
    this.setSub(0.2)
    this.setTilt(-0.1)
    this.setReverseProb(0.12)
    this.setDrift(false)
    this.macros = { decayFactor: 0.7, tapeAging: 0.5, chaos: 0.15 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.8, density: 0.5, mute: false, solo: false })
    set(1, { level: 0.3, density: 0.15, mute: false, solo: false })
    set(2, { level: 0.5, density: 0.3, mute: false, solo: false }) // sonar swells
    set(3, { level: 0.5, mute: false, solo: false })
    set(4, { level: 0.5, density: 0.3, mute: false, solo: false })
    set(5, { level: 0.55, density: 0.3, mute: false, solo: false }) // soft dub bass
    set(6, { level: 0.4, mute: true, solo: false })
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Philip Jeck / Basinski form: long loops rotting on the
   * turntable — endless LOOPLOCK, heavy tape decay, crackle way up, a
   * quarter of the grains running backwards, nothing rhythmic at all.
   */
  applyJeckPreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(true)
    this.setBlockSec(0) // the loop rots, it is never replaced
    this.setKeyLock(true)
    this.setScale('minor')
    this.setPadMode(false)
    this.setFragLen('long')
    this.bpm = 60
    this.setDub(false)
    this.setTape(true)
    this.setPlateShort(false)
    this.setVoicing(true) // dead-speaker band
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(false)
    this.setDuck(false)
    this.setAqua(0.3)
    this.setWidth(0.6)
    this.setSub(0.1)
    this.setTilt(-0.25)
    this.setReverseProb(0.25)
    this.setDrift(true) // slow autonomous disintegration of the macros
    this.macros = { decayFactor: 0.75, tapeAging: 0.85, chaos: 0.2 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.85, density: 0.55, mute: false, solo: false })
    set(1, { level: 0.25, density: 0.1, mute: false, solo: false })
    set(2, { level: 0.45, density: 0.3, mute: false, solo: false })
    set(3, { level: 0.85, mute: false, solo: false }) // the surface IS the music
    set(4, { level: 0.3, mute: true, solo: false })
    set(5, { level: 0.3, mute: true, solo: false })
    set(6, { level: 0.3, mute: true, solo: false })
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Caretaker form: one verbatim ballroom loop through a distant
   * telephone band and a huge room, buried in crackle — no harmony engine,
   * no rhythm voices, no decoration. The record remembers itself.
   */
  applyCaretakerPreset() {
    this.setPhraseMode(true) // verbatim 78 loop
    this.phraseRegion = null
    this.setLooped(true)
    this.setBlockSec(120)
    this.setKeyLock(false) // the source is left exactly as it was
    this.setScale('free')
    this.setPadMode(false)
    this.setFragLen('long')
    this.bpm = 66
    this.setDub(false)
    this.setTape(true)
    this.setPlateShort(false) // the empty ballroom
    this.setVoicing(false)
    this.setTelephony(true) // the distance itself
    this.setCrush(false)
    this.setGroove(false)
    this.setDuck(false)
    this.setAqua(0.15)
    this.setWidth(0.45)
    this.setSub(0)
    this.setTilt(-0.2)
    this.setReverseProb(0.05)
    this.setDrift(false)
    this.macros = { decayFactor: 0.65, tapeAging: 0.9, chaos: 0.08 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.9, density: 0.5, mute: false, solo: false })
    set(1, { level: 0.3, mute: true, solo: false })
    set(2, { level: 0.35, density: 0.2, mute: false, solo: false })
    set(3, { level: 0.9, mute: false, solo: false }) // shellac storm
    set(4, { level: 0.3, mute: true, solo: false })
    set(5, { level: 0.3, mute: true, solo: false })
    set(6, { level: 0.3, mute: true, solo: false })
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Pole form: broken-filter clicks on a dubby lilt — grooved
   * grid with duck pumping, fine crackling fragments, deep bass, dry-ish.
   */
  applyPolePreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(true)
    this.setBlockSec(90)
    this.setKeyLock(true)
    this.setScale('dorian')
    this.setPadMode(false)
    this.setFragLen('fine')
    this.bpm = 106
    this.setDub(true)
    this.setTape(false) // Pole is digital rot, not tape rot
    this.setPlateShort(true)
    this.setVoicing(false)
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(true)
    this.setDuck(true)
    this.setAqua(0.15)
    this.setWidth(0.65)
    this.setSub(0.3)
    this.setTilt(-0.1)
    this.setReverseProb(0)
    this.setDrift(false)
    this.macros = { decayFactor: 0.4, tapeAging: 0.3, chaos: 0.2 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.55, density: 0.4, mute: false, solo: false })
    set(1, { level: 0.6, density: 0.45, mute: false, solo: false }) // the click groove
    set(2, { level: 0.3, density: 0.2, mute: false, solo: false })
    set(3, { level: 0.65, mute: false, solo: false })
    set(4, { level: 0.65, density: 0.5, mute: false, solo: false })
    set(5, { level: 0.65, density: 0.4, mute: false, solo: false }) // dub bass
    set(6, { level: 0.3, mute: true, solo: false })
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click The Books form: hyperactive speech-and-string collage —
   * high chaos, fine fragments everywhere, dry and close, melody chattering.
   */
  applyBooksPreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(false) // free collage, never frozen
    this.setBlockSec(0)
    this.setKeyLock(true)
    this.setScale('pentatonic')
    this.setPadMode(false)
    this.setFragLen('fine')
    this.bpm = 92
    this.setDub(false)
    this.setTape(true)
    this.setPlateShort(true) // close-mic'd living room
    this.setVoicing(false)
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(false)
    this.setDuck(false)
    this.setAqua(0.05)
    this.setWidth(0.65)
    this.setSub(0.05)
    this.setTilt(0.15)
    this.setReverseProb(0.15)
    this.setDrift(false)
    this.macros = { decayFactor: 0.3, tapeAging: 0.35, chaos: 0.55 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.5, density: 0.4, mute: false, solo: false })
    set(1, { level: 0.7, density: 0.5, mute: false, solo: false }) // the cut-up chatter
    set(2, { level: 0.35, density: 0.25, mute: false, solo: false })
    set(3, { level: 0.35, mute: false, solo: false })
    set(4, { level: 0.7, density: 0.55, mute: false, solo: false })
    set(5, { level: 0.3, mute: true, solo: false })
    set(6, { level: 0.5, mute: false, solo: false }) // plucked melody fragments
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Jon Hassell fourth-world form: voice-led modal pads with a
   * humid delay atmosphere, a winding melody line as the "trumpet", slow
   * resonant swells — possible musics from an imaginary tropics.
   */
  applyHassellPreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(false) // breathing, not looping
    this.setBlockSec(0)
    this.setKeyLock(true)
    this.setScale('dorian')
    this.setPadMode(true)
    this.setFragLen('mid')
    this.bpm = 84
    this.setDub(true) // the humidity: echo throws
    this.setTape(false)
    this.setPlateShort(false)
    this.setVoicing(false)
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(false)
    this.setDuck(false)
    this.setAqua(0.35)
    this.setWidth(0.8)
    this.setSub(0.15)
    this.setTilt(0)
    this.setReverseProb(0.1)
    this.setDrift(false)
    this.macros = { decayFactor: 0.6, tapeAging: 0.4, chaos: 0.18 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.75, density: 0.5, mute: false, solo: false })
    set(1, { level: 0.35, density: 0.2, mute: false, solo: false })
    set(2, { level: 0.6, density: 0.35, mute: false, solo: false }) // jungle swells
    set(3, { level: 0.4, mute: false, solo: false })
    set(4, { level: 0.45, density: 0.3, mute: false, solo: false })
    set(5, { level: 0.4, density: 0.25, mute: false, solo: false })
    set(6, { level: 0.55, mute: false, solo: false }) // the trumpet line
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Loscil form: submerged pads on a barely-there slow pulse,
   * everything dark, wide and far below the surface — Submers.
   */
  applyLoscilPreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(true)
    this.setBlockSec(120)
    this.setKeyLock(true)
    this.setScale('minor')
    this.setPadMode(true)
    this.setFragLen('long')
    this.bpm = 60
    this.setDub(false)
    this.setTape(false)
    this.setPlateShort(false)
    this.setVoicing(false)
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(false)
    this.setDuck(true) // the slow engine-room breathing
    this.setAqua(0.45)
    this.setWidth(0.9)
    this.setSub(0.4)
    this.setTilt(-0.35)
    this.setReverseProb(0.05)
    this.setDrift(false)
    this.macros = { decayFactor: 0.75, tapeAging: 0.35, chaos: 0.06 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.85, density: 0.5, mute: false, solo: false })
    set(1, { level: 0.3, mute: true, solo: false })
    set(2, { level: 0.4, density: 0.25, mute: false, solo: false })
    set(3, { level: 0.4, mute: false, solo: false })
    set(4, { level: 0.3, density: 0.2, mute: false, solo: false })
    set(5, { level: 0.6, density: 0.2, mute: false, solo: false }) // deep slow pulse
    set(6, { level: 0.3, mute: true, solo: false })
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click G.E.S. (Gesellschaft zur Emanzipation des Samples) form:
   * found loops circulating through static — holiday-recording exotica,
   * busy plunder collage over a warm pentatonic bed, dead-speaker voicing,
   * shortwave hiss well up. The samples, emancipated.
   */
  applyGesPreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(true)
    this.setBlockSec(90) // loops circulate, then move on
    this.setKeyLock(true)
    this.setScale('pentatonic')
    this.setPadMode(false)
    this.setFragLen('mid')
    this.bpm = 88
    this.setDub(false)
    this.setTape(true)
    this.setPlateShort(true) // found sound stays close and dry
    this.setVoicing(true) // the old transistor radio
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(false)
    this.setDuck(false)
    this.setAqua(0.15)
    this.setWidth(0.55)
    this.setSub(0.1)
    this.setTilt(-0.05)
    this.setReverseProb(0.1)
    this.setDrift(false)
    this.macros = { decayFactor: 0.5, tapeAging: 0.6, chaos: 0.3 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.65, density: 0.45, mute: false, solo: false })
    set(1, { level: 0.55, density: 0.3, mute: false, solo: false }) // the collage
    set(2, { level: 0.35, density: 0.25, mute: false, solo: false })
    set(3, { level: 0.65, mute: false, solo: false }) // shortwave static
    set(4, { level: 0.55, density: 0.35, mute: false, solo: false })
    set(5, { level: 0.35, mute: true, solo: false })
    set(6, { level: 0.3, mute: true, solo: false }) // melody lives in the loops
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Giuseppe Ielasi form (Aix-era): dusty loop miniatures on a
   * soft swung head-nod pulse with duck breathing, granular smears, surface
   * dust well up, everything close, warm and slightly blurred.
   */
  applyIelasiPreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(true)
    this.setBlockSec(90)
    this.setKeyLock(true)
    this.setScale('dorian')
    this.setPadMode(false)
    this.setFragLen('mid')
    this.bpm = 84
    this.setDub(false)
    this.setTape(true)
    this.setPlateShort(true)
    this.setVoicing(false)
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(true) // the wobbly head-nod
    this.setDuck(true)
    this.setAqua(0.3)
    this.setWidth(0.6)
    this.setSub(0.2)
    this.setTilt(-0.15)
    this.setReverseProb(0.15)
    this.setDrift(false)
    this.macros = { decayFactor: 0.45, tapeAging: 0.55, chaos: 0.22 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.6, density: 0.45, mute: false, solo: false })
    set(1, { level: 0.55, density: 0.4, mute: false, solo: false }) // dusty beat
    set(2, { level: 0.3, density: 0.2, mute: false, solo: false })
    set(3, { level: 0.6, mute: false, solo: false }) // the dust itself
    set(4, { level: 0.6, density: 0.4, mute: false, solo: false }) // granular smears
    set(5, { level: 0.5, density: 0.3, mute: false, solo: false })
    set(6, { level: 0.3, mute: true, solo: false })
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Microstoria form (init ding / _snd): weightless wholetone
   * pads smeared with 12-bit digital debris — unlooped, beatless, bright
   * synthetic sheen, glitch micro-fragments floating through. No tape:
   * this rot is purely digital.
   */
  applyMicrostoriaPreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(false) // weightless free flow
    this.setBlockSec(0)
    this.setKeyLock(true)
    this.setScale('wholetone')
    this.setPadMode(true)
    this.setFragLen('mid')
    this.bpm = 70
    this.setDub(false)
    this.setTape(false)
    this.setPlateShort(false)
    this.setVoicing(false)
    this.setTelephony(false)
    this.setCrush(true) // the digital grain itself
    this.setGroove(false)
    this.setDuck(false)
    this.setAqua(0.25)
    this.setWidth(0.75)
    this.setSub(0.1)
    this.setTilt(0.2)
    this.setReverseProb(0.1)
    this.setDrift(false)
    this.macros = { decayFactor: 0.6, tapeAging: 0.15, chaos: 0.3 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.7, density: 0.5, mute: false, solo: false })
    set(1, { level: 0.3, density: 0.2, mute: false, solo: false })
    set(2, { level: 0.4, density: 0.25, mute: false, solo: false })
    set(3, { level: 0.3, mute: false, solo: false })
    set(4, { level: 0.75, density: 0.5, mute: false, solo: false }) // glitch debris
    set(5, { level: 0.3, mute: true, solo: false })
    set(6, { level: 0.3, mute: true, solo: false })
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Eli Keszler form (Stadium / Last Signs of Speed): pointillist
   * percussion — dense un-gridded flurries of tiny transient hits and
   * micro-rattles, dry and close, a soft pad haze far underneath. The
   * Poisson stream at high density IS the drumming; no grid, no swing.
   */
  applyKeszlerPreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(false) // a flurry never repeats itself
    this.setBlockSec(0)
    this.setKeyLock(true)
    this.setScale('dorian')
    this.setPadMode(true) // the haze under the drums
    this.setFragLen('fine')
    this.bpm = 112
    this.setDub(false)
    this.setTape(false)
    this.setPlateShort(true) // close-mic'd room
    this.setVoicing(false)
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(false) // skitter, not grid
    this.setDuck(false)
    this.setAqua(0.1)
    this.setWidth(0.7)
    this.setSub(0.1)
    this.setTilt(0.1)
    this.setReverseProb(0.05)
    this.setDrift(false)
    this.macros = { decayFactor: 0.35, tapeAging: 0.2, chaos: 0.5 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.45, density: 0.35, mute: false, solo: false }) // the haze
    set(1, { level: 0.8, density: 0.7, mute: false, solo: false }) // the drumming
    set(2, { level: 0.3, density: 0.2, mute: false, solo: false })
    set(3, { level: 0.3, mute: false, solo: false })
    set(4, { level: 0.65, density: 0.5, mute: false, solo: false }) // micro-rattles
    set(5, { level: 0.3, mute: true, solo: false })
    set(6, { level: 0.3, mute: true, solo: false })
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  /**
   * One-click Harold Budd form (The Pearl / Plateaux of Mirror): soft-pedal
   * piano ambient — a slow luminous V7 line over lydian voice-led pads,
   * drowned in a long gauzy chamber. No rhythm, no dust, no plunder;
   * the reverb is the instrument.
   */
  applyBuddPreset() {
    this.setPhraseMode(false)
    this.phraseRegion = null
    this.setLooped(false)
    this.setBlockSec(0)
    this.setKeyLock(true)
    this.setScale('lydian')
    this.setPadMode(true)
    this.setFragLen('long')
    this.bpm = 60
    this.setDub(false)
    this.setTape(false)
    this.setPlateShort(false) // the long soft chamber IS the piece
    this.setVoicing(false)
    this.setTelephony(false)
    this.setCrush(false)
    this.setGroove(false)
    this.setDuck(false)
    this.setAqua(0.2)
    this.setWidth(0.8)
    this.setSub(0.05)
    this.setTilt(-0.1)
    this.setReverseProb(0.05)
    this.setDrift(false)
    this.macros = { decayFactor: 0.85, tapeAging: 0.25, chaos: 0.08 }
    const set = (i: number, p: Partial<VoiceParams>) => {
      this.voices[i] = { ...this.voices[i], ...p }
    }
    set(0, { level: 0.7, density: 0.4, mute: false, solo: false }) // the pads
    set(1, { level: 0.3, mute: true, solo: false })
    set(2, { level: 0.35, density: 0.2, mute: false, solo: false })
    set(3, { level: 0.3, mute: true, solo: false }) // clean, no dust
    set(4, { level: 0.3, mute: true, solo: false })
    set(5, { level: 0.3, mute: true, solo: false })
    set(6, { level: 0.65, mute: false, solo: false }) // the piano line
    this.applyMacros()
    this.applyVoiceGains()
    this.emitChange()
  }

  private rebuildProgression() {
    this.progression = makeProgression(this.scale, this.keyRoot)
  }

  private get chordPeriodSec(): number {
    return this.looped && this.blockSec > 0 ? this.blockSec : 12
  }

  /** The chord sounding at an audio-context time (null when CHORDLOCK is off). */
  chordAtTime(when: number): Chord | null {
    if (!this.keyLock) return null
    return chordAt(this.progression, this.chordPeriodSec, when - this.harmStartTime)
  }

  currentChordName(): string | null {
    if (!this.ctx || !this.keyLock) return null
    return this.chordAtTime(this.ctx.currentTime)?.name ?? null
  }

  /** Harmony context for the generators at a given schedule time. */
  private harmCtxAt(when: number): HarmCtx | null {
    const chord = this.chordAtTime(when)
    if (!chord) return null
    return {
      chord,
      scale: this.scale,
      root: this.keyRoot,
      pad: this.padMode,
      padPrev: this.lastPadSemis,
      prevChroma: this.lastV1Chroma,
    }
  }

  setDub(on: boolean) {
    this.dub = on
    window.clearTimeout(this.dubTimer)
    if (on && this.playing) this.scheduleDubGesture()
  }

  /** grain/cycle length multiplier for the current fragment regime */
  get fragK(): number {
    return this.fragLen === 'long' ? 4.5 : this.fragLen === 'mid' ? 2.2 : 1
  }

  private get fragMaxSlice(): number {
    return this.fragLen === 'long' ? 6 : this.fragLen === 'mid' ? 2.8 : 1.2
  }

  private get fragMinSlice(): number {
    return this.fragLen === 'long' ? 0.2 : this.fragLen === 'mid' ? 0.12 : 0.08
  }

  /**
   * FRAG regime: FINE = current confetti, MID/LONG = longer harmonic loops.
   * Re-slices every auto-sliced source under the new length caps (manual
   * boundary edits are left untouched).
   */
  setFragLen(mode: 'fine' | 'mid' | 'long') {
    this.fragLen = mode
    for (const src of this.sources) {
      if (!src.manual) {
        src.slices = buildSlices(
          src.analysis, src.bounds, false, this.fragMaxSlice, this.fragMinSlice,
        ) as Slice[]
      }
    }
    this.rebuildSlices()
    this.loopCells = this.loopCells.map(() => null)
    this.phraseRegion = null
  }

  setVoicing(on: boolean) {
    this.voicing = on
    this.dsp?.setVoicing(on)
  }

  setPlateShort(on: boolean) {
    this.plateShort = on
    this.dsp?.setPlateShort(on)
  }

  setSub(v: number) {
    this.sub = v
    this.dsp?.setSub(v)
  }

  setReverseProb(v: number) {
    this.reverseProb = Math.min(1, Math.max(0, v))
  }

  /** V8 PINGS level — 0 silences and stops the stream. */
  setPings(v: number) {
    this.pings = Math.min(1, Math.max(0, v))
    if (this.pingSend) this.pingSend.gain.value = this.pings * 0.5
    window.clearTimeout(this.pingTimer)
    if (this.pings > 0 && this.playing) this.schedulePings()
  }

  private schedulePings() {
    if (!this.playing || this.pings <= 0 || !this.ctx) return
    const wait = (1.2 + this.pingRng() * 6) / (0.35 + this.pings)
    this.pingTimer = window.setTimeout(() => {
      if (this.playing && this.pings > 0 && this.ctx && this.pingGain) {
        const when = this.ctx.currentTime + 0.08
        realizePing(
          this.ctx, this.pingGain, this.pingSend, when,
          this.pingFreq(when), 0.35 + this.pings * 0.4, this.pingRng,
        )
      }
      this.schedulePings()
    }, wait * 1000)
  }

  /** Ping pitch: a chord tone under CHORDLOCK, else key-rooted pentatonic. */
  private pingFreq(when: number): number {
    const rng = this.pingRng
    const chord = this.chordAtTime(when)
    const pcs = chord ? chord.pcs : [0, 2, 4, 7, 9].map((d) => (d + this.keyRoot) % 12)
    const pc = pcs[Math.floor(rng() * pcs.length)]
    const mult = [1, 1, 2, 2, 4][Math.floor(rng() * 5)]
    return 261.63 * Math.pow(2, pc / 12) * mult
  }

  setTape(on: boolean) {
    this.tape = on
    window.clearTimeout(this.tapeTimer)
    if (on && this.playing) this.scheduleTapeGesture()
  }

  /** Occasional dub-mixer moves: delay throw, filter drop, splash, mute drop. */
  private scheduleDubGesture() {
    if (!this.dub || !this.playing) return
    const wait = 7 + Math.random() * 16
    this.dubTimer = window.setTimeout(() => {
      if (this.dub && this.playing && this.dsp) {
        const r = Math.random()
        if (r < 0.35) this.dsp.throwDelay(1.5 + Math.random() * 1.5)
        else if (r < 0.6) this.dsp.filterDrop(2 + Math.random() * 3)
        else if (r < 0.8) this.dsp.splash(2 + Math.random() * 2)
        else this.muteDrop(Math.floor(Math.random() * 3)) // V1/V2/V3
      }
      this.scheduleDubGesture()
    }, wait * 1000)
  }

  /** Briefly pull a voice out of the mix, dub-style. */
  private muteDrop(voice: number, sec = 1.6) {
    if (!this.ctx) return
    const g = this.voiceGains[voice]
    if (!g) return
    g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05)
    window.setTimeout(() => this.applyVoiceGains(), sec * 1000)
  }

  /** Tape wear events: dropout holes + wow dips. */
  private scheduleTapeGesture() {
    if (!this.tape || !this.playing) return
    const wait = 5 + Math.random() * 11
    this.tapeTimer = window.setTimeout(() => {
      if (this.tape && this.playing && this.ctx && this.masterGain) {
        if (Math.random() < 0.55) {
          // dropout: a brief hole in the master
          const t = this.ctx.currentTime
          const hole = 0.03 + Math.random() * 0.1
          const g = this.masterGain.gain
          const back = this.masterMuted ? 0 : this.masterVolume
          g.setValueAtTime(back, t)
          g.linearRampToValueAtTime(back * 0.06, t + 0.012)
          g.setValueAtTime(back * 0.06, t + hole)
          g.linearRampToValueAtTime(back, t + hole + 0.02)
        } else {
          this.dsp?.wowDip(1 + Math.random() * 1.5)
        }
      }
      this.scheduleTapeGesture()
    }, wait * 1000)
  }

  /** Mark a source as an ambience bed (loops continuously under everything). */
  toggleBed(idx: number) {
    const src = this.sources[idx]
    if (!src) return
    src.bed = !src.bed
    if (this.playing) {
      this.stopBeds()
      this.startBeds()
    }
  }

  private startBeds() {
    if (!this.ctx) return
    const beds = this.sources.filter((s) => s.bed)
    if (beds.length === 0) return
    if (!this.bedFilter) {
      this.bedFilter = this.ctx.createBiquadFilter()
      this.bedFilter.type = 'lowpass'
      this.bedFilter.frequency.value = 1100
      this.bedFilter.Q.value = 0.5
      this.bedFilter.connect(this.voiceGains[NOISE_VOICE])
    }
    for (const bed of beds) {
      const src = this.ctx.createBufferSource()
      src.buffer = bed.buffer
      src.loop = true
      const g = this.ctx.createGain()
      g.gain.value = 0.35
      src.connect(g)
      g.connect(this.bedFilter)
      src.start()
      this.bedSources.push(src)
    }
  }

  private stopBeds() {
    for (const s of this.bedSources) {
      try {
        s.stop()
      } catch { /* already stopped */ }
    }
    this.bedSources = []
  }

  setWidth(v: number) {
    this.width = v
    this.dsp?.setWidth(v)
  }

  setTilt(v: number) {
    this.tilt = v
    this.dsp?.setTilt(v)
  }

  /**
   * Radio mode: endless background stream — every 3 minutes reseed and
   * rotate one bundled stem in the pool (uploads/YT/mic are left alone).
   * Drift comes on with it.
   */
  setRadio(on: boolean) {
    this.radio = on
    window.clearInterval(this.radioTimer)
    if (!on) return
    if (!this.drift) this.setDrift(true)
    this.radioTimer = window.setInterval(() => {
      void (async () => {
        this.reseed()
        const loadedKeys = new Set(this.sources.filter((s) => s.stemKey).map((s) => s.stemKey))
        const unloaded = BUNDLED_STEMS.filter((s) => !loadedKeys.has(s.key))
        const oldestStemIdx = this.sources.findIndex((s) => s.stemKey)
        if (unloaded.length > 0 && oldestStemIdx >= 0) {
          this.removeSource(oldestStemIdx)
          await this.addStem(unloaded[Math.floor(Math.random() * unloaded.length)].key)
        }
        this.emitChange()
      })()
    }, 180_000)
  }

  /**
   * Freeze/resample: capture N seconds of the processed master back into the
   * pool as a new source — the collage becomes its own sample material.
   */
  async freezeResample(seconds = 12): Promise<void> {
    if (!this.ctx || !this.tap) return
    const ctx = this.ctx
    const proc = ctx.createScriptProcessor(4096, 2, 2)
    const chunksL: Float32Array[] = []
    const chunksR: Float32Array[] = []
    const target = Math.ceil(seconds * ctx.sampleRate)
    let collected = 0
    await new Promise<void>((resolve) => {
      proc.onaudioprocess = (e) => {
        if (collected >= target) return
        chunksL.push(new Float32Array(e.inputBuffer.getChannelData(0)))
        chunksR.push(new Float32Array(e.inputBuffer.getChannelData(1)))
        collected += e.inputBuffer.length
        if (collected >= target) resolve()
      }
      const sink = ctx.createGain()
      sink.gain.value = 0
      this.tap!.connect(proc)
      proc.connect(sink)
      sink.connect(ctx.destination)
    })
    this.tap.disconnect(proc)
    proc.disconnect()
    const buf = ctx.createBuffer(2, Math.min(collected, target), ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      const chunks = ch === 0 ? chunksL : chunksR
      let off = 0
      for (const c of chunks) {
        const n = Math.min(c.length, d.length - off)
        d.set(c.subarray(0, n), off)
        off += n
        if (off >= d.length) break
      }
    }
    const n = this.sources.filter((s) => s.name.startsWith('Freeze')).length + 1
    this.addSource(`Freeze ${n}`, buf, null)
  }

  /** Slow autonomous random-walk of the three macros. */
  setDrift(on: boolean) {
    this.drift = on
    window.clearInterval(this.driftTimer)
    if (!on) return
    const rng = mulberry32(this.seed + 31337)
    this.driftTargets = { ...this.macros }
    this.driftTimer = window.setInterval(() => {
      const t = this.driftTargets!
      for (const k of ['decayFactor', 'tapeAging', 'chaos'] as const) {
        if (rng() < 0.15) t[k] = Math.min(1, Math.max(0, t[k] + (rng() - 0.5) * 0.5))
        this.macros = { ...this.macros, [k]: this.macros[k] + (t[k] - this.macros[k]) * 0.06 }
      }
      this.applyMacros()
      this.emitChange()
    }, 1500)
  }

  // ---------- scenes & song ----------

  captureScene(): Scene {
    return {
      macros: { ...this.macros },
      voices: this.voices.map((v) => ({ ...v })),
      scale: this.scale,
      telephony: this.telephony,
      crush: this.crush,
      bpm: this.bpm,
    }
  }

  saveScene(slot: number) {
    this.scenes[slot] = this.captureScene()
  }

  clearScene(slot: number) {
    this.scenes[slot] = null
    // drop song sections that reference the cleared slot
    this.songSections = this.songSections.filter((s) => s.scene !== slot)
  }

  private applyBlend(a: Scene, b: Scene, k: number) {
    for (const m of ['decayFactor', 'tapeAging', 'chaos'] as const) {
      this.macros = { ...this.macros, [m]: lerp(a.macros[m], b.macros[m], k) }
    }
    this.voices = this.voices.map((v, i) => {
      const av = a.voices[i] ?? v
      const bv = b.voices[i] ?? v
      return {
        ...v,
        level: lerp(av.level, bv.level, k),
        density: lerp(av.density, bv.density, k),
        pitchRange: lerp(av.pitchRange, bv.pitchRange, k),
        reverbSend: lerp(av.reverbSend, bv.reverbSend, k),
        mute: k < 0.5 ? av.mute : bv.mute,
        solo: k < 0.5 ? av.solo : bv.solo,
      }
    })
    this.bpm = Math.round(lerp(a.bpm, b.bpm, k))
    if (k >= 0.5) {
      if (this.scale !== b.scale) this.scale = b.scale
      if (this.telephony !== b.telephony) this.setTelephony(b.telephony)
      if (this.crush !== b.crush) this.setCrush(b.crush)
    }
    this.applyMacros()
    this.applyVoiceGains()
  }

  /** Morph the live state into a saved scene over `seconds`. */
  morphTo(slot: number, seconds = 10) {
    const target = this.scenes[slot]
    if (!target) return
    window.clearInterval(this.morphTimer)
    if (seconds <= 0.2) {
      this.applyBlend(this.captureScene(), target, 1)
      this.emitChange()
      return
    }
    const from = this.captureScene()
    const t0 = performance.now()
    this.morphTimer = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / (seconds * 1000))
      this.applyBlend(from, target, k)
      this.emitChange()
      if (k >= 1) window.clearInterval(this.morphTimer)
    }, 120)
  }

  /** Live song mode: sequence of scene sections, morphing between them. */
  playSong(loop = true) {
    if (this.songSections.length === 0) return
    if (this.songSections.some((s) => !this.scenes[s.scene])) return
    this.stopSong()
    this.songActive = true
    if (!this.playing) this.play()
    const step = (i: number) => {
      const sec = this.songSections[i]
      this.morphTo(sec.scene, Math.min(8, Math.max(1, sec.sec / 3)))
      const next = i + 1
      if (next < this.songSections.length) {
        this.songTimer = window.setTimeout(() => step(next), sec.sec * 1000)
      } else if (loop) {
        this.songTimer = window.setTimeout(() => step(0), sec.sec * 1000)
      } else {
        this.songTimer = window.setTimeout(() => {
          this.songActive = false
          this.emitChange()
        }, sec.sec * 1000)
      }
    }
    step(0)
    this.emitChange()
  }

  stopSong() {
    window.clearTimeout(this.songTimer)
    window.clearInterval(this.morphTimer)
    this.songActive = false
  }

  private applyMacros() {
    if (!this.dsp) return
    this.dsp.setDecayFactor(this.macros.decayFactor)
    this.dsp.setTapeAging(this.macros.tapeAging)
    this.updateNoiseGain()
  }

  private applyVoiceGains() {
    if (!this.ctx) return
    const anySolo = this.voices.some((v) => v.solo)
    for (let i = 0; i < NUM_VOICES; i++) {
      const v = this.voices[i]
      const audible = !v.mute && (!anySolo || v.solo)
      const g = audible ? v.level : 0
      this.voiceGains[i].gain.setTargetAtTime(g, this.ctx.currentTime, 0.03)
      this.sendGains[i].gain.setTargetAtTime(
        audible ? v.level * v.reverbSend : 0,
        this.ctx.currentTime,
        0.03,
      )
    }
    this.updateNoiseGain()
  }

  private updateNoiseGain() {
    // the surface-noise voice also rides the Tape Aging macro
    if (!this.ctx || this.voiceGains.length <= NOISE_VOICE) return
    const v = this.voices[NOISE_VOICE]
    const anySolo = this.voices.some((x) => x.solo)
    const audible = !v.mute && (!anySolo || v.solo)
    const g = audible ? v.level * (0.25 + this.macros.tapeAging * 0.75) : 0
    this.voiceGains[NOISE_VOICE].gain.setTargetAtTime(g, this.ctx.currentTime, 0.05)
  }

  // ---------- events ----------

  onFired(fn: (e: FiredEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  private emit(e: FiredEvent) {
    for (const fn of this.listeners) fn(e)
  }

  private emitChange() {
    for (const fn of this.changeListeners) fn()
  }

  // ---------- slice playback ----------

  /** Reversed copy of a source buffer, cached per buffer. */
  private reversedOf(buffer: AudioBuffer): AudioBuffer {
    let rev = this.reversedCache.get(buffer)
    if (rev) return rev
    rev = this.ctx!.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const s = buffer.getChannelData(ch)
      const d = rev.getChannelData(ch)
      for (let i = 0; i < s.length; i++) d[i] = s[s.length - 1 - i]
    }
    this.reversedCache.set(buffer, rev)
    return rev
  }

  private realizeEvent(ev: SliceEvent, when: number) {
    try {
      this.realizeEventInner(ev, when)
    } catch (e) {
      // one pathological grain must never kill the whole schedule
      console.warn('grain skipped:', e)
    }
  }

  private realizeEventInner(ev: SliceEvent, when: number) {
    if (!this.ctx) return
    const slice = this.slices[ev.sliceId]
    if (!slice) return
    const buffer = this.sources[slice.sourceIdx]?.buffer
    if (!buffer) return

    // CHORDLOCK: pull pitched slices onto the current chord's tones;
    // melody/pad events carry exact targets and skip correction
    const chordNow = ev.noCorrect ? null : this.chordAtTime(when)
    const rate =
      ev.rate * (chordNow ? chordCorrection(slice.pitch, slice.pitchConfidence, chordNow) : 1)
    // cadence breathing: the dominant chord leans slightly forward
    const tension = this.chordAtTime(when)?.isCadence ? 1.12 : 1
    const evGain = ev.gain * tension

    const src = this.ctx.createBufferSource()
    const reversed = !!ev.reverse && !ev.micro
    src.buffer = reversed ? this.reversedOf(buffer) : buffer
    src.playbackRate.value = rate

    const offset = slice.start + (ev.grainOffset ?? 0)
    const dur = ev.micro ? ev.micro.cellDur : (ev.grainDur ?? slice.duration) / rate
    const attack = ev.attack ?? Math.min(0.01, dur / 4)
    const release = ev.release ?? Math.min(0.05, dur / 3)

    const env = this.ctx.createGain()
    applyGrainEnvelope(env.gain, when, dur, attack, release, evGain)

    let head: AudioNode = src
    if (ev.filter) {
      const bp = this.ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = ev.filter.q
      bp.frequency.setValueAtTime(ev.filter.freq0, when)
      bp.frequency.exponentialRampToValueAtTime(ev.filter.freq1, when + ev.filter.sweepDur)
      head.connect(bp)
      head = bp
    }
    const panner = this.ctx.createStereoPanner()
    panner.pan.value = ev.pan
    head.connect(env)
    env.connect(panner)
    panner.connect(this.voiceGains[ev.voice])
    panner.connect(this.sendGains[ev.voice])

    if (ev.micro) {
      // microsampling: loop a tiny window for the cell duration
      src.loop = true
      src.loopStart = offset
      src.loopEnd = Math.min(offset + ev.micro.loopDur, buffer.duration)
      src.start(when, offset)
      src.stop(when + dur + 0.05)
    } else if (reversed) {
      // tape reverse: play the mirrored buffer over the same material
      const playLen = Math.min(dur * rate + 0.02, buffer.duration - offset)
      const revOffset = Math.max(0, buffer.duration - offset - playLen)
      src.start(when, revOffset, playLen)
      src.stop(when + dur + 0.05)
    } else {
      src.start(when, offset, Math.min(dur * rate + 0.02, buffer.duration - offset))
      src.stop(when + dur + 0.05)
    }
    this.activeSources.add(src)
    src.onended = () => this.activeSources.delete(src)

    // sidechain: plunder hits duck the harmonic bed
    if (this.duck && ev.voice === 1 && this.duckGain) {
      const g = this.duckGain.gain
      g.cancelScheduledValues(when)
      g.setValueAtTime(1, when)
      g.linearRampToValueAtTime(0.35, when + 0.03)
      g.setTargetAtTime(1, when + 0.12, 0.3)
    }

    this.emit({ voice: ev.voice, sliceId: slice.id, time: when, durationSec: dur })
  }

  /** Mouse-selected waveform region → the V1 phrase loop, verbatim. */
  regionLoop(sourceIdx: number, start: number, dur: number) {
    const src = this.sources[sourceIdx]
    if (!src) return
    const s = Math.max(0, Math.min(start, src.buffer.duration - 0.3))
    const d = Math.max(0.3, Math.min(dur, src.buffer.duration - s, 30))
    this.phraseRegion = { sourceIdx, start: s, dur: d }
    this.setPhraseMode(true)
    this.emitChange()
  }

  /** Mouse-selected waveform region → a new standalone source in the pool. */
  regionToSource(sourceIdx: number, start: number, dur: number) {
    if (!this.ctx) return
    const src = this.sources[sourceIdx]
    if (!src) return
    const sr = src.buffer.sampleRate
    const s = Math.max(0, Math.min(start, src.buffer.duration - 0.1))
    const d = Math.max(0.1, Math.min(dur, src.buffer.duration - s))
    const from = Math.floor(s * sr)
    const len = Math.floor(d * sr)
    const cut = this.ctx.createBuffer(src.buffer.numberOfChannels, len, sr)
    for (let ch = 0; ch < src.buffer.numberOfChannels; ch++) {
      cut.getChannelData(ch).set(src.buffer.getChannelData(ch).subarray(from, from + len))
    }
    const base = src.name.replace(/^Cut — /, '').slice(0, 24)
    this.addSource(`Cut — ${base} ${s.toFixed(1)}–${(s + d).toFixed(1)}s`, cut, null)
  }

  /** Several mouse-selected regions spliced hard into one new source. */
  regionsToSpliced(sourceIdx: number, regions: Array<{ start: number; dur: number }>) {
    if (!this.ctx) return
    const src = this.sources[sourceIdx]
    if (!src || regions.length === 0) return
    const sr = src.buffer.sampleRate
    const parts = regions
      .map((r) => {
        const s = Math.max(0, Math.min(r.start, src.buffer.duration - 0.05))
        const d = Math.max(0.05, Math.min(r.dur, src.buffer.duration - s))
        return { from: Math.floor(s * sr), len: Math.floor(d * sr) }
      })
      .sort((a, b) => a.from - b.from)
    const total = parts.reduce((n, p) => n + p.len, 0)
    const out = this.ctx.createBuffer(src.buffer.numberOfChannels, total, sr)
    for (let ch = 0; ch < src.buffer.numberOfChannels; ch++) {
      const dst = out.getChannelData(ch)
      const data = src.buffer.getChannelData(ch)
      let off = 0
      for (const p of parts) {
        dst.set(data.subarray(p.from, p.from + p.len), off)
        off += p.len
      }
    }
    const base = src.name.replace(/^(Cut|Splice) — /, '').slice(0, 24)
    this.addSource(`Splice — ${base} (${parts.length} cuts)`, out, null)
  }

  /**
   * Raw source preview: play the whole source buffer clean (straight to the
   * output, no generative engine, no DSP color). Same index toggles off.
   */
  previewToggle(idx: number) {
    if (this.previewSource === idx) {
      this.stopPreview()
      this.emitChange()
      return
    }
    this.startPreview(idx, 0)
  }

  /** Seek: (re)start the raw preview of a source at a given second. */
  previewFrom(idx: number, sec: number) {
    this.startPreview(idx, sec)
  }

  private startPreview(idx: number, fromSec: number) {
    const src = this.sources[idx]
    if (!src) return
    const offset = Math.max(0, Math.min(fromSec, src.buffer.duration - 0.05))
    this.previewParts(idx, [{ start: offset, dur: src.buffer.duration - offset }])
  }

  /** Play the mouse-selected region(s) of a source, in order, clean. */
  previewRegions(idx: number, regions: Array<{ start: number; dur: number }>) {
    const src = this.sources[idx]
    if (!src || regions.length === 0) return
    const parts = regions
      .map((r) => {
        const s = Math.max(0, Math.min(r.start, src.buffer.duration - 0.05))
        return { start: s, dur: Math.max(0.05, Math.min(r.dur, src.buffer.duration - s)) }
      })
      .sort((a, b) => a.start - b.start)
    this.previewParts(idx, parts)
  }

  /** Schedule one clean buffer node per part, back to back. */
  private previewParts(idx: number, parts: Array<{ start: number; dur: number }>) {
    if (!this.ctx) return
    this.stopPreview()
    const src = this.sources[idx]
    if (!src) return
    if (!this.previewGain) {
      this.previewGain = this.ctx.createGain()
      this.previewGain.connect(this.ctx.destination)
    }
    this.previewGain.gain.value = this.masterMuted ? 0 : this.masterVolume
    const t0 = this.ctx.currentTime + 0.03
    let at = t0
    parts.forEach((p, i) => {
      const node = this.ctx!.createBufferSource()
      node.buffer = src.buffer
      node.connect(this.previewGain!)
      if (i === parts.length - 1) {
        node.onended = () => {
          if (this.previewNodes.includes(node)) {
            this.previewNodes = []
            this.previewSource = null
            this.previewStartInfo = null
            this.emitChange()
          }
        }
      }
      node.start(at, p.start, p.dur)
      at += p.dur
      this.previewNodes.push(node)
    })
    this.previewSource = idx
    this.previewStartInfo = { ctxTime: t0, parts }
    this.emitChange()
  }

  /** Current preview playhead position in the source, for the waveform cursor. */
  previewPosition(): { idx: number; sec: number } | null {
    if (!this.ctx || this.previewSource === null || !this.previewStartInfo) return null
    let elapsed = this.ctx.currentTime - this.previewStartInfo.ctxTime
    if (elapsed < 0) elapsed = 0
    for (const p of this.previewStartInfo.parts) {
      if (elapsed < p.dur) return { idx: this.previewSource, sec: p.start + elapsed }
      elapsed -= p.dur
    }
    const last = this.previewStartInfo.parts[this.previewStartInfo.parts.length - 1]
    return { idx: this.previewSource, sec: last.start + last.dur }
  }

  stopPreview() {
    const nodes = this.previewNodes
    this.previewNodes = []
    for (const n of nodes) {
      try {
        n.stop()
      } catch { /* already stopped */ }
    }
    this.previewSource = null
    this.previewStartInfo = null
  }

  auditionSlice(id: number) {
    if (!this.ctx) return
    const slice = this.slices.find((s) => s.id === id)
    if (!slice) return
    this.armedSliceId = slice.id
    this.realizeEvent(
      { voice: 0, sliceId: slice.id, t: 0, rate: 1, gain: 0.9, pan: 0 },
      this.ctx.currentTime + 0.02,
    )
  }

  /** Keyboard performance: play the armed slice transposed by semitones. */
  playArmedAt(semitones: number) {
    if (!this.ctx || this.armedSliceId === null) return
    const slice = this.slices.find((s) => s.id === this.armedSliceId)
    if (!slice) return
    this.realizeEvent(
      {
        voice: 0,
        sliceId: slice.id,
        t: 0,
        rate: Math.pow(2, semitones / 12),
        gain: 0.85,
        pan: Math.max(-0.6, Math.min(0.6, semitones / 20)),
      },
      this.ctx.currentTime + 0.02,
    )
  }

  /** Category pool restricted to a voice's routing mask (with top-up). */
  poolFor(voice: number, cat: Slice['category']): Slice[] {
    const mask = this.sourceMasks[voice]
    const scoped = mask ? this.slices.filter((s) => mask.includes(s.sourceIdx)) : this.slices
    return poolFrom(scoped.length ? scoped : this.slices, cat)
  }

  byCategory(cat: Slice['category']): Slice[] {
    return this.poolFor(-1, cat)
  }

  // ---------- voice scheduling (live) ----------

  /**
   * Loop-lock: build a cell for a voice by accumulating generated events
   * until the target duration. Each voice gets its own unequal length, so
   * the frozen loops phase against each other (Poirier/Reich).
   */
  captureCell(voice: number, rngOverride?: Rng): LoopCell {
    const rng = rngOverride ?? this.voiceRng[voice]
    const events: SliceEvent[] = []
    let dur = 0
    const harm = this.harmCtxAt(this.ctx?.currentTime ?? 0)
    if (voice === 0) {
      const { events: evs, cycleDur, sliceChroma, padSemis } = genV1Cycle(
        this.poolFor(0, 'harmonic'), this.voices[0], this.macros, this.scale, rng, this.tape, harm,
        this.fragK, this.reverseProb,
      )
      this.lastV1Chroma = sliceChroma
      if (padSemis) this.lastPadSemis = padSemis
      events.push(...evs)
      dur = cycleDur
    } else if (voice === 6) {
      if (harm) {
        const { events: evs, dur: d, motif } = genV7Phrase(
          this.poolFor(6, 'harmonic'), this.voices[6], harm, this.bpm, rng, this.melodyMotif,
        )
        this.melodyMotif = motif
        events.push(...evs)
        dur = d
      } else {
        dur = 4
      }
    } else if (voice === 1) {
      const target = 2.4 + rng() * 2.4
      let markov = rngOverride ? -1 : this.markovIdx
      while (dur < target) {
        const { event, dt, idx } = genV2Step(
          this.poolFor(1, 'transient'), this.voices[1], this.macros, this.bpm, markov, rng,
        )
        markov = idx
        events.push({ ...event, t: dur })
        dur += Math.min(dt, 1.6)
      }
      if (!rngOverride) this.markovIdx = markov
    } else if (voice === 2) {
      const { event, dt } = genV3Step(
        [...this.poolFor(2, 'texture'), ...this.poolFor(2, 'harmonic')],
        this.voices[2], rng, this.tape, harm,
      )
      events.push(event)
      dur = Math.min(dt, 8 + rng() * 6)
    } else if (voice === 4) {
      const target = 1.6 + rng() * 1.6
      while (dur < target) {
        const { events: evs, dt } = genV5Cell(
          [...this.poolFor(4, 'transient'), ...this.poolFor(4, 'harmonic')],
          this.voices[4], this.macros, this.scale, rng, harm, this.fragK,
        )
        for (const ev of evs) events.push({ ...ev, t: dur + ev.t })
        dur += Math.min(dt, 2.5)
      }
    }
    return { events, dur: Math.max(0.8, dur), reps: 0 }
  }

  /** Replay a voice's cell verbatim; every 8th repeat may mutate one event. */
  private runLooped(voice: number): number {
    const cell = this.loopCells[voice] ?? (this.loopCells[voice] = this.captureCell(voice))
    const t0 = this.ctx!.currentTime + LOOKAHEAD
    for (const ev of cell.events) this.realizeEvent(ev, t0 + ev.t)
    cell.reps++
    if (cell.reps % 8 === 0 && cell.events.length > 0 && this.voiceRng[voice]() < 0.6) {
      // dub-style slow evolution: one event drifts
      const ev = cell.events[Math.floor(this.voiceRng[voice]() * cell.events.length)]
      ev.pan = Math.max(-0.9, Math.min(0.9, ev.pan + (this.voiceRng[voice]() - 0.5) * 0.6))
      ev.gain *= 0.8 + this.voiceRng[voice]() * 0.4
      // S&H start-point drift: the loop's read position creeps 1–5%
      const s = this.slices[ev.sliceId]
      if (s && ev.grainOffset !== undefined) {
        ev.grainOffset = Math.max(
          0,
          Math.min(
            s.duration * 0.9,
            ev.grainOffset + (this.voiceRng[voice]() - 0.5) * 0.08 * s.duration,
          ),
        )
      }
    }
    return cell.dur
  }

  /** Build the verbatim loop event for a phrase region (shared with offline). */
  phraseEventFor(region: { sourceIdx: number; start: number; dur: number }): SliceEvent | null {
    const ofSource = this.slices.filter((s) => s.sourceIdx === region.sourceIdx)
    if (ofSource.length === 0) return null
    const slice =
      ofSource.find((s) => s.start <= region.start && s.start + s.duration > region.start) ??
      ofSource[0]
    return {
      voice: 0,
      sliceId: slice.id,
      t: 0,
      rate: 1, // the phrase keeps its natural pitch — that's the point
      gain: 0.5,
      pan: 0,
      attack: 0.08,
      release: 0.08,
      grainDur: region.dur,
      grainOffset: region.start - slice.start,
      noCorrect: true,
    }
  }

  private scheduleVoice1() {
    if (!this.playing || !this.ctx) return
    if (this.phraseMode) {
      // PHRASE: one onset-aligned region looping verbatim with a crossfade
      const region = this.phraseRegion ?? this.pickPhraseRegion(this.voiceRng[0])
      if (region) {
        const ev = this.phraseEventFor(region)
        if (ev) this.realizeEvent(ev, this.ctx.currentTime + LOOKAHEAD)
        this.timers[0] = window.setTimeout(
          () => this.scheduleVoice1(),
          Math.max(300, (region.dur - 0.08) * 1000),
        )
        return
      }
    }
    if (this.looped) {
      const dur = this.runLooped(0)
      this.timers[0] = window.setTimeout(() => this.scheduleVoice1(), dur * 1000)
      return
    }
    const { events, cycleDur, sliceChroma, padSemis } = genV1Cycle(
      this.poolFor(0, 'harmonic'),
      this.voices[0],
      this.macros,
      this.scale,
      this.voiceRng[0],
      this.tape,
      this.harmCtxAt(this.ctx.currentTime + LOOKAHEAD),
      this.fragK,
      this.reverseProb,
    )
    this.lastV1Chroma = sliceChroma
    if (padSemis) this.lastPadSemis = padSemis
    const t0 = this.ctx.currentTime + LOOKAHEAD
    for (const ev of events) this.realizeEvent(ev, t0 + ev.t)
    // overlap the next cycle slightly so slice changes crossfade
    this.timers[0] = window.setTimeout(
      () => this.scheduleVoice1(),
      Math.max(1, cycleDur - 0.6) * 1000,
    )
  }

  private scheduleVoice2() {
    if (!this.playing || !this.ctx) return
    if (this.looped) {
      const dur = this.runLooped(1)
      this.timers[1] = window.setTimeout(() => this.scheduleVoice2(), dur * 1000)
      return
    }
    if (this.groove) {
      // batch-schedule a lookahead window of grid onsets so background-tab
      // timer throttling (≥1s) can't starve the groove
      const horizon = this.ctx.currentTime + 2.4
      if (this.grooveNextTime < this.ctx.currentTime + 0.05) {
        this.grooveNextTime = this.ctx.currentTime + LOOKAHEAD
      }
      while (this.grooveNextTime < horizon) {
        const { event, idx } = genV2Step(
          this.poolFor(1, 'transient'),
          this.voices[1],
          this.macros,
          this.bpm,
          this.markovIdx,
          this.voiceRng[1],
        )
        this.markovIdx = idx
        const g = grooveNext(this.grooveStep, this.voices[1].density, this.bpm)
        this.grooveStep = g.step
        this.realizeEvent(event, this.grooveNextTime + g.swing)
        this.grooveNextTime += g.dtGrid
      }
      this.timers[1] = window.setTimeout(() => this.scheduleVoice2(), 1200)
      return
    }
    const { event, dt, idx } = genV2Step(
      this.poolFor(1, 'transient'),
      this.voices[1],
      this.macros,
      this.bpm,
      this.markovIdx,
      this.voiceRng[1],
    )
    this.markovIdx = idx
    this.realizeEvent(event, this.ctx.currentTime + LOOKAHEAD)
    this.timers[1] = window.setTimeout(() => this.scheduleVoice2(), dt * 1000)
  }

  private scheduleVoice3() {
    if (!this.playing || !this.ctx) return
    if (this.looped) {
      const dur = this.runLooped(2)
      this.timers[2] = window.setTimeout(() => this.scheduleVoice3(), dur * 1000)
      return
    }
    const pool = [...this.poolFor(2, 'texture'), ...this.poolFor(2, 'harmonic')]
    const { event, dt } = genV3Step(
      pool, this.voices[2], this.voiceRng[2], this.tape,
      this.harmCtxAt(this.ctx.currentTime + LOOKAHEAD),
    )
    this.realizeEvent(event, this.ctx.currentTime + LOOKAHEAD)
    this.timers[2] = window.setTimeout(() => this.scheduleVoice3(), dt * 1000)
  }

  private startVoice4() {
    if (!this.ctx || !this.noiseBuffer || this.noiseSource) return
    const src = this.ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    src.loop = true
    src.connect(this.voiceGains[NOISE_VOICE])
    src.start()
    this.noiseSource = src
  }

  private stopVoice4() {
    try {
      this.noiseSource?.stop()
    } catch { /* already stopped */ }
    this.noiseSource = null
  }

  private scheduleVoice5() {
    if (!this.playing || !this.ctx) return
    if (this.looped) {
      const dur = this.runLooped(4)
      this.timers[4] = window.setTimeout(() => this.scheduleVoice5(), dur * 1000)
      return
    }
    const pool = [...this.poolFor(4, 'transient'), ...this.poolFor(4, 'harmonic')]
    const { events, dt } = genV5Cell(
      pool, this.voices[4], this.macros, this.scale, this.voiceRng[4],
      this.harmCtxAt(this.ctx.currentTime + LOOKAHEAD), this.fragK,
    )
    const t0 = this.ctx.currentTime + LOOKAHEAD
    for (const ev of events) this.realizeEvent(ev, t0 + ev.t)
    this.timers[4] = window.setTimeout(() => this.scheduleVoice5(), dt * 1000)
  }

  /** Voice 7 — melody: motif phrases (needs CHORDLOCK for a harmonic frame). */
  private scheduleVoice7() {
    if (!this.playing || !this.ctx) return
    if (this.looped) {
      const dur = this.runLooped(6)
      this.timers[6] = window.setTimeout(() => this.scheduleVoice7(), dur * 1000)
      return
    }
    const harm = this.harmCtxAt(this.ctx.currentTime + LOOKAHEAD)
    if (!harm) {
      this.timers[6] = window.setTimeout(() => this.scheduleVoice7(), 2000)
      return
    }
    const { events, dur, motif } = genV7Phrase(
      this.poolFor(6, 'harmonic'), this.voices[6], harm, this.bpm, this.voiceRng[6],
      this.melodyMotif,
    )
    this.melodyMotif = motif
    const t0 = this.ctx.currentTime + LOOKAHEAD
    for (const ev of events) this.realizeEvent(ev, t0 + ev.t)
    this.timers[6] = window.setTimeout(() => this.scheduleVoice7(), dur * 1000)
  }

  /**
   * Voice 6 — sub pulse (Poirier's dub heartbeat): soft sine thumps on the
   * beat grid, probability from density, frequency from pitch range.
   * Batch-scheduled ahead so tab throttling can't starve the pulse.
   */
  private scheduleVoice6() {
    if (!this.playing || !this.ctx) return
    const v = this.voices[5]
    const beat = 60 / this.bpm
    const horizon = this.ctx.currentTime + 2.4
    if (this.pulseNextTime < this.ctx.currentTime + 0.05) {
      this.pulseNextTime = this.ctx.currentTime + LOOKAHEAD
    }
    while (this.pulseNextTime < horizon) {
      if (this.voiceRng[5]() < 0.15 + v.density * 0.75) {
        // CHORDLOCK: the pulse walks the chord roots (occasional fifth)
        const chord = this.chordAtTime(this.pulseNextTime)
        let freq = 42 + v.pitchRange * 28
        if (chord) {
          const pc = this.voiceRng[5]() < 0.2 ? (chord.pcs[0] + 7) % 12 : chord.pcs[0]
          freq = 27.5 * Math.pow(2, pc / 12)
          if (freq < 36) freq *= 2 // keep it in the 36–72Hz pocket
        }
        this.realizePulse(this.pulseNextTime, freq, 0.8)
      }
      this.pulseNextTime += beat
    }
    this.timers[5] = window.setTimeout(() => this.scheduleVoice6(), 1200)
  }

  private realizePulse(when: number, freq: number, gain: number) {
    if (!this.ctx) return
    const osc = this.ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq * 1.6, when)
    osc.frequency.exponentialRampToValueAtTime(freq, when + 0.06)
    const env = this.ctx.createGain()
    env.gain.setValueAtTime(0, when)
    env.gain.linearRampToValueAtTime(gain, when + 0.008)
    env.gain.exponentialRampToValueAtTime(0.001, when + 0.4)
    osc.connect(env)
    env.connect(this.voiceGains[5])
    osc.start(when)
    osc.stop(when + 0.5)
    this.emit({ voice: 5, sliceId: -1, time: when, durationSec: 0.4 })
  }
}

/**
 * Grain amplitude envelope. Short grains get raised-cosine (Hann) edges --
 * gain(t) = g * 0.5 * (1 - cos(pi*t/T)) -- so grain boundaries carry no
 * zero-crossing clicks; long events keep cheap linear ramps.
 */
/**
 * One West Coast FM ping: sine carrier + sine modulator whose index decays
 * fast (metallic attack melting into a pure chime), exponential-decay
 * envelope, random pan. Works on both live and offline contexts.
 */
export function realizePing(
  ctx: BaseAudioContext,
  dest: AudioNode,
  send: AudioNode | null,
  when: number,
  freq: number,
  level: number,
  rng: Rng,
) {
  const car = ctx.createOscillator()
  car.type = 'sine'
  car.frequency.value = freq
  const mod = ctx.createOscillator()
  mod.type = 'sine'
  mod.frequency.value = freq * [1.41, 2.01, 2.76, 3.53][Math.floor(rng() * 4)]
  const modGain = ctx.createGain()
  modGain.gain.setValueAtTime(freq * (0.5 + rng() * 2), when)
  modGain.gain.exponentialRampToValueAtTime(1, when + 0.12 + rng() * 0.5)
  mod.connect(modGain)
  modGain.connect(car.frequency)
  const dur = 0.7 + rng() * 2.3
  const g = level * (0.5 + rng() * 0.5) * 0.35
  const env = ctx.createGain()
  env.gain.setValueAtTime(0, when)
  env.gain.linearRampToValueAtTime(g, when + 0.004)
  env.gain.exponentialRampToValueAtTime(0.0006, when + dur)
  env.gain.linearRampToValueAtTime(0, when + dur + 0.03)
  const pan = ctx.createStereoPanner()
  pan.pan.value = (rng() - 0.5) * 1.4
  car.connect(env)
  env.connect(pan)
  pan.connect(dest)
  if (send) pan.connect(send)
  car.start(when)
  mod.start(when)
  car.stop(when + dur + 0.06)
  mod.stop(when + dur + 0.06)
}

export function applyGrainEnvelope(
  param: AudioParam,
  when: number,
  dur: number,
  attack: number,
  release: number,
  gain: number,
) {
  let a = Math.max(0.001, attack)
  let r = Math.max(0.001, release)
  if (a + r > dur) {
    const k = dur / (a + r)
    a *= k * 0.95
    r *= k * 0.95
  }
  param.setValueAtTime(0, when)
  if (dur < 1.2) {
    const N = 24
    const up = new Float32Array(N)
    const down = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const h = 0.5 * (1 - Math.cos((Math.PI * i) / (N - 1)))
      up[i] = h * gain
      down[i] = (1 - h) * gain
    }
    try {
      param.setValueCurveAtTime(up, when, a)
      param.setValueAtTime(gain, when + a)
      const relStart = Math.max(when + a + 0.001, when + dur - r)
      param.setValueAtTime(gain, relStart)
      param.setValueCurveAtTime(
        down,
        relStart + 0.0005,
        Math.max(0.001, when + dur - relStart - 0.001),
      )
    } catch {
      // rare float-boundary overlap between curve segments: fall back to
      // plain ramps — audibly equivalent, and it can never throw
      param.cancelScheduledValues(when)
      param.setValueAtTime(0, when)
      param.linearRampToValueAtTime(gain, when + a)
      param.setValueAtTime(gain, Math.max(when + a, when + dur - r))
      param.linearRampToValueAtTime(0, when + dur)
    }
  } else {
    param.linearRampToValueAtTime(gain, when + a)
    param.setValueAtTime(gain, Math.max(when + a, when + dur - r))
    param.linearRampToValueAtTime(0, when + dur)
  }
}

export const engine = new AudioEngine()

// dev-only handle for console probing
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__engine = engine
}
