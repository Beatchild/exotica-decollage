import { useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { SourceRec } from '../engine/AudioEngine'
import type { Slice } from '../engine/types'
import type { ActiveFire } from '../hooks/useAudioEngine'

const CHARCOAL = '#1A1A1A'
const BURNT = '#D35400'
const CREAM = '#F4EFEA'
const CAT_COLOR: Record<Slice['category'], string> = {
  transient: BURNT,
  harmonic: CHARCOAL,
  texture: '#8A7F72',
}

interface Props {
  sources: SourceRec[]
  slices: Slice[]
  firesRef: MutableRefObject<ActiveFire[]>
  onAudition: (id: number) => void
  onEditBoundary: (sourceIdx: number, time: number, tolerance: number) => void
  onCycleCategory: (id: number) => void
  onPreview: (sourceIdx: number) => void
  previewSource: number | null
  onRegionLoop: (sourceIdx: number, start: number, dur: number) => void
  onRegionSource: (sourceIdx: number, start: number, dur: number) => void
  onRegionSplice: (sourceIdx: number, regions: Array<{ start: number; dur: number }>) => void
  onPreviewFrom: (sourceIdx: number, sec: number) => void
  onPreviewRegions: (sourceIdx: number, regions: Array<{ start: number; dur: number }>) => void
  getPreviewPos: () => { idx: number; sec: number } | null
  getPhraseInfo: () => { sourceIdx: number; start: number; dur: number; sec: number } | null
}

const peaksCache = new WeakMap<AudioBuffer, { key: string; peaks: Array<[number, number]> }>()

/** Min-max waveform peaks for a view window [v0,v1] (fractions), cached. */
function computePeaks(
  buffer: AudioBuffer,
  width: number,
  v0 = 0,
  v1 = 1,
): Array<[number, number]> {
  const key = `${width}|${v0.toFixed(6)}|${v1.toFixed(6)}`
  const hit = peaksCache.get(buffer)
  if (hit && hit.key === key) return hit.peaks
  const data = buffer.getChannelData(0)
  const from = Math.floor(v0 * data.length)
  const to = Math.min(data.length, Math.max(from + width, Math.floor(v1 * data.length)))
  const step = Math.max(1, Math.floor((to - from) / width))
  const stride = Math.max(1, Math.floor(step / 256))
  const peaks: Array<[number, number]> = []
  for (let x = 0; x < width; x++) {
    let min = 0
    let max = 0
    const a = from + x * step
    const b = Math.min(a + step, to)
    for (let i = a; i < b; i += stride) {
      if (data[i] < min) min = data[i]
      if (data[i] > max) max = data[i]
    }
    peaks.push([min, max])
  }
  peaksCache.set(buffer, { key, peaks })
  return peaks
}

export function AudioVisualizer({
  sources,
  slices,
  firesRef,
  onAudition,
  onEditBoundary,
  onCycleCategory,
  onPreview,
  previewSource,
  onRegionLoop,
  onRegionSource,
  onRegionSplice,
  onPreviewFrom,
  onPreviewRegions,
  getPreviewPos,
  getPhraseInfo,
}: Props) {
  // mouse-selected waveform regions, in seconds of the selected source
  const [regions, setRegions] = useState<Array<{ a: number; b: number }>>([])
  const regionsRef = useRef(regions)
  regionsRef.current = regions
  // zoom window as fractions of the buffer
  const [view, setView] = useState({ v0: 0, v1: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const dragRef = useRef<{ startX: number; startTime: number; added: boolean } | null>(null)
  const waveRef = useRef<HTMLCanvasElement>(null)
  const scatterRef = useRef<HTMLCanvasElement>(null)
  const raf = useRef(0)
  const [selRaw, setSel] = useState(0)
  const sel = Math.min(selRaw, Math.max(0, sources.length - 1))
  const selected: SourceRec | undefined = sources[sel]

  // scatter layout: x = brightness (log centroid), y = duration (log)
  const scatterPoints = useMemo(() => {
    if (slices.length === 0) return []
    const cMin = Math.log(80)
    const cMax = Math.log(9000)
    const dMin = Math.log(0.07)
    const dMax = Math.log(1.3)
    return slices.map((s) => ({
      id: s.id,
      x: Math.min(1, Math.max(0, (Math.log(Math.max(80, s.centroid)) - cMin) / (cMax - cMin))),
      y: 1 - Math.min(1, Math.max(0, (Math.log(Math.max(0.07, s.duration)) - dMin) / (dMax - dMin))),
      r: 2.5 + Math.min(6, s.rms * 60),
      cat: s.category,
      sourceIdx: s.sourceIdx,
    }))
  }, [slices])

  useEffect(() => {
    const wave = waveRef.current
    const scatter = scatterRef.current
    if (!wave || !scatter) return
    const dpr = window.devicePixelRatio || 1

    const draw = () => {
      const now = performance.now()
      const fires = firesRef.current.filter((f) => f.until > now)

      // ----- waveform (selected source) -----
      {
        const w = wave.clientWidth
        const h = wave.clientHeight
        if (wave.width !== w * dpr || wave.height !== h * dpr) {
          wave.width = w * dpr
          wave.height = h * dpr
        }
        const g = wave.getContext('2d')!
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.clearRect(0, 0, w, h)
        if (selected) {
          const buffer = selected.buffer
          const { v0, v1 } = viewRef.current
          const span = Math.max(0.000001, v1 - v0)
          const timeToX = (t: number) => ((t / buffer.duration - v0) / span) * w
          const peaks = computePeaks(buffer, w, v0, v1)
          const mid = h / 2
          g.strokeStyle = CHARCOAL
          g.globalAlpha = 0.9
          g.beginPath()
          for (let x = 0; x < peaks.length; x++) {
            g.moveTo(x + 0.5, mid + peaks[x][0] * mid * 0.92)
            g.lineTo(x + 0.5, mid + peaks[x][1] * mid * 0.92)
          }
          g.stroke()
          g.globalAlpha = 1

          for (const s of slices) {
            if (s.sourceIdx !== sel || s.start === 0) continue
            const x = timeToX(s.start)
            if (x < 0 || x > w) continue
            g.strokeStyle = CAT_COLOR[s.category]
            g.globalAlpha = 0.4
            g.beginPath()
            g.moveTo(x, 0)
            g.lineTo(x, h)
            g.stroke()
          }
          g.globalAlpha = 1

          for (const f of fires) {
            const s = slices.find((sl) => sl.id === f.sliceId)
            if (!s || s.sourceIdx !== sel) continue
            const x = timeToX(s.start)
            const sw = Math.max(2, (s.duration / buffer.duration / span) * w)
            if (x + sw < 0 || x > w) continue
            const life = (f.until - now) / 400
            g.fillStyle = BURNT
            g.globalAlpha = Math.min(0.5, Math.max(0.08, life * 0.4))
            g.fillRect(x, 0, sw, h)
          }
          g.globalAlpha = 1

          // mouse selection overlays
          for (const sr of regionsRef.current) {
            const x0 = timeToX(Math.min(sr.a, sr.b))
            const x1 = timeToX(Math.max(sr.a, sr.b))
            if (x1 < 0 || x0 > w) continue
            g.fillStyle = BURNT
            g.globalAlpha = 0.18
            g.fillRect(x0, 0, Math.max(1, x1 - x0), h)
            g.globalAlpha = 0.8
            g.strokeStyle = BURNT
            g.beginPath()
            g.moveTo(x0, 0)
            g.lineTo(x0, h)
            g.moveTo(x1, 0)
            g.lineTo(x1, h)
            g.stroke()
            g.globalAlpha = 1
          }

          // running phrase loop: region band + cycling playhead
          const ph = getPhraseInfo()
          if (ph && ph.sourceIdx === sel) {
            const x0 = timeToX(ph.start)
            const x1 = timeToX(ph.start + ph.dur)
            if (x1 >= 0 && x0 <= w) {
              g.fillStyle = BURNT
              g.globalAlpha = 0.1
              g.fillRect(x0, 0, Math.max(1, x1 - x0), h)
              g.globalAlpha = 0.7
              g.strokeStyle = BURNT
              g.setLineDash([4, 3])
              g.beginPath()
              g.moveTo(x0, 0)
              g.lineTo(x0, h)
              g.moveTo(x1, 0)
              g.lineTo(x1, h)
              g.stroke()
              g.setLineDash([])
              const xp = timeToX(ph.sec)
              if (xp >= 0 && xp <= w) {
                g.globalAlpha = 1
                g.lineWidth = 2
                g.beginPath()
                g.moveTo(xp, 0)
                g.lineTo(xp, h)
                g.stroke()
                g.lineWidth = 1
                g.fillStyle = BURNT
                g.globalAlpha = 1
                g.beginPath()
                g.moveTo(xp - 5, 0)
                g.lineTo(xp + 5, 0)
                g.lineTo(xp, 7)
                g.closePath()
                g.fill()
              }
              g.globalAlpha = 1
            }
          }

          // preview playhead
          const pp = getPreviewPos()
          if (pp && pp.idx === sel) {
            const x = timeToX(pp.sec)
            if (x >= 0 && x <= w) {
              g.strokeStyle = CHARCOAL
              g.globalAlpha = 0.9
              g.lineWidth = 1.5
              g.beginPath()
              g.moveTo(x, 0)
              g.lineTo(x, h)
              g.stroke()
              g.lineWidth = 1
              // arrowhead
              g.fillStyle = CHARCOAL
              g.beginPath()
              g.moveTo(x - 5, 0)
              g.lineTo(x + 5, 0)
              g.lineTo(x, 7)
              g.closePath()
              g.fill()
              g.globalAlpha = 1
            }
          }
        } else {
          g.fillStyle = CHARCOAL
          g.font = '11px monospace'
          g.fillText('NO SOURCE LOADED', 12, h / 2)
        }
      }

      // ----- scatter / timbre map -----
      {
        const w = scatter.clientWidth
        const h = scatter.clientHeight
        if (scatter.width !== w * dpr || scatter.height !== h * dpr) {
          scatter.width = w * dpr
          scatter.height = h * dpr
        }
        const g = scatter.getContext('2d')!
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.clearRect(0, 0, w, h)

        g.strokeStyle = CHARCOAL
        g.globalAlpha = 0.25
        g.beginPath()
        g.moveTo(28, 8)
        g.lineTo(28, h - 22)
        g.lineTo(w - 8, h - 22)
        g.stroke()
        g.globalAlpha = 0.6
        g.fillStyle = CHARCOAL
        g.font = '9px monospace'
        g.fillText('BRIGHTNESS →', w - 92, h - 8)
        g.save()
        g.translate(10, 90)
        g.rotate(-Math.PI / 2)
        g.fillText('DURATION →', 0, 0)
        g.restore()
        g.globalAlpha = 1

        const px = (v: number) => 34 + v * (w - 48)
        const py = (v: number) => 12 + v * (h - 40)
        const activeIds = new Set(fires.map((f) => f.sliceId))
        for (const p of scatterPoints) {
          const active = activeIds.has(p.id)
          const fromSelected = p.sourceIdx === sel
          g.beginPath()
          g.arc(px(p.x), py(p.y), active ? p.r + 3 : p.r, 0, Math.PI * 2)
          g.fillStyle = active ? BURNT : CAT_COLOR[p.cat]
          g.globalAlpha = active ? 1 : fromSelected ? 0.8 : 0.35
          g.fill()
          if (active) {
            g.beginPath()
            g.arc(px(p.x), py(p.y), p.r + 8, 0, Math.PI * 2)
            g.strokeStyle = BURNT
            g.globalAlpha = 0.4
            g.stroke()
          }
        }
        g.globalAlpha = 1
      }

      raf.current = requestAnimationFrame(draw)
    }
    raf.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf.current)
  }, [selected, sel, slices, scatterPoints, firesRef])

  const xToTime = (clientX: number, rect: DOMRect) => {
    if (!selected) return 0
    const { v0, v1 } = viewRef.current
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return (v0 + frac * (v1 - v0)) * selected.buffer.duration
  }

  // waveform mouse: drag = add a selected region; a plain click = toggle a boundary
  const handleWaveDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = waveRef.current
    if (!canvas || !selected) return
    const rect = canvas.getBoundingClientRect()
    const dur = selected.buffer.duration
    dragRef.current = { startX: e.clientX, startTime: xToTime(e.clientX, rect), added: false }
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      if (Math.abs(ev.clientX - d.startX) > 4) {
        const t = xToTime(ev.clientX, rect)
        if (!d.added) {
          d.added = true
          setRegions((rs) => [...rs, { a: d.startTime, b: t }])
        } else {
          setRegions((rs) => rs.map((r, i) => (i === rs.length - 1 ? { ...r, b: t } : r)))
        }
      }
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const d = dragRef.current
      dragRef.current = null
      if (!d) return
      if (!d.added && Math.abs(ev.clientX - d.startX) <= 4) {
        // plain click: keep the old boundary-toggle behavior
        const { v0, v1 } = viewRef.current
        const tolerance = (8 / rect.width) * (v1 - v0) * dur
        onEditBoundary(sel, d.startTime, tolerance)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // wheel = zoom at cursor · shift+wheel = pan (native listener: preventDefault)
  useEffect(() => {
    const canvas = waveRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const src = sources[Math.min(selRaw, Math.max(0, sources.length - 1))]
      if (!src) return
      const dur = src.buffer.duration
      const rect = canvas.getBoundingClientRect()
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      setView((v) => {
        const span = v.v1 - v.v0
        if (e.shiftKey) {
          const shift = span * 0.18 * (e.deltaY > 0 ? 1 : -1)
          const v0 = Math.max(0, Math.min(1 - span, v.v0 + shift))
          return { v0, v1: v0 + span }
        }
        const minSpan = Math.min(1, 0.25 / dur)
        const k = e.deltaY < 0 ? 1 / 1.35 : 1.35
        const newSpan = Math.min(1, Math.max(minSpan, span * k))
        const anchor = v.v0 + frac * span
        let v0 = anchor - frac * newSpan
        v0 = Math.max(0, Math.min(1 - newSpan, v0))
        return { v0, v1: v0 + newSpan }
      })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [sources, selRaw])

  const sortedRegions = [...regions]
    .map((r) => ({ start: Math.min(r.a, r.b), dur: Math.abs(r.b - r.a) }))
    .filter((r) => r.dur > 0.05)
    .sort((a, b) => a.start - b.start)
  const totalSel = sortedRegions.reduce((n, r) => n + r.dur, 0)
  const zoomed = view.v1 - view.v0 < 0.999

  const hitScatterPoint = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = scatterRef.current
    if (!canvas || scatterPoints.length === 0) return null
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const px = (v: number) => 34 + v * (w - 48)
    const py = (v: number) => 12 + v * (h - 40)
    let best: { id: number; d: number } | null = null
    for (const p of scatterPoints) {
      const d = Math.hypot(px(p.x) - mx, py(p.y) - my)
      if (d < 14 && (!best || d < best.d)) best = { id: p.id, d }
    }
    return best
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="border border-charcoal/60" style={{ background: CREAM }}>
        <div className="px-3 py-1.5 text-[10px] tracking-[0.2em] border-b border-charcoal/30 flex items-center gap-2 flex-wrap">
          <span>WAVEFORM — CLICK: BOUNDARY · DRAG: SELECT · 2×CLICK: PLAY HERE · WHEEL: ZOOM</span>
          {zoomed && (
            <button
              onClick={() => setView({ v0: 0, v1: 1 })}
              title="Reset zoom to the full track (Shift+wheel pans while zoomed)"
              className="px-1.5 py-0.5 border border-charcoal/60 text-[9px] tracking-widest hover:bg-charcoal/10"
              style={{ background: CHARCOAL, color: CREAM }}
            >
              1:1
            </button>
          )}
          {sortedRegions.length > 0 && (
            <>
              <span style={{ color: BURNT }}>
                {sortedRegions.length > 1 ? `${sortedRegions.length}× ` : ''}
                {totalSel.toFixed(2)}S
              </span>
              <button
                onClick={() => onPreviewRegions(sel, sortedRegions)}
                title="Play only the selected region(s), in order, clean"
                className="px-1.5 py-0.5 border border-charcoal/60 text-[9px] tracking-widest hover:bg-charcoal/10"
              >
                ▶ SEL
              </button>
              {sortedRegions.length === 1 && (
                <button
                  onClick={() => {
                    onRegionLoop(sel, sortedRegions[0].start, sortedRegions[0].dur)
                    setRegions([])
                  }}
                  title="The selected region becomes the V1 phrase loop, verbatim (PHRASE turns on)"
                  className="px-1.5 py-0.5 border text-[9px] tracking-widest"
                  style={{ background: BURNT, color: CREAM, borderColor: BURNT }}
                >
                  → LOOP
                </button>
              )}
              <button
                onClick={() => {
                  for (const r of sortedRegions) onRegionSource(sel, r.start, r.dur)
                  setRegions([])
                }}
                title="Each selected region is cut out as its own new source in the pool"
                className="px-1.5 py-0.5 border border-charcoal/60 text-[9px] tracking-widest hover:bg-charcoal/10"
              >
                → SOURCE{sortedRegions.length > 1 ? 'S' : ''}
              </button>
              {sortedRegions.length > 1 && (
                <button
                  onClick={() => {
                    onRegionSplice(sel, sortedRegions)
                    setRegions([])
                  }}
                  title="All selected regions spliced hard, in order, into ONE new source — a collage cut"
                  className="px-1.5 py-0.5 border text-[9px] tracking-widest"
                  style={{ background: BURNT, color: CREAM, borderColor: BURNT }}
                >
                  → SPLICE
                </button>
              )}
              <button
                onClick={() => setRegions([])}
                title="Clear the selection"
                className="px-1.5 py-0.5 border border-charcoal/40 text-[9px] tracking-widest hover:bg-charcoal/10 opacity-60"
              >
                ✕
              </button>
            </>
          )}
          <button
            onClick={() => onPreview(sel)}
            title="Raw playback of the selected source — clean, no engine, no effects. Click again to stop."
            className="px-2 py-0.5 border border-charcoal/60 text-[10px] tracking-widest hover:bg-charcoal/10"
            style={previewSource === sel ? { background: BURNT, color: CREAM } : undefined}
          >
            {previewSource === sel ? '■ STOP' : '▶ PLAY'}
          </button>
          <span className="flex-1" />
          {sources.map((s, i) => (
            <button
              key={i}
              onClick={() => {
                setSel(i)
                setRegions([])
                setView({ v0: 0, v1: 1 })
              }}
              className="px-1.5 py-0.5 border border-charcoal/40 text-[9px] tracking-wider max-w-40 truncate"
              style={i === sel ? { background: CHARCOAL, color: CREAM } : undefined}
              title={s.name}
            >
              {s.name}
            </button>
          ))}
        </div>
        <canvas
          ref={waveRef}
          className="w-full h-48 block cursor-col-resize"
          onMouseDown={handleWaveDown}
          onDoubleClick={(e) => {
            const canvas = waveRef.current
            if (!canvas || !selected) return
            onPreviewFrom(sel, xToTime(e.clientX, canvas.getBoundingClientRect()))
          }}
        />
      </div>
      <div
        className="border border-charcoal/60 flex-1 min-h-0 flex flex-col"
        style={{ background: CREAM }}
      >
        <div className="px-3 py-1.5 text-[10px] tracking-[0.2em] border-b border-charcoal/30 flex justify-between">
          <span>TIMBRE MAP — CLICK: AUDITION · RIGHT-CLICK: RECLASSIFY</span>
          <span className="flex gap-3">
            <span style={{ color: BURNT }}>● TRANSIENT</span>
            <span style={{ color: CHARCOAL }}>● HARMONIC</span>
            <span style={{ color: '#8A7F72' }}>● TEXTURE</span>
          </span>
        </div>
        {/* canvas is absolutely positioned so its bitmap size can't feed back into layout */}
        <div className="relative flex-1 min-h-44">
          <canvas
            ref={scatterRef}
            className="absolute inset-0 w-full h-full cursor-crosshair"
            onClick={(e) => {
              const hit = hitScatterPoint(e)
              if (hit) onAudition(hit.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              const hit = hitScatterPoint(e)
              if (hit) onCycleCategory(hit.id)
            }}
          />
        </div>
      </div>
    </div>
  )
}
