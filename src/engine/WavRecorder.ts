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

export function encodeWav(L: Float32Array, R: Float32Array, sampleRate: number, format?: WavFormat): Blob {
  return new Blob([encodeWavBuffer(L, R, sampleRate, format)], { type: 'audio/wav' })
}

/** Tags written into exported WAVs (RIFF INFO + ID3v2.4 'id3 ' chunk). */
export interface WavMeta {
  title?: string
  artist?: string
  album?: string
  /** e.g. "3/8" */
  track?: string
  year?: string
  comment?: string
  software?: string
  /** free-form key/values → ID3 TXXX frames (e.g. SEED, PRESET, LUFS) */
  extra?: Record<string, string>
  /** cover art (ID3 APIC, front cover): image/png or image/jpeg */
  cover?: { mime: string; data: Uint8Array }
}

export interface WavFormat {
  bits?: 16 | 24
  meta?: WavMeta
}

/**
 * Stereo PCM WAV bytes, 16-bit (TPDF-dithered) or 24-bit, with optional
 * metadata chunks appended after the audio.
 */
export function encodeWavBuffer(
  L: Float32Array,
  R: Float32Array,
  sampleRate: number,
  format: WavFormat = {},
): ArrayBuffer {
  const bits = format.bits ?? 16
  const bytesPer = bits / 8
  const frames = L.length
  const dataSize = frames * 2 * bytesPer
  const meta = format.meta ? metaChunks(format.meta) : new Uint8Array(0)
  const dataPad = dataSize % 2 // RIFF chunks are word-aligned
  const buf = new ArrayBuffer(44 + dataSize + dataPad + meta.length)
  const view = new DataView(buf)
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, buf.byteLength - 8, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 2, true) // stereo
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2 * bytesPer, true)
  view.setUint16(32, 2 * bytesPer, true)
  view.setUint16(34, bits, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  const clip = (x: number) => (x > 1 ? 1 : x < -1 ? -1 : x !== x ? 0 : x)
  if (bits === 16) {
    // TPDF dither (±1 LSB triangular) decorrelates the requantization error —
    // fades and reverb tails don't turn into gritty truncation distortion.
    // Int16Array is ~5× faster than DataView.setInt16 (WAV is little-endian).
    const pcm = new Int16Array(buf, 44, frames * 2)
    let seed = 0x9e3779b9
    const rnd = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 4294967296
    }
    for (let i = 0, o = 0; i < frames; i++, o += 2) {
      const l = clip(L[i]) * 32767 + (rnd() - rnd())
      const r = clip(R[i]) * 32767 + (rnd() - rnd())
      pcm[o] = l > 32767 ? 32767 : l < -32768 ? -32768 : Math.round(l)
      pcm[o + 1] = r > 32767 ? 32767 : r < -32768 ? -32768 : Math.round(r)
    }
  } else {
    const u8 = new Uint8Array(buf, 44, dataSize)
    for (let i = 0, o = 0; i < frames; i++, o += 6) {
      let l = Math.round(clip(L[i]) * 8388607)
      let r = Math.round(clip(R[i]) * 8388607)
      if (l < 0) l += 0x1000000
      if (r < 0) r += 0x1000000
      u8[o] = l & 0xff
      u8[o + 1] = (l >> 8) & 0xff
      u8[o + 2] = (l >> 16) & 0xff
      u8[o + 3] = r & 0xff
      u8[o + 4] = (r >> 8) & 0xff
      u8[o + 5] = (r >> 16) & 0xff
    }
  }
  new Uint8Array(buf, 44 + dataSize + dataPad).set(meta)
  return buf
}

const utf8 = new TextEncoder()

function chunk(id: string, body: Uint8Array): Uint8Array {
  const pad = body.length % 2
  const out = new Uint8Array(8 + body.length + pad)
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i)
  new DataView(out.buffer).setUint32(4, body.length, true)
  out.set(body, 8)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** LIST/INFO (read by Windows Explorer, most DAWs) + ID3v2.4 (players, taggers). */
function metaChunks(m: WavMeta): Uint8Array {
  const info: Array<[string, string | undefined]> = [
    ['INAM', m.title], ['IART', m.artist], ['IPRD', m.album], ['ITRK', m.track],
    ['ICRD', m.year], ['ICMT', m.comment], ['ISFT', m.software],
  ]
  const infoParts = info
    .filter(([, v]) => v)
    .map(([id, v]) => chunk(id, concat([utf8.encode(v!), new Uint8Array([0])])))
  const list = infoParts.length
    ? chunk('LIST', concat([utf8.encode('INFO'), ...infoParts]))
    : new Uint8Array(0)
  return concat([list, chunk('id3 ', id3Tag(m))])
}

function syncsafe(n: number): number[] {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]
}

function id3Frame(id: string, body: Uint8Array): Uint8Array {
  return concat([utf8.encode(id), new Uint8Array([...syncsafe(body.length), 0, 0]), body])
}

const textFrame = (id: string, v: string) => id3Frame(id, concat([new Uint8Array([3]), utf8.encode(v)]))

function id3Tag(m: WavMeta): Uint8Array {
  const frames: Uint8Array[] = []
  if (m.title) frames.push(textFrame('TIT2', m.title))
  if (m.artist) frames.push(textFrame('TPE1', m.artist))
  if (m.album) frames.push(textFrame('TALB', m.album))
  if (m.track) frames.push(textFrame('TRCK', m.track))
  if (m.year) frames.push(textFrame('TDRC', m.year))
  if (m.software) frames.push(textFrame('TSSE', m.software))
  if (m.comment) {
    frames.push(id3Frame('COMM', concat([new Uint8Array([3]), utf8.encode('eng'), new Uint8Array([0]), utf8.encode(m.comment)])))
  }
  for (const [k, v] of Object.entries(m.extra ?? {})) {
    frames.push(id3Frame('TXXX', concat([new Uint8Array([3]), utf8.encode(k), new Uint8Array([0]), utf8.encode(v)])))
  }
  if (m.cover?.data.length) {
    frames.push(id3Frame('APIC', concat([
      new Uint8Array([0]), utf8.encode(m.cover.mime), new Uint8Array([0]),
      new Uint8Array([3]), new Uint8Array([0]), // front cover, empty description
      m.cover.data,
    ])))
  }
  const body = concat(frames)
  return concat([utf8.encode('ID3'), new Uint8Array([4, 0, 0, ...syncsafe(body.length)]), body])
}
