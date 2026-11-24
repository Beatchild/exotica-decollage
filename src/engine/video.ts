/**
 * RELEASE VIDEO — a 1280×720 WebM for YouTube: the cover breathing slowly,
 * an audio-reactive trace of the waveform, title, the current chapter and a
 * thin progress line. Recorded in real time (MediaRecorder), so it takes as
 * long as the track; keep the tab visible while it records.
 */

export interface VideoInput {
  wav: Blob
  cover: Blob
  title: string
  artist: string
  chapters?: Array<{ t: number; label: string }>
  onProgress?: (f: number) => void
  signal?: AbortSignal
}

function pickMime(): string {
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

export async function recordVideo(o: VideoInput): Promise<Blob> {
  const mime = pickMime()
  if (!mime) throw new Error('This browser cannot record WebM video.')
  const ctx = new AudioContext()
  try {
    await ctx.resume()
    const buf = await ctx.decodeAudioData(await o.wav.arrayBuffer())
    const art = await createImageBitmap(o.cover)
    const W = 1280
    const H = 720
    const cv = document.createElement('canvas')
    cv.width = W
    cv.height = H
    const g = cv.getContext('2d')!

    const src = ctx.createBufferSource()
    src.buffer = buf
    const an = ctx.createAnalyser()
    an.fftSize = 2048
    an.smoothingTimeConstant = 0.6
    const dest = ctx.createMediaStreamDestination()
    src.connect(an)
    an.connect(dest) // recorded, not played: the studio may keep playing

    const stream = cv.captureStream(30)
    for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr)
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 256_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()))

    const wave = new Float32Array(an.fftSize)
    const dur = buf.duration
    let t0 = 0
    const draw = () => {
      const t = Math.max(0, ctx.currentTime - t0)
      const p = Math.min(1, t / dur)
      // ground
      g.fillStyle = '#0f0c0a'
      g.fillRect(0, 0, W, H)
      // the cover, slowly breathing in
      const side = 560 * (1 + 0.05 * p + 0.008 * Math.sin(t * 0.3))
      g.globalAlpha = 0.95
      g.drawImage(art, (W - side) / 2 - 150, (H - side) / 2 - 20, side, side)
      g.globalAlpha = 1
      // the trace
      an.getFloatTimeDomainData(wave)
      g.strokeStyle = 'rgba(244,239,234,0.75)'
      g.lineWidth = 1.5
      g.beginPath()
      for (let i = 0; i < wave.length; i += 4) {
        const x = (i / wave.length) * W
        const y = H - 70 + wave[i] * 90
        if (i) g.lineTo(x, y)
        else g.moveTo(x, y)
      }
      g.stroke()
      // type
      g.fillStyle = '#F4EFEA'
      g.font = '600 26px ui-monospace, Menlo, Consolas, monospace'
      g.fillText(o.title.toUpperCase(), W - 470, H / 2 - 30)
      g.globalAlpha = 0.6
      g.font = '400 18px ui-monospace, Menlo, Consolas, monospace'
      if (o.artist) g.fillText(o.artist.toUpperCase(), W - 470, H / 2 + 4)
      const ch = o.chapters?.filter((c) => c.t <= t).pop()
      if (ch) {
        g.fillStyle = '#D35400'
        g.globalAlpha = 0.9
        g.fillText(ch.label, W - 470, H / 2 + 44)
      }
      g.globalAlpha = 1
      // progress
      g.fillStyle = '#D35400'
      g.fillRect(0, H - 4, W * p, 4)
      o.onProgress?.(p)
    }

    const aborted = () => new DOMException('Video cancelled', 'AbortError')
    if (o.signal?.aborted) throw aborted()
    rec.start(1000)
    t0 = ctx.currentTime + 0.1
    src.start(t0)
    const timer = window.setInterval(draw, 1000 / 30)
    draw()
    await new Promise<void>((resolve, reject) => {
      src.onended = () => resolve()
      o.signal?.addEventListener('abort', () => {
        try { src.stop() } catch { /* done */ }
        reject(aborted())
      }, { once: true })
    }).finally(() => {
      window.clearInterval(timer)
      if (rec.state !== 'inactive') rec.stop()
    })
    await stopped
    return new Blob(chunks, { type: mime.split(';')[0] })
  } finally {
    void ctx.close()
  }
}
