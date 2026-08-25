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
- **Album mode** — N tracks batch-rendered with derived seeds, each with its
  own deterministic sleeve PNG.
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
