import { useEffect, useRef, useState } from 'react'
import { Disc3, Users } from 'lucide-react'
import type { useAudioEngine } from '../hooks/useAudioEngine'
import { KIN_ARCS, actAt, arcByKey, tensionAt } from '../engine/kin'
import type { MoodKnobs } from '../engine/moods'

type Api = ReturnType<typeof useAudioEngine>

const CHARCOAL = '#1A1A1A'
const BURNT = '#D35400'
const CREAM = '#F4EFEA'
const WEIGHTS_KEY = 'exotica.weave.weights.v1'
const ROLE = ['LEAD', 'ANSWER', 'PEAK']
const MODE_LINE: Record<string, string> = {
  speak: 'one source at a time, the gesture handed on',
  dialog: 'two families answer each other',
  chorus: 'every source at once',
  lone: 'one source, alone',
}

function loadWeights(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(WEIGHTS_KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

function Slider({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-0.5 flex-1 min-w-32" title={hint}>
      <span className="flex justify-between text-[9px] tracking-widest">
        <b>{label}</b>
        <span className="opacity-60 tabular-nums">{Math.round(value * 100)}</span>
      </span>
      <input type="range" min={0} max={1} step={0.01} value={value} aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[#D35400]" />
      <span className="text-[8px] tracking-wider opacity-50 leading-tight">{hint}</span>
    </label>
  )
}

/**
 * TEXTURE KIN: the same texture from many sources — grouped into families,
 * balanced across sources, staged as drama (acts + a tension curve you can
 * draw). And a whole album built the same way.
 */
export function KinWeave({ api, minutes, knobs, onWeave }: {
  api: Api
  minutes: number
  knobs: MoodKnobs
  onWeave: () => void
}) {
  const { state } = api
  const noSrc = state.slices.length === 0
  const plan = state.memLayers.kin
  const [arcKey, setArcKey] = useState('classic')
  const [perSource, setPerSource] = useState(5)
  const [albumCount, setAlbumCount] = useState(8)
  const [albumMin, setAlbumMin] = useState(4)
  const [albumTitle, setAlbumTitle] = useState('')
  const [pos, setPos] = useState<number | null>(null)
  const [drag, setDrag] = useState<number[] | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const weights = (): Record<number, number> => {
    const byName = loadWeights()
    const w: Record<number, number> = {}
    state.sources.forEach((s, i) => { if (!s.bed) w[i] = byName[s.name] ?? 1 })
    return w
  }
  const weave = (o: { main?: number; contrast?: number } = {}) => {
    onWeave()
    api.weaveKin(minutes, knobs, { arc: plan?.arc ?? arcKey, perSource, weights: weights(), ...o })
  }

  const active = !!plan && state.memoryForm
  useEffect(() => {
    if (!active || !state.songActive) return
    const id = window.setInterval(() => setPos(api.getSongPos()), 250)
    return () => window.clearInterval(id)
  }, [active, state.songActive, api])

  const total = state.memorySecs.reduce((a, b) => a + b, 0)
  const f = active && state.songActive && pos != null && total > 0 ? (pos % total) / total : null
  const curve = drag ?? plan?.tension ?? []
  const now = plan && f != null ? actAt(plan.acts, f) : null

  // the tension curve: drag a point up or down
  const W = 600
  const H = 64
  const startPoint = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg || !plan) return
    const r = svg.getBoundingClientRect()
    let cur = [...plan.tension]
    const move = (ev: PointerEvent) => {
      const v = Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / Math.max(1, r.height)))
      cur = [...cur]
      cur[i] = Math.round(v * 100) / 100
      setDrag(cur)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      api.setKin({ tension: cur })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const sum = plan ? plan.acts.reduce((n, a) => n + a.share, 0) || 1 : 1
  const seams = plan ? plan.acts.map((_, i) => plan.acts.slice(0, i).reduce((n, a) => n + a.share, 0) / sum) : []

  return (
    <div data-adv className="px-3 py-2.5 flex flex-col gap-2.5 border-b-2" style={{ borderColor: CHARCOAL, background: 'rgba(26,26,26,0.035)' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <b className="text-[11px] tracking-[0.25em]">TEXTURE KIN</b>
        <span className="text-[9px] tracking-wider opacity-70">
          the same texture, found in many recordings — one voice, many mouths, staged as drama
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => weave()} disabled={noSrc}
          className="flex items-center gap-1.5 border-2 px-3 py-1.5 text-[10px] tracking-[0.2em] font-bold disabled:opacity-40"
          style={{ borderColor: CHARCOAL, background: CHARCOAL, color: CREAM }}
          title="Group every source's fragments into texture families, take the main one + a contrasting one (balanced across sources) and stage them along the arc">
          <Users size={12} /> {plan ? 'WEAVE KIN AGAIN' : 'WEAVE KIN'}
        </button>
        <select value={plan?.arc ?? arcKey}
          onChange={(e) => { setArcKey(e.target.value); if (plan) api.setKinArc(e.target.value, minutes) }}
          className="bg-transparent border border-charcoal/40 px-1 py-1 text-[9px] tracking-widest" aria-label="Dramatic arc"
          title={arcByKey(plan?.arc ?? arcKey).line}>
          {KIN_ARCS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
        <label className="flex items-center gap-1 text-[9px] tracking-widest border border-charcoal/40 px-1.5 py-1"
          title="At most this many fragments from each source in each family (× the source's weight in MEMORY WEAVE)">
          <select value={perSource} onChange={(e) => setPerSource(Number(e.target.value))} className="bg-transparent" aria-label="Kin fragments per source">
            {[2, 3, 5, 8].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          PER SOURCE · FAMILY
        </label>
        <span className="text-[8px] tracking-wider opacity-55">{arcByKey(plan?.arc ?? arcKey).line}</span>
      </div>

      {plan && (
        <>
          {/* the families */}
          {state.kinFamilies.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" aria-label="Texture families">
              {state.kinFamilies.map((fam, i) => {
                const role = state.kinRoles.indexOf(i)
                return (
                  <div key={fam.name} className="border px-2 py-1 text-[9px] tracking-wider flex flex-col gap-0.5 min-w-40"
                    style={{ borderColor: role >= 0 ? BURNT : 'rgba(26,26,26,0.35)', background: role === 0 ? 'rgba(211,84,0,0.08)' : undefined }}>
                    <span className="flex items-center gap-1.5">
                      <b style={role >= 0 ? { color: BURNT } : undefined}>{fam.name}</b>
                      {role >= 0 && <span className="text-[8px] px-1" style={{ background: BURNT, color: CREAM }}>{ROLE[role]}</span>}
                    </span>
                    <span className="opacity-60 text-[8px]">{fam.line}</span>
                    <span className="opacity-70 text-[8px] tabular-nums">{fam.size} fragments · {fam.sources} sources</span>
                    <span className="flex gap-px" aria-hidden title="fragments per source">
                      {state.sources.map((s, si) => s.bed ? null : (
                        <span key={si} className="w-2" style={{ height: 3 + 2 * (fam.perSource[si] ?? 0), background: (fam.perSource[si] ?? 0) ? CHARCOAL : 'rgba(26,26,26,0.12)', alignSelf: 'flex-end' }} />
                      ))}
                    </span>
                    <span className="flex gap-1 mt-0.5">
                      <button disabled={role === 0} onClick={() => weave({ main: i, contrast: state.kinRoles[1] === i ? undefined : state.kinRoles[1] })}
                        className="border border-charcoal/50 px-1 text-[8px] tracking-widest disabled:opacity-30 hover:bg-charcoal/10"
                        title="Let this family lead">LEAD</button>
                      <button disabled={role === 1 || role === 0} onClick={() => weave({ main: state.kinRoles[0], contrast: i })}
                        className="border border-charcoal/50 px-1 text-[8px] tracking-widest disabled:opacity-30 hover:bg-charcoal/10"
                        title="Let this family answer the lead">ANSWER</button>
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-[9px] tracking-wider opacity-70">{plan.names.map((n, i) => `${ROLE[i]}: ${n}`).join(' · ')} — WEAVE KIN AGAIN to choose other families</div>
          )}

          {/* acts + tension */}
          <div className="flex flex-col gap-1">
            <div className="flex w-full border border-charcoal/50 text-[9px]" aria-label="Acts">
              {plan.acts.map((a, i) => (
                <div key={i} className="px-1.5 py-1 border-r last:border-r-0 border-charcoal/30 min-w-0"
                  style={{ flexGrow: a.share, flexBasis: 0, background: now?.index === i ? 'rgba(211,84,0,0.16)' : undefined }}
                  title={`${MODE_LINE[a.mode]} — ${a.fams.map((r) => plan.names[r]).filter(Boolean).join(' / ')}`}>
                  <div className="tracking-widest font-bold truncate" style={now?.index === i ? { color: BURNT } : undefined}>{a.label}</div>
                  <div className="opacity-60 truncate">{a.mode.toUpperCase()} · {a.fams.map((r) => plan.names[r]).filter(Boolean)[0] ?? ''}</div>
                </div>
              ))}
            </div>
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-16 border border-charcoal/30 touch-none" aria-label="Tension curve — drag the points">
              {seams.map((x, i) => <line key={i} x1={x * W} x2={x * W} y1={0} y2={H} stroke={CHARCOAL} strokeOpacity={0.15} />)}
              <polyline fill="none" stroke={BURNT} strokeWidth={2} vectorEffect="non-scaling-stroke"
                points={Array.from({ length: 61 }, (_, k) => `${(k / 60) * W},${H - 4 - tensionAt(curve, k / 60) * (H - 8)}`).join(' ')} />
              {curve.map((v, i) => (
                <circle key={i} cx={(i / Math.max(1, curve.length - 1)) * W} cy={H - 4 - v * (H - 8)} r={5}
                  fill={CREAM} stroke={CHARCOAL} strokeWidth={1.5} vectorEffect="non-scaling-stroke"
                  className="cursor-ns-resize" onPointerDown={startPoint(i)}>
                  <title>tension {Math.round(v * 100)} — drag up or down</title>
                </circle>
              ))}
              {f != null && <line x1={f * W} x2={f * W} y1={0} y2={H} stroke={BURNT} strokeWidth={2} vectorEffect="non-scaling-stroke" />}
            </svg>
            <span className="text-[8px] tracking-wider opacity-55">
              TENSION — drag the points: higher = denser, brighter, more sources at once, wider intervals · {now ? `${now.act.label}: ${MODE_LINE[now.act.mode]}` : 'the acts decide who speaks'}
            </span>
          </div>

          <div className="flex flex-wrap gap-4 items-end">
            <Slider label="KIN" value={plan.amt} onChange={(v) => api.setKin({ amt: v })}
              hint="how loud the kin lead is over the rest of the weave" />
            <Slider label="RELAY" value={plan.relay} onChange={(v) => api.setKin({ relay: v })}
              hint="0 = every phrase a new gesture · 1 = one gesture handed through every source" />
            <Slider label="CHORUS" value={plan.chorus} onChange={(v) => api.setKin({ chorus: v })}
              hint="at the peak: 0 = a few sources · 1 = every source at once" />
          </div>
        </>
      )}

      {/* a whole album built the same way */}
      <div className="flex flex-wrap items-center gap-2 border-t border-charcoal/20 pt-2">
        <b className="text-[9px] tracking-[0.25em]">KIN ALBUM</b>
        <select value={albumCount} onChange={(e) => setAlbumCount(Number(e.target.value))}
          className="bg-transparent border border-charcoal/40 px-1 py-0.5 text-[9px] tracking-widest" aria-label="Number of kin album tracks">
          {[4, 5, 6, 7, 8, 9, 10, 12].map((n) => <option key={n} value={n}>{n} TRACKS</option>)}
        </select>
        <span className="flex items-center gap-1 border border-charcoal/40 px-1.5 py-0.5 text-[9px] tracking-widest">
          ~<input type="number" min={2} max={15} step={0.5} value={albumMin}
            onChange={(e) => setAlbumMin(Math.min(15, Math.max(2, Number(e.target.value) || 4)))}
            className="w-9 bg-transparent" aria-label="Kin album track length in minutes" /> MIN EACH
        </span>
        <input value={albumTitle} onChange={(e) => setAlbumTitle(e.target.value)} placeholder="album title"
          className="w-36 bg-transparent border border-charcoal/40 px-1.5 py-0.5 text-[10px] outline-none placeholder:opacity-45" aria-label="Kin album title" />
        <button disabled={noSrc}
          onClick={() => api.weaveKinAlbum({ count: albumCount, minutes: albumMin, knobs, perSource, weights: weights(), title: albumTitle })}
          className="flex items-center gap-1 border-2 px-2 py-1 text-[9px] tracking-widest font-bold disabled:opacity-40"
          style={{ borderColor: CHARCOAL }}
          title="Each track led by another texture family on its own arc (slow burn first, the biggest wave near the end, a fading choir last), related keys, the album rising and falling; the last track returns to the first family. Replaces the album plan (the old one is kept as a backup).">
          <Disc3 size={11} /> WEAVE KIN ALBUM
        </button>
        <span className="text-[8px] tracking-wider opacity-50">a family per track · slow burn → waves → fading choir · the last remembers the first</span>
      </div>
    </div>
  )
}
