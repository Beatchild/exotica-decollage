import { genV1Cycle, genV2Step, genV3Step, genV5Cell, genV7Phrase, grooveNext } from './generate'
import type { HarmCtx } from './generate'
import { chordAt, chordCorrection, makeProgression } from './Harmony'
import type { Motif } from './Harmony'
import { mulberry32 } from './rng'
import { eraChain, ensureEraSurfaces, startEraSurfaces } from './eras'
import { LAYERS_OFF, layersActive, memoryLanes, prepareStretches, sectionIndexAt, sectionSpanAt } from './memoryLayers'
import type { MemoryLayerParams } from './memoryLayers'
import type { MixBus } from './AudioEngine'
import { isMemoryForm } from './memory'
import type { MasterChain } from './mastering'
import { renderSurfaceNoise } from './stems'
import { masterAsync } from './masterAsync'
import type { WavFormat } from './WavRecorder'
import type { LoudnessReport } from './loudness'
import { applyGrainEnvelope, poolFrom, realizePing } from './AudioEngine'
import type { AudioEngine } from './AudioEngine'
import { NOISE_VOICE, NUM_VOICES } from './types'
import type { MacroParams, Scene, Slice, SliceEvent, VoiceParams } from './types'

export interface RenderOpts {
  /** render only this voice (stem export); null/undefined = full mix */
  soloVoice?: number | null
  /** bar-locked loop: length = bars × 4 beats at the engine BPM, tail folded onto the start */
  loopBars?: number | null
  /** overrides for remix variants — engine state is read-only, so several
   * renders with different personalities can run in parallel */
  seed?: number
  macros?: MacroParams
  scale?: Scene['scale']
  groove?: boolean
  duck?: boolean
  /** restrict all voices to these source indices (e.g. only YT collages) */
  sourceFilter?: number[]
  /** 0..1 as the render advances */
  onProgress?: (fraction: number) => void
  /** loudness normalization of the final master */
  master?: MasterOpts
  /** cancel: the render rejects with an AbortError within one 5s chunk */
  signal?: AbortSignal
  /** output sample rate (default: the live context's, usually 48000) */
  sampleRate?: number
  /** bit depth + metadata of the WAV */
  format?: WavFormat
  /** which parts of which sources this render actually played */
  onUsage?: (usage: SourceUsage[]) => void
  /** render one MIX bus alone (memory-layer stems) */
  soloBus?: MixBus
}

/** Provenance: the stretches of one pool source a render played from. */
export interface SourceUsage {
  sourceIdx: number
  name: string
  /** number of sample events drawn from this source */
  events: number
  /** merged [start, end] seconds inside the source buffer */
  ranges: Array<[number, number]>
}

export interface RawRender {
  L: Float32Array
  R: Float32Array
  sampleRate: number
  usage: SourceUsage[]
}

export interface MasterOpts {
  /** integrated loudness target, e.g. −14 LUFS; null/undefined = measure only */
  targetLufs?: number | null
  /** true-peak ceiling in dBTP (default −1) */
  ceilingDb?: number
  /** release chain applied before loudness (MASTER section) */
  chain?: MasterChain
  onReport?: (r: { before: LoudnessReport; after: LoudnessReport; crc: number }) => void
}

interface TimelineState {
  macros: MacroParams
  voices: VoiceParams[]
  bpm: number
  scale: Scene['scale']
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k

/**
 * Song timeline: piecewise state over the render from the engine's scene
 * sequence, with a short morph window at each section start.
 */
function makeTimeline(engine: AudioEngine): ((t: number) => TimelineState) | null {
  const sections = engine.songSections
  if (sections.length === 0) return null
  if (sections.some((s) => !engine.scenes[s.scene])) return null
  const total = sections.reduce((n, s) => n + s.sec, 0)
  const starts: number[] = []
  let acc = 0
  for (const s of sections) {
    starts.push(acc)
    acc += s.sec
  }
  const sceneAt = (i: number) => engine.scenes[sections[i].scene]!
  return (t: number) => {
    const tt = ((t % total) + total) % total // loop the song over long renders
    let i = sections.length - 1
    for (let k = 0; k < sections.length; k++) {
      if (tt < starts[k] + sections[k].sec) {
        i = k
        break
      }
    }
    const cur = sceneAt(i)
    const prev = sceneAt((i - 1 + sections.length) % sections.length)
    const morph = Math.min(8, Math.max(1, sections[i].sec / 3))
    const into = tt - starts[i]
    const k = sections.length > 1 && into < morph ? into / morph : 1
    return {
      macros: {
        decayFactor: lerp(prev.macros.decayFactor, cur.macros.decayFactor, k),
        tapeAging: lerp(prev.macros.tapeAging, cur.macros.tapeAging, k),
        chaos: lerp(prev.macros.chaos, cur.macros.chaos, k),
      },
      voices: cur.voices.map((cv, vi) => {
        const pv = prev.voices[vi] ?? cv
        return {
          ...cv,
          level: lerp(pv.level, cv.level, k),
          density: lerp(pv.density, cv.density, k),
          pitchRange: lerp(pv.pitchRange, cv.pitchRange, k),
          reverbSend: lerp(pv.reverbSend, cv.reverbSend, k),
        }
      }),
      bpm: Math.round(lerp(prev.bpm, cur.bpm, k)),
      scale: k < 0.5 ? prev.scale : cur.scale,
    }
  }
}

/**
 * Deterministic offline bounce: replays the generative processes from the
 * engine's seed into an OfflineAudioContext, through a native-node
 * approximation of the live Tone.js master chain, and encodes a 16-bit WAV.
 * Supports per-voice stems, a scene-sequence song timeline, sidechain duck,
 * and bar-locked loop export with the tail folded onto the start.
 */
export async function renderOffline(
  engine: AudioEngine,
  minutes: number,
  opts: RenderOpts = {},
): Promise<Blob> {
  const raw = await renderRaw(engine, minutes, opts)
  opts.onUsage?.(raw.usage)
  return finishMaster(raw.L, raw.R, raw.sampleRate, opts.master, opts.signal, opts.format)
}

/** The render itself, before loudness/encoding — float channels + provenance. */
/** share of the progress bar the offline bounce takes (the rest: sub-octave, then the caller's mastering) */
const RENDER_SHARE = 0.93

export async function renderRaw(
  engine: AudioEngine,
  minutes: number,
  opts: RenderOpts = {},
): Promise<RawRender> {
  const sampleRate = opts.sampleRate ?? engine.ctx?.sampleRate ?? 48000
  const loopSec = opts.loopBars ? (opts.loopBars * 4 * 60) / engine.bpm : null
  const tailSec = loopSec ? 3 : 0
  // 45min cap: beyond that the float render buffer alone tops 1GB
  const seconds = loopSec ? loopSec + tailSec : Math.max(10, Math.min(45 * 60, minutes * 60))
  // memory layers: the stretch clouds must exist before the bounce starts
  // a bus stem (CLOUDS / MELODY / GHOSTS / LOOP / SURFACE) plays that bus alone
  const soloBus = opts.soloBus ?? null
  const ml = soloBus ? soloLayers(engine.memLayers, soloBus) : engine.memLayers
  const layersOn = !loopSec && (opts.soloVoice ?? null) === null && layersActive(ml)
  if (layersOn && ml.stretch > 0.02) await prepareStretches(engine.slices, engine.sources)
  await ensureEraSurfaces(sampleRate, engine.sources.filter((x) => !x.bed).map((x) => x.era ?? 'none'))
  throwIfAborted(opts.signal)
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate)
  const { voices, telephony, crush } = engine
  const seed = opts.seed ?? engine.seed
  const duck = opts.duck ?? engine.duck
  const groove = opts.groove ?? engine.groove
  // explicit macro overrides (remix variants) take precedence over the song timeline
  const timeline = opts.macros ? null : makeTimeline(engine)
  const baseMacros = opts.macros ?? engine.macros
  const baseScale = opts.scale ?? engine.scale
  const stateAt = (t: number): TimelineState =>
    timeline?.(t) ?? { macros: baseMacros, voices, bpm: engine.bpm, scale: baseScale }
  const m0 = stateAt(0).macros

  // remix mode may restrict every voice to specific sources (e.g. YT collages)
  const scoped = opts.sourceFilter
    ? engine.slices.filter((s) => opts.sourceFilter!.includes(s.sourceIdx))
    : null
  const pool = (voice: number, cat: Slice['category']) =>
    scoped && scoped.length ? poolFrom(scoped, cat) : engine.poolFor(voice, cat)

  // CHORDLOCK mirror: the chord clock runs from t=0 over the render
  const harmProg = engine.keyLock ? makeProgression(baseScale, engine.keyRoot) : null
  const harmPeriod = engine.looped && engine.blockSec > 0 ? engine.blockSec : 12
  const chordAtT = (t: number) => (harmProg ? chordAt(harmProg, harmPeriod, t) : null)
  let harmPrevChroma: number[] | undefined
  let harmPadPrev: number[] | null = null
  const harmAt = (t: number): HarmCtx | null => {
    const chord = chordAtT(t)
    if (!chord) return null
    return {
      chord,
      scale: baseScale,
      root: engine.keyRoot,
      pad: engine.padMode,
      padPrev: harmPadPrev,
      prevChroma: harmPrevChroma,
    }
  }

  // ---------- native master chain (approximates DSPChain) ----------
  const input = ctx.createGain()

  const flutter = ctx.createDelay(0.06)
  flutter.delayTime.value = 0.02
  const lfo = ctx.createOscillator()
  const lfoGain = ctx.createGain()
  lfo.connect(lfoGain)
  lfoGain.connect(flutter.delayTime)
  lfo.start(0)
  // noise-derived flutter jitter (seeded → deterministic renders)
  const fnRng = mulberry32(seed + 123)
  const fnBuf = ctx.createBuffer(1, 2 * sampleRate, sampleRate)
  const fnD = fnBuf.getChannelData(0)
  for (let i = 0; i < fnD.length; i++) fnD[i] = fnRng() * 2 - 1
  const fnSrc = ctx.createBufferSource()
  fnSrc.buffer = fnBuf
  fnSrc.loop = true
  const fnLP = ctx.createBiquadFilter()
  fnLP.type = 'lowpass'
  fnLP.frequency.value = 12
  const lfo2Gain = ctx.createGain()
  lfo2Gain.gain.value = 0.0009
  fnSrc.connect(fnLP)
  fnLP.connect(lfo2Gain)
  lfo2Gain.connect(flutter.delayTime)
  fnSrc.start(0)
  input.connect(flutter)

  const dryTel = ctx.createGain()
  const wetTel = ctx.createGain()
  dryTel.gain.value = telephony ? 0 : 1
  wetTel.gain.value = telephony ? 1 : 0
  const tel = ctx.createBiquadFilter()
  tel.type = 'bandpass'
  tel.frequency.value = 1100
  tel.Q.value = 0.9
  flutter.connect(dryTel)
  flutter.connect(tel)
  tel.connect(wetTel)

  const shaper = ctx.createWaveShaper()
  const curve = new Float32Array(2048)
  const drive = 1 + m0.tapeAging * 2.5
  const levels = crush ? 4096 : 0
  // asymmetric soft-clip: DC bias bends the tanh so even harmonics appear
  const satBias = 0.14
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length / 2 - 0.5)) - 1
    let y = (Math.tanh(drive * (x + satBias)) - Math.tanh(drive * satBias)) / Math.tanh(drive)
    if (levels) y = Math.round(y * levels) / levels
    curve[i] = y
  }
  shaper.curve = curve
  shaper.oversample = '2x'
  dryTel.connect(shaper)
  wetTel.connect(shaper)

  const delayWet = ctx.createGain()
  delayWet.gain.value = 0.22
  for (const [time, pan] of [
    [0.38, -0.75],
    [0.54, 0.75],
  ] as const) {
    const d = ctx.createDelay(1)
    d.delayTime.value = time
    const fb = ctx.createGain()
    fb.gain.value = 0.45
    const roll = ctx.createBiquadFilter()
    roll.type = 'lowpass'
    roll.frequency.value = 3000
    roll.Q.value = 0.6
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    shaper.connect(d)
    d.connect(roll)
    roll.connect(fb)
    fb.connect(d)
    roll.connect(p)
    p.connect(delayWet)
  }

  const reverb = ctx.createConvolver()
  reverb.buffer = makeImpulse(ctx, engine.plateShort ? 1.7 : 4.5, sampleRate)
  const revDamp = ctx.createBiquadFilter()
  revDamp.type = 'lowpass'
  revDamp.frequency.value = engine.plateShort ? 3500 : 20000
  const revWet = ctx.createGain()
  const revSend = ctx.createGain()
  shaper.connect(revDamp)
  delayWet.connect(revDamp)
  revSend.connect(revDamp)
  revDamp.connect(reverb)
  reverb.connect(revWet)

  const warmth = ctx.createBiquadFilter()
  warmth.type = 'lowpass'
  warmth.Q.value = 0.4
  shaper.connect(warmth)
  delayWet.connect(warmth)
  revWet.connect(warmth)

  // vintage voicing: 2-pole Butterworth HP + resonant bell + 4-pole LP
  const von = engine.voicing
  const vHP = ctx.createBiquadFilter()
  vHP.type = 'highpass'
  vHP.frequency.value = von ? 320 : 5
  vHP.Q.value = 0.707
  const vBell = ctx.createBiquadFilter()
  vBell.type = 'peaking'
  vBell.frequency.value = 1200
  vBell.Q.value = 1.4
  vBell.gain.value = von ? 2.5 : 0
  const vLP1 = ctx.createBiquadFilter()
  const vLP2 = ctx.createBiquadFilter()
  for (const [f, q] of [[vLP1, 0.54], [vLP2, 1.31]] as const) {
    f.type = 'lowpass'
    f.frequency.value = von ? 5500 : 20000
    f.Q.value = q
  }
  warmth.connect(vHP)
  vHP.connect(vBell)
  vBell.connect(vLP1)
  vLP1.connect(vLP2)
  const voiced = vLP2

  // AQUA: light chorus (single modulated delay mixed in) + steep muffle
  const aqua = Math.min(1, Math.max(0, engine.aqua))
  const muffle = ctx.createBiquadFilter()
  muffle.type = 'lowpass'
  muffle.frequency.value = 20000 * Math.pow(900 / 20000, aqua)
  muffle.Q.value = 0.7
  if (aqua > 0.01) {
    const chDelay = ctx.createDelay(0.05)
    chDelay.delayTime.value = 0.0045
    const chLfo = ctx.createOscillator()
    chLfo.frequency.value = 0.35
    const chDepth = ctx.createGain()
    chDepth.gain.value = 0.0012 + aqua * 0.0022
    chLfo.connect(chDepth)
    chDepth.connect(chDelay.delayTime)
    chLfo.start(0)
    const chWet = ctx.createGain()
    chWet.gain.value = aqua * 0.5
    const chDry = ctx.createGain()
    chDry.gain.value = 1
    voiced.connect(chDelay)
    chDelay.connect(chWet)
    voiced.connect(chDry)
    chWet.connect(muffle)
    chDry.connect(muffle)
  } else {
    voiced.connect(muffle)
  }

  // stereo width via M/S matrix: L' = m + s·w, R' = m − s·w (w = width×2);
  // aqua narrows the image toward the submerged center
  const w = Math.min(1, Math.max(0, engine.width * (1 - aqua * 0.45))) * 2
  const split = ctx.createChannelSplitter(2)
  const merge = ctx.createChannelMerger(2)
  const ll = ctx.createGain()
  const lr = ctx.createGain()
  const rl = ctx.createGain()
  const rr = ctx.createGain()
  ll.gain.value = (1 + w) / 2
  lr.gain.value = (1 - w) / 2
  rl.gain.value = (1 - w) / 2
  rr.gain.value = (1 + w) / 2
  muffle.connect(split)
  split.connect(ll, 0)
  split.connect(rl, 0)
  split.connect(lr, 1)
  split.connect(rr, 1)
  ll.connect(merge, 0, 0)
  lr.connect(merge, 0, 0)
  rl.connect(merge, 0, 1)
  rr.connect(merge, 0, 1)

  // spectral tilt: ±6dB opposing shelves
  const tiltLow = ctx.createBiquadFilter()
  tiltLow.type = 'lowshelf'
  tiltLow.frequency.value = 400
  tiltLow.gain.value = -engine.tilt * 6
  const tiltHigh = ctx.createBiquadFilter()
  tiltHigh.type = 'highshelf'
  tiltHigh.frequency.value = 2500
  tiltHigh.gain.value = engine.tilt * 6

  const rumbleHP = ctx.createBiquadFilter()
  rumbleHP.type = 'highpass'
  rumbleHP.frequency.value = 30
  rumbleHP.Q.value = 0.7
  // gentle glue, not a brickwall — micro-transient decays survive
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -12
  limiter.knee.value = 8
  limiter.ratio.value = 3
  limiter.attack.value = 0.012
  limiter.release.value = 0.25
  merge.connect(tiltLow)
  tiltLow.connect(tiltHigh)
  tiltHigh.connect(rumbleHP)
  rumbleHP.connect(limiter)
  // tape dropout holes cut here, after the limiter
  const holeGain = ctx.createGain()
  limiter.connect(holeGain)
  holeGain.connect(ctx.destination)

  // macro-driven params: scheduled along the timeline (2s grid), else static
  const scheduleMacroCurves = () => {
    const step = timeline ? 2 : seconds + 1
    for (let t = 0; t <= seconds; t += step) {
      const m = stateAt(t).macros
      const at = Math.min(t, seconds)
      lfo.frequency.setValueAtTime(0.3 + m.tapeAging * 1.5, at)
      lfoGain.gain.setValueAtTime(0.0005 + m.tapeAging * 0.004, at)
      revWet.gain.setValueAtTime(0.15 + m.decayFactor * 0.55, at)
      warmth.frequency.setValueAtTime(16000 - m.tapeAging * 11500, at)
    }
  }
  scheduleMacroCurves()

  // ---------- voice buses ----------
  const solo = opts.soloVoice ?? null
  // MIX: the generative voices share one fader (dry + reverb send)
  const voicesDry = ctx.createGain()
  voicesDry.gain.value = engine.mix.voices
  voicesDry.connect(input)
  const voicesSend = ctx.createGain()
  voicesSend.gain.value = engine.mix.voices
  voicesSend.connect(revSend)
  const duckGain = ctx.createGain() // voice 0 sidechain target
  duckGain.connect(voicesDry)
  const anySolo = voices.some((v) => v.solo)
  const voiceGains: GainNode[] = []
  const sendGains: GainNode[] = []
  const audibleAt = (vi: number, t: number) => {
    if (solo !== null && vi !== solo) return 0
    const v = stateAt(t).voices[vi] ?? voices[vi]
    // a song section's own mute wins (the timeline carries each scene's voices)
    const on = !v.mute && (!anySolo || voices[vi].solo)
    if (!on) return 0
    return vi === NOISE_VOICE ? v.level * (0.25 + stateAt(t).macros.tapeAging * 0.75) : v.level
  }
  for (let i = 0; i < NUM_VOICES; i++) {
    const g = ctx.createGain()
    const s = ctx.createGain()
    const step = timeline ? 2 : seconds + 1
    for (let t = 0; t <= seconds; t += step) {
      const at = Math.min(t, seconds)
      const lvl = audibleAt(i, at)
      g.gain.setValueAtTime(lvl, at)
      s.gain.setValueAtTime(lvl * (stateAt(at).voices[i]?.reverbSend ?? voices[i].reverbSend), at)
    }
    g.connect(i === 0 ? duckGain : voicesDry)
    s.connect(voicesSend)
    voiceGains.push(g)
    sendGains.push(s)
  }

  // ---------- event realization ----------
  const revCache = new Map<AudioBuffer, AudioBuffer>()
  const reversedOf = (buffer: AudioBuffer): AudioBuffer => {
    let rev = revCache.get(buffer)
    if (rev) return rev
    rev = new AudioBuffer({
      numberOfChannels: buffer.numberOfChannels,
      length: buffer.length,
      sampleRate: buffer.sampleRate,
    })
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const s = buffer.getChannelData(ch)
      const d = rev.getChannelData(ch)
      for (let i = 0; i < s.length; i++) d[i] = s[s.length - 1 - i]
    }
    revCache.set(buffer, rev)
    return rev
  }

  // provenance: which stretches of which sources get played
  const used = new Map<number, { events: number; ranges: Array<[number, number]> }>()
  const markUsed = (sourceIdx: number, from: number, to: number) => {
    let u = used.get(sourceIdx)
    if (!u) used.set(sourceIdx, (u = { events: 0, ranges: [] }))
    u.events++
    u.ranges.push([from, to])
  }

  const eraRng = mulberry32(seed + 8191)
  const realize = (ev: SliceEvent, when: number) => {
    const slice = engine.slices[ev.sliceId]
    if (!slice) return
    const buffer = engine.sources[slice.sourceIdx]?.buffer
    if (!buffer) return
    {
      const from = slice.start + (ev.grainOffset ?? 0)
      const len = ev.micro ? ev.micro.loopDur : (ev.grainDur ?? slice.duration)
      markUsed(slice.sourceIdx, from, Math.min(buffer.duration, from + len))
    }
    const chordNow = ev.noCorrect ? null : chordAtT(when)
    const rate =
      ev.rate * (chordNow ? chordCorrection(slice.pitch, slice.pitchConfidence, chordNow) : 1)
    const tension = chordAtT(when)?.isCadence ? 1.12 : 1
    const evGain = ev.gain * tension
    const reversed = !!ev.reverse && !ev.micro
    const src = ctx.createBufferSource()
    src.buffer = reversed ? reversedOf(buffer) : buffer
    src.playbackRate.value = rate
    const offset = slice.start + (ev.grainOffset ?? 0)
    const dur = ev.micro ? ev.micro.cellDur : (ev.grainDur ?? slice.duration) / rate
    const attack = ev.attack ?? Math.min(0.01, dur / 4)
    const release = ev.release ?? Math.min(0.05, dur / 3)
    const env = ctx.createGain()
    applyGrainEnvelope(env.gain, when, dur, attack, release, evGain)
    let head: AudioNode = src
    if (ev.filter) {
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = ev.filter.q
      bp.frequency.setValueAtTime(ev.filter.freq0, when)
      bp.frequency.exponentialRampToValueAtTime(ev.filter.freq1, when + ev.filter.sweepDur)
      head.connect(bp)
      head = bp
    }
    const era = engine.sources[slice.sourceIdx]?.era
    if (era && era !== 'none') head = eraChain(ctx, head, src, era, eraRng, when)
    const panner = ctx.createStereoPanner()
    panner.pan.value = ev.pan
    head.connect(env)
    env.connect(panner)
    panner.connect(voiceGains[ev.voice])
    panner.connect(sendGains[ev.voice])
    if (ev.micro) {
      src.loop = true
      src.loopStart = offset
      src.loopEnd = Math.min(offset + ev.micro.loopDur, buffer.duration)
      src.start(when, offset)
      src.stop(when + dur + 0.05)
    } else if (reversed) {
      const playLen = Math.min(dur * rate + 0.02, buffer.duration - offset)
      const revOffset = Math.max(0, buffer.duration - offset - playLen)
      src.start(when, revOffset, playLen)
      src.stop(when + dur + 0.05)
    } else {
      src.start(when, offset, Math.min(dur * rate + 0.02, buffer.duration - offset))
      src.stop(when + dur + 0.05)
    }
    // sidechain: plunder hits duck the harmonic bed
    if (duck && ev.voice === 1) {
      const g = duckGain.gain
      g.setValueAtTime(1, when)
      g.linearRampToValueAtTime(0.35, when + 0.03)
      g.setTargetAtTime(1, when + 0.12, 0.3)
    }
  }

  // ---------- schedule all voices from fresh seeded streams ----------
  // Each voice is a generator that schedules one step and yields its next
  // start time. Scheduling happens in windows while the OfflineAudioContext
  // is suspended, so a 20-minute render never builds hundreds of thousands
  // of nodes up front (which froze the UI and ballooned memory).
  const rngs = Array.from({ length: NUM_VOICES }, (_, i) => mulberry32(seed + i * 7919))
  const want = (vi: number) => soloBus === null && (solo === null || solo === vi)
  const lanes: Array<Generator<number, void, void>> = []

  // loop-lock: tile a captured cell verbatim, recapturing at block boundaries
  function* tileLooped(voice: number, start: number): Generator<number, void, void> {
    let t = start
    let cell = engine.captureCell(voice, rngs[voice])
    let blockEnd = engine.blockSec > 0 ? engine.blockSec : Infinity
    while (t < seconds) {
      if (t >= blockEnd) {
        cell = engine.captureCell(voice, rngs[voice])
        blockEnd += engine.blockSec
      }
      for (const ev of cell.events) if (t + ev.t < seconds) realize(ev, t + ev.t)
      t += Math.max(0.05, cell.dur)
      yield t
    }
  }

  if (want(0)) {
    if (engine.phraseMode) {
      lanes.push((function* () {
        // PHRASE mirror: verbatim loop, re-picked at block boundaries
        let region = engine.phraseRegion ?? engine.pickPhraseRegion(rngs[0], false)
        let blockEnd = engine.blockSec > 0 ? engine.blockSec : Infinity
        let tp = 0.1
        while (tp < seconds && region) {
          if (tp >= blockEnd) {
            region = engine.pickPhraseRegion(rngs[0], false) ?? region
            blockEnd += engine.blockSec
          }
          const ev = engine.phraseEventFor(region)
          if (ev) realize(ev, tp)
          tp += Math.max(0.3, region.dur - 0.08)
          yield tp
        }
      })())
    } else if (engine.looped) lanes.push(tileLooped(0, 0.1))
    else {
      lanes.push((function* () {
        let t1 = 0.1
        while (t1 < seconds) {
          const st = stateAt(t1)
          const { events, cycleDur, sliceChroma, padSemis } = genV1Cycle(
            pool(0, 'harmonic'), st.voices[0], st.macros, st.scale, rngs[0], engine.tape,
            harmAt(t1), engine.fragK, engine.reverseProb,
          )
          harmPrevChroma = sliceChroma
          if (padSemis) harmPadPrev = padSemis
          for (const ev of events) if (t1 + ev.t < seconds) realize(ev, t1 + ev.t)
          t1 += Math.max(1, cycleDur - 0.6) // slight overlap: slice changes crossfade
          yield t1
        }
      })())
    }
  }

  // voice 2 events always generated when duck is on (they shape voice 0),
  // but only made audible when wanted
  if (engine.looped && want(1)) {
    lanes.push(tileLooped(1, 0.1))
  } else if (want(1) || (duck && want(0))) {
    lanes.push((function* () {
      let t2 = 0.1
      let markov = -1
      let step = 0
      let swingOff = 0
      while (t2 < seconds) {
        const st = stateAt(t2)
        const { event, dt, idx } = genV2Step(
          pool(1, 'transient'), st.voices[1], st.macros, st.bpm, markov, rngs[1],
        )
        markov = idx
        const at = t2 + swingOff
        if (want(1)) realize(event, at)
        else if (duck) {
          // schedule only the duck envelope
          const g = duckGain.gain
          g.setValueAtTime(1, at)
          g.linearRampToValueAtTime(0.35, at + 0.03)
          g.setTargetAtTime(1, at + 0.12, 0.3)
        }
        if (groove) {
          const g = grooveNext(step, st.voices[1].density, st.bpm)
          step = g.step
          swingOff = g.swing
          t2 += g.dtGrid
        } else {
          swingOff = 0
          t2 += dt
        }
        yield t2
      }
    })())
  }

  if (want(2)) {
    if (engine.looped) lanes.push(tileLooped(2, 0.5))
    else {
      lanes.push((function* () {
        let t3 = 0.5
        while (t3 < seconds) {
          const st = stateAt(t3)
          const pool3 = [...pool(2, 'texture'), ...pool(2, 'harmonic')]
          const { event, dt } = genV3Step(pool3, st.voices[2], rngs[2], engine.tape, harmAt(t3))
          realize(event, t3)
          t3 += dt
          yield t3
        }
      })())
    }
  }

  if (want(NOISE_VOICE)) {
    const noise = await renderSurfaceNoise(sampleRate)
    const noiseSrc = ctx.createBufferSource()
    noiseSrc.buffer = noise
    noiseSrc.loop = true
    noiseSrc.connect(voiceGains[NOISE_VOICE])
    noiseSrc.start(0)
    noiseSrc.stop(seconds)
  }

  if (want(4)) {
    if (engine.looped) lanes.push(tileLooped(4, 0.3))
    else {
      lanes.push((function* () {
        let t5 = 0.3
        while (t5 < seconds) {
          const st = stateAt(t5)
          const pool5 = [...pool(4, 'transient'), ...pool(4, 'harmonic')]
          const { events, dt } = genV5Cell(pool5, st.voices[4], st.macros, st.scale, rngs[4], harmAt(t5), engine.fragK)
          for (const ev of events) if (t5 + ev.t < seconds) realize(ev, t5 + ev.t)
          t5 += dt
          yield t5
        }
      })())
    }
  }

  // voice 7 — melody: motif phrases (needs the chord clock)
  if (want(6) && harmProg) {
    if (engine.looped) lanes.push(tileLooped(6, 0.2))
    else {
      lanes.push((function* () {
        let t7 = 0.2
        let motif: Motif | null = null
        while (t7 < seconds) {
          const st = stateAt(t7)
          const harm = harmAt(t7)!
          const { events, dur, motif: m } = genV7Phrase(
            pool(6, 'harmonic'), st.voices[6] ?? voices[6], harm, st.bpm, rngs[6], motif,
          )
          motif = m
          for (const ev of events) if (t7 + ev.t < seconds) realize(ev, t7 + ev.t)
          t7 += dur
          yield t7
        }
      })())
    }
  }

  // voice 6 — sub pulse on the beat grid
  if (want(5)) lanes.push((function* () {
    let tb = 0.1
    while (tb < seconds) {
      const st = stateAt(tb)
      const v6 = st.voices[5] ?? voices[5]
      if (rngs[5]() < 0.15 + v6.density * 0.75) {
        let freq = 42 + v6.pitchRange * 28
        const chord = chordAtT(tb)
        if (chord) {
          const pc = rngs[5]() < 0.2 ? (chord.pcs[0] + 7) % 12 : chord.pcs[0]
          freq = 27.5 * Math.pow(2, pc / 12)
          if (freq < 36) freq *= 2
        }
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq * 1.6, tb)
        osc.frequency.exponentialRampToValueAtTime(freq, tb + 0.06)
        const env = ctx.createGain()
        env.gain.setValueAtTime(0, tb)
        env.gain.linearRampToValueAtTime(0.8, tb + 0.008)
        env.gain.exponentialRampToValueAtTime(0.001, tb + 0.4)
        osc.connect(env)
        env.connect(voiceGains[5])
        osc.start(tb)
        osc.stop(tb + 0.5)
      }
      tb += 60 / st.bpm
      yield tb
    }
  })())

  // V8 pings — FM chimes obeying the chord clock (full mix only, not stems)
  if (engine.pings > 0 && solo === null && soloBus === null) lanes.push((function* () {
    const rngP = mulberry32(seed + NUM_VOICES * 7919)
    const pingBus = ctx.createGain()
    pingBus.gain.value = 1
    pingBus.connect(voicesDry)
    const pingSendG = ctx.createGain()
    pingSendG.gain.value = engine.pings * 0.5
    pingSendG.connect(voicesSend)
    let tp = 0.5 + rngP() * 3
    while (tp < seconds) {
      const chord = chordAtT(tp)
      const pcs = chord ? chord.pcs : [0, 2, 4, 7, 9].map((d) => (d + engine.keyRoot) % 12)
      const pc = pcs[Math.floor(rngP() * pcs.length)]
      const mult = [1, 1, 2, 2, 4][Math.floor(rngP() * 5)]
      realizePing(
        ctx, pingBus, pingSendG, tp,
        261.63 * Math.pow(2, pc / 12) * mult, 0.35 + engine.pings * 0.4, rngP,
      )
      tp += (1.2 + rngP() * 6) / (0.35 + engine.pings)
      yield tp
    }
  })())

  // ambience beds: flagged sources loop continuously, heavily filtered
  const beds = engine.sources.filter((s) => s.bed)
  if (beds.length > 0 && want(NOISE_VOICE)) {
    const bedLP = ctx.createBiquadFilter()
    bedLP.type = 'lowpass'
    bedLP.frequency.value = 1100
    bedLP.Q.value = 0.5
    bedLP.connect(voiceGains[NOISE_VOICE])
    for (const bed of beds) {
      markUsed(engine.sources.indexOf(bed), 0, bed.buffer.duration)
      const src = ctx.createBufferSource()
      src.buffer = bed.buffer
      src.loop = true
      const g = ctx.createGain()
      g.gain.value = 0.35
      src.connect(g)
      g.connect(bedLP)
      src.start(0)
      src.stop(seconds)
    }
  }

  // dub gestures: seeded mixer moves across the timeline
  if (engine.dub) {
    const grng = mulberry32(seed + 777)
    let tg = 8
    while (tg < seconds - 4) {
      const r = grng()
      if (r < 0.4) {
        // delay throw
        delayWet.gain.setValueAtTime(delayWet.gain.value, tg)
        delayWet.gain.linearRampToValueAtTime(0.5, tg + 0.12)
        delayWet.gain.setValueAtTime(0.5, tg + 1.6)
        delayWet.gain.linearRampToValueAtTime(0.22, tg + 3)
      } else if (r < 0.7) {
        // filter drop
        warmth.frequency.setValueAtTime(warmth.frequency.value, tg)
        warmth.frequency.linearRampToValueAtTime(420, tg + 0.25)
        warmth.frequency.setValueAtTime(420, tg + 2 + grng() * 2)
        warmth.frequency.linearRampToValueAtTime(stateAt(tg).macros.tapeAging * -11500 + 16000, tg + 5)
      } else {
        // reverb splash
        const base = 0.15 + stateAt(tg).macros.decayFactor * 0.55
        revWet.gain.setValueAtTime(base, tg)
        revWet.gain.linearRampToValueAtTime(Math.min(1, base + 0.35), tg + 0.15)
        revWet.gain.setValueAtTime(Math.min(1, base + 0.35), tg + 2)
        revWet.gain.linearRampToValueAtTime(base, tg + 3.5)
      }
      tg += 7 + grng() * 16
    }
  }

  // tape wear: dropout holes + wow dips
  if (engine.tape) {
    const trng = mulberry32(seed + 555)
    let tt = 6
    while (tt < seconds - 2) {
      if (trng() < 0.55) {
        const hole = 0.03 + trng() * 0.1
        holeGain.gain.setValueAtTime(1, tt)
        holeGain.gain.linearRampToValueAtTime(0.06, tt + 0.012)
        holeGain.gain.setValueAtTime(0.06, tt + hole)
        holeGain.gain.linearRampToValueAtTime(1, tt + hole + 0.02)
      } else {
        const deep = 0.008
        lfoGain.gain.setValueAtTime(lfoGain.gain.value, tt)
        lfoGain.gain.linearRampToValueAtTime(deep, tt + 0.3)
        lfoGain.gain.linearRampToValueAtTime(0.0005 + stateAt(tt).macros.tapeAging * 0.004, tt + 1.8)
      }
      tt += 5 + trng() * 11
    }
  }

  // ---------- windowed scheduling driven by render suspends ----------
  // MEMORY WEAVE: media surfaces and the memory layers (full mix only)
  if (solo === null && !loopSec) {
    const bus = (k: MixBus) => {
      const dry = ctx.createGain()
      dry.gain.value = soloBus === null || soloBus === k ? engine.mix[k] : 0
      dry.connect(input)
      const send = ctx.createGain()
      send.gain.value = dry.gain.value
      send.connect(revSend)
      return { dry, send }
    }
    const buses = { clouds: bus('clouds'), melody: bus('melody'), ghosts: bus('ghosts'), loop: bus('loop'), kin: bus('kin') }
    const eras = engine.sources.filter((x) => !x.bed).map((x) => x.era ?? 'none')
    if (soloBus === null || soloBus === 'surface') startEraSurfaces(ctx, bus('surface').dry, eras, 0, seed)
    if (layersOn) {
      const form = isMemoryForm(engine)
      lanes.push(...memoryLanes({
        ctx,
        buses,
        start: 0,
        end: seconds,
        seed,
        params: ml,
        keyRoot: engine.keyRoot,
        slices: engine.slices,
        sources: engine.sources,
        chordAt: chordAtT,
        sectionAt: (w) => (form ? sectionIndexAt(engine.songSections, w) : -1),
        sectionSpan: (w) => (form ? sectionSpanAt(engine.songSections, w) : null),
        formPos: (w) => (form ? { t: w, total: engine.songSections.reduce((n, x) => n + x.sec, 0) } : null),
        markUsed,
      }))
    }
  }

  const laneT = lanes.map(() => 0)
  const laneDone = lanes.map(() => false)
  const fillUntil = (limit: number) => {
    for (let i = 0; i < lanes.length; i++) {
      // guard against a generator that stops advancing time
      let guard = 0
      while (!laneDone[i] && laneT[i] < limit && guard++ < 100000) {
        const r = lanes[i].next()
        if (r.done) laneDone[i] = true
        else laneT[i] = Math.max(laneT[i], r.value)
      }
    }
  }
  const progress = opts.onProgress
  const signal = opts.signal
  // 5s chunks: cheap suspend round-trips, and a STOP lands within one chunk
  const STEP = 5
  const AHEAD = 8
  fillUntil(AHEAD)
  const armSuspend = (at: number) => {
    if (at >= seconds - 0.5) return
    ctx.suspend(at).then(() => {
      if (signal?.aborted) {
        // cancelled: leave the context suspended forever (no more CPU spent
        // on reverb/LFO tails), cut the output, let GC take it
        holeGain.disconnect()
        return
      }
      fillUntil(at + AHEAD)
      progress?.((at / seconds) * RENDER_SHARE)
      armSuspend(at + STEP)
      void ctx.resume()
    }, () => void ctx.resume())
  }
  armSuspend(STEP)

  const rendered = await abortable(ctx.startRendering(), signal)
  progress?.(RENDER_SHARE)

  // parallel sub-octave layer: granular −12st resample of the finished master,
  // mixed back in (mirrors the live Tone.PitchShift bus)
  if (engine.sub > 0.01) {
    await addSubOctave(rendered, engine.sub, signal, (f) => progress?.(RENDER_SHARE + f * (1 - RENDER_SHARE)))
  }
  throwIfAborted(signal)
  progress?.(1)

  let L: Float32Array
  let R: Float32Array
  if (loopSec) {
    // fold the tail back onto the start so reverb/delay wrap seamlessly
    const loopLen = Math.floor(loopSec * sampleRate)
    L = new Float32Array(loopLen)
    R = new Float32Array(loopLen)
    for (let ch = 0; ch < 2; ch++) {
      const src = rendered.getChannelData(ch)
      const dst = ch === 0 ? L : R
      for (let i = 0; i < loopLen; i++) dst[i] = src[i]
      for (let i = loopLen; i < src.length && i - loopLen < loopLen; i++) {
        dst[i - loopLen] += src[i]
      }
    }
  } else {
    L = rendered.getChannelData(0)
    R = rendered.getChannelData(1)
  }

  // merge overlapping / near-touching stretches (≤0.25s apart)
  const usage: SourceUsage[] = [...used.entries()]
    .filter(([i]) => i >= 0 && engine.sources[i])
    .map(([i, u]) => {
      const sorted = u.ranges.sort((a, b) => a[0] - b[0])
      const merged: Array<[number, number]> = []
      for (const [a, b] of sorted) {
        const last = merged[merged.length - 1]
        if (last && a <= last[1] + 0.25) last[1] = Math.max(last[1], b)
        else merged.push([a, b])
      }
      return { sourceIdx: i, name: engine.sources[i].name, events: u.events, ranges: merged }
    })
    .sort((a, b) => b.events - a.events)

  return { L, R, sampleRate, usage }
}

/** True for the error a cancelled render rejects with. */
export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError')
}

/** Reject as soon as `signal` aborts, without waiting for `p`. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Render cancelled', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Loudness pass + WAV encode. Measures integrated LUFS (BS.1770-4); with a
 * target, applies gain and a true-peak-safe limiter, then re-measures.
 */
export async function finishMaster(
  L: Float32Array,
  R: Float32Array,
  sampleRate: number,
  master?: MasterOpts,
  signal?: AbortSignal,
  format?: WavFormat,
): Promise<Blob> {
  throwIfAborted(signal)
  const { wav, crc, before, after } = await masterAsync(
    L, R, sampleRate, master?.targetLufs ?? null, master?.ceilingDb ?? -1, signal, format, master?.chain,
  )
  master?.onReport?.({ before, after, crc })
  return wav
}

/** Per-voice stems: N deterministic renders sharing the same seed streams.
 * Stems are never loudness-normalized (they must sum like the mix). */
export async function renderStems(
  engine: AudioEngine,
  minutes: number,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<Blob[]> {
  const stems: Blob[] = []
  // memory-layer buses that actually sound get their own stems too
  const buses = stemBuses(engine)
  const total = NUM_VOICES + buses.length
  for (let v = 0; v < NUM_VOICES; v++) {
    stems.push(await renderOffline(engine, minutes, {
      soloVoice: v,
      signal,
      onProgress: (f) => onProgress?.((v + f) / total),
    }))
  }
  for (let b = 0; b < buses.length; b++) {
    stems.push(await renderOffline(engine, minutes, {
      soloBus: buses[b],
      signal,
      onProgress: (f) => onProgress?.((NUM_VOICES + b + f) / total),
    }))
  }
  return stems
}

/** Which MIX buses get a stem: the memory layers in use, and the eras' surface. */
export function stemBuses(engine: AudioEngine): MixBus[] {
  const ml = engine.memLayers
  const out: MixBus[] = []
  if (ml.stretch > 0.02) out.push('clouds')
  if (ml.motif > 0.02 || (ml.lines ?? 0) > 0.02) out.push('melody')
  if (ml.ghosts > 0.02) out.push('ghosts')
  if ((ml.loop ?? 0) > 0.02) out.push('loop')
  if ((ml.kin?.amt ?? 0) > 0.02) out.push('kin')
  if (engine.sources.some((x) => !x.bed && x.era && x.era !== 'none')) out.push('surface')
  return out
}

/** Only the layer behind one bus (surface: none — it is the eras' noise). */
function soloLayers(ml: MemoryLayerParams, bus: MixBus): MemoryLayerParams {
  const only: Partial<MemoryLayerParams> =
    bus === 'clouds' ? { stretch: ml.stretch } : bus === 'melody' ? { motif: ml.motif, lines: ml.lines }
      : bus === 'ghosts' ? { ghosts: ml.ghosts } : bus === 'loop' ? { loop: ml.loop } : bus === 'kin' ? { kin: ml.kin } : {}
  return { ...LAYERS_OFF, motifSeed: ml.motifSeed, ...only }
}

/** Granular octaver: overlapped 120ms grains read at half rate, position-synced. */
/**
 * Sub-octave, in place: overlapping 120 ms grains (hop 60 ms, triangular
 * windows that sum to 1) each read at half speed from where they start —
 * one octave down, no time stretch — then low-passed at 2.5 kHz and mixed
 * in at `amount`. A plain O(n) loop in ~2 s chunks with a yield between.
 *
 * (It used to be a second OfflineAudioContext with one source node per
 * grain — ~2 000 nodes for 2 minutes, ~10 000 for ten — whose cost grew with
 * nodes × length: long renders stalled at the end and never finished.)
 */
async function addSubOctave(buf: AudioBuffer, amount: number, signal?: AbortSignal, onProgress?: (f: number) => void) {
  const sr = buf.sampleRate
  const n = buf.length
  const G = Math.round(0.12 * sr) // grain
  const H = G >> 1 // hop: two grains overlap everywhere
  // RBJ low-pass, 2.5 kHz, Q 0.707
  const w0 = (2 * Math.PI * 2500) / sr
  const al = Math.sin(w0) / (2 * Math.SQRT1_2)
  const cw = Math.cos(w0)
  const a0 = 1 + al
  const b0 = (1 - cw) / 2 / a0
  const b1 = (1 - cw) / a0
  const b2 = b0
  const a1 = (-2 * cw) / a0
  const a2 = (1 - al) / a0
  const CHUNK = sr * 2
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const x = buf.getChannelData(ch)
    const dry = new Float32Array(x) // read from the untouched signal
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let c0 = 0; c0 < n; c0 += CHUNK) {
      const c1 = Math.min(n, c0 + CHUNK)
      for (let i = c0; i < c1; i++) {
        // the two grains covering sample i start at g0 (current hop) and g0 − H
        const g0 = i - (i % H)
        let v = 0
        for (const g of [g0, g0 - H]) {
          if (g < 0) continue
          const k = i - g // 0 … G−1 within the grain
          if (k >= G) continue
          const w = k < H ? k / H : (G - k) / H // triangle: up over the first half, down over the second
          const pos = g + k * 0.5 // half speed from the grain's own start
          const j = pos | 0
          const fr = pos - j
          const s0 = dry[j] ?? 0
          const s1 = dry[j + 1] ?? s0
          v += w * (s0 + (s1 - s0) * fr)
        }
        const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1; x1 = v; y2 = y1; y1 = y
        x[i] = dry[i] + amount * y
      }
      onProgress?.((ch + c1 / n) / buf.numberOfChannels)
      throwIfAborted(signal)
      await new Promise<void>((r) => setTimeout(r, 0))
    }
  }
}

function makeImpulse(ctx: OfflineAudioContext, decay: number, sampleRate: number): AudioBuffer {
  const len = Math.ceil(decay * sampleRate)
  const buf = ctx.createBuffer(2, len, sampleRate)
  const rng = mulberry32(909)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let lp = 0
    for (let i = 0; i < len; i++) {
      const w = rng() * 2 - 1
      lp = lp * 0.7 + w * 0.3
      d[i] = lp * Math.pow(1 - i / len, 2.2)
    }
  }
  return buf
}
