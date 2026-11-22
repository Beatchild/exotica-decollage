# Exotica Décollage

Generative plunderphonics & musique concrète web studio — an homage to Andrew
Pekler's *Cover Versions* and Jan Jelinek's *Loop-Finding-Jazz-Records*.

Ingests sample material (drag-and-drop WAV/MP3/AIFF/FLAC, or four bundled
synthesized lounge stems), slices it on detected transients, extracts timbral
features per slice, and recombines everything through a 4-voice asynchronous
generative matrix with vintage-DSP mastering.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173 and press **START STUDIO** (audio is gated behind an
explicit gesture per browser autoplay policy), then **▶**.

## Features beyond the core

- **Offline render** — deterministic bounce of the current seed (1/2/5/10 min)
  straight to a 16-bit WAV, much faster than real time (`OfflineRenderer.ts`,
  native-node approximation of the master chain).
- **Seed + shareable URL** — every stochastic choice draws from per-voice
  seeded streams; the URL hash always encodes seed + full patch (macros, voice
  params, scale, bundled stems). Copy the URL to share/restore a patch. Dice
  button reseeds.
- **Multi-source pool** — up to 6 sources sliced into one shared pool (stems,
  uploads, mic captures); voices pick across all of them.
- **Slice editing** — click the waveform to add/remove boundaries (switches
  that source to manual slicing); right-click a timbre-map dot to reclassify it.
- **Scale quantize** — Voice 1 detune snapped to pentatonic / whole-tone /
  fifths for a more "tuned" exotica wash.
- **Drift** — slow autonomous random-walk of the three macros for hands-off
  long-form sessions.
- **Mic sampling** — 8-second capture from mic/line-in into the pool.
- **Sleeve PNG export** — download the current generative artwork.
- **Cover sonification** — drop an image (album cover) and it is read as a
  spectrogram (UPIC/MetaSynth lineage): columns = time, log-frequency rows =
  sine partials, luminance = amplitude. The 13s resynthesis lands in the
  source pool as sample material, while the cover's palette maps onto the
  macros (darkness → decay, desaturation → tape aging, contrast → chaos),
  picks the scale by dominant hue, and recolors the generative sleeve
  (`ImageSonifier.ts`).

- **YouTube ingestion** (dev server only) — paste one or several links (up to
  6, any separator; drag-drop works too): the Vite dev server shells out to
  the system `yt-dlp` (must be on PATH) and streams bestaudio back. One link →
  the client auto-selects its best percussive / harmonic / texture 12s windows
  (`Highlights.ts`) and adds ~36s of cuts. Several links → parallel fetch,
  fewer windows per track, everything spliced into a single collage source.
  Videos over 10 minutes are refused. Note: sampled material in anything you
  release still needs clearance.

- **V5 Microloop** — Jelinek-style microsampling voice: 10–80ms windows of a
  slice looped into 0.5–3s buzzing/rhythmic cells, pitch snapped to the scale.
- **Per-voice source routing** — numbered chips on each channel strip restrict
  which pool sources feed that voice (none highlighted = all).
- **Sidechain duck** — plunder hits (V2) briefly duck the harmonic bed (V1);
  applied identically in offline renders.
- **Scenes & morph** — 4 slots (A–D): click empty = save, click filled = 10s
  morph to it, right-click = overwrite.
- **Song mode** — a scene sequence like `A:60 B:90 C:45` played live with
  automatic morphs (loops), and used as a macro/level automation timeline by
  offline renders when scenes are set.
- **Stem export** — five per-voice WAVs from the same seed (per-voice RNG
  streams make each stem exactly its part of the full mix; shared master
  nonlinearities mean the sum is close to, not identical to, the mix bounce).
- **Bar-locked loop export** — 4/8/16 bars at the pulse BPM, rendered with a
  3s tail folded onto the loop start so reverb/delay wrap seamlessly.
- **Crates** — the whole source pool (audio + edited boundaries) saved to
  IndexedDB per browser; params stay in the URL, crates carry the audio.
- **Sleeve video export** — 30s of the animated artwork + master audio to a
  webm clip via canvas.captureStream + MediaRecorder (tab must stay visible).

- **Freeze / resample** — capture 12s of the processed master back into the
  pool as a new source; the collage cannibalizes itself.
- **Groove mode** — V2 timing switches from Poisson to a euclidean 16th grid
  with per-event swing at the pulse BPM (batch-scheduled ahead so background
  tab throttling can't starve it; sample-accurate offline too).
- **Keyboard performance** — click a timbre-map dot to arm it, then play it
  chromatically from the home row (A–L; Shift = octave down). Space = play,
  R = record, 1–4 = scenes.
- **Album builder** (ALBUM button) — a tracklist where each row is a track:
  title, character (studio sound or one of the one-click presets), length,
  seed. ▶ auditions a row live, 🎲 rerolls it; RENDER ALBUM writes ONE zip:
  `NN Title.wav` (loudness-matched), a sleeve per track, `cover.png` and
  `tracklist.txt` with LUFS / true peak. The plan persists in localStorage
  and the studio patch is restored when the panel closes (`album.ts`,
  `AlbumPanel.tsx`, store-only zip in `zip.ts`).
- **Pinned dots** — Shift-click a timbre-map dot (or drag it into the
  COMPOSE pin strip) to pin it; Alt-click pins a dot plus its four closest
  sound-alikes. MATERIAL decides how pins steer the generative voices:
  ALL SLICES (ignored) · FAVOUR PINNED (pinned dots repeated until they are
  about half of every voice's choices — measured ~70% of events from 6% of
  the pool) · PINNED ONLY (nothing else plays). Deterministic, so seeded
  renders still repeat; pins survive boundary edits / FRAG re-slicing by
  position. Dragging a dot (or DRAG ALL) onto an ARRANGE track places that
  exact slice there, beat-snapped, several end to end.
- **COMPOSE** (`ComposePanel.tsx`, `moods.ts`) — the short way to a sound:
  1 material (pins) · 2 mood (EERIE · MYTHIC · HAUNTED RITUAL · SUNKEN
  TEMPLE — whole desk settings for drones, ghosts, rituals) · 3 three knobs,
  live: DARKNESS / SPACE / MOTION · 4 keep it: LISTEN, ANOTHER TAKE (seed),
  SKETCH TO ARRANGE (lays the pinned dots out as a 4/8/16-bar piece across
  the four tracks), RENDER, + ALBUM (stores the exact patch with the track,
  so the album renders that sound even after the studio has moved on).
- **MEMORY WEAVE** (`memory.ts`, top of COMPOSE) — one button, one haunted,
  tonal track from every source: it pins the warmest, most clearly pitched
  fragments of each source (3–12 per source, spread across each file, one soft
  texture for air), reads the key from those fragments only, applies the
  FORGOTTEN MEMORY mood (pentatonic choir-pads, a lullaby line, old tape) and
  lays out a four-part form in scene slots E–H — DUST → SURFACING → THE
  MEMORY → DISSOLVING — timed to the MIN length, played from the top and
  rendered the same way. KEY ◀ ▶ retunes it; pin/unpin dots by hand and KEEP
  FRAGMENTS, REBUILD. + ALBUM stores the form, its scenes and the pins with the
  track (patches now carry `sg` / `scn` / `pins`).
  - **Sources** — a weight per source (OFF … 2×: how many of its fragments are
    gathered) and an **era** per source (`eras.ts`): VINYL · CASSETTE · VHS ·
    AM RADIO · TELEPHONE. Every fragment of that source is coloured by the
    medium (band limits, resonance, saturation, wow/flutter as detune) and each
    medium in use lays its surface under the mix (crackle, hiss, mains hum,
    static). The first weave suggests a different medium per source, darkest
    on vinyl, brightest on radio.
  - **Memory layers** (`memoryLayers.ts`, live and in renders):
    STRETCH — the most tonal fragments PaulStretch-ed (`stretch.ts`, chunked
    FFT, cached) into 18 s clouds, snapped to the key, strongest in DUST and
    DISSOLVING; RETURNING MELODY — one pentatonic motif played on the clearest
    pitched fragment: far and partial in SURFACING, whole in THE MEMORY, back
    slower, sinking and partly backwards in DISSOLVING (ANOTHER MELODY = new
    motif seed); GHOST VOICES — the most voice-like fragments, behind a wall or
    down a phone line, sometimes reversed, with an echo.
  - **Live form** — a playhead on the section bar; click a section to play from
    it; drag a seam to re-proportion (kept when the length or knobs change).
  - **3 TAKES** — three seeds of the same weave; ▶ START or ▶ HEART (jump to THE
    MEMORY) each, KEEP the one you want.
  - **WEAVE ALBUM** — 4–12 tracks from the same material: each leans on a
    different source, keys walk the circle of fifths from the home key and the
    last track returns home and quotes the first one's melody, darkness follows
    a light → dark → light arc; titles are suggested. Replaces the album plan
    (previous plan kept under `exotica.album.v1.backup`). Patches carry the
    layers (`ml`) and eras (`era`).
- **MIX & MASTER** (`MixMasterPanel.tsx`, `mastering.ts`, Alt+6) — the
  finishing stage:
  - **MIX** — five bus faders (−∞ … +6 dB, double-click = 0 dB): VOICES (the
    generative desk + chimes), CLOUDS, MELODY, GHOSTS, SURFACE. Each bus scales
    its dry signal and its reverb send together; live and in renders; saved in
    every patch (`mx`), so album tracks keep their balance.
  - **MASTER** — a release chain: low cut (24 dB/oct) → mono bass (sides
    high-passed) → warmth (140 Hz shelf) → mud cut (320 Hz bell) → air (9 kHz
    shelf) → glue (stereo-linked RMS compressor, threshold relative to the
    programme) → tape (level-referenced tanh) → width. Presets: TRANSPARENT ·
    WARM TAPE · CLEAR STREAMING · DARK AMBIENT · VINYL CUT. It is heard live
    (native-node twin between the studio and the speakers; meters read after
    it) and MASTER ON/OFF is the A/B switch — what you hear is what exports.
    Every export (single, loop, album) runs the chain in the mastering worker
    before LUFS normalization, true-peak limiting and dither. Saved across
    sessions (`exotica.master.v1`) — it belongs to the release, not a track.
  - **FINISH** — loudness target, format, length, RENDER FINAL MASTER, and the
    last export's integrated loudness / true peak.
  - **EXACT PREVIEW** — 30 s (THE HEART or THE START) rendered offline and
    mastered by the export code itself, played straight to the speakers;
    A · MASTERED / B · UNMASTERED (level-matched, so the A/B compares tone).
  - **MATCH A REFERENCE** — load a finished track: its middle minute and 30 s
    of your pre-master mix are profiled (band balance <150 · 150–500 · 500–4k ·
    >4k Hz, side energy, low-end mono-ness, peak-to-loudness); the chain's
    warmth / mud / air / width / glue / mono bass and the loudness target are
    set to land near it, with a short report.
  - **RELEASE KIT** — one ZIP: the final master WAV (1000 px cover in its ID3),
    `cover-3000.jpg` drawn from the material (the fragments' timbre map as a
    cloud of light, reel rings, scratches, grain), `release.txt` (Bandcamp ·
    distributor fields · YouTube description with the form's chapters) and
    `samples.txt`. Optional: a 1280×720 WebM for YouTube, recorded in real
    time (keep the tab visible). Album ZIPs now get `release.txt` and a
    generated cover when none is uploaded.
  - **MIDI CONTROL** — Web MIDI with MIDI LEARN: DARKNESS / SPACE / MOTION,
    every MIX fader, the four memory layers, MASTER on/off, play/pause and
    WEAVE. Mappings persist (`exotica.midi.v1`).
- **DISINTEGRATING TAPE** (memory layer, LOOP bus) — in DISSOLVING one phrase
  loops; every pass the tape sheds more: holes open and never heal, the top
  darkens, the speed sags ~7 %, until only fragments remain (without a form: a
  60–90 s disintegration now and then). Measured: −15 → −42 dB across the
  section.
- **Stems** now include the memory buses that sound (`memory-clouds`,
  `-melody`, `-ghosts`, `-loop`, `-surface`).
- **Stretch clouds** are computed in a worker (`stretch.worker.ts`), with the
  chunked main-thread path as fallback.
- **SIMPLE / ADVANCED** (COMPOSE) — SIMPLE keeps weave, mood, three knobs,
  listen / render / + album; ADVANCED shows sources & eras, layers, pins,
  takes, album weave and sketch.
- **UNDO** — Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y): whole-studio snapshots (patch +
  master) taken when the state settles; song morphs and drift don't count.
- **Release-ready WAVs** — 24-bit or 16-bit (TPDF-dithered), 44.1 or
  48 kHz (EXPORT menu / album RELEASE settings). Every export is tagged twice:
  RIFF `LIST/INFO` (Explorer, DAWs) and an ID3v2.4 `id3 ` chunk (players,
  taggers) — title, artist, album, track n/N, year, seed, and embedded cover
  art (the track's sleeve, or your own uploaded PNG/JPEG cover).
- **Album transitions** — SEPARATE TRACKS (fade in/out per track) or
  GAPLESS: each track renders a few seconds long and that overhang
  equal-power-crossfades into the next track's head, so the files play as
  one continuous piece; album fade-in/out only at the two ends.
- **Sample provenance** (`provenance.ts`) — every pool source records where
  it came from: bundled stems (in-app, nothing to clear), uploads, mic takes,
  sonified images, resamples, and YouTube cuts with the exact timestamp of
  each window in the original video (also through region cuts/splices and
  crates). Renders log which stretches of which source they actually played;
  album zips add `samples.txt` + `samples.json` mapping every track back to
  original recordings and time ranges, for clearance. EXPORT → SAMPLE REPORT
  gives the same for a single render.
- **Navigation** — sticky top bar (transport · meter · EXPORT menu · ALBUM ·
  search · help), section tabs that follow the scroll (Alt+1–4), collapsible
  sections that remember their state, a Ctrl/⌘+K command palette with every
  action (renders, characters, scenes, stems, settings), a `?` help overlay,
  and non-blocking toasts instead of `alert()` popups (`src/ui/`).
- **Stopping renders** — every render (RENDER / STEMS / LOOP / REMIX /
  ALBUM / arrangement BOUNCE) has a STOP button next to its progress bar,
  and Esc stops it from anywhere. Cancelled renders save nothing and free
  the CPU at once (the OfflineAudioContext is left suspended, the mastering
  worker is terminated). The album adds finer control: SKIP TRACK (drop the
  current one, keep going), STOP AFTER THIS TRACK, STOP NOW · KEEP FINISHED
  (zips what is done), CANCEL ALL (saves nothing); rows can be unticked to
  leave them out, ⬇ on a row exports just that track, and the output can be
  one .zip or separate WAVs.
- **Loudness** — BS.1770-4 integrated LUFS, short-term max and 4×
  oversampled true peak (`loudness.ts`). RENDER / LOOP / REMIX / ALBUM are
  normalized to the header's target (−14 streaming default, −16, −23, −9,
  or off) with a look-ahead limiter holding true peak ≤ −1 dBTP; STEMS are
  never normalized. The header meter shows live momentary / short-term /
  integrated LUFS of the master.
- **Portable crates** — export/import the pool as a `.crate` file (binary:
  JSON header + raw Float32 audio) alongside per-browser IndexedDB saves.
- **Radio mode** — endless background stream: reseed + bundled-stem rotation
  every 3 minutes, drift on.
- **Width & tilt** — master stereo image (mono→extra wide, Tone.StereoWidener
  live / M-S matrix offline) and ±6dB spectral tilt shelves.
- **Parallel remix** — ×N REMIX renders simultaneous variants from the
  YouTube/Freeze material only: each gets its own seed, random macros, scale,
  groove and duck (RenderOpts overrides keep engine state untouched, so the
  OfflineAudioContexts genuinely run concurrently — ~1.6x over sequential).

## Staying responsive

- Source analysis (Meyda features, onset detection, per-slice pitch) runs in
  a Web Worker pool (`analysis.worker.ts` / `analyzeAsync.ts`), so long
  uploads and YouTube collages no longer lock the UI. Pitch autocorrelation
  is 2×-decimated with parabolic refinement (~4× cheaper).
- Offline renders schedule voices as generators in 10s windows driven by
  `OfflineAudioContext.suspend()`, instead of building every node of a
  20-minute track up front; `onProgress` feeds the header progress bar.
- Loudness, limiting, WAV encoding and the zip CRC run in
  `master.worker.ts`.
- Presets only re-slice the pool when the fragment regime actually changes.

## Desktop app (Tauri)

`src-tauri/` wraps the studio as a native Windows app (WebView2). The Rust
backend exposes `yt_check` / `yt_fetch` commands that shell out to the system
`yt-dlp`, so the YouTube module works in the packaged app too (no dev server
needed) — `src/engine/ytBridge.ts` routes to Rust inside Tauri and to the Vite
middleware in the browser.

Build (Rust + MSVC required; on this machine both live on D: —
`RUSTUP_HOME=D:\rustup`, `CARGO_HOME=D:\cargo`, `CARGO_TARGET_DIR=D:\cargo-target`,
VC tools in `D:\VSBuildTools`):

```bash
npm run tauri build
```

Outputs: `D:\cargo-target\release\exotica-decollage.exe` (portable, 7.4MB) and
`D:\cargo-target\release\bundle\nsis\Exotica Decollage_1.0.0_x64-setup.exe`
(installer with Start Menu shortcuts + uninstaller).

## Architecture

| Path | Role |
| --- | --- |
| `src/engine/Slicer.ts` | Frame analysis (Meyda RMS/centroid/ZCR + custom spectral flux), adaptive-threshold onset detection, 80ms–1.2s micro-slices, autocorrelation pitch, 3-way timbral categorization |
| `src/engine/AudioEngine.ts` | Master manager; 4 phase-free voices on independent timers: granular harmonic bed, Markov/Poisson plunder fragments (tape-ratio rates, wide random pan), resonant bandpass-swept decays, looped surface noise (crackle/hum/hiss) |
| `src/engine/DSPChain.ts` | Tone.js master rack: LFO tape flutter, switchable telephony bandpass, saturation + 12-bit crusher, asymmetric 380/540ms tape delay with HF roll-off, long plate reverb, limiter |
| `src/engine/stems.ts` | Four royalty-free-by-construction vintage stems rendered offline (e-piano, bass & brush, string pad, exotica percussion) + surface-noise loop |
| `src/engine/WavRecorder.ts` | Real-time master capture → true 16-bit stereo `.wav` download |
| `src/components/AudioVisualizer.tsx` | Waveform + slice boundaries; brightness/duration scatter timbre map, click-to-audition, live fire highlights |
| `src/components/GenerativeArtwork.tsx` | Constructivist sleeve collage reacting to slice triggers + master spectrum |
| `src/components/MixerRack.tsx` | Per-voice strips (level/mute/solo/density/pitch/reverb) + Decay Factor / Tape Aging / Chaos macros |
| `src/hooks/useAudioEngine.ts` | React ↔ engine bridge |

## Notes

- Meyda 5's built-in `spectralFlux` extractor throws (`x is not defined`), so
  flux is computed manually from Meyda's amplitude spectrum plus an RMS
  derivative term.
- The bundled stems are synthesized (OfflineAudioContext, seeded PRNG) rather
  than sampled recordings — no rights exposure, no payload weight, deterministic
  slicing. Load your own crate digs via drag-and-drop for the real thing.
- Recording uses a ScriptProcessor PCM tap instead of MediaRecorder because the
  spec calls for a genuine `.wav` export (MediaRecorder yields opus/webm).
