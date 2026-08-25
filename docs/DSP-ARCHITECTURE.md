# Exotica Décollage — DSP Architecture & Porting Spec

Modular architecture, parameter ranges, and signal flow of the engine, mapped
against the granular/tape/vintage-conditioning specification. Current
implementation is Web Audio + Tone.js (files referenced below); porting notes
target C++ (JUCE), Max/MSP (gen~), and Python (NumPy/SciPy/torchaudio).

---

## 1. Granular / Micro-Sampler Engine

Implementation: `src/engine/generate.ts` (event generation),
`src/engine/AudioEngine.ts` `realizeEvent` (realization), `src/engine/Slicer.ts`
(buffer segmentation).

| Sub-module | Spec | Implementation | Parameters |
| --- | --- | --- | --- |
| Buffer slice & windowing | dynamic micro-loops 100–800ms | V5 "spec loop" mode: grain train over a 100–800ms window (`genV5Cell`); plus native 10–80ms buzzing micro-loops | `loopDur` 0.1–0.8s, cell length 0.5–3s |
| Crossfade at loop bounds | equal-power 15–40ms | grain-train repeats overlap by `xfade` 15–40ms with linear ramps (equal-power approximation; see porting note) | `xfade` 0.015–0.04s |
| Non-grid polymetric playback | independent unquantized playheads | five slice voices run free-running, per-voice timers with irrational-feeling cycle lengths (V1 3.2–7.1s, V3 6–14s, V5 poisson 0.25–6s); LOOPLOCK freezes per-voice cells of *unequal* lengths that phase against each other | per-voice cycle ranges; no shared transport (`bpm` is only a pulse grid for V2-groove/V6) |
| Varipitch | −3…−12st, high-quality interpolation | V5 free mode: −300…−1200 cents; playback via `AudioBufferSourceNode.playbackRate` (browser-native interpolation — see porting note for Hermite/Sinc) | rate = 2^(cents/1200) |
| Granular freeze + spray | frozen position, 5–30ms jitter | spec-loop repeats share a frozen `grainOffset`, each repeat jittered by ±spray | `spray` 0.005–0.03s |
| Start-point S&H drift | 1–5% per loop cycle | LOOPLOCK mutation (every 8th repeat): `grainOffset` drifts ±(≤4%) of slice length | drift ±0.08 × sliceDur / 2 |

**Porting notes**
- JUCE: `juce::AudioBuffer` slices + per-grain `CatmullRomInterpolator` (Hermite)
  or `LagrangeInterpolator`; equal-power fades = `sin/cos(πx/2)` gain tables.
- gen~: `wave~`/`peek` with phasor-per-voice; crossfade via two read heads and
  `triangle`→`sin` shaping; freeze = latch on phasor wrap + `noise`-driven S&H.
- Python: `scipy.signal.resample_poly` (sinc) per grain; offline block assembly
  with overlap-add; torchaudio `Resample` for GPU batches.

## 2. Tape Drift & Modulation Engine

Implementation: `src/engine/DSPChain.ts` (live), `src/engine/OfflineRenderer.ts`
(mirror). Realized as a modulated delay line (~20ms nominal) on the master —
equivalent to read-rate modulation.

| Sub-module | Spec | Implementation | Parameters |
| --- | --- | --- | --- |
| Wow | sine 0.3–0.8Hz, ±10–25 cents | LFO on delay time, rate 0.1–0.8Hz mapped from Tape Aging macro; depth ±0.5–4.5ms of 20ms line (≈ up to ±25 cents equivalent slope) | `tapeAging` macro 0–1 |
| Flutter | 4–8Hz jitter, ±3–8 cents | second LFO (triangle 5.5Hz, ±0.35ms) summed into the same delay line | fixed; scale `flutter2Gain` for depth |
| Deep wow dips | — (extension) | TAPE gesture `wowDip`: depth ×6 surge for 1–2.5s at random 5–16s intervals | |
| Start-point drift S&H | 1–5% per cycle | see §1 (LOOPLOCK mutation) | |

**Porting notes**: JUCE — `juce::dsp::DelayLine` with two `dsp::Oscillator`
modulators (replace triangle flutter with filtered white noise for the
Perlin-ish character: `Random::nextFloat` → one-pole LP at ~6Hz). gen~ —
`delay` with `cycle` + `noise`→`slide`. Python — variable-delay via fractional
indexing with `np.interp` over a modulated read pointer.

## 3. Vintage Signal Conditioning Chain

Implementation: `DSPChain.ts` (`setVoicing`, `setTapeAging`), stems noise in
`stems.ts` (`renderSurfaceNoise`).

| Sub-module | Spec | Implementation | Parameters |
| --- | --- | --- | --- |
| HP filter | 2-pole Butterworth 250–400Hz | `voicingHP`: 12dB/oct highpass @320Hz, Q 0.707 (VOICING toggle) | 320Hz |
| LP filter | 4-pole 4.5–6.5kHz | `voicingLP`: 24dB/oct lowpass @5.5kHz (live Tone rolloff −24; offline two cascaded biquads Q 0.54/1.31 = true Butterworth) | 5.5kHz |
| Resonant bell | +2.5dB @1.2kHz, Q 1.4 | `voicingBell`: peaking EQ exactly per spec | +2.5dB, 1.2kHz, Q 1.4 |
| Saturation | soft-clip, 2nd/3rd harmonics | `tanh` waveshaper (odd harmonics) + Tone.Distortion wet 0.3–0.9; asymmetry for 2nd-order can be added via DC-offset pre-shaper | drive 1–3.5 from Tape Aging |
| Noise layer | pink + vinyl crackle, pre/post gain | Voice 4: pinkened hiss + 50/100/150Hz hum + two-scale crackle, loop-synthesized (`renderSurfaceNoise`), level = channel × Tape Aging | |

**Porting notes**: JUCE — `dsp::IIR::Coefficients::makeHighPass/LowPass/
PeakFilter`; saturation `std::tanh(drive·x + bias) − std::tanh(bias)` for
2nd+3rd harmonics. gen~ — `biquad`/`svf`; Python — `scipy.signal.butter(2/4)`
+ `sosfilt`.

## 4. Spatial & Reverb Routing

| Sub-module | Spec | Implementation | Parameters |
| --- | --- | --- | --- |
| Short dark plate | 1.2–2.2s, 0ms predelay, HF damp >3.5kHz, mix ≤50% | PLATE toggle: decay 1.7s + damping LP 3.5kHz feeding the convolver (offline: exp-decay noise IR of same length); long-chamber mode (4.5s) remains default | decay 1.7s / 4.5s; wet 0.15–0.7 via Decay macro |
| Resampling & layering bus | master bounce → −12st sub layer, parallel mix | SUB slider: live = Tone.PitchShift(−12, 100ms window) parallel bus rejoining pre-tape-stage; offline = second-pass granular octaver (120ms grains, 50% overlap, rate 0.5, position-synced, LP 2.5kHz) | sub gain 0–0.5 |
| Also | — | asymmetric tape delay 380/540ms fb 0.45 with HF roll-off; M/S width matrix; ±6dB tilt; AQUA chorus+muffle | |

**Porting notes**: JUCE — `dsp::Convolution` with generated IR, or Schroeder/
FDN for the plate; sub layer via `SoundTouch`/`RubberBand` or the same 2:1
overlap-add granular. gen~ — `mc.tapin~/tapout~` grains at 0.5 rate. Python —
`librosa.effects.pitch_shift(n_steps=-12)` on the bounced master, mixed back.

## Hauntology layer (Cover Versions pipeline additions)

| Sub-module | Spec | Implementation | Parameters |
| --- | --- | --- | --- |
| Grain windowing | Hann/Gaussian, no clicks | `applyGrainEnvelope`: raised-cosine `g·½(1−cos(πt/T))` curves (24-pt `setValueCurveAtTime`) on every grain < 1.2s; linear ramps beyond | attack/release per event |
| Reverse probability | 0–100% control | RVRS slider → `reverseProb`, reversed-buffer playback; TAPE adds +18% baseline | 0–1 |
| Downward varipitch | −1…−24st | V5 free mode −100…−2400 cents (PIT-scaled); V1 harmonic interval set gains −24 octave drops | |
| Async looper | irrational lengths, per-voice speed | phase-free voices + LOOPLOCK unequal cells + PHRASE verbatim region loops | native architecture |
| Wow | 0.5–2Hz sine | LFO 0.3–1.8Hz from Tape Aging | |
| Flutter | 5–15Hz randomized noise | white noise → 12Hz LP → read-head delay jitter (live Tone.Noise; offline seeded buffer → deterministic) | ±0.9ms |
| Head-loss + rumble | LP 3.5–8k, low-cut 20–60Hz | VOICING LP 5.5k (24dB) + always-on 30Hz rumble HP post-tilt | |
| Asymmetric saturation | odd + even harmonics | `y = tanh(d(x+b)) − tanh(db)`, b = 0.14 — the DC bias bends the transfer so 2nd-order harmonics join tanh's odd series (live native WaveShaper after Tone.Distortion; offline folded into the master shaper) | d 1.4 |
| Surface artifacts | friction, Poisson ticks, hum | Voice 4: pinkened hiss + two-scale Poisson-spaced crackle + 50/100/150Hz hum, stereo-decorrelated | |
| BBD dark delay | bucket-brigade repeats | feedback path lowpass 3kHz (true darkening per repeat, not shelf) | 380/540ms, fb 0.45 |
| Master dynamics | gentle, no brickwall | soft compressor (−14dB, 2.5:1, 12ms/250ms) + −0.5dB safety limiter; offline 3:1 knee 8 | |

## Master signal flow

```
voices (V1 bed/pad · V2 plunder · V3 decay · V4 noise+beds · V5 micro · V6 sub-pulse · V7 melody)
  │  (per-voice gain + reverb send · V1 through sidechain duck)
  ▼
input ──┬────────────────────────────► tape drift (wow 0.1–0.8Hz + flutter 5.5Hz on 20ms line)
        └► PitchShift −12 ► subGain ──┘
  ▼
telephony bandpass (crossfade bypass) ► tanh saturation ► 12-bit crusher (wet)
  ▼                    ├──► asym delay 380/540ms (fb .45, HF roll-off) ─┐
  ▼                    └──► damping LP (3.5k when PLATE) ► reverb ◄─────┘ + sends
  ▼
warmth LP ► VOICING [HP 320 ► bell +2.5dB@1.2k ► LP 5.5k ×24dB] ► AQUA [chorus ► muffle]
  ▼
M/S width matrix ► tilt shelves ±6dB ► limiter ► (tape dropout hole gain) ► out
```

## Control plane (all deterministic per seed)

- Chord clock: 7th-chords stacked in-scale, 4-chord progression, period 12s
  (or LOOPLOCK block), cadence chord flagged (+12% event gain).
- Per-voice seeded RNG streams (`mulberry32(seed + voice·7919)`) — live and
  offline renders realize identical event lists; offline output differs only
  by ±1 LSB (browser convolver float-order jitter).
- Every parameter above is serialized into the URL hash for patch recall.
