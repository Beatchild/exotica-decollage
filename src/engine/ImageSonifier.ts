import type { MacroParams, ScaleName } from './types'

/**
 * Cover-art sonification (UPIC / MetaSynth lineage):
 * the image is read as a spectrogram — columns are time, rows are a log
 * frequency axis, pixel luminance drives a bank of sine partials rendered
 * offline. The result lands in the source pool as ordinary sample material.
 * A palette analysis of the same image maps onto the engine's macros/scale.
 */

const COLS = 220
const ROWS = 96
const DURATION = 13 // seconds
const F_MIN = 70
const F_MAX = 5500

export interface ImageAnalysis {
  imageData: ImageData
  palette: string[]
  avgLum: number // 0–1
  saturation: number // 0–1
  contrast: number // 0–1 (luminance std, scaled)
  hue: number // 0–360, luminance-weighted dominant
}

/** Decode + downscale an image file and extract palette/traits. */
export async function analyzeImage(file: File): Promise<ImageAnalysis> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = COLS
    canvas.height = ROWS
    const g = canvas.getContext('2d', { willReadFrequently: true })!
    g.drawImage(bitmap, 0, 0, COLS, ROWS)
    const imageData = g.getImageData(0, 0, COLS, ROWS)
    return { imageData, ...extractTraits(imageData) }
  } finally {
    bitmap.close()
  }
}

function extractTraits(img: ImageData): Omit<ImageAnalysis, 'imageData'> {
  const d = img.data
  const n = img.width * img.height
  let lumSum = 0
  let satSum = 0
  let hx = 0
  let hy = 0
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>()
  const lums: number[] = []
  for (let i = 0; i < n; i++) {
    const r = d[i * 4]
    const g = d[i * 4 + 1]
    const b = d[i * 4 + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    lums.push(lum)
    lumSum += lum
    const sat = max === 0 ? 0 : (max - min) / max
    satSum += sat
    // hue as a weighted vector so wrap-around averages correctly
    if (max !== min) {
      let h: number
      if (max === r) h = ((g - b) / (max - min)) % 6
      else if (max === g) h = (b - r) / (max - min) + 2
      else h = (r - g) / (max - min) + 4
      const rad = (h * 60 * Math.PI) / 180
      const w = sat * lum
      hx += Math.cos(rad) * w
      hy += Math.sin(rad) * w
    }
    // 4-bit-per-channel buckets for the dominant palette
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.count++
      bucket.r += r
      bucket.g += g
      bucket.b += b
    } else {
      buckets.set(key, { count: 1, r, g, b })
    }
  }
  const avgLum = lumSum / n
  let variance = 0
  for (const l of lums) variance += (l - avgLum) ** 2
  const contrast = Math.min(1, Math.sqrt(variance / n) * 3)
  const hue = ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360

  const palette = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((v) => {
      const to = (x: number) =>
        Math.round(x / v.count)
          .toString(16)
          .padStart(2, '0')
      return `#${to(v.r)}${to(v.g)}${to(v.b)}`
    })

  return { palette, avgLum, saturation: satSum / n, contrast, hue }
}

/** Map the cover's visual traits onto engine macros + scale. */
export function traitsToPatch(a: ImageAnalysis): { macros: MacroParams; scale: ScaleName } {
  const macros: MacroParams = {
    // darker sleeve → longer decay wash
    decayFactor: Math.min(1, 0.3 + (1 - a.avgLum) * 0.6),
    // washed-out colors → older tape
    tapeAging: Math.min(1, 0.25 + (1 - a.saturation) * 0.6),
    // hard graphic contrast → more entropy
    chaos: Math.min(1, 0.15 + a.contrast * 0.7),
  }
  let scale: ScaleName
  if (a.saturation < 0.12) scale = 'free'
  else if (a.hue < 90 || a.hue >= 330) scale = 'pentatonic' // warm reds/oranges/yellows
  else if (a.hue < 210) scale = 'wholetone' // greens/cyans
  else scale = 'fifths' // blues/purples
  return { macros, scale }
}

/**
 * Additive resynthesis: one sine partial per row on a log-frequency grid,
 * amplitude driven by that row's luminance curve across the columns.
 */
export async function sonifyImage(a: ImageAnalysis, sampleRate: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(DURATION * sampleRate), sampleRate)
  const d = a.imageData.data

  const master = ctx.createGain()
  master.gain.value = 1
  // soften the top and tame partial pile-ups
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 7000
  lp.Q.value = 0.4
  master.connect(lp)
  lp.connect(ctx.destination)

  for (let row = 0; row < ROWS; row++) {
    // top of the image = high frequencies
    const f = F_MAX * Math.pow(F_MIN / F_MAX, row / (ROWS - 1))
    const curve = new Float32Array(COLS + 1)
    let any = false
    for (let col = 0; col < COLS; col++) {
      const i = (row * COLS + col) * 4
      const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255
      // gamma lift for contrast + gentle high-frequency tilt
      const v = Math.pow(lum, 1.8) * Math.pow(F_MIN / f, 0.25)
      curve[col] = v
      if (v > 0.004) any = true
    }
    curve[COLS] = 0 // fade out at the end
    if (!any) continue

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = f
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, 0)
    env.gain.setValueCurveAtTime(curve, 0, DURATION)
    const pan = ctx.createStereoPanner()
    pan.pan.value = row % 2 === 0 ? -0.35 : 0.35
    osc.connect(env)
    env.connect(pan)
    pan.connect(master)
    osc.start(0)
    osc.stop(DURATION)
  }

  const rendered = await ctx.startRendering()
  // normalize to a healthy peak — sparse dark covers stay audible,
  // bright busy ones don't clip
  let peak = 0
  for (let ch = 0; ch < 2; ch++) {
    const data = rendered.getChannelData(ch)
    for (let i = 0; i < data.length; i += 16) peak = Math.max(peak, Math.abs(data[i]))
  }
  if (peak > 1e-6) {
    const scale = 0.85 / peak
    for (let ch = 0; ch < 2; ch++) {
      const data = rendered.getChannelData(ch)
      for (let i = 0; i < data.length; i++) data[i] *= scale
    }
  }
  return rendered
}
