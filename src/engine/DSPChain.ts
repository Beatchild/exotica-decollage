import * as Tone from 'tone'

/**
 * Master signal chain:
 * voices → input → varispeed flutter (LFO-modulated delay line) →
 * telephony bandpass (crossfaded bypass) → saturation → bitcrusher (wet) →
 * asymmetric tape delay (380ms L / 540ms R, 45% fb, HF roll-off) →
 * plate-style convolution reverb (wet) → warmth lowpass → limiter → out.
 * A separate reverbSend input lets voices reach the reverb pre-chain.
 */
export class DSPChain {
  readonly input: Tone.Gain
  readonly reverbSend: Tone.Gain
  /** post-limiter tap for analysis + recording */
  readonly output: Tone.Gain

  private flutterDelay: Tone.Delay
  private flutterLFO: Tone.LFO
  /** noise-derived flutter jitter on top of the slow wow */
  private flutterNoise: Tone.Noise
  private flutterNoiseLP: Tone.Filter
  private flutter2Gain: Tone.Gain
  private telephonyFilter: Tone.Filter
  private telephonyFade: Tone.CrossFade
  private saturation: Tone.Distortion
  private crusher: Tone.BitCrusher
  private delayL: Tone.FeedbackDelay
  private delayR: Tone.FeedbackDelay
  private delayRoll: Tone.Filter
  private delayWetGain: Tone.Gain
  private reverb: Tone.Reverb
  private warmth: Tone.Filter
  private chorus: Tone.Chorus
  private muffle: Tone.Filter
  private rumbleHP: Tone.Filter
  private asym: WaveShaperNode | null = null
  private gentleComp: Tone.Compressor
  private voicingHP: Tone.Filter
  private voicingBell: Tone.Filter
  private voicingLP: Tone.Filter
  private revDamp: Tone.Filter
  private subShift: Tone.PitchShift
  private subGain: Tone.Gain
  private widener: Tone.StereoWidener
  private tiltLow: Tone.Filter
  private tiltHigh: Tone.Filter
  private limiter: Tone.Limiter
  private baseWarmth = 16000
  private baseWidth = 0.5
  private baseDelayWet = 0.22
  private aqua = 0
  private flutterBase = 0.002

  constructor() {
    this.input = new Tone.Gain(1)
    this.reverbSend = new Tone.Gain(1)
    this.output = new Tone.Gain(1)

    // --- varispeed tape drift: dual modulators on a short delay line
    // wow: slow sine 0.3–0.8Hz (deep); flutter: 4–8Hz jitter (shallow)
    this.flutterDelay = new Tone.Delay({ delayTime: 0.02, maxDelay: 0.06 })
    this.flutterLFO = new Tone.LFO({ frequency: 0.4, min: 0.017, max: 0.023 })
    this.flutterLFO.connect(this.flutterDelay.delayTime)
    this.flutterLFO.start()
    // noise-derived flutter: white noise band-limited to ~5–15Hz drives the
    // read-head jitter — irregular like a real transport, not a clean LFO
    this.flutterNoise = new Tone.Noise('white').start()
    this.flutterNoiseLP = new Tone.Filter({ type: 'lowpass', frequency: 12, Q: 0.7 })
    this.flutter2Gain = new Tone.Gain(0.0009)
    this.flutterNoise.connect(this.flutterNoiseLP)
    this.flutterNoiseLP.connect(this.flutter2Gain)
    this.flutter2Gain.connect(this.flutterDelay.delayTime)

    // --- telephony bandpass, switchable via crossfade
    this.telephonyFilter = new Tone.Filter({
      type: 'bandpass',
      frequency: 1100,
      Q: 0.9,
    })
    this.telephonyFade = new Tone.CrossFade(0) // 0 = clean, 1 = filtered

    // --- warm saturation + optional bit reduction
    this.saturation = new Tone.Distortion({ distortion: 0.18, oversample: '2x', wet: 0.6 })
    this.crusher = new Tone.BitCrusher(12)
    this.crusher.wet.value = 0

    // --- asymmetric ping-pong-ish tape delay
    this.delayL = new Tone.FeedbackDelay({ delayTime: 0.38, feedback: 0.45, wet: 1 })
    this.delayR = new Tone.FeedbackDelay({ delayTime: 0.54, feedback: 0.45, wet: 1 })
    // BBD character: true lowpass darkening in the repeats, not just a shelf
    this.delayRoll = new Tone.Filter({ type: 'lowpass', frequency: 3000, Q: 0.6 })
    this.delayWetGain = new Tone.Gain(0.22)

    // --- reverb (long chamber, or short dark plate with 3.5kHz damping)
    this.revDamp = new Tone.Filter({ type: 'lowpass', frequency: 20000, Q: 0.5 })
    this.reverb = new Tone.Reverb({ decay: 4.5, preDelay: 0.03, wet: 0.35 })

    // --- final warmth + vintage voicing + aquatic modulation + image/tone shaping
    this.warmth = new Tone.Filter({ type: 'lowpass', frequency: 16000, Q: 0.4 })
    // vintage conditioning: 12dB/oct HP + resonant bell + 24dB/oct LP (neutral when off)
    this.voicingHP = new Tone.Filter({ type: 'highpass', frequency: 5, rolloff: -12, Q: 0.7 })
    this.voicingBell = new Tone.Filter({ type: 'peaking', frequency: 1200, Q: 1.4, gain: 0 })
    this.voicingLP = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -24, Q: 0.7 })
    this.chorus = new Tone.Chorus({ frequency: 0.35, delayTime: 4.5, depth: 0.55, wet: 0 }).start()
    this.muffle = new Tone.Filter({ type: 'lowpass', frequency: 20000, Q: 0.7 })
    // parallel sub-octave layer: the mix pitched −12st and blended back in
    this.subShift = new Tone.PitchShift({ pitch: -12, windowSize: 0.1, wet: 1 })
    this.subGain = new Tone.Gain(0)
    this.widener = new Tone.StereoWidener(0.5) // 0 = mono, 0.5 = unchanged, 1 = wide
    this.tiltLow = new Tone.Filter({ type: 'lowshelf', frequency: 400, gain: 0 })
    this.tiltHigh = new Tone.Filter({ type: 'highshelf', frequency: 2500, gain: 0 })
    this.rumbleHP = new Tone.Filter({ type: 'highpass', frequency: 30, Q: 0.7 })
    // gentle glue instead of harsh brickwalling; limiter stays only as safety
    this.gentleComp = new Tone.Compressor({ threshold: -14, ratio: 2.5, attack: 0.012, release: 0.25 })
    this.limiter = new Tone.Limiter(-0.5)

    // asymmetric soft-clip: y = tanh(d(x+b)) − tanh(db) — the DC-bias b bends
    // the curve so even (2nd-order) harmonics join the odd ones
    const rawCtx = Tone.getContext().rawContext as AudioContext
    this.asym = rawCtx.createWaveShaper()
    const asymCurve = new Float32Array(2048)
    const bias = 0.14
    const drive = 1.4
    for (let i = 0; i < asymCurve.length; i++) {
      const x = (i / (asymCurve.length / 2 - 0.5)) - 1
      asymCurve[i] = Math.tanh(drive * (x + bias)) - Math.tanh(drive * bias)
    }
    this.asym.curve = asymCurve
    this.asym.oversample = '2x'

    // dry path (+ parallel sub-octave resample layer joining before the tape stage)
    this.input.connect(this.flutterDelay)
    this.input.connect(this.subShift)
    this.subShift.connect(this.subGain)
    this.subGain.connect(this.flutterDelay)
    this.flutterDelay.connect(this.telephonyFade.a)
    this.flutterDelay.connect(this.telephonyFilter)
    this.telephonyFilter.connect(this.telephonyFade.b)
    this.telephonyFade.connect(this.saturation)
    Tone.connect(this.saturation, this.asym)
    Tone.connect(this.asym, this.crusher)

    // delay as parallel wet bus after the crusher
    const panL = new Tone.Panner(-0.75)
    const panR = new Tone.Panner(0.75)
    this.crusher.connect(this.delayL)
    this.crusher.connect(this.delayR)
    this.delayL.connect(panL)
    this.delayR.connect(panR)
    panL.connect(this.delayRoll)
    panR.connect(this.delayRoll)
    this.delayRoll.connect(this.delayWetGain)

    this.crusher.connect(this.revDamp)
    this.delayWetGain.connect(this.revDamp)
    this.reverbSend.connect(this.revDamp)
    this.revDamp.connect(this.reverb)

    this.reverb.connect(this.warmth)
    this.warmth.connect(this.voicingHP)
    this.voicingHP.connect(this.voicingBell)
    this.voicingBell.connect(this.voicingLP)
    this.voicingLP.connect(this.chorus)
    this.chorus.connect(this.muffle)
    this.muffle.connect(this.widener)
    this.widener.connect(this.tiltLow)
    this.tiltLow.connect(this.tiltHigh)
    this.tiltHigh.connect(this.rumbleHP)
    this.rumbleHP.connect(this.gentleComp)
    this.gentleComp.connect(this.limiter)
    this.limiter.connect(this.output)
    this.output.toDestination()
  }

  /** Stereo image: 0 = mono, 0.5 = as recorded, 1 = extra wide. */
  setWidth(v: number) {
    this.baseWidth = Math.min(1, Math.max(0, v))
    this.applyWidth()
  }

  /** Spectral tilt: -1 = dark (bass up / top down), +1 = bright. ±6dB shelves. */
  setTilt(v: number) {
    const t = Math.min(1, Math.max(-1, v))
    this.tiltLow.gain.rampTo(-t * 6, 0.1)
    this.tiltHigh.gain.rampTo(t * 6, 0.1)
  }

  /** Decay Factor macro: reverb wetness + decay time (grain length lives in the engine). */
  setDecayFactor(v: number) {
    this.reverb.wet.rampTo(0.15 + v * 0.55, 0.2)
  }

  /** Tape Aging macro: flutter depth/rate + top-end warmth (hiss handled by Voice 4). */
  setTapeAging(v: number) {
    const depth = 0.0005 + v * 0.004
    this.flutterBase = depth
    this.flutterLFO.min = 0.02 - depth
    this.flutterLFO.max = 0.02 + depth
    this.flutterLFO.frequency.rampTo(0.3 + v * 1.5, 0.2)
    this.baseWarmth = 16000 - v * 11500
    this.warmth.frequency.rampTo(this.baseWarmth, 0.3)
    this.saturation.wet.rampTo(0.3 + v * 0.6, 0.2)
  }

  /** Vintage voicing: HP 320Hz (12dB/oct) + bell +2.5dB@1.2kHz + LP 5.5kHz (24dB/oct). */
  setVoicing(on: boolean) {
    this.voicingHP.frequency.rampTo(on ? 320 : 5, 0.2)
    this.voicingBell.gain.rampTo(on ? 2.5 : 0, 0.2)
    this.voicingLP.frequency.rampTo(on ? 5500 : 20000, 0.2)
  }

  /** Short dark plate: 1.7s decay, damped above 3.5kHz (vs the long chamber). */
  setPlateShort(on: boolean) {
    this.reverb.decay = on ? 1.7 : 4.5
    this.revDamp.frequency.rampTo(on ? 3500 : 20000, 0.2)
  }

  /** Parallel sub-octave layer amount (0–0.5). */
  setSub(v: number) {
    this.subGain.gain.rampTo(Math.min(0.5, Math.max(0, v)), 0.15)
  }

  /** AQUA: submerged chorus wobble + steep muffle + narrowed image (Poirier). */
  setAqua(v: number) {
    this.aqua = Math.min(1, Math.max(0, v))
    this.chorus.wet.rampTo(this.aqua * 0.65, 0.2)
    this.chorus.depth = 0.2 + this.aqua * 0.6
    // log sweep 20kHz → 900Hz
    this.muffle.frequency.rampTo(20000 * Math.pow(900 / 20000, this.aqua), 0.3)
    this.applyWidth()
  }

  private applyWidth() {
    const eff = this.baseWidth * (1 - this.aqua * 0.45)
    this.widener.width.rampTo(Math.min(1, Math.max(0, eff)), 0.1)
  }

  // ---------- dub / tape gestures ----------

  /** Dub delay-throw: feedback and wet surge, then decay back. */
  throwDelay(sec = 2) {
    this.delayWetGain.gain.rampTo(0.5, 0.1)
    this.delayL.feedback.rampTo(0.72, 0.1)
    this.delayR.feedback.rampTo(0.72, 0.1)
    setTimeout(() => {
      this.delayWetGain.gain.rampTo(this.baseDelayWet, 1.2)
      this.delayL.feedback.rampTo(0.45, 0.8)
      this.delayR.feedback.rampTo(0.45, 0.8)
    }, sec * 1000)
  }

  /** Dub filter-drop: master lowpass dives, then reopens. */
  filterDrop(sec = 3) {
    this.warmth.frequency.rampTo(420, 0.25)
    setTimeout(() => this.warmth.frequency.rampTo(this.baseWarmth, sec * 0.5), sec * 1000)
  }

  /** Dub reverb splash: wet surge. */
  splash(sec = 2.5) {
    const base = this.reverb.wet.value
    this.reverb.wet.rampTo(Math.min(1, base + 0.35), 0.15)
    setTimeout(() => this.reverb.wet.rampTo(base, 1.5), sec * 1000)
  }

  /** Tape wow dip: flutter depth surges — a drunken pitch sag. */
  wowDip(sec = 1.5) {
    const deep = Math.min(0.012, this.flutterBase * 6)
    this.flutterLFO.min = 0.02 - deep
    this.flutterLFO.max = 0.02 + deep
    setTimeout(() => {
      this.flutterLFO.min = 0.02 - this.flutterBase
      this.flutterLFO.max = 0.02 + this.flutterBase
    }, sec * 1000)
  }

  setTelephony(on: boolean) {
    this.telephonyFade.fade.rampTo(on ? 1 : 0, 0.15)
  }

  setTelephonyFreq(hz: number) {
    this.telephonyFilter.frequency.rampTo(Math.min(3800, Math.max(250, hz)), 0.1)
  }

  setTelephonyQ(q: number) {
    this.telephonyFilter.Q.rampTo(q, 0.1)
  }

  setCrush(on: boolean, bits: 12 | 14 = 12) {
    this.crusher.bits.value = bits
    this.crusher.wet.rampTo(on ? 0.5 : 0, 0.15)
  }

  setDelayWet(v: number) {
    this.baseDelayWet = v * 0.5
    this.delayWetGain.gain.rampTo(this.baseDelayWet, 0.15)
  }

  dispose() {
    for (const n of [
      this.input, this.reverbSend, this.output, this.flutterDelay, this.flutterLFO,
      this.telephonyFilter, this.telephonyFade, this.saturation, this.crusher,
      this.delayL, this.delayR, this.delayRoll, this.delayWetGain, this.reverb,
      this.warmth, this.chorus, this.muffle, this.widener, this.tiltLow, this.tiltHigh,
      this.limiter, this.rumbleHP, this.gentleComp, this.flutterNoise, this.flutterNoiseLP, this.flutter2Gain, this.voicingHP, this.voicingBell,
      this.voicingLP, this.revDamp, this.subShift, this.subGain,
    ]) n.dispose()
  }
}
