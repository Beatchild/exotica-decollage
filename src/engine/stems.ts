/**
 * Bundled source material. Rather than shipping sampled recordings (rights
 * risk, payload weight), four vintage lounge / easy-listening stems are
 * synthesized offline at load time — warm e-piano chords, plucked bass with
 * brushes, a detuned string pad, and an exotica percussion bed. Deterministic
 * via a seeded PRNG so slicing results are stable between sessions.
 */

import { mulberry32 } from './rng'

export interface StemDef {
  key: string
  name: string
  render: (sampleRate: number) => Promise<AudioBuffer>
}

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

function ctxFor(seconds: number, sampleRate: number) {
  return new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate)
}

/** Shared: soft saturation + gentle lowpass master for a "vintage" print. */
function master(ctx: OfflineAudioContext, cutoff = 7500): AudioNode {
  const shaper = ctx.createWaveShaper()
  const curve = new Float32Array(1024)
  for (let i = 0; i < 1024; i++) {
    const x = (i / 511.5) - 1
    curve[i] = Math.tanh(1.5 * x)
  }
  shaper.curve = curve
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = cutoff
  lp.Q.value = 0.5
  shaper.connect(lp)
  lp.connect(ctx.destination)
  return shaper
}

/** FM e-piano voice with percussive envelope. */
function epNote(
  ctx: OfflineAudioContext,
  out: AudioNode,
  freq: number,
  t: number,
  dur: number,
  vel: number,
  pan: number,
) {
  const carrier = ctx.createOscillator()
  carrier.type = 'sine'
  carrier.frequency.value = freq
  const mod = ctx.createOscillator()
  mod.type = 'sine'
  mod.frequency.value = freq * 14
  const modGain = ctx.createGain()
  modGain.gain.setValueAtTime(freq * 1.6 * vel, t)
  modGain.gain.exponentialRampToValueAtTime(freq * 0.02, t + dur * 0.5)
  mod.connect(modGain)
  modGain.connect(carrier.frequency)
  const env = ctx.createGain()
  env.gain.setValueAtTime(0, t)
  env.gain.linearRampToValueAtTime(vel * 0.5, t + 0.008)
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  const p = ctx.createStereoPanner()
  p.pan.value = pan
  carrier.connect(env)
  env.connect(p)
  p.connect(out)
  carrier.start(t)
  carrier.stop(t + dur + 0.05)
  mod.start(t)
  mod.stop(t + dur + 0.05)
}

async function renderEPiano(sampleRate: number): Promise<AudioBuffer> {
  const dur = 16
  const ctx = ctxFor(dur, sampleRate)
  const out = master(ctx, 6500)
  const rnd = mulberry32(101)
  // Cmaj9 → Am11 → Fmaj7 → G13-ish voicings
  const chords = [
    [48, 55, 59, 62, 67],
    [45, 52, 57, 60, 67],
    [41, 48, 57, 60, 64],
    [43, 50, 59, 64, 65],
  ]
  let t = 0.2
  let ci = 0
  while (t < dur - 2.5) {
    const chord = chords[ci % chords.length]
    for (const m of chord) {
      const strum = rnd() * 0.09
      epNote(ctx, out, midiHz(m), t + strum, 2.4 + rnd() * 1.4, 0.35 + rnd() * 0.3, (rnd() - 0.5) * 1.2)
    }
    // sparse melodic answer
    if (rnd() > 0.4) {
      const m = chord[Math.floor(rnd() * chord.length)] + 12
      epNote(ctx, out, midiHz(m), t + 1.4 + rnd() * 0.8, 1.0 + rnd(), 0.25, (rnd() - 0.5))
    }
    t += 3.4 + rnd() * 0.6
    ci++
  }
  return ctx.startRendering()
}

async function renderBassBrush(sampleRate: number): Promise<AudioBuffer> {
  const dur = 14
  const ctx = ctxFor(dur, sampleRate)
  const out = master(ctx, 5000)
  const rnd = mulberry32(202)
  const walk = [36, 43, 41, 40, 38, 45, 43, 36]
  let t = 0.15
  let i = 0
  while (t < dur - 1.2) {
    // plucked upright-ish bass: triangle with fast lowpassed decay
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = midiHz(walk[i % walk.length])
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(900, t)
    lp.frequency.exponentialRampToValueAtTime(150, t + 0.5)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, t)
    env.gain.linearRampToValueAtTime(0.55, t + 0.01)
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.9 + rnd() * 0.3)
    osc.connect(lp)
    lp.connect(env)
    env.connect(out)
    osc.start(t)
    osc.stop(t + 1.4)

    // brush hit: bandpassed noise burst on the offbeat
    const nLen = 0.18 + rnd() * 0.12
    const nBuf = ctx.createBuffer(1, Math.ceil(nLen * sampleRate), sampleRate)
    const nd = nBuf.getChannelData(0)
    for (let k = 0; k < nd.length; k++) nd[k] = (rnd() * 2 - 1) * (1 - k / nd.length) ** 2
    const nSrc = ctx.createBufferSource()
    nSrc.buffer = nBuf
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 3500 + rnd() * 2500
    bp.Q.value = 0.8
    const nGain = ctx.createGain()
    nGain.gain.value = 0.16
    const np = ctx.createStereoPanner()
    np.pan.value = (rnd() - 0.5) * 1.4
    nSrc.connect(bp)
    bp.connect(nGain)
    nGain.connect(np)
    np.connect(out)
    nSrc.start(t + 0.42 + rnd() * 0.1)

    t += 0.85 + rnd() * 0.25
    i++
  }
  return ctx.startRendering()
}

async function renderStringPad(sampleRate: number): Promise<AudioBuffer> {
  const dur = 15
  const ctx = ctxFor(dur, sampleRate)
  const out = master(ctx, 4800)
  const rnd = mulberry32(303)
  const chords = [
    [53, 60, 64, 69],
    [50, 57, 65, 69],
    [48, 55, 64, 67],
  ]
  let t = 0.1
  let ci = 0
  while (t < dur - 4) {
    const chord = chords[ci % chords.length]
    const hold = 4.2 + rnd() * 1.4
    for (const m of chord) {
      for (const det of [-7, 4]) {
        const osc = ctx.createOscillator()
        osc.type = 'sawtooth'
        osc.frequency.value = midiHz(m)
        osc.detune.value = det + (rnd() - 0.5) * 6
        // slow vibrato
        const vib = ctx.createOscillator()
        vib.frequency.value = 4.5 + rnd()
        const vibGain = ctx.createGain()
        vibGain.gain.value = 3.5
        vib.connect(vibGain)
        vibGain.connect(osc.detune)
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = 1600
        const env = ctx.createGain()
        env.gain.setValueAtTime(0, t)
        env.gain.linearRampToValueAtTime(0.06, t + 1.2)
        env.gain.setValueAtTime(0.06, t + hold - 1.5)
        env.gain.linearRampToValueAtTime(0, t + hold)
        const p = ctx.createStereoPanner()
        p.pan.value = (rnd() - 0.5) * 1.2
        osc.connect(lp)
        lp.connect(env)
        env.connect(p)
        p.connect(out)
        osc.start(t)
        osc.stop(t + hold + 0.1)
        vib.start(t)
        vib.stop(t + hold + 0.1)
      }
    }
    t += hold - 0.8
    ci++
  }
  return ctx.startRendering()
}

async function renderExoticaPerc(sampleRate: number): Promise<AudioBuffer> {
  const dur = 13
  const ctx = ctxFor(dur, sampleRate)
  const out = master(ctx, 8000)
  const rnd = mulberry32(404)
  let t = 0.1
  while (t < dur - 1.5) {
    const kind = rnd()
    if (kind < 0.35) {
      // woodblock / claves: high sine ping
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = 800 + rnd() * 1400
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.4, t)
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
      const p = ctx.createStereoPanner()
      p.pan.value = (rnd() - 0.5) * 1.6
      osc.connect(env)
      env.connect(p)
      p.connect(out)
      osc.start(t)
      osc.stop(t + 0.15)
    } else if (kind < 0.6) {
      // shaker: short highpassed noise
      const len = 0.1 + rnd() * 0.08
      const buf = ctx.createBuffer(1, Math.ceil(len * sampleRate), sampleRate)
      const d = buf.getChannelData(0)
      for (let k = 0; k < d.length; k++) d[k] = (rnd() * 2 - 1) * Math.sin((Math.PI * k) / d.length)
      const src = ctx.createBufferSource()
      src.buffer = buf
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 6000
      const g = ctx.createGain()
      g.gain.value = 0.3
      src.connect(hp)
      hp.connect(g)
      g.connect(out)
      src.start(t)
    } else if (kind < 0.8) {
      // cymbal wash: long bandpassed noise swell
      const len = 1.6 + rnd() * 1.2
      const buf = ctx.createBuffer(1, Math.ceil(len * sampleRate), sampleRate)
      const d = buf.getChannelData(0)
      for (let k = 0; k < d.length; k++) d[k] = (rnd() * 2 - 1) * (1 - k / d.length) ** 1.5
      const src = ctx.createBufferSource()
      src.buffer = buf
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 7000 + rnd() * 3000
      bp.Q.value = 1.2
      const g = ctx.createGain()
      g.gain.value = 0.22
      const p = ctx.createStereoPanner()
      p.pan.value = (rnd() - 0.5)
      src.connect(bp)
      bp.connect(g)
      g.connect(p)
      p.connect(out)
      src.start(t)
    } else {
      // low conga-ish tom: pitched sine drop
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      const f0 = 140 + rnd() * 80
      osc.frequency.setValueAtTime(f0 * 1.4, t)
      osc.frequency.exponentialRampToValueAtTime(f0, t + 0.08)
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.5, t)
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.4)
      const p = ctx.createStereoPanner()
      p.pan.value = (rnd() - 0.5) * 0.8
      osc.connect(env)
      env.connect(p)
      p.connect(out)
      osc.start(t)
      osc.stop(t + 0.5)
    }
    t += 0.22 + rnd() * 0.55
  }
  return ctx.startRendering()
}

export const BUNDLED_STEMS: StemDef[] = [
  { key: 'epiano', name: 'Verdigris Lounge — E-Piano', render: renderEPiano },
  { key: 'bass', name: 'Harbour Lights — Bass & Brush', render: renderBassBrush },
  { key: 'strings', name: 'Motel Panorama — String Pad', render: renderStringPad },
  { key: 'perc', name: 'Terrazzo — Exotica Percussion', render: renderExoticaPerc },
]

/** Continuous surface-noise loop for Voice 4: crackle + hum + hiss + pops. */
export async function renderSurfaceNoise(sampleRate: number): Promise<AudioBuffer> {
  const dur = 8
  const ctx = ctxFor(dur, sampleRate)
  const rnd = mulberry32(505)

  // tape hiss bed
  const hissBuf = ctx.createBuffer(2, Math.ceil(dur * sampleRate), sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = hissBuf.getChannelData(ch)
    let lp = 0
    for (let k = 0; k < d.length; k++) {
      const w = rnd() * 2 - 1
      lp = lp * 0.96 + w * 0.04 // pinken slightly
      d[k] = w * 0.012 + lp * 0.02
    }
  }
  const hiss = ctx.createBufferSource()
  hiss.buffer = hissBuf
  hiss.connect(ctx.destination)
  hiss.start(0)

  // ground hum: 50Hz + weak 100/150Hz harmonics
  for (const [f, g] of [[50, 0.006], [100, 0.0025], [150, 0.0012]] as const) {
    const osc = ctx.createOscillator()
    osc.frequency.value = f
    const gain = ctx.createGain()
    gain.gain.value = g
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(0)
  }

  // crackle: random short ticks, denser small ones, sparse big pops
  let t = 0
  while (t < dur) {
    const big = rnd() > 0.93
    const len = big ? 0.012 : 0.003
    const buf = ctx.createBuffer(1, Math.ceil(len * sampleRate) + 2, sampleRate)
    const d = buf.getChannelData(0)
    for (let k = 0; k < d.length; k++) d[k] = (rnd() * 2 - 1) * (1 - k / d.length)
    const src = ctx.createBufferSource()
    src.buffer = buf
    const g = ctx.createGain()
    g.gain.value = big ? 0.25 + rnd() * 0.2 : 0.04 + rnd() * 0.05
    const hp = ctx.createBiquadFilter()
    hp.type = big ? 'bandpass' : 'highpass'
    hp.frequency.value = big ? 1200 : 3000
    const p = ctx.createStereoPanner()
    p.pan.value = (rnd() - 0.5) * 0.9
    src.connect(hp)
    hp.connect(g)
    g.connect(p)
    p.connect(ctx.destination)
    src.start(t)
    t += big ? 0.3 + rnd() * 0.6 : 0.02 + rnd() * 0.12
  }
  return ctx.startRendering()
}
