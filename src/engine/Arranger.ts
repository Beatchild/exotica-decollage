import type { AudioEngine } from './AudioEngine'

/** One audio clip on the arrangement timeline. */
export interface ArrClip {
  id: number
  /** track row index */
  track: number
  /** index into the engine's source pool */
  sourceIdx: number
  /** start inside the source buffer, seconds */
  offset: number
  /** clip length, seconds */
  dur: number
  /** timeline position, seconds */
  at: number
  gain: number
  fadeIn: number
  fadeOut: number
}

export interface ArrTrack {
  name: string
  gain: number
  pan: number
  mute: boolean
  solo: boolean
}

const N_TRACKS = 4

/**
 * Minimal DAW layer: a multitrack clip timeline played through the engine's
 * master chain (so the tape/saturation/reverb color applies to arrangements
 * exactly like it does to the generative voices).
 */
export class Arranger {
  tracks: ArrTrack[] = Array.from({ length: N_TRACKS }, (_, i) => ({
    name: `T${i + 1}`,
    gain: 0.85,
    pan: 0,
    mute: false,
    solo: false,
  }))
  clips: ArrClip[] = []
  playing = false
  loop = true
  snap = true
  /** called once when a non-looped pass reaches the end (used by BOUNCE) */
  onEnd: (() => void) | null = null

  private nextId = 1
  private pos = 0
  private startCtx = 0
  private active: AudioBufferSourceNode[] = []
  private chains: Array<{ g: GainNode; p: StereoPannerNode }> = []
  private endTimer = 0

  private engine: AudioEngine

  constructor(engine: AudioEngine) {
    this.engine = engine
  }

  length(): number {
    return this.clips.reduce((m, c) => Math.max(m, c.at + c.dur), 0)
  }

  playhead(): number {
    const ctx = this.engine.ctx
    if (!this.playing || !ctx) return this.pos
    const el = ctx.currentTime - this.startCtx
    return el < 0 ? this.pos : Math.min(this.pos + el, this.length())
  }

  addClip(sourceIdx: number, offset: number, dur: number, at?: number, track = 0): ArrClip | null {
    const src = this.engine.sources[sourceIdx]
    if (!src) return null
    const o = Math.max(0, Math.min(offset, src.buffer.duration - 0.05))
    const d = Math.max(0.05, Math.min(dur, src.buffer.duration - o))
    const clip: ArrClip = {
      id: this.nextId++,
      track: Math.max(0, Math.min(track, this.tracks.length - 1)),
      sourceIdx,
      offset: o,
      dur: d,
      at: Math.max(0, at ?? this.playhead()),
      gain: 1,
      fadeIn: 0.01,
      fadeOut: 0.03,
    }
    this.clips.push(clip)
    this.restartIfPlaying()
    return clip
  }

  updateClip(id: number, patch: Partial<ArrClip>) {
    const c = this.clips.find((x) => x.id === id)
    if (!c) return
    Object.assign(c, patch)
    c.at = Math.max(0, c.at)
    c.track = Math.max(0, Math.min(c.track, this.tracks.length - 1))
    const src = this.engine.sources[c.sourceIdx]
    if (src) {
      c.offset = Math.max(0, Math.min(c.offset, src.buffer.duration - 0.05))
      c.dur = Math.max(0.05, Math.min(c.dur, src.buffer.duration - c.offset))
    }
    c.gain = Math.max(0, Math.min(2, c.gain))
    c.fadeIn = Math.max(0, Math.min(c.fadeIn, c.dur))
    c.fadeOut = Math.max(0, Math.min(c.fadeOut, c.dur))
    this.restartIfPlaying()
  }

  removeClip(id: number) {
    this.clips = this.clips.filter((c) => c.id !== id)
    this.restartIfPlaying()
  }

  duplicateClip(id: number): ArrClip | null {
    const c = this.clips.find((x) => x.id === id)
    if (!c) return null
    const copy: ArrClip = { ...c, id: this.nextId++, at: c.at + c.dur }
    this.clips.push(copy)
    this.restartIfPlaying()
    return copy
  }

  setTrack(i: number, patch: Partial<ArrTrack>) {
    if (!this.tracks[i]) return
    Object.assign(this.tracks[i], patch)
    this.applyTrackGains()
  }

  /** Drop clips that referenced a removed source and remap the rest. */
  sourceRemoved(idx: number) {
    this.clips = this.clips.filter((c) => c.sourceIdx !== idx)
    for (const c of this.clips) if (c.sourceIdx > idx) c.sourceIdx--
    this.restartIfPlaying()
  }

  seek(t: number) {
    const target = Math.max(0, Math.min(t, this.length()))
    if (this.playing) this.play(target)
    else this.pos = target
  }

  toggleLoop() {
    this.loop = !this.loop
  }

  play(from?: number) {
    const ctx = this.engine.ctx
    const bus = this.engine.arrangeBus()
    if (!ctx || !bus) return
    this.stopNodes()
    const len = this.length()
    if (len <= 0) return
    this.pos = Math.max(0, Math.min(from ?? this.pos, len))
    if (this.pos >= len - 0.01) this.pos = 0
    this.ensureChains(ctx, bus)
    this.applyTrackGains()
    const t0 = ctx.currentTime + 0.06
    this.startCtx = t0

    for (const c of this.clips) {
      if (c.at + c.dur <= this.pos + 0.01) continue
      const src = this.engine.sources[c.sourceIdx]
      if (!src) continue
      const skip = Math.max(0, this.pos - c.at)
      const when = t0 + Math.max(0, c.at - this.pos)
      const dur = c.dur - skip
      if (dur <= 0.02) continue

      const node = ctx.createBufferSource()
      node.buffer = src.buffer
      const env = ctx.createGain()
      // linear fades, clamped and monotonic
      const fiEnd = Math.min(c.fadeIn, c.dur)
      const foStart = Math.max(fiEnd + 0.001, c.dur - c.fadeOut)
      const levelAt = (tc: number) => {
        // envelope level at clip-time tc
        let v = c.gain
        if (tc < fiEnd && fiEnd > 0) v = c.gain * (tc / fiEnd)
        if (tc > foStart) v = Math.min(v, c.gain * Math.max(0, (c.dur - tc) / Math.max(0.001, c.dur - foStart)))
        return Math.max(0, v)
      }
      env.gain.setValueAtTime(levelAt(skip), when)
      if (skip < fiEnd) env.gain.linearRampToValueAtTime(c.gain, when + (fiEnd - skip))
      if (foStart > skip) {
        env.gain.setValueAtTime(c.gain, when + Math.max(0.001, foStart - skip))
        env.gain.linearRampToValueAtTime(0.0001, when + dur)
      }
      node.connect(env)
      env.connect(this.chains[c.track].g)
      node.start(when, c.offset + skip, dur + 0.02)
      this.active.push(node)
    }

    this.playing = true
    const remaining = len - this.pos
    window.clearTimeout(this.endTimer)
    this.endTimer = window.setTimeout(() => {
      if (!this.playing) return
      if (this.loop) this.play(0)
      else {
        this.stop()
        this.pos = 0
        this.onEnd?.()
      }
    }, (remaining + 0.08) * 1000)
  }

  stop() {
    if (this.playing) this.pos = this.playhead()
    this.playing = false
    window.clearTimeout(this.endTimer)
    this.stopNodes()
  }

  private restartIfPlaying() {
    if (this.playing) this.play(this.playhead())
  }

  private stopNodes() {
    for (const n of this.active) {
      try {
        n.stop()
      } catch { /* already stopped */ }
    }
    this.active = []
  }

  private ensureChains(ctx: AudioContext, bus: GainNode) {
    while (this.chains.length < this.tracks.length) {
      const g = ctx.createGain()
      const p = ctx.createStereoPanner()
      g.connect(p)
      p.connect(bus)
      this.chains.push({ g, p })
    }
  }

  applyTrackGains() {
    if (this.chains.length === 0) return
    const anySolo = this.tracks.some((t) => t.solo)
    this.tracks.forEach((t, i) => {
      const ch = this.chains[i]
      if (!ch) return
      const audible = !t.mute && (!anySolo || t.solo)
      ch.g.gain.value = audible ? t.gain : 0
      ch.p.pan.value = t.pan
    })
  }
}
