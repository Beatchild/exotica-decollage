import { useCallback, useEffect, useRef, useState } from 'react'
import { engine } from '../engine/AudioEngine'
import type { SourceRec } from '../engine/AudioEngine'
import type { ArrClip, ArrTrack } from '../engine/Arranger'
import { finishMaster, isAbort, renderOffline, renderRaw, renderStems, stemBuses } from '../engine/OfflineRenderer'
import type { SourceUsage } from '../engine/OfflineRenderer'
import { deleteCrate, exportCrateFile, importCrateFile, listCrates, loadCrate, saveCrate } from '../engine/Crates'
import { renderSleevePng } from '../engine/SleevePng'
import { DEFAULT_FORMAT, PRESETS, safeName, samplesJson, samplesText, tracklistText } from '../engine/album'
import type { AlbumPlan, AlbumResult, AlbumTrack, ExportFormat } from '../engine/album'
import type { SourceOrigin } from '../engine/provenance'
import type { LoudnessReport } from '../engine/loudness'
import { makeZip } from '../engine/zip'
import { applyMood as applyMoodTo } from '../engine/moods'
import type { MoodKnobs } from '../engine/moods'
import { MEMORY_SLOTS, buildMemoryForm, clearMemoryForm, gatherMemories, isMemoryForm, keyOf, scaleSections } from '../engine/memory'
import { LAYERS_OFF, LAYERS_WEAVE } from '../engine/memoryLayers'
import type { MemoryLayerParams } from '../engine/memoryLayers'
import { arcByKey, contrastOf, findFamilies, makePlan } from '../engine/kin'
import type { KinFamily, KinPlan } from '../engine/kin'
import { isEra, suggestEras } from '../engine/eras'
import { DEFAULT_CHAIN, MASTER_PRESETS, matchChain, toneProfile } from '../engine/mastering'
import { measureLoudness } from '../engine/loudness'
import { releaseNotes, renderCover } from '../engine/release'
import { recordVideo } from '../engine/video'
import type { MasterChain } from '../engine/mastering'
import { MIX_DEFAULT } from '../engine/AudioEngine'
import type { MixLevels } from '../engine/AudioEngine'
import type { Era } from '../engine/eras'
import { toast as pushToast } from '../ui/toast'

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

const toast = (kind: 'error' | 'info' | 'success', text: string) => pushToast(text, kind)
import type { ZipEntry } from '../engine/zip'
import { ytAvailableCheck, ytExpand, spotifyQueries } from '../engine/ytBridge'
import { mulberry32, randomSeed } from '../engine/rng'
import { NUM_VOICES } from '../engine/types'
import type { FiredEvent, MacroParams, PinMode, ScaleName, Scene, Slice, SongSection, VoiceParams } from '../engine/types'

export interface ActiveFire extends FiredEvent {
  until: number // performance.now() ms when the highlight should fade
}

export interface EngineState {
  started: boolean
  playing: boolean
  loading: boolean
  recording: boolean
  rendering: boolean
  micState: 'idle' | 'recording' | 'unavailable'
  sources: SourceRec[]
  slices: Slice[]
  sourceMasks: Array<number[] | null>
  voices: VoiceParams[]
  macros: MacroParams
  masterVolume: number
  masterMuted: boolean
  bpm: number
  telephony: boolean
  crush: boolean
  scale: ScaleName
  drift: boolean
  duck: boolean
  groove: boolean
  radio: boolean
  width: number
  tilt: number
  aqua: number
  looped: boolean
  blockSec: number
  keyLock: boolean
  keyRoot: number
  padMode: boolean
  phraseMode: boolean
  chordName: string | null
  voicing: boolean
  plateShort: boolean
  sub: number
  fragLen: 'fine' | 'mid' | 'long'
  dub: boolean
  tape: boolean
  reverseProb: number
  pings: number
  previewSource: number | null
  armedSliceId: number | null
  arrClips: ArrClip[]
  arrTracks: ArrTrack[]
  arrPlaying: boolean
  arrLoop: boolean
  arrSnap: boolean
  arrLen: number
  freezing: boolean
  seed: number
  sleevePalette: string[] | null
  ytAvailable: boolean
  scenesFilled: boolean[]
  songActive: boolean
  /** the song is a MEMORY WEAVE form (scenes E–H) */
  memoryForm: boolean
  /** its section lengths, seconds (empty when there is no form) */
  memorySecs: number[]
  memLayers: MemoryLayerParams
  /** TEXTURE KIN: the families found in the material, and which play which role */
  kinFamilies: Array<{ name: string; line: string; size: number; sources: number; perSource: Record<number, number> }>
  kinRoles: number[]
  crates: string[]
  /** 0..1 while an offline render runs, else null */
  renderProgress: number | null
  renderLabel: string
  /** short-lived status line, e.g. 'RENDER CANCELLED' */
  notice: string
  /** arrangement BOUNCE recording in progress */
  bouncing: boolean
  /** export loudness target (LUFS) or null = off */
  loudnessTarget: number | null
  mix: MixLevels
  masterChain: MasterChain
  masterBypass: boolean
  /** preset key, or 'custom' once a knob is moved */
  masterPreset: string
  /** EXACT PREVIEW: what is ready, what is playing */
  exactReady: { label: string; lufs: number | null; truePeak: number | null } | null
  exactPlaying: 'mastered' | 'raw' | null
  referenceReport: { name: string; lines: string[] } | null
  canUndo: boolean
  canRedo: boolean
  /** loudness of the last exported master */
  lastReport: LoudnessReport | null
  /** bit depth + sample rate for every export */
  exportFormat: ExportFormat
  /** a sample report for the last export is available */
  hasSampleReport: boolean
  /** does anything in the pool need clearance? */
  poolNeedsClearance: boolean
  /** how pinned dots steer the composition */
  pinMode: PinMode
  pinnedCount: number
}

let ytAvailable = false
let crates: string[] = []
let lastReport: LoudnessReport | null = null
/** usage of the last export → SAMPLE REPORT button */
let lastUsage: { title: string; plan: AlbumPlan; origins: Array<SourceOrigin | undefined> } | null = null
let exportFormat: ExportFormat = (() => {
  try {
    const v = JSON.parse(localStorage.getItem('exotica.format') ?? 'null') as ExportFormat | null
    if (v && (v.bits === 16 || v.bits === 24) && (v.sampleRate === 44100 || v.sampleRate === 48000)) return v
  } catch { /* storage unavailable */ }
  return DEFAULT_FORMAT
})()
let masterPreset = 'warmtape'
// MASTER: the release chain, kept across sessions (it belongs to the release, not a track)
const MASTER_KEY = 'exotica.master.v1'
;(() => {
  try {
    const v = JSON.parse(localStorage.getItem(MASTER_KEY) ?? 'null') as { chain?: Partial<MasterChain>; bypass?: boolean; preset?: string } | null
    if (v?.chain) engine.masterChain = { ...DEFAULT_CHAIN, ...v.chain }
    if (v?.bypass != null) engine.masterBypass = !!v.bypass
    if (v?.preset) masterPreset = v.preset
  } catch { /* storage unavailable */ }
})()
function saveMaster() {
  try {
    localStorage.setItem(MASTER_KEY, JSON.stringify({ chain: engine.masterChain, bypass: engine.masterBypass, preset: masterPreset }))
  } catch { /* storage unavailable */ }
}
/** the chain every export gets (none when MASTER is switched off) */
const exportChain = () => (engine.masterBypass ? undefined : { ...engine.masterChain })

let loudnessTarget: number | null = (() => {
  try {
    const v = localStorage.getItem('exotica.lufs')
    if (v === 'off') return null
    if (v != null && Number.isFinite(Number(v))) return Number(v)
  } catch { /* storage unavailable */ }
  return -14
})()

interface Flags {
  loading: boolean
  recording: boolean
  rendering: boolean
  freezing: boolean
  micState: EngineState['micState']
  renderProgress: number | null
  renderLabel: string
  notice: string
  bouncing: boolean
}

const snapshot = (f: Flags): EngineState => ({
  started: engine.started,
  playing: engine.playing,
  loading: f.loading,
  recording: f.recording,
  rendering: f.rendering,
  micState: f.micState,
  sources: [...engine.sources],
  slices: [...engine.slices],
  sourceMasks: engine.sourceMasks.map((m) => (m ? [...m] : null)),
  voices: engine.voices,
  macros: engine.macros,
  masterVolume: engine.masterVolume,
  masterMuted: engine.masterMuted,
  bpm: engine.bpm,
  telephony: engine.telephony,
  crush: engine.crush,
  scale: engine.scale,
  drift: engine.drift,
  duck: engine.duck,
  groove: engine.groove,
  radio: engine.radio,
  width: engine.width,
  tilt: engine.tilt,
  aqua: engine.aqua,
  looped: engine.looped,
  blockSec: engine.blockSec,
  keyLock: engine.keyLock,
  keyRoot: engine.keyRoot,
  padMode: engine.padMode,
  phraseMode: engine.phraseMode,
  chordName: engine.currentChordName(),
  voicing: engine.voicing,
  plateShort: engine.plateShort,
  sub: engine.sub,
  fragLen: engine.fragLen,
  dub: engine.dub,
  tape: engine.tape,
  reverseProb: engine.reverseProb,
  pings: engine.pings,
  previewSource: engine.previewSource,
  armedSliceId: engine.armedSliceId,
  arrClips: engine.arranger.clips.map((c) => ({ ...c })),
  arrTracks: engine.arranger.tracks.map((t) => ({ ...t })),
  arrPlaying: engine.arranger.playing,
  arrLoop: engine.arranger.loop,
  arrSnap: engine.arranger.snap,
  arrLen: engine.arranger.length(),
  freezing: f.freezing,
  seed: engine.seed,
  sleevePalette: engine.sleevePalette,
  ytAvailable,
  scenesFilled: engine.scenes.map((s) => s !== null),
  songActive: engine.songActive,
  memoryForm: isMemoryForm(engine),
  memorySecs: isMemoryForm(engine) ? engine.songSections.map((x) => x.sec) : [],
  memLayers: { ...engine.memLayers },
  kinFamilies: kinFams.map((f) => ({ name: f.name, line: f.line, size: f.ids.length, sources: f.sources.length, perSource: f.perSource })),
  kinRoles: engine.memLayers.kin ? [...kinRoles] : [],
  crates,
  renderProgress: f.renderProgress,
  renderLabel: f.renderLabel,
  notice: f.notice,
  bouncing: f.bouncing,
  loudnessTarget,
  mix: { ...engine.mix },
  masterChain: { ...engine.masterChain },
  masterBypass: engine.masterBypass,
  masterPreset,
  exactReady: exact ? { label: exact.label, lufs: exact.report?.integrated ?? null, truePeak: exact.report?.truePeak ?? null } : null,
  exactPlaying,
  referenceReport,
  canUndo: undoStack.length > 0,
  canRedo: redoStack.length > 0,
  lastReport,
  exportFormat,
  hasSampleReport: lastUsage !== null,
  poolNeedsClearance: engine.sources.some((s) => s.origin?.needsClearance !== false),
  pinMode: engine.pinMode,
  pinnedCount: engine.slices.reduce((n, s) => n + (s.pinned ? 1 : 0), 0),
})

// ---------- shareable URL state ----------

interface UrlState {
  s: number
  m: [number, number, number]
  v: Array<[number, number, number, number, number, number]>
  bpm: number
  tel: number
  cr: number
  sc: ScaleName
  dr: number
  dk?: number
  gv?: number
  w?: number
  tl?: number
  aq?: number
  ll?: number
  blk?: number
  kl?: number
  kr?: number
  pd?: number
  phm?: number
  vc?: number
  ps?: number
  sb?: number
  fl?: string
  db?: number
  tp?: number
  rv?: number
  pn?: number
  pm?: PinMode
  /** song sequence (always written by new patches; [] = no song) */
  sg?: SongSection[]
  /** scenes referenced by sg, by slot */
  scn?: Record<number, Scene>
  /** pinned slice ids */
  pins?: number[]
  /** memory layers */
  ml?: MemoryLayerParams
  /** per-source era, by source index */
  era?: Array<Era | null>
  /** MIX faders */
  mx?: MixLevels
  rt?: Array<number[] | null>
  vol: number
  stems: string[]
}

// EXACT PREVIEW buffers (mastered + level-matched raw) and their player
let exact: { mastered: AudioBuffer; raw: AudioBuffer; label: string; report: LoudnessReport | null } | null = null
let exactSrc: AudioBufferSourceNode | null = null
let exactT0 = 0
let exactOffset = 0
let exactPlaying: 'mastered' | 'raw' | null = null
let referenceReport: { name: string; lines: string[] } | null = null

// UNDO: whole-studio snapshots (patch + master), taken when the hash is written
interface UndoEntry { patch: UrlState; master: MasterChain; preset: string; bypass: boolean; key: string }
const undoStack: UndoEntry[] = []
const redoStack: UndoEntry[] = []
let undoLast: UndoEntry | null = null
let undoMuted = false

function undoCurrent(): UndoEntry {
  const patch = capturePatch()
  // while a song morphs or drift wanders, voices/macros/tempo move by themselves: not an edit
  const moving = engine.songActive || engine.drift
  const keyPatch = moving ? { ...patch, v: [], m: [0, 0, 0], bpm: 0 } : patch
  const master = { ...engine.masterChain }
  return { patch, master, preset: masterPreset, bypass: engine.masterBypass, key: JSON.stringify([keyPatch, master, engine.masterBypass]) }
}

function noteUndo() {
  if (undoMuted || !engine.started) return
  const cur = undoCurrent()
  if (undoLast && undoLast.key !== cur.key) {
    undoStack.push(undoLast)
    if (undoStack.length > 60) undoStack.shift()
    redoStack.length = 0
  }
  undoLast = cur
}

function restoreUndo(e: UndoEntry) {
  undoMuted = true
  try {
    const wasPlaying = engine.playing
    if (wasPlaying) engine.pause()
    applyPatch(e.patch)
    masterPreset = e.preset
    engine.setMasterChain(e.master)
    engine.setMasterBypass(e.bypass)
    saveMaster()
    if (wasPlaying) engine.play()
    undoLast = undoCurrent()
  } finally {
    undoMuted = false
  }
}

function writeHash() {
  noteUndo()
  const st = capturePatch()
  const enc = btoa(JSON.stringify(st)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  history.replaceState(null, '', `#p=${enc}`)
}

/** Apply a captured patch to the engine (everything except the source pool). */
function applyPatch(url: UrlState) {
  engine.reseed(url.s)
  engine.setMacro('decayFactor', url.m[0])
  engine.setMacro('tapeAging', url.m[1])
  engine.setMacro('chaos', url.m[2])
  url.v.slice(0, NUM_VOICES).forEach(([level, mute, solo, density, pitchRange, reverbSend], i) => {
    engine.setVoiceParam(i, 'level', level)
    engine.setVoiceParam(i, 'mute', !!mute)
    engine.setVoiceParam(i, 'solo', !!solo)
    engine.setVoiceParam(i, 'density', density)
    engine.setVoiceParam(i, 'pitchRange', pitchRange)
    engine.setVoiceParam(i, 'reverbSend', reverbSend)
  })
  engine.bpm = url.bpm
  engine.setTelephony(!!url.tel)
  engine.setCrush(!!url.cr)
  engine.setScale(url.sc)
  engine.setDuck(!!url.dk)
  engine.setGroove(!!url.gv)
  engine.setWidth(url.w ?? 0.5)
  engine.setTilt(url.tl ?? 0)
  engine.setAqua(url.aq ?? 0)
  engine.setLooped(!!url.ll)
  engine.setBlockSec(url.blk ?? 0)
  engine.setKeyLock(!!url.kl)
  engine.setKeyRoot(url.kr ?? 0)
  engine.setPadMode(!!url.pd)
  engine.setPhraseMode(!!url.phm)
  engine.setVoicing(!!url.vc)
  engine.setPlateShort(!!url.ps)
  engine.setSub(url.sb ?? 0)
  const fl = url.fl === 'mid' || url.fl === 'long' ? url.fl : 'fine'
  if (engine.fragLen !== fl) engine.setFragLen(fl) // re-slices every source: only when it changes
  engine.setDub(!!url.db)
  engine.setTape(!!url.tp)
  engine.setReverseProb(url.rv ?? 0)
  engine.setPings(url.pn ?? 0)
  if (url.pm) engine.pinMode = url.pm
  if (url.pins) {
    for (const sl of engine.slices) sl.pinned = false
    engine.setPinned(url.pins, true)
  }
  engine.setMemoryLayers(url.ml ? { ...LAYERS_OFF, ...url.ml } : LAYERS_OFF)
  engine.setMix(url.mx ? { ...MIX_DEFAULT, ...url.mx } : MIX_DEFAULT)
  engine.sources.forEach((src, i) => {
    const e = url.era?.[i]
    src.era = isEra(e) ? e : 'none'
  })
  if (url.sg) {
    engine.stopSong()
    if (url.scn) for (const [slot, sc] of Object.entries(url.scn)) engine.scenes[Number(slot)] = sc
    engine.songSections = url.sg.filter((x) => engine.scenes[x.scene])
  }
  engine.setMasterVolume(url.vol)
  if (url.rt) engine.sourceMasks = engine.sourceMasks.map((_, i) => url.rt![i] ?? null)
  engine.setDrift(!!url.dr)
}

function capturePatch(): UrlState {
  return {
    s: engine.seed,
    m: [engine.macros.decayFactor, engine.macros.tapeAging, engine.macros.chaos],
    v: engine.voices.map((v) => [
      v.level, v.mute ? 1 : 0, v.solo ? 1 : 0, v.density, v.pitchRange, v.reverbSend,
    ]) as UrlState['v'],
    bpm: engine.bpm,
    tel: engine.telephony ? 1 : 0,
    cr: engine.crush ? 1 : 0,
    sc: engine.scale,
    dr: engine.drift ? 1 : 0,
    dk: engine.duck ? 1 : 0,
    gv: engine.groove ? 1 : 0,
    w: engine.width,
    tl: engine.tilt,
    aq: engine.aqua,
    ll: engine.looped ? 1 : 0,
    blk: engine.blockSec,
    kl: engine.keyLock ? 1 : 0,
    kr: engine.keyRoot,
    pd: engine.padMode ? 1 : 0,
    phm: engine.phraseMode ? 1 : 0,
    vc: engine.voicing ? 1 : 0,
    ps: engine.plateShort ? 1 : 0,
    sb: engine.sub,
    fl: engine.fragLen,
    db: engine.dub ? 1 : 0,
    tp: engine.tape ? 1 : 0,
    rv: engine.reverseProb,
    pn: engine.pings,
    pm: engine.pinMode,
    sg: engine.songSections.map((x) => ({ ...x })),
    scn: Object.fromEntries(
      [...new Set(engine.songSections.map((x) => x.scene))]
        .filter((i) => engine.scenes[i])
        .map((i) => [i, engine.scenes[i]!]),
    ),
    pins: engine.slices.filter((x) => x.pinned).map((x) => x.id),
    ml: { ...engine.memLayers },
    era: engine.sources.map((x) => x.era ?? 'none'),
    mx: { ...engine.mix },
    rt: engine.sourceMasks,
    vol: engine.masterVolume,
    stems: engine.sources.filter((x) => x.stemKey).map((x) => x.stemKey!),
  }
}

function readHash(): UrlState | null {
  const m = location.hash.match(/#p=([A-Za-z0-9_-]+)/)
  if (!m) return null
  try {
    return JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))) as UrlState
  } catch {
    return null
  }
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// dev-only handle for console probing
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__renderOffline = renderOffline
}

/** Parse a song string like "A:60 B:90 C:45" into scene sections. */
export function parseSong(text: string): SongSection[] {
  const out: SongSection[] = []
  for (const m of text.matchAll(/([A-Ha-h])\s*:\s*(\d+)/g)) {
    out.push({ scene: m[1].toUpperCase().charCodeAt(0) - 65, sec: Math.max(4, Number(m[2])) })
  }
  return out
}

export interface WeaveOpts {
  /** false: keep the current pins */
  regather?: boolean
  perSource?: number
  /** per source index: 0 = leave out … 2 = double */
  weights?: Record<number, number>
  /** force a key instead of reading it from the fragments */
  key?: number
  motifSeed?: number
  /** don't suggest eras even if none are set */
  keepEras?: boolean
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function shuffle<T>(a: T[], rng: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const ALBUM_TITLES = [
  'მტვერი სხვენზე', 'დედის კასეტა', 'ზაფხული, რომელიც არ ყოფილა', 'ბებიის რადიო',
  'ფირი 1987', 'სახლი წყლის ქვეშ', 'ხმა კედლის მიღმა', 'ძველი ფოტოს ფერები',
  'დავიწყებული იავნანა', 'სადგური, სადაც არავინ ჩამოდის', 'ზეთის ლამპა', 'ჩაძირული ეზო',
]

/** mean brightness of a source's slices (for era suggestions) */
const sourceCentroid = (i: number) => {
  const own = engine.slices.filter((x) => x.sourceIdx === i)
  return own.length ? own.reduce((n, x) => n + x.centroid, 0) / own.length : 1500
}

/**
 * The weave itself, without transport: FORGOTTEN MEMORY on the desk, the
 * gathered (or kept) fragments pinned, the key, the layers, the form.
 */
function weaveInto(minutes: number, knobs: MoodKnobs, opts: WeaveOpts) {
  applyMoodTo(engine, 'memory', knobs) // re-slices long first: pins must come after
  let pins = engine.pinnedSlices()
  if (opts.regather !== false || pins.length === 0) {
    const groups = gatherMemories(engine, opts.perSource ?? 6, opts.weights ?? {})
    for (const sl of engine.slices) sl.pinned = false
    engine.setPinned(groups.flatMap((g) => g.ids), true)
    pins = engine.pinnedSlices()
  }
  engine.setPinMode(pins.length >= 10 ? 'only' : 'favor')
  engine.setKeyRoot(opts.key ?? keyOf(pins))
  // each source on its own old medium, unless the user has already chosen
  if (!opts.keepEras && engine.sources.every((x) => !x.era || x.era === 'none')) {
    const live = engine.sources.map((x, i) => ({ x, i })).filter((o) => !o.x.bed)
    const eras = suggestEras(live.map((o) => sourceCentroid(o.i)))
    live.forEach((o, k) => (o.x.era = eras[k]))
  }
  const prev = engine.memLayers
  engine.memLayers = {
    ...(prev.stretch || prev.motif || prev.ghosts ? { ...prev, loop: prev.loop ?? LAYERS_WEAVE.loop, lines: prev.lines ?? LAYERS_WEAVE.lines } : { ...prev, ...LAYERS_WEAVE }),
    motifSeed: opts.motifSeed ?? (prev.motifSeed > 1 ? prev.motifSeed : randomSeed()),
    kin: undefined, // a plain weave: no texture-kin lead
  }
  buildMemoryForm(engine, minutes)
}


// ---------- TEXTURE KIN ----------

export interface KinOpts {
  arc?: string
  /** family indices (into the found families) for the main and contrast roles */
  main?: number
  contrast?: number
  perSource?: number
  weights?: Record<number, number>
  key?: number
  tension?: number[]
  relay?: number
  chorus?: number
  amt?: number
  motifSeed?: number
  keepEras?: boolean
}

/** the families found in the material, for the KIN panel (same material → same families) */
let kinFams: KinFamily[] = []
let kinRoles: number[] = []
const KIN_SEED = 1
/** what the memory layers do under a KIN weave: the kin lead, the rest as atmosphere */
const LAYERS_KIN = { stretch: 0.4, motif: 0.2, ghosts: 0.15, loop: 0.55, lines: 0.4 }

function kinInto(minutes: number, knobs: MoodKnobs, o: KinOpts): boolean {
  applyMoodTo(engine, 'memory', knobs) // re-slices long first: families and pins after
  kinFams = findFamilies(engine.slices, engine.sources, KIN_SEED, o.perSource ?? 5, o.weights ?? {})
  if (kinFams.length < 2) return false
  const main = Math.min(kinFams.length - 1, Math.max(0, o.main ?? 0))
  let contrast = o.contrast ?? -1
  if (contrast < 0 || contrast === main || contrast >= kinFams.length) contrast = contrastOf(kinFams, main)
  const third = contrastOf(kinFams, main, [contrast])
  kinRoles = [main, contrast, third].filter((r) => r >= 0)
  const arc = arcByKey(o.arc ?? 'classic')
  const plan = makePlan(kinFams, kinRoles, arc, { amt: o.amt, relay: o.relay, chorus: o.chorus, tension: o.tension })
  for (const sl of engine.slices) sl.pinned = false
  engine.setPinned([...new Set(plan.families.flat())], true)
  const pins = engine.pinnedSlices()
  engine.setPinMode(pins.length >= 10 ? 'only' : 'favor')
  engine.setKeyRoot(o.key ?? keyOf(pins))
  if (!o.keepEras && engine.sources.every((x) => !x.era || x.era === 'none')) {
    const live = engine.sources.map((x, i) => ({ x, i })).filter((q) => !q.x.bed)
    const eras = suggestEras(live.map((q) => sourceCentroid(q.i)))
    live.forEach((q, k) => (q.x.era = eras[k]))
  }
  const prev = engine.memLayers
  engine.memLayers = {
    ...(prev.kin ? { ...prev } : { ...prev, ...LAYERS_KIN }),
    motifSeed: o.motifSeed ?? (prev.motifSeed > 1 ? prev.motifSeed : randomSeed()),
    kin: plan,
  }
  buildMemoryForm(engine, minutes)
  engine.songSections = scaleSections(arc.sections.map((x) => x * 1000), minutes)
  return true
}

/**
 * A drama for the album — where each track sits in the whole: a slow burn
 * opens, the biggest wave comes at ~60 %, a fading choir closes; between
 * them no two neighbours share an arc.
 */
function albumArcs(count: number): string[] {
  if (count <= 1) return ['classic']
  const peak = Math.round((count - 1) * 0.6)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    let a = i === 0 ? 'slowburn' : i === count - 1 ? 'fading' : i === peak ? 'waves' : ['classic', 'slowburn', 'classic', 'waves'][i % 4]
    if (i !== peak && i !== 0 && i !== count - 1 && (a === out[i - 1] || (i === peak - 1 && a === 'waves'))) a = out[i - 1] === 'classic' ? 'slowburn' : 'classic'
    if (i === peak && out[i - 1] === 'waves') out[i - 1] = 'classic'
    out.push(a)
  }
  return out
}

/** Bridges the imperative AudioEngine singleton into React state. */
export function useAudioEngine() {
  const flags = useRef<Flags>({
    loading: false,
    recording: false,
    rendering: false,
    freezing: false,
    micState: 'idle',
    renderProgress: null,
    renderLabel: '',
    notice: '',
    bouncing: false,
  })
  const [state, setState] = useState<EngineState>(() => snapshot(flags.current))
  const firesRef = useRef<ActiveFire[]>([])
  const hashTimer = useRef(0)

  const sync = useCallback(() => {
    setState(snapshot(flags.current))
    if (engine.started) {
      window.clearTimeout(hashTimer.current)
      hashTimer.current = window.setTimeout(writeHash, 400)
    }
  }, [])

  useEffect(() => {
    const offFired = engine.onFired((e) => {
      const now = performance.now()
      const fires = firesRef.current.filter((f) => f.until > now)
      fires.push({ ...e, until: now + Math.max(250, e.durationSec * 1000) })
      firesRef.current = fires
    })
    const offChange = engine.onChange(() => setState(snapshot(flags.current)))
    return () => {
      offFired()
      offChange()
    }
  }, [])

  const start = useCallback(async () => {
    flags.current.loading = true
    sync()
    ytAvailable = await ytAvailableCheck()
    try {
      crates = await listCrates()
    } catch {
      crates = []
    }
    await engine.init()
    const url = readHash()
    if (url) {
      // stems first (slicing honours the fragment length), then the patch
      if (url.fl === 'mid' || url.fl === 'long') engine.setFragLen(url.fl)
      for (const key of url.stems.length ? url.stems : ['epiano']) await engine.addStem(key)
      applyPatch(url)
    } else {
      await engine.addStem('epiano')
    }
    flags.current.loading = false
    sync()
  }, [sync])

  const withLoading = useCallback(
    async (fn: () => Promise<void>) => {
      flags.current.loading = true
      sync()
      try {
        await fn()
      } finally {
        flags.current.loading = false
        sync()
      }
    },
    [sync],
  )

  // ---------- render bookkeeping ----------

  // one controller per render job; album tracks get a child controller so a
  // single track can be skipped without stopping the whole job
  const jobRef = useRef<AbortController | null>(null)
  const trackRef = useRef<AbortController | null>(null)
  const noticeTimer = useRef(0)

  const notify = useCallback((text: string) => {
    flags.current.notice = text
    pushToast(text, /FAILED/.test(text) ? 'error' : 'info')
    sync()
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => {
      flags.current.notice = ''
      setState(snapshot(flags.current))
    }, 3500)
  }, [sync])

  const beginRender = useCallback((label: string): AbortSignal => {
    const c = new AbortController()
    jobRef.current = c
    flags.current.rendering = true
    flags.current.renderProgress = 0
    flags.current.renderLabel = label
    flags.current.notice = ''
    sync()
    return c.signal
  }, [sync])

  /** progress callback, throttled to ~1% steps so React isn't flooded */
  const progressTo = useCallback(
    (from = 0, span = 1) => (f: number) => {
      const p = from + f * span
      const prev = flags.current.renderProgress ?? 0
      if (p - prev >= 0.01 || p >= 1) {
        flags.current.renderProgress = Math.min(1, p)
        setState(snapshot(flags.current))
      }
    },
    [],
  )

  const endRender = useCallback(() => {
    jobRef.current = null
    trackRef.current = null
    flags.current.rendering = false
    flags.current.renderProgress = null
    flags.current.renderLabel = ''
    sync()
  }, [sync])

  const masterOpts = useCallback(
    () => ({
      targetLufs: loudnessTarget,
      ceilingDb: -1,
      chain: exportChain(),
      onReport: (r: { after: LoudnessReport }) => {
        lastReport = r.after
      },
    }),
    [],
  )

  /**
   * Stop whatever is rendering (RENDER / STEMS / LOOP / REMIX / ALBUM) or a
   * running arrangement BOUNCE. Nothing half-finished is downloaded, except
   * that an album still zips the tracks it already finished.
   */
  const cancelRender = useCallback(() => {
    jobRef.current?.abort()
    if (flags.current.bouncing) {
      engine.arranger.onEnd = null
      engine.arranger.stop()
      engine.stopRecording()
      flags.current.bouncing = false
      flags.current.recording = false
      notify('BOUNCE CANCELLED')
    }
  }, [notify])

  /** Album only: abandon the track being rendered and go on with the next. */
  const skipAlbumTrack = useCallback(() => {
    trackRef.current?.abort()
  }, [])

  /** Run a render job; an AbortError becomes a quiet 'cancelled' notice. */
  const runJob = useCallback(
    async (label: string, job: (signal: AbortSignal) => Promise<void>) => {
      if (flags.current.rendering || engine.slices.length === 0) return
      const signal = beginRender(label)
      try {
        await job(signal)
      } catch (err) {
        if (isAbort(err)) notify(`${label} CANCELLED`)
        else {
          console.error(err)
          notify(`${label} FAILED`)
        }
      } finally {
        endRender()
      }
    },
    [beginRender, endRender, notify],
  )

  const setExportFormat = useCallback((f: Partial<ExportFormat>) => {
    exportFormat = { ...exportFormat, ...f }
    try {
      localStorage.setItem('exotica.format', JSON.stringify(exportFormat))
    } catch { /* storage unavailable */ }
    sync()
  }, [sync])

  /** sample rate + bit depth + tags for single (non-album) exports */
  const formatOpts = useCallback(
    (title: string) => ({
      sampleRate: exportFormat.sampleRate,
      format: {
        bits: exportFormat.bits,
        meta: { title, software: 'Exotica Décollage', comment: `seed ${engine.seed}`, extra: { SEED: String(engine.seed) } },
      },
      onUsage: (usage: SourceUsage[]) => {
        const origins = engine.sources.map((s) => s.origin)
        lastUsage = {
          title,
          origins,
          plan: {
            title, artist: '', targetLufs: loudnessTarget, ceilingDb: -1, format: exportFormat,
            tracks: [{ id: 0, title, seed: engine.seed, preset: null, minutes: 0, status: 'done', progress: 1, number: 1, usage }],
          },
        }
      },
    }),
    [],
  )

  /** samples.txt for whatever was exported last (RENDER / LOOP / ALBUM). */
  const downloadSampleReport = useCallback(() => {
    if (!lastUsage) return
    const blob = new Blob(['\ufeff' + samplesText(lastUsage.plan, lastUsage.origins)], { type: 'text/plain;charset=utf-8' })
    downloadBlob(blob, `${safeName(lastUsage.title)} — samples.txt`)
  }, [])

  const setLoudnessTarget = useCallback((v: number | null) => {
    loudnessTarget = v
    try {
      localStorage.setItem('exotica.lufs', v == null ? 'off' : String(v))
    } catch { /* storage unavailable */ }
    sync()
  }, [sync])

  const play = useCallback(() => {
    engine.play()
    sync()
  }, [sync])

  const pause = useCallback(() => {
    engine.pause()
    sync()
  }, [sync])

  const reset = useCallback(() => {
    engine.reset()
    sync()
  }, [sync])

  const addStem = useCallback(
    (key: string) => withLoading(() => engine.addStem(key)),
    [withLoading],
  )

  const loadFile = useCallback(
    (file: File) =>
      withLoading(async () => {
        try {
          await engine.addFile(file)
        } catch {
          toast('error', `Could not decode "${file.name}" — this browser may not support the format.`)
        }
      }),
    [withLoading],
  )

  const loadImage = useCallback(
    (file: File) =>
      withLoading(async () => {
        try {
          await engine.addImage(file)
        } catch {
          toast('error', `Could not read "${file.name}" as an image.`)
        }
      }),
    [withLoading],
  )

  /**
   * Parallel remixes of the downloaded material: N offline renders run
   * simultaneously, every variant with its own seed, macros, scale, groove
   * and duck — all voices restricted to the ingested (YT/Mixtape/Weave/
   * Freeze) sources.
   */
  const remixCollages = useCallback(async (count: number, minutes: number) => {
    if (flags.current.rendering || engine.slices.length === 0) return
    const remixable = engine.sources
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => /^(YT|Mixtape|Weave|Freeze)/.test(s.name))
      .map(({ i }) => i)
    if (remixable.length === 0) {
      toast('error', 'No YouTube / Freeze sources in the pool — paste links (CUT) first.')
      return
    }
    await runJob(`REMIX ×${count}`, async (signal) => {
      const base = randomSeed()
      const done: number[] = Array(count).fill(0)
      const scales: ScaleName[] = ['free', 'pentatonic', 'wholetone', 'fifths']
      await Promise.all(
        Array.from({ length: count }, (_, i) => {
          const seed = base + i * 104729
          const rng = mulberry32(seed)
          return renderOffline(engine, minutes, {
            seed,
            macros: {
              decayFactor: 0.25 + rng() * 0.65,
              tapeAging: 0.2 + rng() * 0.6,
              chaos: 0.15 + rng() * 0.65,
            },
            scale: scales[Math.floor(rng() * scales.length)],
            groove: rng() < 0.4,
            duck: rng() < 0.5,
            sourceFilter: remixable,
            master: masterOpts(),
            signal,
            onProgress: (f) => {
              done[i] = f
              progressTo()(done.reduce((a, b) => a + b, 0) / count)
            },
          })
        }),
      ).then((blobs) =>
        // all-or-nothing: a cancel drops every variant, not a random subset
        blobs.forEach((blob, i) => downloadBlob(blob, `exotica-remix-${i + 1}-seed${base + i * 104729}.wav`)),
      )
    })
  }, [masterOpts, progressTo, runJob])

  /**
   * Accepts free text with one or many YouTube links. Multi-link assembly
   * mode: collage / mixtape / interleave. `auto` chains parallel remixes
   * right after ingestion — paste links, come back to WAVs.
   */
  const addYouTube = useCallback(
    (
      text: string,
      opts?: {
        mode?: 'collage' | 'mixtape' | 'interleave'
        auto?: boolean
        remixCount?: number
        minutes?: number
      },
    ) =>
      withLoading(async () => {
        const links = text.match(/https?:\/\/[^\s,"'<>]+/g) ?? []
        const ytLinks = links.filter((u) => /youtube\.com|youtu\.be/.test(u))
        const spLinks = links.filter((u) => /open\.spotify\.com/.test(u))
        if (ytLinks.length === 0 && spLinks.length === 0) {
          toast('error', 'No YouTube or Spotify links found in the input.')
          return
        }
        const fetchables: string[] = []
        const expandFails: string[] = []
        for (const u of ytLinks) {
          if (/[?&]list=|\/playlist\b/.test(u)) {
            try {
              fetchables.push(...(await ytExpand(u)))
            } catch (e) {
              expandFails.push(`${u} — ${e instanceof Error ? e.message : e}`)
            }
          } else fetchables.push(u)
        }
        for (const u of spLinks) {
          try {
            fetchables.push(...(await spotifyQueries(u)).map((q) => `ytsearch1:${q}`))
          } catch (e) {
            expandFails.push(`${u} — ${e instanceof Error ? e.message : e}`)
          }
        }
        if (fetchables.length === 0) {
          toast('error', expandFails.join('\n') || 'Nothing fetchable found in the input.')
          return
        }
        try {
          const { failed, wav } = await engine.addYouTubeCollage(fetchables, opts?.mode ?? 'collage')
          if (wav) downloadBlob(wav, `exotica-mixtape-${Date.now()}.wav`)
          const allFails = [...expandFails, ...failed]
          if (allFails.length) toast('error', `Some links failed:\n${allFails.join('\n')}`)
        } catch (err) {
          toast('error', `Fetch failed: ${err instanceof Error ? err.message : err}`)
          return
        }
        if (opts?.auto) {
          await remixCollages(opts.remixCount ?? 3, opts.minutes ?? 2)
        }
      }),
    [withLoading, remixCollages],
  )

  const removeSource = useCallback((idx: number) => {
    engine.removeSource(idx)
    sync()
  }, [sync])

  const sampleFromMic = useCallback(async (seconds = 8) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      flags.current.micState = 'unavailable'
      sync()
      return
    }
    flags.current.micState = 'recording'
    sync()
    try {
      await engine.sampleFromMic(seconds)
    } catch {
      toast('error', 'Microphone unavailable — permission denied or no input device.')
    }
    flags.current.micState = 'idle'
    sync()
  }, [sync])

  const editBoundary = useCallback((sourceIdx: number, time: number, tolerance: number) => {
    engine.editBoundary(sourceIdx, time, tolerance)
    sync()
  }, [sync])

  const cycleCategory = useCallback((sliceId: number) => {
    engine.cycleCategory(sliceId)
    sync()
  }, [sync])

  const toggleRouting = useCallback((voice: number, sourceIdx: number) => {
    engine.toggleRouting(voice, sourceIdx)
    sync()
  }, [sync])

  const reseed = useCallback(() => {
    engine.reseed()
    sync()
  }, [sync])

  const setScale = useCallback((s: ScaleName) => {
    engine.setScale(s)
    sync()
  }, [sync])

  const setDrift = useCallback((on: boolean) => {
    engine.setDrift(on)
    sync()
  }, [sync])

  const setDuck = useCallback((on: boolean) => {
    engine.setDuck(on)
    sync()
  }, [sync])

  const setGroove = useCallback((on: boolean) => {
    engine.setGroove(on)
    sync()
  }, [sync])

  const setRadio = useCallback((on: boolean) => {
    engine.setRadio(on)
    sync()
  }, [sync])

  const setWidth = useCallback((v: number) => {
    engine.setWidth(v)
    sync()
  }, [sync])

  const setTilt = useCallback((v: number) => {
    engine.setTilt(v)
    sync()
  }, [sync])

  const setAqua = useCallback((v: number) => {
    engine.setAqua(v)
    sync()
  }, [sync])

  const setLooped = useCallback((on: boolean) => {
    engine.setLooped(on)
    sync()
  }, [sync])

  const setBlockSec = useCallback((sec: number) => {
    engine.setBlockSec(sec)
    sync()
  }, [sync])

  const setKeyLock = useCallback((on: boolean) => {
    engine.setKeyLock(on)
    sync()
  }, [sync])

  const setPadMode = useCallback((on: boolean) => {
    engine.setPadMode(on)
    sync()
  }, [sync])

  const setVoicing = useCallback((on: boolean) => {
    engine.setVoicing(on)
    sync()
  }, [sync])

  const setPhraseMode = useCallback((on: boolean) => {
    engine.setPhraseMode(on)
    sync()
  }, [sync])

  const loopArmed = useCallback(() => {
    engine.loopArmed()
    sync()
  }, [sync])

  const peklerPreset = useCallback(() => {
    engine.applyPeklerPreset()
    sync()
  }, [sync])

  const afrikaPreset = useCallback(() => {
    engine.applyAfrikaPreset()
    sync()
  }, [sync])

  const templetonPreset = useCallback(() => {
    engine.applyTempletonPreset()
    sync()
  }, [sync])

  const jelinekPreset = useCallback(() => {
    engine.applyJelinekPreset()
    sync()
  }, [sync])

  const poirierPreset = useCallback(() => {
    engine.applyPoirierPreset()
    sync()
  }, [sync])

  const jeckPreset = useCallback(() => {
    engine.applyJeckPreset()
    sync()
  }, [sync])

  const caretakerPreset = useCallback(() => {
    engine.applyCaretakerPreset()
    sync()
  }, [sync])

  const polePreset = useCallback(() => {
    engine.applyPolePreset()
    sync()
  }, [sync])

  const booksPreset = useCallback(() => {
    engine.applyBooksPreset()
    sync()
  }, [sync])

  const hassellPreset = useCallback(() => {
    engine.applyHassellPreset()
    sync()
  }, [sync])

  const loscilPreset = useCallback(() => {
    engine.applyLoscilPreset()
    sync()
  }, [sync])

  const gesPreset = useCallback(() => {
    engine.applyGesPreset()
    sync()
  }, [sync])

  const ielasiPreset = useCallback(() => {
    engine.applyIelasiPreset()
    sync()
  }, [sync])

  const microstoriaPreset = useCallback(() => {
    engine.applyMicrostoriaPreset()
    sync()
  }, [sync])

  const keszlerPreset = useCallback(() => {
    engine.applyKeszlerPreset()
    sync()
  }, [sync])

  const buddPreset = useCallback(() => {
    engine.applyBuddPreset()
    sync()
  }, [sync])

  const setPlateShort = useCallback((on: boolean) => {
    engine.setPlateShort(on)
    sync()
  }, [sync])

  const setSub = useCallback((v: number) => {
    engine.setSub(v)
    sync()
  }, [sync])

  const setFragLen = useCallback((mode: 'fine' | 'mid' | 'long') => {
    engine.setFragLen(mode)
    sync()
  }, [sync])

  const setDubMode = useCallback((on: boolean) => {
    engine.setDub(on)
    sync()
  }, [sync])

  const setTapeMode = useCallback((on: boolean) => {
    engine.setTape(on)
    sync()
  }, [sync])

  const setPings = useCallback((v: number) => {
    engine.setPings(v)
    sync()
  }, [sync])

  const setReverseProb = useCallback((v: number) => {
    engine.setReverseProb(v)
    sync()
  }, [sync])

  const toggleBed = useCallback((idx: number) => {
    engine.toggleBed(idx)
    sync()
  }, [sync])

  const freeze = useCallback(async (seconds = 12) => {
    if (flags.current.freezing || !engine.playing) return
    flags.current.freezing = true
    sync()
    try {
      await engine.freezeResample(seconds)
    } finally {
      flags.current.freezing = false
      sync()
    }
  }, [sync])

  const playArmedAt = useCallback((semitones: number) => engine.playArmedAt(semitones), [])

  // ---------- scenes & song ----------

  const saveScene = useCallback((slot: number) => {
    engine.saveScene(slot)
    sync()
  }, [sync])

  const morphScene = useCallback((slot: number, seconds = 10) => {
    engine.morphTo(slot, seconds)
    sync()
  }, [sync])

  const clearScene = useCallback((slot: number) => {
    engine.clearScene(slot)
    sync()
  }, [sync])

  const playSong = useCallback((text: string) => {
    const sections = parseSong(text)
    if (sections.length === 0) {
      toast('error', 'Song format: "A:60 B:90 C:45" — letters are scene slots, numbers are seconds.')
      return
    }
    if (sections.some((s) => !engine.scenes[s.scene])) {
      toast('error', 'Some referenced scenes are empty — save them first (right-click a slot).')
      return
    }
    engine.songSections = sections
    engine.playSong(true)
    sync()
  }, [sync])

  const stopSong = useCallback(() => {
    engine.stopSong()
    sync()
  }, [sync])

  // ---------- rendering ----------

  const renderToWav = useCallback(
    (minutes: number) =>
      runJob('RENDER', async (signal) => {
        const title = `Exotica Décollage seed ${engine.seed}`
        const blob = await renderOffline(engine, minutes, {
          master: masterOpts(),
          onProgress: progressTo(),
          signal,
          ...formatOpts(title),
        })
        downloadBlob(blob, `exotica-decollage-seed${engine.seed}-${minutes}min.wav`)
      }),
    [formatOpts, masterOpts, progressTo, runJob],
  )

  const renderStemsToWav = useCallback(
    (minutes: number) =>
      runJob('STEMS', async (signal) => {
        // stems stay un-normalized so they still sum like the mix
        const stems = await renderStems(engine, minutes, progressTo(), signal)
        const names = ['bed', 'plunder', 'decay', 'noise', 'microloop', 'subpulse', 'melody', ...stemBuses(engine).map((b) => `memory-${b}`)]
        stems.forEach((blob, i) =>
          downloadBlob(blob, `exotica-seed${engine.seed}-stem-${i + 1}-${names[i]}.wav`),
        )
      }),
    [progressTo, runJob],
  )

  const renderLoop = useCallback(
    (bars: number) =>
      runJob('LOOP', async (signal) => {
        const blob = await renderOffline(engine, 0, {
          loopBars: bars,
          master: masterOpts(),
          onProgress: progressTo(),
          signal,
          ...formatOpts(`Loop ${bars} bars ${engine.bpm} BPM · seed ${engine.seed}`),
        })
        downloadBlob(blob, `exotica-seed${engine.seed}-loop-${bars}bars-${engine.bpm}bpm.wav`)
      }),
    [formatOpts, masterOpts, progressTo, runJob],
  )

  // ---------- album ----------

  /** Snapshot of the whole studio patch (not the pool) — for album round-trips. */
  const albumSnapshot = useCallback(() => capturePatch(), [])

  const albumRestore = useCallback((p: ReturnType<typeof capturePatch>) => {
    const wasPlaying = engine.playing
    if (wasPlaying) engine.pause()
    applyPatch(p)
    if (wasPlaying) engine.play()
    sync()
  }, [sync])

  /** Put the engine into a track's sound: base patch + optional preset + seed. */
  const applyTrack = useCallback((base: ReturnType<typeof capturePatch>, t: AlbumTrack) => {
    if (t.patch) {
      // a sound composed in COMPOSE and sent to the album: exactly that desk
      applyPatch(t.patch as unknown as UrlState)
    } else {
      applyPatch(base)
      const preset = PRESETS.find((p) => p.key === t.preset)
      if (preset) preset.apply(engine)
    }
    engine.setDrift(false) // drift is live-only; renders must be repeatable
    engine.reseed(t.seed)
  }, [])

  /** Audition a track live (restart from its seed). */
  const albumPreview = useCallback(
    (base: ReturnType<typeof capturePatch>, t: AlbumTrack) => {
      if (flags.current.rendering || engine.slices.length === 0) return
      engine.pause()
      applyTrack(base, t)
      engine.reset()
      engine.play()
      sync()
    },
    [applyTrack, sync],
  )

  /**
   * Render an album. Default output is ONE zip: numbered, loudness-matched,
   * tagged WAVs (title / artist / album / track / cover art embedded), a
   * sleeve per track, cover.png, tracklist.txt and samples.txt/.json (which
   * originals every track uses, with timestamps). `output: 'files'` downloads
   * each WAV on its own instead. The studio patch is restored afterwards.
   *
   * Transitions: 'gap' fades every track in/out; 'gapless' renders each
   * track a few seconds long and crossfades that tail into the next track's
   * head, so the album plays as one continuous piece.
   *
   * Control while it runs:
   * - cancelRender()   → stop now; finished tracks are still saved
   * - skipAlbumTrack() → drop the current track, continue with the next
   * - opts.stopAfter() → checked between tracks: finish this one, then stop
   * - opts.discard()   → checked at the end: save nothing at all
   */
  const renderAlbumPlan = useCallback(
    async (
      plan: AlbumPlan,
      base: ReturnType<typeof capturePatch>,
      onTrack: (i: number, patch: Partial<AlbumTrack>) => void,
      opts: {
        stopAfter?: () => boolean
        discard?: () => boolean
        output?: 'zip' | 'files'
        /** displayed track numbers (defaults to 1..n) */
        numbers?: number[]
        /** album-wide cover (else each track's generated sleeve) */
        cover?: { mime: string; data: Uint8Array; name: string }
      } = {},
    ): Promise<AlbumResult> => {
      const result: AlbumResult = { saved: 0, skipped: 0, failed: 0, stopped: false, discarded: false }
      if (flags.current.rendering || engine.slices.length === 0) return result
      const wasPlaying = engine.playing
      engine.pause() // live voices off: the album gets the whole CPU
      const job = beginRender('ALBUM')
      const n = plan.tracks.length
      const fmt = plan.format ?? DEFAULT_FORMAT
      const sr = fmt.sampleRate
      const gapless = plan.transition === 'gapless' && n > 1
      const xfade = gapless ? Math.max(0.5, Math.min(15, plan.crossfade ?? 4)) : 0
      const totalNum = String(opts.numbers ? Math.max(...opts.numbers) : n)
      const entries: ZipEntry[] = []
      const files: Array<{ name: string; data: Blob }> = []
      const done: AlbumTrack[] = []
      const origins = engine.sources.map((s) => s.origin)
      const folder = safeName(plan.title)
      // gapless: the previous track's overhang, faded out, waiting to be mixed in
      let carry: { L: Float32Array; R: Float32Array } | null = null
      try {
        for (let i = 0; i < n; i++) {
          if (job.aborted || opts.stopAfter?.()) {
            result.stopped = true
            break
          }
          const t = plan.tracks[i]
          const last = i === n - 1
          const number = opts.numbers?.[i] ?? i + 1
          onTrack(i, { status: 'rendering', progress: 0, error: undefined })
          flags.current.renderLabel = n > 1 ? `ALBUM ${i + 1}/${n}` : 'TRACK'
          const tc = new AbortController()
          trackRef.current = tc
          const relay = () => tc.abort()
          job.addEventListener('abort', relay, { once: true })
          let report: LoudnessReport | undefined
          let crc = 0
          try {
            applyTrack(base, t)
            const overhang = gapless && !last ? xfade : 0
            const raw = await renderRaw(engine, t.minutes + overhang / 60, {
              sampleRate: sr,
              signal: tc.signal,
              onProgress: (f) => {
                progressTo(i / n, 1 / n)(f * 0.9)
                onTrack(i, { progress: f * 0.9 })
              },
            })
            const bodyLen = Math.min(raw.L.length, Math.round(t.minutes * 60 * sr))
            const L = raw.L.subarray(0, bodyLen)
            const R = raw.R.subarray(0, bodyLen)
            const xf = Math.round(xfade * sr)
            if (gapless) {
              // equal-power: this track rises while the previous one's overhang falls
              if (carry && i > 0) {
                const m = Math.min(xf, bodyLen, carry.L.length)
                for (let k = 0; k < m; k++) {
                  const g = Math.sin((Math.PI / 2) * (k / m))
                  L[k] = L[k] * g + carry.L[k]
                  R[k] = R[k] * g + carry.R[k]
                }
              }
              carry = null
              if (!last) {
                const tailL = raw.L.slice(bodyLen, bodyLen + xf)
                const tailR = raw.R.slice(bodyLen, bodyLen + xf)
                for (let k = 0; k < tailL.length; k++) {
                  const g = Math.cos((Math.PI / 2) * (k / tailL.length))
                  tailL[k] *= g
                  tailR[k] *= g
                }
                carry = { L: tailL, R: tailR }
              }
            }
            // fades: every track in 'gap' mode; only the album's two ends when gapless
            const fin = Math.round((!gapless || i === 0 ? plan.fadeIn ?? 0 : 0) * sr)
            const fout = Math.round((!gapless || last ? plan.fadeOut ?? 0 : 0) * sr)
            for (let k = 0; k < Math.min(fin, bodyLen); k++) {
              const g = (k / fin) ** 2
              L[k] *= g
              R[k] *= g
            }
            for (let k = 0; k < Math.min(fout, bodyLen); k++) {
              const g = (k / fout) ** 2
              L[bodyLen - 1 - k] *= g
              R[bodyLen - 1 - k] *= g
            }

            const sleeve = await renderSleevePng(t.seed, engine.sleevePalette)
            const sleeveBytes = sleeve ? new Uint8Array(await sleeve.arrayBuffer()) : null
            const cover = opts.cover ?? (sleeveBytes ? { mime: 'image/png', data: sleeveBytes } : undefined)
            const presetLabel = PRESETS.find((p) => p.key === t.preset)?.label ?? 'studio sound'
            const wav = await finishMaster(L, R, sr, {
              targetLufs: plan.targetLufs,
              ceilingDb: plan.ceilingDb,
              chain: exportChain(),
              onReport: (r) => {
                report = r.after
                crc = r.crc
              },
            }, tc.signal, {
              bits: fmt.bits,
              meta: {
                title: t.title,
                artist: plan.artist || undefined,
                album: plan.title,
                track: `${number}/${totalNum}`,
                year: plan.year || String(new Date().getFullYear()),
                software: 'Exotica Décollage',
                comment: `seed ${t.seed} · ${presetLabel}`,
                extra: { SEED: String(t.seed), CHARACTER: presetLabel },
                cover: cover ? { mime: cover.mime, data: cover.data } : undefined,
              },
            })
            const num = String(number).padStart(2, '0')
            const name = `${num} ${safeName(t.title)}`
            entries.push({ name: `${folder}/${name}.wav`, data: wav, crc })
            files.push({ name: `${name}.wav`, data: wav })
            if (sleeve) entries.push({ name: `${folder}/${name}.png`, data: sleeve })
            if (done.length === 0) {
              if (opts.cover) {
                entries.push({ name: `${folder}/${opts.cover.name}`, data: new Blob([opts.cover.data as Uint8Array<ArrayBuffer>], { type: opts.cover.mime }) })
              } else if (sleeve) entries.push({ name: `${folder}/cover.png`, data: sleeve })
            }
            done.push({ ...t, report, number, usage: raw.usage, status: 'done', progress: 1 })
            onTrack(i, { status: 'done', progress: 1, report, usage: raw.usage, number })
            lastReport = report ?? null
            result.saved++
          } catch (err) {
            carry = null // the chain is broken; the next track starts clean
            if (isAbort(err) && job.aborted) {
              // whole job stopped: this track is simply not finished
              onTrack(i, { status: 'cancelled', progress: 0 })
              result.stopped = true
              break
            }
            if (isAbort(err)) {
              onTrack(i, { status: 'skipped', progress: 0 })
              result.skipped++
              continue
            }
            result.failed++
            onTrack(i, { status: 'error', error: err instanceof Error ? err.message : String(err) })
            // keep going: one bad track shouldn't cost the rest of the album
          } finally {
            job.removeEventListener('abort', relay)
            trackRef.current = null
          }
        }
        const donePlan = { ...plan, tracks: done }
        if (done.length) lastUsage = { title: plan.title, plan: donePlan, origins }
        if (opts.discard?.()) {
          result.discarded = true
        } else if (done.length && (opts.output ?? 'zip') === 'zip') {
          const txt = (s: string) => new Blob(['﻿' + s], { type: 'text/plain;charset=utf-8' })
          entries.push({ name: `${folder}/tracklist.txt`, data: txt(tracklistText(donePlan)) })
          entries.push({
            name: `${folder}/release.txt`,
            data: txt(releaseNotes({
              kind: 'album', title: plan.title, artist: plan.artist, year: plan.year ?? String(new Date().getFullYear()),
              tracks: done.map((t, k) => ({ n: t.number ?? k + 1, title: t.title, sec: t.minutes * 60, lufs: t.report?.integrated, truePeak: t.report?.truePeak })),
              sources: engine.sources.filter((x) => !x.bed).map((x) => ({ name: x.name, era: x.era })),
              lufsTarget: plan.targetLufs, format: plan.format ?? DEFAULT_FORMAT,
            })),
          })
          if (!opts.cover) {
            const pins = engine.pinnedSlices()
            entries.push({
              name: `${folder}/cover-3000.jpg`,
              data: await renderCover({ title: plan.title, artist: plan.artist, seed: done[0]?.seed ?? engine.seed, slices: pins.length ? pins : engine.slices, darkness: 0.6 }),
            })
          }
          entries.push({ name: `${folder}/samples.txt`, data: txt(samplesText(donePlan, origins)) })
          entries.push({
            name: `${folder}/samples.json`,
            data: new Blob([samplesJson(donePlan, origins)], { type: 'application/json' }),
          })
          downloadBlob(await makeZip(entries), `${folder}.zip`)
        } else if (done.length) {
          for (const f of files) downloadBlob(f.data, f.name)
        }
      } catch (err) {
        result.failed++
        console.error('album render failed', err)
      } finally {
        try {
          applyPatch(base)
          if (wasPlaying) engine.play()
        } catch (err) {
          console.error('could not restore the studio patch', err)
        }
        endRender()
      }
      if (result.discarded) notify('ALBUM CANCELLED — NOTHING SAVED')
      else if (result.stopped) notify(`ALBUM STOPPED — ${result.saved} TRACK${result.saved === 1 ? '' : 'S'} SAVED`)
      return result
    },
    [applyTrack, beginRender, endRender, notify, progressTo],
  )

  /** Quick album: N tracks of the current sound with derived seeds. */
  const renderAlbum = useCallback(async (tracks: number, minutes: number) => {
    const base = capturePatch()
    const plan: AlbumPlan = {
      title: `Exotica Decollage ${base.s}`,
      artist: '',
      targetLufs: loudnessTarget,
      ceilingDb: -1,
      format: exportFormat,
      tracks: Array.from({ length: tracks }, (_, i) => ({
        id: i,
        title: `Track ${i + 1}`,
        seed: base.s + i * 1000003,
        preset: null,
        minutes,
        status: 'idle',
        progress: 0,
      })),
    }
    await renderAlbumPlan(plan, base, () => {})
  }, [renderAlbumPlan])

  // ---------- crates ----------

  const crateExport = useCallback(() => {
    if (engine.sources.length === 0) return
    downloadBlob(exportCrateFile(engine), `exotica-${Date.now()}.crate`)
  }, [])

  const crateImport = useCallback(
    (file: File) =>
      withLoading(async () => {
        try {
          const n = await importCrateFile(file, engine)
          if (n === 0) toast('error', 'Crate file was empty or unreadable.')
        } catch {
          toast('error', 'Could not read the .crate file.')
        }
      }),
    [withLoading],
  )

  const crateSave = useCallback(async (name: string) => {
    if (!name.trim() || engine.sources.length === 0) return
    await saveCrate(name.trim(), engine)
    crates = await listCrates()
    sync()
  }, [sync])

  const crateLoad = useCallback(
    (name: string) =>
      withLoading(async () => {
        const n = await loadCrate(name, engine)
        if (n === 0) toast('error', `Crate "${name}" is empty or missing.`)
      }),
    [withLoading],
  )

  const crateDelete = useCallback(async (name: string) => {
    await deleteCrate(name)
    crates = await listCrates()
    sync()
  }, [sync])

  // ---------- misc params ----------

  const setVoiceParam = useCallback(
    <K extends keyof VoiceParams>(voice: number, key: K, value: VoiceParams[K]) => {
      engine.setVoiceParam(voice, key, value)
      sync()
    },
    [sync],
  )

  const setMacro = useCallback((key: keyof MacroParams, value: number) => {
    engine.setMacro(key, value)
    sync()
  }, [sync])

  const setMasterVolume = useCallback((v: number) => {
    engine.setMasterVolume(v)
    sync()
  }, [sync])

  const toggleMasterMute = useCallback(() => {
    engine.setMasterMute(!engine.masterMuted)
    sync()
  }, [sync])

  const setBpm = useCallback((v: number) => {
    engine.bpm = v
    sync()
  }, [sync])

  const setTelephony = useCallback((on: boolean) => {
    engine.setTelephony(on)
    sync()
  }, [sync])

  const setCrush = useCallback((on: boolean) => {
    engine.setCrush(on)
    sync()
  }, [sync])

  const toggleRecording = useCallback(() => {
    if (engine.recorder?.recording) {
      const blob = engine.stopRecording()
      flags.current.recording = false
      sync()
      if (blob) downloadBlob(blob, `exotica-decollage-live-${Date.now()}.wav`)
    } else {
      engine.startRecording()
      flags.current.recording = true
      sync()
    }
  }, [sync])

  const previewToggle = useCallback((idx: number) => {
    engine.previewToggle(idx)
    sync()
  }, [sync])

  const previewFrom = useCallback((idx: number, sec: number) => {
    engine.previewFrom(idx, sec)
    sync()
  }, [sync])

  const previewRegions = useCallback(
    (idx: number, regions: Array<{ start: number; dur: number }>) => {
      engine.previewRegions(idx, regions)
      sync()
    },
    [sync],
  )

  const getPreviewPos = useCallback(() => engine.previewPosition(), [])

  const getPhraseInfo = useCallback(() => engine.phraseInfo(), [])

  // ---------- arrangement (DAW layer) ----------
  const getArrPos = useCallback(() => engine.arranger.playhead(), [])

  const arrPlay = useCallback((from?: number) => {
    engine.arranger.play(from)
    sync()
  }, [sync])

  const arrStop = useCallback(() => {
    engine.arranger.stop()
    sync()
  }, [sync])

  const arrSeek = useCallback((t: number) => {
    engine.arranger.seek(t)
    sync()
  }, [sync])

  const arrToggleLoop = useCallback(() => {
    engine.arranger.toggleLoop()
    sync()
  }, [sync])

  const arrToggleSnap = useCallback(() => {
    engine.arranger.snap = !engine.arranger.snap
    sync()
  }, [sync])

  // ---------- pinned dots & quick compose ----------

  const togglePin = useCallback((id: number) => {
    engine.togglePin(id)
  }, [])

  const setPinned = useCallback((ids: number[], on: boolean) => {
    engine.setPinned(ids, on)
  }, [])

  const clearPins = useCallback(() => {
    engine.clearPins()
  }, [])

  const pinSimilar = useCallback((id: number, n = 4) => {
    engine.pinSimilar(id, n)
  }, [])

  const setPinMode = useCallback((m: PinMode) => {
    engine.setPinMode(m)
  }, [])

  /** Set the desk for a mood (live: audible right away if playing). */
  const applyMood = useCallback((key: string, knobs: MoodKnobs) => {
    if (key !== 'memory') clearMemoryForm(engine)
    const form = key === 'memory' && isMemoryForm(engine)
    const minutes = form ? engine.songSections.reduce((n, x) => n + x.sec, 0) / 60 : 0
    const root = engine.keyRoot
    applyMoodTo(engine, key, knobs)
    if (form) {
      // knobs bend the woven form: rebuild its sections, keep the gathered key
      engine.setKeyRoot(root)
      buildMemoryForm(engine, minutes)
    }
    sync()
  }, [sync])

  /**
   * MEMORY WEAVE: gather tonal fragments from every source (pinned), tune the
   * key to them, apply FORGOTTEN MEMORY and lay out the four-part form —
   * then play it from the top. `regather: false` keeps the current pins.
   */
  const weaveMemory = useCallback((minutes: number, knobs: MoodKnobs, opts: WeaveOpts = {}) => {
    if (engine.slices.length === 0) return
    weaveInto(minutes, knobs, opts)
    engine.reset()
    engine.play()
    engine.playSong(false)
    const pins = engine.pinnedSlices()
    const n = new Set(pins.map((x) => x.sourceIdx)).size
    toast('success', `Woven ${pins.length} fragments from ${n} source${n === 1 ? '' : 's'} into one memory, in ${NOTE_NAMES[engine.keyRoot]}.`)
    sync()
    // the stretch clouds take a few seconds to compute: they join when ready
    if (engine.memLayers.stretch > 0.02) {
      void engine.prepareMemory().then(() => sync()).catch(() => {})
    }
  }, [sync])

  /** Re-time the woven form to a new length (keeps its sections' proportions). */
  const setMemoryMinutes = useCallback((minutes: number) => {
    if (!isMemoryForm(engine)) return
    engine.songSections = scaleSections(engine.songSections.map((x) => x.sec), minutes)
    sync()
  }, [sync])

  /** Set the four section lengths (seconds) directly — the form's handles. */
  const setMemorySecs = useCallback((secs: number[]) => {
    if (!isMemoryForm(engine) || secs.length !== 4) return
    engine.songSections = secs.map((sec, i) => ({ scene: MEMORY_SLOTS[i], sec: Math.max(8, Math.round(sec)) }))
    sync()
  }, [sync])

  /** Play the woven form from a section (0 = the start), optionally as another take. */
  const playMemory = useCallback((from = 0, seed?: number) => {
    if (!isMemoryForm(engine)) return
    engine.reset()
    if (seed != null) engine.reseed(seed)
    engine.play()
    engine.playSong(false, from)
    sync()
  }, [sync])

  const getSongPos = useCallback(() => engine.songPosition(), [])

  const setMemoryLayers = useCallback((p: Partial<MemoryLayerParams>) => {
    engine.setMemoryLayers(p)
    if ((p.stretch ?? 0) > 0.02) void engine.prepareMemory().then(() => sync()).catch(() => {})
    sync()
  }, [sync])

  // ---------- exact master preview · reference matching ----------

  /** where to take 30 s from: the start, or the heart of the track */
  const excerptStart = () => {
    if (isMemoryForm(engine)) {
      const s = engine.songSections
      return s[0].sec + s[1].sec + Math.min(10, s[2].sec / 3)
    }
    return 0
  }

  const stopExact = useCallback(() => {
    if (exactSrc) {
      try { exactSrc.stop() } catch { /* done */ }
      exactSrc.disconnect()
      exactSrc = null
    }
    exactPlaying = null
    sync()
  }, [sync])

  /** Play one side of the exact preview, keeping the position when switching. */
  const playExact = useCallback((which: 'mastered' | 'raw') => {
    const ctx = engine.ctx
    if (!ctx || !exact) return
    const buf = which === 'mastered' ? exact.mastered : exact.raw
    let pos = 0
    if (exactSrc && exactPlaying) pos = (ctx.currentTime - exactT0 + exactOffset) % buf.duration
    if (exactSrc) {
      try { exactSrc.stop() } catch { /* done */ }
      exactSrc.disconnect()
    }
    if (engine.playing) engine.pause()
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    // straight to the speakers: this IS the exported sound, no live chain on top
    src.connect(ctx.destination)
    src.start(ctx.currentTime + 0.02, pos)
    exactSrc = src
    exactT0 = ctx.currentTime + 0.02
    exactOffset = pos
    exactPlaying = which
    sync()
  }, [sync])

  /**
   * EXACT PREVIEW: 30 s rendered offline and mastered by the very code the
   * export uses (chain → loudness → true-peak limit → dither), plus the same
   * 30 s un-mastered and level-matched for a fair A/B.
   */
  const exactPreview = useCallback(
    (where: 'start' | 'heart') =>
      runJob('EXACT PREVIEW', async (signal) => {
        const ctx = engine.ctx
        if (!ctx) return
        stopExact()
        const len = 30
        const from = where === 'heart' ? excerptStart() : 0
        const raw = await renderRaw(engine, (from + len) / 60, { onProgress: progressTo(), signal })
        const sr = raw.sampleRate
        const a = Math.min(raw.L.length - 1, Math.floor(from * sr))
        const n = Math.min(raw.L.length - a, Math.floor(len * sr))
        const L = raw.L.slice(a, a + n)
        const R = raw.R.slice(a, a + n)
        let after: LoudnessReport | null = null
        const blob = await finishMaster(L, R, sr, {
          targetLufs: loudnessTarget, ceilingDb: -1, chain: exportChain(),
          onReport: (r) => { after = r.after },
        }, signal, { bits: 24 })
        const mastered = await ctx.decodeAudioData(await blob.arrayBuffer())
        // the raw side at the master's loudness: the A/B compares tone, not level
        const rawLufs = measureLoudness(L, R, sr).integrated
        const tgt = (after as LoudnessReport | null)?.integrated ?? rawLufs
        const g = Number.isFinite(rawLufs) && Number.isFinite(tgt) ? Math.min(6, Math.pow(10, (tgt - rawLufs) / 20)) : 1
        const rawBuf = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: sr })
        const l2 = new Float32Array(n)
        const r2 = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          l2[i] = Math.max(-1, Math.min(1, L[i] * g))
          r2[i] = Math.max(-1, Math.min(1, R[i] * g))
        }
        rawBuf.copyToChannel(l2, 0)
        rawBuf.copyToChannel(r2, 1)
        exact = { mastered, raw: rawBuf, label: where === 'heart' ? 'THE HEART' : 'THE START', report: after }
        playExact('mastered')
      }),
    [playExact, progressTo, runJob, stopExact],
  )

  /**
   * MATCH A REFERENCE: analyse a track you like (its middle minute) and 30 s
   * of your mix before the master, then bend the chain toward the reference's
   * tone, width and density, and set the loudness target to its loudness.
   */
  const matchReference = useCallback(
    (file: File) =>
      runJob('MATCH REFERENCE', async (signal) => {
        const ctx = engine.ctx
        if (!ctx) return
        const ref = await ctx.decodeAudioData(await file.arrayBuffer())
        const rL = ref.getChannelData(0)
        const rR = ref.numberOfChannels > 1 ? ref.getChannelData(1) : rL
        const refLoud = measureLoudness(rL, rR, ref.sampleRate)
        const refTone = toneProfile(rL, rR, ref.sampleRate, refLoud.integrated, refLoud.truePeak)
        const from = excerptStart()
        const raw = await renderRaw(engine, (from + 30) / 60, { onProgress: progressTo(), signal })
        const sr = raw.sampleRate
        const a = Math.floor(from * sr)
        const L = raw.L.slice(a)
        const R = raw.R.slice(a)
        const ourLoud = measureLoudness(L, R, sr)
        const ours = toneProfile(L, R, sr, ourLoud.integrated, ourLoud.truePeak)
        const { chain, lines } = matchChain(ours, refTone, engine.masterChain)
        masterPreset = 'custom'
        engine.setMasterChain(chain)
        engine.setMasterBypass(false)
        if (Number.isFinite(refLoud.integrated)) {
          loudnessTarget = Math.round(Math.min(-8, Math.max(-20, refLoud.integrated)))
          try { localStorage.setItem('exotica.lufs', String(loudnessTarget)) } catch { /* storage */ }
        }
        saveMaster()
        referenceReport = { name: file.name, lines: [...lines, `→ LOUDNESS ${loudnessTarget} LUFS`] }
        toast('success', `Master matched to “${file.name}”. Try EXACT PREVIEW to hear it.`)
      }),
    [progressTo, runJob],
  )

  // ---------- undo ----------

  const undo = useCallback(() => {
    const prev = undoStack.pop()
    if (!prev) return toast('info', 'Nothing to undo.')
    redoStack.push(undoCurrent())
    restoreUndo(prev)
    sync()
  }, [sync])

  const redo = useCallback(() => {
    const next = redoStack.pop()
    if (!next) return toast('info', 'Nothing to redo.')
    undoStack.push(undoCurrent())
    restoreUndo(next)
    sync()
  }, [sync])

  // ---------- release kit ----------

  /**
   * RELEASE KIT (single): the final master WAV (with the cover inside its
   * tags), a 3000×3000 cover drawn from the material, release.txt (Bandcamp ·
   * distributor · YouTube with chapters) and samples.txt — one ZIP. With
   * `video`, a YouTube WebM is then recorded in real time.
   */
  const releaseKit = useCallback(
    (o: { minutes: number; title: string; artist: string; year: string; video: boolean }) =>
      runJob('RELEASE KIT', async (signal) => {
        const title = o.title.trim() || `Exotica Décollage ${engine.seed}`
        const artist = o.artist.trim()
        const year = o.year.trim() || String(new Date().getFullYear())
        const pins = engine.pinnedSlices()
        const darkness = Math.min(1, Math.max(0, (0.25 - engine.tilt) / 0.85))
        const coverBlob = await renderCover({ title, artist, seed: engine.seed, slices: pins.length ? pins : engine.slices, darkness })
        const smallCover = await renderCover({ title, artist, seed: engine.seed, slices: pins.length ? pins : engine.slices, darkness, size: 1000 })
        const raw = await renderRaw(engine, o.minutes, {
          onProgress: progressTo(0, o.video ? 0.5 : 0.95), signal, sampleRate: exportFormat.sampleRate,
        })
        let after: LoudnessReport | null = null
        const wav = await finishMaster(raw.L, raw.R, raw.sampleRate, {
          targetLufs: loudnessTarget, ceilingDb: -1, chain: exportChain(),
          onReport: (r) => { after = r.after },
        }, signal, {
          bits: exportFormat.bits,
          meta: {
            title, artist, year, software: 'Exotica Décollage', comment: `seed ${engine.seed}`,
            extra: { SEED: String(engine.seed) },
            cover: { mime: 'image/jpeg', data: new Uint8Array(await smallCover.arrayBuffer()) },
          },
        })
        lastReport = after
        const sec = o.minutes * 60
        const rep = after as LoudnessReport | null
        const origins = engine.sources.map((x) => x.origin)
        const plan: AlbumPlan = {
          title, artist, targetLufs: loudnessTarget, ceilingDb: -1, format: exportFormat,
          tracks: [{ id: 0, title, seed: engine.seed, preset: null, minutes: o.minutes, status: 'done', progress: 1, number: 1, usage: raw.usage }],
        }
        lastUsage = { title, plan, origins }
        // chapters: the woven form's sections (YouTube wants ≥ 10 s each)
        let chapters: Array<{ t: number; label: string }> | undefined
        if (isMemoryForm(engine)) {
          const names = ['Dust', 'Surfacing', 'The Memory', 'Dissolving']
          let acc = 0
          chapters = engine.songSections.map((x, i) => {
            const c = { t: acc, label: names[i] }
            acc += x.sec
            return c
          }).filter((c, i, arr) => i === 0 || c.t - arr[i - 1].t >= 10)
        }
        const notes = releaseNotes({
          kind: 'single', title, artist, year,
          tracks: [{ n: 1, title, sec, lufs: rep?.integrated, truePeak: rep?.truePeak }],
          chapters, keyRoot: engine.keyLock ? engine.keyRoot : undefined,
          sources: engine.sources.filter((x) => !x.bed).map((x) => ({ name: x.name, era: x.era })),
          fragments: pins.length || undefined,
          lufsTarget: loudnessTarget, format: exportFormat,
        })
        const folder = safeName(`${artist ? artist + ' - ' : ''}${title}`)
        const txt = (s: string) => new Blob(['﻿' + s], { type: 'text/plain;charset=utf-8' })
        const entries: ZipEntry[] = [
          { name: `${folder}/${safeName(title)}.wav`, data: wav },
          { name: `${folder}/cover-3000.jpg`, data: coverBlob },
          { name: `${folder}/release.txt`, data: txt(notes) },
          { name: `${folder}/samples.txt`, data: txt(samplesText(plan, origins)) },
        ]
        downloadBlob(await makeZip(entries), `${folder}.zip`)
        if (o.video) {
          flags.current.renderLabel = 'VIDEO · REAL TIME'
          sync()
          const video = await recordVideo({ wav, cover: coverBlob, title, artist, chapters, onProgress: progressTo(0.5, 0.5), signal })
          downloadBlob(video, `${folder}.webm`)
        }
        toast('success', `Release kit ready: ${folder}.zip${o.video ? ' + video' : ''}.`)
      }),
    [progressTo, runJob, sync],
  )

  const setMix = useCallback((p: Partial<MixLevels>) => {
    engine.setMix(p)
    sync()
  }, [sync])

  /** a preset key, or knob changes (which make the chain 'custom') */
  const setMaster = useCallback((p: { preset?: string; chain?: Partial<MasterChain> }) => {
    if (p.preset) {
      const pr = MASTER_PRESETS.find((x) => x.key === p.preset)
      if (pr) {
        masterPreset = pr.key
        engine.setMasterChain(pr.chain)
      }
    }
    if (p.chain) {
      masterPreset = 'custom'
      engine.setMasterChain(p.chain)
    }
    saveMaster()
    sync()
  }, [sync])

  const setMasterBypass = useCallback((b: boolean) => {
    engine.setMasterBypass(b)
    saveMaster()
    sync()
  }, [sync])

  const setSourceEra = useCallback((i: number, era: Era) => {
    engine.setSourceEra(i, era)
    sync()
  }, [sync])

  /**
   * WEAVE AN ALBUM: `count` woven tracks from the same material, each leaning
   * on different sources, in related keys (around the circle of fifths and
   * home again), along a light → dark → light arc; the last track quotes the
   * first one's motif. Replaces the album plan (the old one is kept as a backup).
   */
  const weaveAlbum = useCallback((o: {
    count: number; minutes: number; knobs: MoodKnobs; perSource: number; weights: Record<number, number>; title?: string
  }) => {
    if (engine.slices.length === 0) return
    const snapshot = capturePatch()
    const wasPlaying = engine.playing
    engine.pause()
    const rng = mulberry32(randomSeed())
    const live = engine.sources.map((src, i) => ({ src, i })).filter((x) => !x.src.bed && (o.weights[x.i] ?? 1) > 0)
    // the album's home key: what the whole gathered material agrees on
    applyMoodTo(engine, 'memory', o.knobs)
    const all = gatherMemories(engine, o.perSource, o.weights)
    const home = keyOf(all.flatMap((g) => g.ids).map((id) => engine.slices[id]).filter(Boolean))
    const motifHome = Math.floor(rng() * 1e6) + 2
    const KEY_PATH = [0, 7, 2, 9, 5, 10, 3, 8, 4, 11, 6, 1]
    const titles = shuffle([...ALBUM_TITLES], rng)
    const tracks: Array<Record<string, unknown>> = []
    for (let i = 0; i < o.count; i++) {
      const last = i === o.count - 1 && o.count > 1
      const arc = o.count > 1 ? Math.sin((Math.PI * i) / (o.count - 1)) : 0.5 // 0 → 1 → 0
      const knobs: MoodKnobs = {
        darkness: clamp01(o.knobs.darkness - 0.15 + arc * 0.35 + (rng() - 0.5) * 0.08),
        space: clamp01(o.knobs.space + arc * 0.2 + (rng() - 0.5) * 0.1),
        motion: clamp01(o.knobs.motion + (rng() - 0.5) * 0.2),
      }
      // lean on one source per track (the last one gathers everything)
      const lean = live.length ? live[i % live.length].i : -1
      const weights: Record<number, number> = {}
      for (const { i: si } of live) {
        const w = o.weights[si] ?? 1
        weights[si] = last ? w : w * (si === lean ? 1.8 : 0.6)
      }
      const minutes = Math.max(2, Math.round(o.minutes * (0.8 + rng() * 0.45) * 2) / 2)
      const seed = randomSeed()
      clearMemoryForm(engine)
      engine.reseed(seed)
      weaveInto(minutes, knobs, {
        perSource: o.perSource,
        weights,
        key: (home + (last ? 0 : KEY_PATH[i % KEY_PATH.length])) % 12,
        motifSeed: i === 0 || last ? motifHome : motifHome + i * 17,
        keepEras: true,
      })
      tracks.push({
        title: titles[i % titles.length] + (i >= titles.length ? ` ${Math.floor(i / titles.length) + 1}` : ''),
        seed, preset: null, minutes, include: true, patch: capturePatch(),
      })
    }
    // put the studio back exactly as it was
    applyPatch(snapshot)
    if (wasPlaying) engine.play()
    const KEY = 'exotica.album.v1'
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) localStorage.setItem(KEY + '.backup', raw)
      const old = raw ? JSON.parse(raw) : {}
      const plan = {
        ...old,
        title: o.title?.trim() || old.title || 'Untitled Memory',
        artist: old.artist ?? '',
        targetLufs: old.targetLufs ?? loudnessTarget,
        tracks,
      }
      localStorage.setItem(KEY, JSON.stringify(plan))
      toast('success', `Album woven: ${tracks.length} tracks around ${NOTE_NAMES[home]}, first and last sharing one melody. Open ALBUM to listen and render (the previous plan is kept as a backup).`)
    } catch {
      toast('error', 'Could not save the album plan (browser storage unavailable).')
    }
    sync()
  }, [sync])

  // ---------- TEXTURE KIN ----------

  /**
   * TEXTURE KIN: group every source's fragments into texture families, take
   * the main family + a contrasting one (+ a third for the peak), balanced
   * across sources, and stage them along a dramatic arc — then play.
   */
  const weaveKin = useCallback((minutes: number, knobs: MoodKnobs, o: KinOpts = {}) => {
    if (engine.slices.length === 0) return
    if (!kinInto(minutes, knobs, o)) {
      toast('error', 'Not enough material to find texture families — add more sources (or longer ones).')
      return
    }
    engine.reset()
    engine.play()
    engine.playSong(false)
    const plan = engine.memLayers.kin!
    const n = new Set(plan.families.flat().map((id) => engine.slices[id]?.sourceIdx)).size
    toast('success', `${plan.names.join(' · ')} — ${plan.families.flat().length} fragments from ${n} sources, staged as ${arcByKey(plan.arc).label}, in ${NOTE_NAMES[engine.keyRoot]}.`)
    sync()
    if (engine.memLayers.stretch > 0.02) void engine.prepareMemory().then(() => sync()).catch(() => {})
  }, [sync])

  /** Change the kin plan in place (level, relay, chorus, drawn tension). */
  const setKin = useCallback((p: Partial<KinPlan>) => {
    const k = engine.memLayers.kin
    if (!k) return
    engine.setMemoryLayers({ kin: { ...k, ...p } })
    sync()
  }, [sync])

  /** Another dramatic arc for the same families: acts, tension and the form's proportions. */
  const setKinArc = useCallback((key: string, minutes: number) => {
    const k = engine.memLayers.kin
    if (!k) return
    const arc = arcByKey(key)
    if (isMemoryForm(engine)) engine.songSections = scaleSections(arc.sections.map((x) => x * 1000), minutes)
    engine.setMemoryLayers({ kin: { ...k, arc: arc.key, acts: arc.acts.map((a) => ({ ...a, fams: [...a.fams] })), tension: [...arc.tension] } })
    if (engine.songActive) engine.playSong(false)
    sync()
  }, [sync])

  /**
   * KIN ALBUM: every track a different texture family in the lead (the last
   * returns to the first one's), each on its own dramatic arc chosen for its
   * place in the album (slow burn → … → the peak → fading choir), in related
   * keys, the whole album rising and falling. Replaces the album plan (the
   * old one is kept as a backup).
   */
  const weaveKinAlbum = useCallback((o: {
    count: number; minutes: number; knobs: MoodKnobs; perSource: number; weights: Record<number, number>; title?: string
  }) => {
    if (engine.slices.length === 0) return
    const snap = capturePatch()
    const wasPlaying = engine.playing
    engine.pause()
    applyMoodTo(engine, 'memory', o.knobs)
    const fams = findFamilies(engine.slices, engine.sources, KIN_SEED, o.perSource, o.weights)
    if (fams.length < 2) {
      applyPatch(snap)
      if (wasPlaying) engine.play()
      toast('error', 'Not enough material to find texture families — add more sources (or longer ones).')
      sync()
      return
    }
    const rng = mulberry32(randomSeed())
    const home = keyOf(fams.flatMap((f) => f.ids).map((id) => engine.slices[id]).filter(Boolean))
    const motifHome = Math.floor(rng() * 1e6) + 2
    const KEY_PATH = [0, 7, 2, 9, 5, 10, 3, 8, 4, 11, 6, 1]
    const titles = shuffle([...ALBUM_TITLES], rng)
    const leads = fams.map((_, i) => i).slice(0, Math.max(1, Math.min(fams.length, o.count - 1)))
    const arcs = albumArcs(o.count)
    const tracks: Array<Record<string, unknown>> = []
    const lines: string[] = []
    for (let i = 0; i < o.count; i++) {
      const last = i === o.count - 1 && o.count > 1
      const swell = o.count > 1 ? Math.sin((Math.PI * i) / (o.count - 1)) : 1 // the album's own arc
      const arc = arcByKey(arcs[i])
      const main = last ? leads[0] : leads[i % leads.length]
      const knobs: MoodKnobs = {
        darkness: clamp01(o.knobs.darkness - 0.12 + swell * 0.3 + (rng() - 0.5) * 0.08),
        space: clamp01(o.knobs.space + swell * 0.15 + (rng() - 0.5) * 0.1),
        motion: clamp01(o.knobs.motion + (swell - 0.5) * 0.2),
      }
      const minutes = Math.max(2, Math.round(o.minutes * (0.8 + rng() * 0.45) * 2) / 2)
      const seed = randomSeed()
      clearMemoryForm(engine)
      engine.reseed(seed)
      kinInto(minutes, knobs, {
        arc: arc.key, main, perSource: o.perSource, weights: o.weights,
        key: (home + (last ? 0 : KEY_PATH[i % KEY_PATH.length])) % 12,
        tension: arc.tension.map((v) => clamp01(v * (0.7 + 0.3 * swell))),
        chorus: 0.5 + 0.5 * swell,
        relay: 0.5 + rng() * 0.4,
        motifSeed: i === 0 || last ? motifHome : motifHome + i * 17,
        keepEras: true,
      })
      const title = titles[i % titles.length] + (i >= titles.length ? ` ${Math.floor(i / titles.length) + 1}` : '')
      lines.push(`${i + 1}. ${title} — ${fams[main].name} · ${arc.label}`)
      tracks.push({ title, seed, preset: null, minutes, include: true, patch: capturePatch() })
    }
    applyPatch(snap)
    if (wasPlaying) engine.play()
    const KEY = 'exotica.album.v1'
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) localStorage.setItem(KEY + '.backup', raw)
      const old = raw ? JSON.parse(raw) : {}
      localStorage.setItem(KEY, JSON.stringify({
        ...old,
        title: o.title?.trim() || old.title || 'Kin',
        artist: old.artist ?? '',
        targetLufs: old.targetLufs ?? loudnessTarget,
        tracks,
      }))
      console.info('KIN ALBUM\n' + lines.join('\n'))
      toast('success', `Kin album: ${tracks.length} tracks, each led by another texture family on its own arc, around ${NOTE_NAMES[home]}; the last returns to the first. Open ALBUM to listen and render (the previous plan is kept as a backup).`)
    } catch {
      toast('error', 'Could not save the album plan (browser storage unavailable).')
    }
    sync()
  }, [sync])

  const setKeyRoot = useCallback((pc: number) => {
    engine.setKeyRoot(pc)
    sync()
  }, [sync])

  /** Start the current sound over from its seed. */
  const listenFromTop = useCallback(() => {
    if (engine.slices.length === 0) return
    engine.reset()
    engine.play()
    sync()
  }, [sync])

  /**
   * Append the current sound (full patch + seed) to the album plan, so the
   * album renders exactly what COMPOSE is playing.
   */
  const addToAlbum = useCallback((title: string, minutes: number) => {
    const KEY = 'exotica.album.v1'
    try {
      const raw = localStorage.getItem(KEY)
      const plan = raw ? JSON.parse(raw) : { title: 'Untitled Album', artist: '', targetLufs: loudnessTarget, tracks: [] }
      plan.tracks = [...(plan.tracks ?? []), {
        title, seed: engine.seed, preset: null, minutes, include: true, patch: capturePatch(),
      }]
      localStorage.setItem(KEY, JSON.stringify(plan))
      toast('success', `Added “${title}” to the album as track ${plan.tracks.length}.`)
    } catch {
      toast('error', 'Could not save to the album plan (browser storage unavailable).')
    }
  }, [])

  /**
   * SKETCH: lay the pinned dots (or the best of each kind when nothing is
   * pinned) onto the arrangement as a short seeded piece — pads/harmonic
   * stretched across bars on track 1, textures drifting on track 2, hits on
   * the beat grid on track 3, a sparse answer on track 4. A starting point
   * to edit by hand, not a finished arrangement.
   */
  const sketchArrangement = useCallback((bars = 8) => {
    const pins = engine.pinnedSlices()
    const pool = pins.length ? pins : engine.slices
    if (pool.length === 0) return
    const rng = mulberry32(engine.seed + 4242)
    const pick = (cat: Slice['category']) => {
      const c = pool.filter((s) => s.category === cat)
      return c.length ? c : pool
    }
    const beat = 60 / Math.max(30, engine.bpm)
    const bar = beat * 4
    const start = engine.arranger.length() > 0 ? Math.ceil(engine.arranger.length() / bar) * bar : 0
    const total = bars * bar
    const harm = pick('harmonic')
    const tex = pick('texture')
    const hits = pick('transient')
    const any = (arr: Slice[]) => arr[Math.floor(rng() * arr.length)]
    // 1 · harmonic bed: one slice per bar, held and overlapped
    for (let t = 0; t < total; t += bar) {
      const s = any(harm)
      engine.arranger.addClip(s.sourceIdx, s.start, Math.min(s.duration, bar), start + t, 0)
    }
    // 2 · textures every 1–2 bars, off the grid
    for (let t = rng() * bar; t < total; t += bar * (1 + rng())) {
      const s = any(tex)
      engine.arranger.addClip(s.sourceIdx, s.start, s.duration, start + t, 1)
    }
    // 3 · hits on beats, sparse and seeded (a slow ceremonial pattern)
    const pattern = [1, 0, 0, rng() < 0.5 ? 1 : 0, 0, rng() < 0.3 ? 1 : 0, 1, 0]
    for (let b = 0; b < bars * 4; b++) {
      if (!pattern[b % pattern.length]) continue
      const s = any(hits)
      engine.arranger.addClip(s.sourceIdx, s.start, Math.min(s.duration, beat), start + b * beat, 2)
    }
    // 4 · an answer phrase in the second half
    for (let t = total / 2; t < total; t += bar * 2) {
      const s = any(pool)
      engine.arranger.addClip(s.sourceIdx, s.start, s.duration, start + t + beat * 2, 3)
    }
    toast('info', `Sketched ${bars} bars onto the arrangement from ${pins.length ? `${pins.length} pinned dots` : 'the whole pool'}.`)
    sync()
  }, [sync])

  const arrAddClip = useCallback(
    (sourceIdx: number, offset: number, dur: number, at?: number, track?: number) => {
      engine.arranger.addClip(sourceIdx, offset, dur, at, track)
      sync()
    },
    [sync],
  )

  const arrUpdateClip = useCallback((id: number, patch: Partial<ArrClip>) => {
    engine.arranger.updateClip(id, patch)
    sync()
  }, [sync])

  const arrRemoveClip = useCallback((id: number) => {
    engine.arranger.removeClip(id)
    sync()
  }, [sync])

  const arrDuplicateClip = useCallback((id: number) => {
    engine.arranger.duplicateClip(id)
    sync()
  }, [sync])

  const arrSetTrack = useCallback((i: number, patch: Partial<ArrTrack>) => {
    engine.arranger.setTrack(i, patch)
    sync()
  }, [sync])

  /** BOUNCE: one clean non-looped pass through the master, captured to WAV. */
  const arrBounce = useCallback(() => {
    if (engine.recorder?.recording || engine.arranger.length() <= 0) return
    const wasLoop = engine.arranger.loop
    engine.arranger.loop = false
    engine.startRecording()
    flags.current.recording = true
    flags.current.bouncing = true
    engine.arranger.onEnd = () => {
      engine.arranger.onEnd = null
      engine.arranger.loop = wasLoop
      const blob = engine.stopRecording()
      flags.current.recording = false
      flags.current.bouncing = false
      sync()
      if (blob) downloadBlob(blob, `exotica-arrangement-${Date.now()}.wav`)
    }
    engine.arranger.play(0)
    sync()
  }, [sync])

  const regionSplice = useCallback(
    (sourceIdx: number, regions: Array<{ start: number; dur: number }>) => {
      engine.regionsToSpliced(sourceIdx, regions)
      sync()
    },
    [sync],
  )

  const regionLoop = useCallback((sourceIdx: number, start: number, dur: number) => {
    engine.regionLoop(sourceIdx, start, dur)
    sync()
  }, [sync])

  const regionToSource = useCallback((sourceIdx: number, start: number, dur: number) => {
    engine.regionToSource(sourceIdx, start, dur)
    sync()
  }, [sync])

  const auditionSlice = useCallback((id: number) => {
    engine.auditionSlice(id)
    sync() // the armed slice enables ARM→LOOP and the keyboard hint
  }, [sync])

  const getAudioStream = useCallback(() => engine.getAudioStream(), [])

  return {
    state,
    firesRef,
    analyser: engine.analyser,
    start,
    play,
    pause,
    reset,
    addStem,
    loadFile,
    loadImage,
    addYouTube,
    removeSource,
    sampleFromMic,
    editBoundary,
    cycleCategory,
    toggleRouting,
    reseed,
    setScale,
    setDrift,
    setDuck,
    setGroove,
    setRadio,
    setWidth,
    setTilt,
    setAqua,
    setLooped,
    setBlockSec,
    setKeyLock,
    setPadMode,
    setPhraseMode,
    loopArmed,
    peklerPreset,
    afrikaPreset,
    templetonPreset,
    jelinekPreset,
    poirierPreset,
    jeckPreset,
    caretakerPreset,
    polePreset,
    booksPreset,
    hassellPreset,
    loscilPreset,
    gesPreset,
    ielasiPreset,
    microstoriaPreset,
    keszlerPreset,
    buddPreset,
    setVoicing,
    setPlateShort,
    setSub,
    setFragLen,
    setDubMode,
    setTapeMode,
    setReverseProb,
    setPings,
    toggleBed,
    freeze,
    playArmedAt,
    remixCollages,
    renderAlbum,
    renderAlbumPlan,
    togglePin,
    setPinned,
    clearPins,
    pinSimilar,
    setPinMode,
    applyMood,
    listenFromTop,
    addToAlbum,
    sketchArrangement,
    weaveMemory,
    weaveAlbum,
    weaveKin,
    setKin,
    setKinArc,
    weaveKinAlbum,
    setMemoryMinutes,
    setMemorySecs,
    playMemory,
    getSongPos,
    setMemoryLayers,
    setSourceEra,
    setMix,
    setMaster,
    setMasterBypass,
    exactPreview,
    releaseKit,
    playExact,
    stopExact,
    matchReference,
    undo,
    redo,
    setKeyRoot,
    setExportFormat,
    downloadSampleReport,
    cancelRender,
    skipAlbumTrack,
    albumPreview,
    albumSnapshot,
    albumRestore,
    setLoudnessTarget,
    crateExport,
    crateImport,
    saveScene,
    morphScene,
    clearScene,
    playSong,
    stopSong,
    renderToWav,
    renderStemsToWav,
    renderLoop,
    crateSave,
    crateLoad,
    crateDelete,
    setVoiceParam,
    setMacro,
    setMasterVolume,
    toggleMasterMute,
    setBpm,
    setTelephony,
    setCrush,
    toggleRecording,
    auditionSlice,
    previewToggle,
    previewFrom,
    previewRegions,
    getPreviewPos,
    getPhraseInfo,
    getArrPos,
    arrPlay,
    arrStop,
    arrSeek,
    arrToggleLoop,
    arrToggleSnap,
    arrAddClip,
    arrUpdateClip,
    arrRemoveClip,
    arrDuplicateClip,
    arrSetTrack,
    arrBounce,
    regionLoop,
    regionToSource,
    regionSplice,
    getAudioStream,
  }
}

export type EngineApi = ReturnType<typeof useAudioEngine>
