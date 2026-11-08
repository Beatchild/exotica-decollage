import { useEffect, useRef, useState } from 'react'
import type { EngineApi } from '../hooks/useAudioEngine'

const CHARCOAL = '#1A1A1A'
const BURNT = '#D35400'
const CREAM = '#F4EFEA'

const RULER = 18
const ROW_H = 56

type Drag =
  | { kind: 'move'; id: number; dt: number; dy: number }
  | { kind: 'trim-l' | 'trim-r'; id: number }
  | { kind: 'seek' }

/** Minimal DAW arrangement view: multitrack clip timeline on a canvas. */
export function ArrangeView({ api }: { api: EngineApi }) {
  const {
    state, arrPlay, arrStop, arrSeek, arrToggleLoop, arrToggleSnap, arrAddClip,
    arrUpdateClip, arrRemoveClip, arrDuplicateClip, arrSetTrack, arrBounce, getArrPos,
  } = api
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const raf = useRef(0)
  const [pxSec, setPxSec] = useState(14)
  const [scrollX, setScrollX] = useState(0)
  const [selClip, setSelClip] = useState<number | null>(null)
  const dragRef = useRef<Drag | null>(null)

  const clipsRef = useRef(state.arrClips)
  clipsRef.current = state.arrClips
  const viewRef = useRef({ pxSec, scrollX })
  viewRef.current = { pxSec, scrollX }
  const selRef = useRef(selClip)
  selRef.current = selClip
  const bpmRef = useRef(state.bpm)
  bpmRef.current = state.bpm
  const namesRef = useRef<string[]>([])
  namesRef.current = state.sources.map((s) => s.name)

  const beat = 60 / Math.max(30, state.bpm)
  const snapT = (t: number) => (state.arrSnap ? Math.round(t / beat) * beat : t)

  const xToT = (x: number) => Math.max(0, (x + viewRef.current.scrollX) / viewRef.current.pxSec)
  const tToX = (t: number) => t * viewRef.current.pxSec - viewRef.current.scrollX

  // ---------- draw loop ----------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const draw = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      const g = canvas.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      const { pxSec: ps, scrollX: sx } = viewRef.current

      // ruler + beat/bar grid
      const b = 60 / Math.max(30, bpmRef.current)
      const barW = b * 4 * ps
      g.fillStyle = CHARCOAL
      g.globalAlpha = 0.06
      g.fillRect(0, 0, w, RULER)
      g.globalAlpha = 1
      const firstBar = Math.floor(sx / barW)
      for (let i = firstBar; i * barW - sx < w; i++) {
        const x = i * barW - sx
        g.strokeStyle = CHARCOAL
        g.globalAlpha = 0.25
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x, h)
        g.stroke()
        g.globalAlpha = 0.6
        g.font = '8px monospace'
        g.fillStyle = CHARCOAL
        g.fillText(String(i + 1), x + 3, 12)
        // beats
        g.globalAlpha = 0.08
        for (let k = 1; k < 4; k++) {
          const xb = x + k * b * ps
          g.beginPath()
          g.moveTo(xb, RULER)
          g.lineTo(xb, h)
          g.stroke()
        }
      }
      g.globalAlpha = 1

      // track lanes
      for (let r = 0; r <= 4; r++) {
        const y = RULER + r * ROW_H
        g.strokeStyle = CHARCOAL
        g.globalAlpha = 0.2
        g.beginPath()
        g.moveTo(0, y)
        g.lineTo(w, y)
        g.stroke()
      }
      g.globalAlpha = 1

      // clips
      for (const c of clipsRef.current) {
        const x = c.at * ps - sx
        const cw = Math.max(3, c.dur * ps)
        if (x + cw < 0 || x > w) continue
        const y = RULER + c.track * ROW_H + 4
        const ch = ROW_H - 8
        const selected = c.id === selRef.current
        g.fillStyle = CHARCOAL
        g.globalAlpha = selected ? 0.92 : 0.75
        g.fillRect(x, y, cw, ch)
        if (selected) {
          g.strokeStyle = BURNT
          g.lineWidth = 2
          g.strokeRect(x + 1, y + 1, cw - 2, ch - 2)
          g.lineWidth = 1
        }
        // fades
        g.fillStyle = CREAM
        g.globalAlpha = 0.25
        const fiW = Math.min(c.fadeIn * ps, cw)
        const foW = Math.min(c.fadeOut * ps, cw)
        if (fiW > 1) {
          g.beginPath()
          g.moveTo(x, y + ch)
          g.lineTo(x + fiW, y)
          g.lineTo(x, y)
          g.closePath()
          g.fill()
        }
        if (foW > 1) {
          g.beginPath()
          g.moveTo(x + cw, y + ch)
          g.lineTo(x + cw - foW, y)
          g.lineTo(x + cw, y)
          g.closePath()
          g.fill()
        }
        g.globalAlpha = 0.95
        g.fillStyle = CREAM
        g.font = '8px monospace'
        const name = namesRef.current[c.sourceIdx] ?? '?'
        g.fillText(name.slice(0, Math.max(2, Math.floor(cw / 6))), x + 4, y + 12)
        g.fillText(`${c.dur.toFixed(1)}s`, x + 4, y + ch - 5)
        g.globalAlpha = 1
      }

      // playhead
      const pos = getArrPos()
      const xp = pos * ps - sx
      if (xp >= 0 && xp <= w) {
        g.strokeStyle = BURNT
        g.lineWidth = 2
        g.beginPath()
        g.moveTo(xp, 0)
        g.lineTo(xp, h)
        g.stroke()
        g.lineWidth = 1
        g.fillStyle = BURNT
        g.beginPath()
        g.moveTo(xp - 5, 0)
        g.lineTo(xp + 5, 0)
        g.lineTo(xp, 7)
        g.closePath()
        g.fill()
      }
      raf.current = requestAnimationFrame(draw)
    }
    raf.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- wheel: zoom / pan ----------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.shiftKey) {
        setScrollX((s) => Math.max(0, s + (e.deltaY > 0 ? 80 : -80)))
        return
      }
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      setPxSec((p) => {
        const np = Math.min(200, Math.max(3, p * (e.deltaY < 0 ? 1.25 : 1 / 1.25)))
        setScrollX((s) => Math.max(0, ((mx + s) / p) * np - mx))
        return np
      })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  // ---------- delete key ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (selRef.current !== null) {
        arrRemoveClip(selRef.current)
        setSelClip(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [arrRemoveClip])

  // ---------- mouse: seek / move / trim / alt-copy ----------
  const onDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const t = xToT(mx)

    if (my < RULER) {
      arrSeek(snapT(t))
      dragRef.current = { kind: 'seek' }
    } else {
      const row = Math.floor((my - RULER) / ROW_H)
      const ps = viewRef.current.pxSec
      const hit = [...clipsRef.current]
        .reverse()
        .find((c) => c.track === row && t >= c.at - 4 / ps && t <= c.at + c.dur + 4 / ps)
      if (!hit) {
        setSelClip(null)
        return
      }
      if (e.altKey) arrDuplicateClip(hit.id) // copy lands right after the original
      setSelClip(hit.id)
      const xL = tToX(hit.at)
      const xR = tToX(hit.at + hit.dur)
      if (Math.abs(mx - xL) <= 6) dragRef.current = { kind: 'trim-l', id: hit.id }
      else if (Math.abs(mx - xR) <= 6) dragRef.current = { kind: 'trim-r', id: hit.id }
      else dragRef.current = { kind: 'move', id: hit.id, dt: t - hit.at, dy: my }
    }

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const mx2 = ev.clientX - rect.left
      const my2 = ev.clientY - rect.top
      const t2 = xToT(mx2)
      if (d.kind === 'seek') {
        arrSeek(snapT(t2))
        return
      }
      const c = clipsRef.current.find((x) => x.id === d.id)
      if (!c) return
      if (d.kind === 'move') {
        const row = Math.max(0, Math.min(3, Math.floor((my2 - RULER) / ROW_H)))
        arrUpdateClip(d.id, { at: Math.max(0, snapT(t2 - d.dt)), track: row })
      } else if (d.kind === 'trim-l') {
        const newAt = Math.min(snapT(t2), c.at + c.dur - 0.05)
        const delta = newAt - c.at
        arrUpdateClip(d.id, { at: Math.max(0, newAt), offset: c.offset + delta, dur: c.dur - delta })
      } else {
        arrUpdateClip(d.id, { dur: Math.max(0.05, snapT(t2) - c.at) })
      }
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const sel = state.arrClips.find((c) => c.id === selClip) ?? null

  return (
    <div className="border border-charcoal/60" style={{ background: CREAM }}>
      {/* transport + header */}
      <div className="px-3 py-1.5 text-[10px] tracking-[0.2em] border-b border-charcoal/30 flex items-center gap-2 flex-wrap">
        <span>ARRANGE — DRAG: MOVE · EDGE: TRIM · ALT+CLICK: COPY · DEL: DELETE · RULER: SEEK</span>
        <span className="flex-1" />
        <select
          value=""
          onChange={(e) => {
            const i = Number(e.target.value)
            const src = state.sources[i]
            if (src) arrAddClip(i, 0, src.buffer.duration, undefined, 0)
            e.target.value = ''
          }}
          className="bg-transparent text-[9px] tracking-widest border border-charcoal/60 px-1 py-0.5 max-w-40"
          title="Drop a whole source onto track 1 at the playhead (trim it afterwards)"
        >
          <option value="" disabled>
            + ADD SOURCE…
          </option>
          {state.sources.map((s, i) => (
            <option key={i} value={i}>
              {s.name.slice(0, 30)}
            </option>
          ))}
        </select>
        <button
          onClick={() => (state.arrPlaying ? arrStop() : arrPlay())}
          className="px-2 py-0.5 border border-charcoal/60 text-[9px] tracking-widest hover:bg-charcoal/10"
          style={state.arrPlaying ? { background: BURNT, color: CREAM } : undefined}
          title="Play/stop the arrangement (plays through the master tape chain)"
        >
          {state.arrPlaying ? '■ STOP' : '▶ PLAY'}
        </button>
        <button
          onClick={arrToggleLoop}
          className="px-2 py-0.5 border border-charcoal/60 text-[9px] tracking-widest hover:bg-charcoal/10"
          style={state.arrLoop ? { background: CHARCOAL, color: CREAM } : undefined}
          title="Loop the arrangement end-to-end"
        >
          LOOP
        </button>
        <button
          onClick={arrToggleSnap}
          className="px-2 py-0.5 border border-charcoal/60 text-[9px] tracking-widest hover:bg-charcoal/10"
          style={state.arrSnap ? { background: CHARCOAL, color: CREAM } : undefined}
          title="Snap moves/trims to the beat grid (PULSE BPM)"
        >
          SNAP
        </button>
        <button
          onClick={arrBounce}
          disabled={state.arrLen <= 0 || state.recording}
          className="px-2 py-0.5 border border-charcoal text-[9px] tracking-widest disabled:opacity-35"
          style={{ background: CHARCOAL, color: CREAM }}
          title="BOUNCE: one clean non-looped pass of the arrangement through the master chain, saved as WAV"
        >
          ⤓ BOUNCE
        </button>
        <span className="text-[9px] tracking-widest opacity-60">{state.arrLen.toFixed(1)}S</span>
      </div>

      <div className="flex">
        {/* track strips */}
        <div className="w-36 shrink-0 border-r border-charcoal/30" style={{ paddingTop: RULER }}>
          {state.arrTracks.map((t, i) => (
            <div
              key={i}
              className="px-2 flex flex-col justify-center gap-0.5 border-b border-charcoal/20"
              style={{ height: ROW_H }}
            >
              <div className="flex items-center gap-1">
                <span className="text-[9px] tracking-widest flex-1">{t.name}</span>
                <button
                  onClick={() => arrSetTrack(i, { mute: !t.mute })}
                  className="px-1 text-[8px] border border-charcoal/50"
                  style={t.mute ? { background: CHARCOAL, color: CREAM } : undefined}
                >
                  M
                </button>
                <button
                  onClick={() => arrSetTrack(i, { solo: !t.solo })}
                  className="px-1 text-[8px] border border-charcoal/50"
                  style={t.solo ? { background: BURNT, color: CREAM } : undefined}
                >
                  S
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={1.2}
                step={0.01}
                value={t.gain}
                onChange={(e) => arrSetTrack(i, { gain: Number(e.target.value) })}
                className="w-full"
                title={`Volume ${Math.round(t.gain * 100)}`}
              />
              <input
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={t.pan}
                onChange={(e) => arrSetTrack(i, { pan: Number(e.target.value) })}
                className="w-full"
                title={`Pan ${t.pan.toFixed(2)}`}
              />
            </div>
          ))}
        </div>

        {/* timeline canvas */}
        <div className="relative flex-1 min-w-0" style={{ height: RULER + ROW_H * 4 }}>
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full cursor-crosshair"
            onMouseDown={onDown}
          />
        </div>
      </div>

      {/* selected clip inspector */}
      {sel && (
        <div className="px-3 py-1 border-t border-charcoal/30 flex items-center gap-3 text-[9px] tracking-widest flex-wrap">
          <span style={{ color: BURNT }}>
            CLIP #{sel.id} — {state.sources[sel.sourceIdx]?.name.slice(0, 24) ?? '?'}
          </span>
          <label className="flex items-center gap-1">
            GAIN
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={sel.gain}
              onChange={(e) => arrUpdateClip(sel.id, { gain: Number(e.target.value) })}
              className="w-20"
            />
            {Math.round(sel.gain * 100)}
          </label>
          <label className="flex items-center gap-1">
            FADE IN
            <input
              type="number"
              min={0}
              step={0.1}
              value={Number(sel.fadeIn.toFixed(2))}
              onChange={(e) => arrUpdateClip(sel.id, { fadeIn: Number(e.target.value) || 0 })}
              className="w-12 bg-transparent border-b border-charcoal/40"
            />
            S
          </label>
          <label className="flex items-center gap-1">
            FADE OUT
            <input
              type="number"
              min={0}
              step={0.1}
              value={Number(sel.fadeOut.toFixed(2))}
              onChange={(e) => arrUpdateClip(sel.id, { fadeOut: Number(e.target.value) || 0 })}
              className="w-12 bg-transparent border-b border-charcoal/40"
            />
            S
          </label>
          <button
            onClick={() => arrDuplicateClip(sel.id)}
            className="px-1.5 py-0.5 border border-charcoal/60 hover:bg-charcoal/10"
            title="Duplicate right after itself"
          >
            DUP
          </button>
          <button
            onClick={() => {
              arrRemoveClip(sel.id)
              setSelClip(null)
            }}
            className="px-1.5 py-0.5 border border-charcoal/60 hover:bg-charcoal/10"
          >
            ✕ DELETE
          </button>
        </div>
      )}
    </div>
  )
}
