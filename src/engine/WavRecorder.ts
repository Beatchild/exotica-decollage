/**
 * Real-time master capture → 16-bit stereo WAV download.
 * Taps the master with a ScriptProcessorNode and accumulates PCM, so the
 * export is a true .wav (MediaRecorder would hand back opus/webm instead).
 */
export class WavRecorder {
  private ctx: AudioContext
  private source: AudioNode
  private proc: ScriptProcessorNode | null = null
  private sink: GainNode | null = null
  private chunksL: Float32Array[] = []
  private chunksR: Float32Array[] = []
  recording = false

  constructor(ctx: AudioContext, source: AudioNode) {
    this.ctx = ctx
    this.source = source
  }

  start() {
    if (this.recording) return
    this.chunksL = []
    this.chunksR = []
    this.proc = this.ctx.createScriptProcessor(4096, 2, 2)
    this.proc.onaudioprocess = (e) => {
      this.chunksL.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      this.chunksR.push(new Float32Array(e.inputBuffer.getChannelData(1)))
    }
    // processor must reach the destination to run; keep it silent
    this.sink = this.ctx.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.proc)
    this.proc.connect(this.sink)
    this.sink.connect(this.ctx.destination)
    this.recording = true
  }

  /** Stop and return a WAV blob (null if nothing captured). */
  stop(): Blob | null {
    if (!this.recording || !this.proc || !this.sink) return null
    this.source.disconnect(this.proc)
    this.proc.disconnect()
    this.sink.disconnect()
    this.proc.onaudioprocess = null
    this.proc = null
    this.sink = null
    this.recording = false

    const total = this.chunksL.reduce((n, c) => n + c.length, 0)
    if (total === 0) return null
    const L = new Float32Array(total)
    const R = new Float32Array(total)
    let off = 0
    for (let i = 0; i < this.chunksL.length; i++) {
      L.set(this.chunksL[i], off)
      R.set(this.chunksR[i], off)
      off += this.chunksL[i].length
    }
    return encodeWav(L, R, this.ctx.sampleRate)
  }
}

export function encodeWav(L: Float32Array, R: Float32Array, sampleRate: number): Blob {
  const frames = L.length
  const dataSize = frames * 2 * 2 // stereo, 16-bit
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 2, true) // stereo
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 4, true)
  view.setUint16(32, 4, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  let o = 44
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, L[i]))
    const r = Math.max(-1, Math.min(1, R[i]))
    view.setInt16(o, l < 0 ? l * 0x8000 : l * 0x7fff, true)
    view.setInt16(o + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true)
    o += 4
  }
  return new Blob([buf], { type: 'audio/wav' })
}
