import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { ActiveFire } from '../hooks/useAudioEngine'

/**
 * "Cover Versions" homage: a constructivist collage of discs, rectangles and
 * polygons in warm minimalist hues. Every newly fired slice cluster nudges
 * shapes to new positions/scales; the master analyser adds a slow breathing.
 */

const PALETTE = ['#D35400', '#1A1A1A', '#C7B9A5', '#8A7F72', '#E8DFD3', '#A04000']

interface Shape {
  kind: 'disc' | 'rect' | 'poly' | 'halfdisc'
  x: number
  y: number
  size: number
  rot: number
  color: string
  // animation targets
  tx: number
  ty: number
  tsize: number
  trot: number
}

function makeShape(): Shape {
  const kinds: Shape['kind'][] = ['disc', 'rect', 'poly', 'halfdisc']
  const x = Math.random()
  const y = Math.random()
  const size = 0.06 + Math.random() * 0.28
  const rot = Math.random() * Math.PI * 2
  return {
    kind: kinds[Math.floor(Math.random() * kinds.length)],
    x, y, size, rot,
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    tx: x, ty: y, tsize: size, trot: rot,
  }
}

interface Props {
  firesRef: MutableRefObject<ActiveFire[]>
  analyser: AnalyserNode | null
  /** dominant colors of a sonified cover — overrides the default palette */
  palette?: string[] | null
  /** processed-master audio stream for canvas+audio video capture */
  getAudioStream?: () => MediaStream | null
}

export function GenerativeArtwork({ firesRef, analyser, palette, getAudioStream }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const shapesRef = useRef<Shape[]>([])
  const seenFires = useRef(0)
  const raf = useRef(0)
  const paletteRef = useRef<string[]>(PALETTE)

  useEffect(() => {
    paletteRef.current = palette && palette.length ? palette : PALETTE
    // retarget existing shapes so the sleeve drifts into the new colors
    for (const s of shapesRef.current) {
      if (Math.random() < 0.7) {
        s.color = paletteRef.current[Math.floor(Math.random() * paletteRef.current.length)]
      }
    }
  }, [palette])

  useEffect(() => {
    if (shapesRef.current.length === 0) {
      shapesRef.current = Array.from({ length: 9 }, makeShape)
    }
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const freq = new Uint8Array(1024)

    const draw = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      const g = canvas.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)

      // reposition shapes when new fires arrive
      const fires = firesRef.current
      const latest = fires.length ? fires[fires.length - 1].time : 0
      if (latest > seenFires.current) {
        seenFires.current = latest
        const n = 1 + Math.floor(Math.random() * 3)
        for (let i = 0; i < n; i++) {
          const s = shapesRef.current[Math.floor(Math.random() * shapesRef.current.length)]
          s.tx = Math.random()
          s.ty = Math.random()
          s.tsize = 0.05 + Math.random() * 0.3
          s.trot = Math.random() * Math.PI * 2
          if (Math.random() < 0.3) {
            const pal = paletteRef.current
            s.color = pal[Math.floor(Math.random() * pal.length)]
          }
        }
      }

      // audio-driven breathing
      let energy = 0
      if (analyser) {
        analyser.getByteFrequencyData(freq)
        let sum = 0
        for (let i = 0; i < 64; i++) sum += freq[i]
        energy = sum / (64 * 255)
      }

      g.fillStyle = '#EFE7DC'
      g.fillRect(0, 0, w, h)

      for (const s of shapesRef.current) {
        // ease toward targets
        s.x += (s.tx - s.x) * 0.04
        s.y += (s.ty - s.y) * 0.04
        s.size += (s.tsize - s.size) * 0.04
        s.rot += (s.trot - s.rot) * 0.03

        const cx = s.x * w
        const cy = s.y * h
        const base = Math.min(w, h)
        const sz = s.size * base * (1 + energy * 0.25)
        g.save()
        g.translate(cx, cy)
        g.rotate(s.rot)
        g.fillStyle = s.color
        g.globalAlpha = 0.92
        switch (s.kind) {
          case 'disc':
            g.beginPath()
            g.arc(0, 0, sz / 2, 0, Math.PI * 2)
            g.fill()
            break
          case 'halfdisc':
            g.beginPath()
            g.arc(0, 0, sz / 2, 0, Math.PI)
            g.closePath()
            g.fill()
            break
          case 'rect':
            g.fillRect(-sz / 2, -sz / 4, sz, sz / 2)
            break
          case 'poly': {
            g.beginPath()
            const sides = 3 + (Math.floor(s.rot * 7) % 3)
            for (let i = 0; i <= sides; i++) {
              const a = (i / sides) * Math.PI * 2
              const px = Math.cos(a) * (sz / 2)
              const py = Math.sin(a) * (sz / 2)
              if (i === 0) g.moveTo(px, py)
              else g.lineTo(px, py)
            }
            g.fill()
            break
          }
        }
        g.restore()
      }
      g.globalAlpha = 1

      raf.current = requestAnimationFrame(draw)
    }
    raf.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf.current)
  }, [analyser, firesRef])

  const [videoRec, setVideoRec] = useState(false)

  /** Capture the animated sleeve + master audio into a downloadable webm clip. */
  const recordVideo = (seconds = 30) => {
    const canvas = canvasRef.current
    if (!canvas || videoRec) return
    const audio = getAudioStream?.()
    const stream = new MediaStream([
      ...canvas.captureStream(30).getVideoTracks(),
      ...(audio ? audio.getAudioTracks() : []),
    ])
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm'
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = () => {
      setVideoRec(false)
      const blob = new Blob(chunks, { type: 'video/webm' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `exotica-sleeve-${Date.now()}.webm`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    }
    rec.start()
    setVideoRec(true)
    setTimeout(() => rec.state !== 'inactive' && rec.stop(), seconds * 1000)
  }

  const exportPng = () => {
    canvasRef.current?.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `exotica-sleeve-${Date.now()}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    }, 'image/png')
  }

  return (
    <div className="border border-charcoal/60 h-full flex flex-col">
      <div className="px-3 py-1.5 text-[10px] tracking-[0.2em] border-b border-charcoal/30 flex justify-between items-center gap-1">
        <span>DÉCOLLAGE — GENERATIVE SLEEVE</span>
        <span className="flex gap-1">
          <button
            onClick={() => recordVideo(30)}
            className="px-1.5 py-0.5 border border-charcoal/40 text-[9px] tracking-wider hover:bg-charcoal/10"
            title="Record 30s of the animated sleeve with master audio → webm clip (keep this tab visible while recording)"
            style={videoRec ? { background: '#D35400', color: '#F4EFEA' } : undefined}
          >
            {videoRec ? 'REC 30S…' : 'VIDEO ↓'}
          </button>
          <button
            onClick={exportPng}
            className="px-1.5 py-0.5 border border-charcoal/40 text-[9px] tracking-wider hover:bg-charcoal/10"
            title="Export the current sleeve as PNG"
          >
            PNG ↓
          </button>
        </span>
      </div>
      {/* canvas is absolutely positioned so its bitmap size can't feed back into layout */}
      <div className="relative flex-1 min-h-56">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      </div>
    </div>
  )
}
