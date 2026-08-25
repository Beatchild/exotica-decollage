import { useCallback, useEffect, useRef, useState } from 'react'
import { engine } from '../engine/AudioEngine'
import type { SourceRec } from '../engine/AudioEngine'
import { renderOffline, renderStems } from '../engine/OfflineRenderer'
import { deleteCrate, exportCrateFile, importCrateFile, listCrates, loadCrate, saveCrate } from '../engine/Crates'
import { renderSleevePng } from '../engine/SleevePng'
import { ytAvailableCheck, ytExpand, spotifyQueries } from '../engine/ytBridge'
import { mulberry32, randomSeed } from '../engine/rng'
import { NUM_VOICES } from '../engine/types'
import type { FiredEvent, MacroParams, ScaleName, Slice, SongSection, VoiceParams } from '../engine/types'

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
  freezing: boolean
  seed: number
  sleevePalette: string[] | null
  ytAvailable: boolean
  scenesFilled: boolean[]
  songActive: boolean
  crates: string[]
}

let ytAvailable = false
let crates: string[] = []

interface Flags {
  loading: boolean
  recording: boolean
  rendering: boolean
  freezing: boolean
  micState: EngineState['micState']
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
  freezing: f.freezing,
  seed: engine.seed,
  sleevePalette: engine.sleevePalette,
  ytAvailable,
  scenesFilled: engine.scenes.map((s) => s !== null),
  songActive: engine.songActive,
  crates,
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
  rt?: Array<number[] | null>
  vol: number
  stems: string[]
}

function writeHash() {
  const st: UrlState = {
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
    rt: engine.sourceMasks,
    vol: engine.masterVolume,
    stems: engine.sources.filter((x) => x.stemKey).map((x) => x.stemKey!),
  }
  const enc = btoa(JSON.stringify(st)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  history.replaceState(null, '', `#p=${enc}`)
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

/** Bridges the imperative AudioEngine singleton into React state. */
export function useAudioEngine() {
  const flags = useRef<Flags>({
    loading: false,
    recording: false,
    rendering: false,
    freezing: false,
    micState: 'idle',
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
      engine.keyRoot = url.kr ?? 0
      engine.setPadMode(!!url.pd)
      engine.setPhraseMode(!!url.phm)
      engine.setVoicing(!!url.vc)
      engine.setPlateShort(!!url.ps)
      engine.setSub(url.sb ?? 0)
      if (url.fl === 'mid' || url.fl === 'long') engine.setFragLen(url.fl)
      engine.setDub(!!url.db)
      engine.setTape(!!url.tp)
      engine.setReverseProb(url.rv ?? 0)
      engine.setPings(url.pn ?? 0)
      engine.setMasterVolume(url.vol)
      for (const key of url.stems.length ? url.stems : ['epiano']) await engine.addStem(key)
      if (url.rt) {
        engine.sourceMasks = engine.sourceMasks.map((_, i) => url.rt![i] ?? null)
      }
      engine.setDrift(!!url.dr)
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
          alert(`Could not decode "${file.name}" — this browser may not support the format.`)
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
          alert(`Could not read "${file.name}" as an image.`)
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
      alert('No YouTube / Freeze sources in the pool — paste links (CUT) first.')
      return
    }
    flags.current.rendering = true
    sync()
    try {
      const base = randomSeed()
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
          }).then((blob) => downloadBlob(blob, `exotica-remix-${i + 1}-seed${seed}.wav`))
        }),
      )
    } finally {
      flags.current.rendering = false
      sync()
    }
  }, [sync])

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
          alert('No YouTube or Spotify links found in the input.')
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
          alert(expandFails.join('\n') || 'Nothing fetchable found in the input.')
          return
        }
        try {
          const { failed, wav } = await engine.addYouTubeCollage(fetchables, opts?.mode ?? 'collage')
          if (wav) downloadBlob(wav, `exotica-mixtape-${Date.now()}.wav`)
          const allFails = [...expandFails, ...failed]
          if (allFails.length) alert(`Some links failed:\n${allFails.join('\n')}`)
        } catch (err) {
          alert(`Fetch failed: ${err instanceof Error ? err.message : err}`)
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
      alert('Microphone unavailable — permission denied or no input device.')
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
      alert('Song format: "A:60 B:90 C:45" — letters are scene slots, numbers are seconds.')
      return
    }
    if (sections.some((s) => !engine.scenes[s.scene])) {
      alert('Some referenced scenes are empty — save them first (right-click a slot).')
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

  const renderToWav = useCallback(async (minutes: number) => {
    if (flags.current.rendering || engine.slices.length === 0) return
    flags.current.rendering = true
    sync()
    try {
      const blob = await renderOffline(engine, minutes)
      downloadBlob(blob, `exotica-decollage-seed${engine.seed}-${minutes}min.wav`)
    } finally {
      flags.current.rendering = false
      sync()
    }
  }, [sync])

  const renderStemsToWav = useCallback(async (minutes: number) => {
    if (flags.current.rendering || engine.slices.length === 0) return
    flags.current.rendering = true
    sync()
    try {
      const stems = await renderStems(engine, minutes)
      const names = ['bed', 'plunder', 'decay', 'noise', 'microloop', 'subpulse', 'melody']
      stems.forEach((blob, i) =>
        downloadBlob(blob, `exotica-seed${engine.seed}-stem-${i + 1}-${names[i]}.wav`),
      )
    } finally {
      flags.current.rendering = false
      sync()
    }
  }, [sync])

  const renderLoop = useCallback(async (bars: number) => {
    if (flags.current.rendering || engine.slices.length === 0) return
    flags.current.rendering = true
    sync()
    try {
      const blob = await renderOffline(engine, 0, { loopBars: bars })
      downloadBlob(blob, `exotica-seed${engine.seed}-loop-${bars}bars-${engine.bpm}bpm.wav`)
    } finally {
      flags.current.rendering = false
      sync()
    }
  }, [sync])

  /** Album mode: N tracks with derived seeds, each with its own sleeve PNG. */
  const renderAlbum = useCallback(async (tracks: number, minutes: number) => {
    if (flags.current.rendering || engine.slices.length === 0) return
    flags.current.rendering = true
    sync()
    const orig = engine.seed
    try {
      for (let i = 0; i < tracks; i++) {
        const s = orig + i * 1000003
        engine.reseed(s)
        const blob = await renderOffline(engine, minutes)
        downloadBlob(blob, `exotica-album-track${i + 1}-seed${s}.wav`)
        const png = await renderSleevePng(s, engine.sleevePalette)
        if (png) downloadBlob(png, `exotica-album-track${i + 1}-sleeve.png`)
      }
    } finally {
      engine.reseed(orig)
      flags.current.rendering = false
      sync()
    }
  }, [sync])

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
          if (n === 0) alert('Crate file was empty or unreadable.')
        } catch {
          alert('Could not read the .crate file.')
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
        if (n === 0) alert(`Crate "${name}" is empty or missing.`)
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
    regionLoop,
    regionToSource,
    regionSplice,
    getAudioStream,
  }
}

export type EngineApi = ReturnType<typeof useAudioEngine>
