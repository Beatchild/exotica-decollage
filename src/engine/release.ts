import { mulberry32 } from './rng'
import type { Slice } from './types'

/**
 * RELEASE KIT — what a finished track needs to go out:
 * a 3000×3000 cover drawn from the material itself, the store / distributor /
 * YouTube texts (with chapters from the form), and a real-time video.
 */

const NOTE = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

export interface CoverInput {
  title: string
  artist: string
  seed: number
  /** the fragments the piece is made of (pinned, else the pool) */
  slices: Slice[]
  /** 0 = pale … 1 = black */
  darkness: number
  size?: number
}

/**
 * The cover: the timbre map of the actual fragments as a soft, overexposed
 * cloud of light (bright sounds right, long sounds high, loud sounds large),
 * tape-reel rings, scratches, grain, a vignette, and the title set small.
 */
export async function renderCover(o: CoverInput): Promise<Blob> {
  const size = o.size ?? 3000
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const g = cv.getContext('2d')!
  const rng = mulberry32(o.seed + 3000)
  const u = size / 1000

  // ground: warm dark, lighter with less darkness
  const lift = Math.round((1 - o.darkness) * 34)
  const bg = g.createRadialGradient(size * 0.5, size * 0.42, size * 0.05, size * 0.5, size * 0.5, size * 0.75)
  bg.addColorStop(0, `rgb(${58 + lift},${44 + lift},${34 + lift})`)
  bg.addColorStop(1, `rgb(${14 + lift / 3},${11 + lift / 3},${10 + lift / 3})`)
  g.fillStyle = bg
  g.fillRect(0, 0, size, size)

  // the cloud of fragments
  const PALETTE = ['#D35400', '#F4EFEA', '#C9A227', '#9C6B5E', '#6E8580', '#E8B796']
  const pts = (o.slices.length ? o.slices : []).slice(0, 220)
  const cs = pts.map((s) => Math.log(Math.max(60, s.centroid)))
  const cMin = Math.min(...cs, Math.log(200))
  const cMax = Math.max(...cs, Math.log(6000))
  g.globalCompositeOperation = 'screen'
  g.filter = `blur(${Math.round(26 * u)}px)`
  pts.forEach((s, i) => {
    const x = size * (0.18 + 0.64 * ((cs[i] - cMin) / Math.max(0.01, cMax - cMin))) + (rng() - 0.5) * 60 * u
    const y = size * (0.72 - 0.44 * Math.min(1, s.duration / 1.2)) + (rng() - 0.5) * 80 * u
    const r = (14 + Math.sqrt(s.rms) * 260) * u * (0.6 + rng() * 0.8)
    const col = PALETTE[(s.category === 'harmonic' ? 1 : s.category === 'texture' ? 4 : 0) + (i % 2 ? 0 : 1)] ?? PALETTE[0]
    g.globalAlpha = 0.22 + rng() * 0.25
    g.fillStyle = col
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  })
  // one overexposed core: the memory itself
  g.filter = `blur(${Math.round(90 * u)}px)`
  g.globalAlpha = 0.5
  g.fillStyle = '#F4EFEA'
  g.beginPath()
  g.arc(size * (0.42 + rng() * 0.16), size * (0.4 + rng() * 0.12), 120 * u, 0, Math.PI * 2)
  g.fill()
  g.filter = 'none'
  g.globalCompositeOperation = 'source-over'

  // tape-reel rings
  const rx = size * (0.3 + rng() * 0.4)
  const ry = size * (0.35 + rng() * 0.2)
  g.strokeStyle = '#F4EFEA'
  for (let k = 0; k < 9; k++) {
    g.globalAlpha = 0.05 + rng() * 0.07
    g.lineWidth = (0.6 + rng() * 2) * u
    g.beginPath()
    g.arc(rx, ry, (90 + k * 34 + rng() * 10) * u, rng() * Math.PI * 2, rng() * Math.PI * 2 + Math.PI * (0.6 + rng()))
    g.stroke()
  }
  // scratches
  for (let k = 0; k < 70; k++) {
    g.globalAlpha = 0.03 + rng() * 0.07
    g.lineWidth = (0.4 + rng() * 1.2) * u
    const y0 = rng() * size
    g.beginPath()
    g.moveTo(0, y0)
    g.lineTo(size, y0 + (rng() - 0.5) * 30 * u)
    g.stroke()
  }
  g.globalAlpha = 1

  // grain (tiled)
  const tile = document.createElement('canvas')
  tile.width = tile.height = 256
  const tg = tile.getContext('2d')!
  const img = tg.createImageData(256, 256)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(rng() * 255)
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 22
  }
  tg.putImageData(img, 0, 0)
  g.fillStyle = g.createPattern(tile, 'repeat')!
  g.fillRect(0, 0, size, size)

  // vignette
  const vg = g.createRadialGradient(size / 2, size / 2, size * 0.35, size / 2, size / 2, size * 0.75)
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(0,0,0,0.6)')
  g.fillStyle = vg
  g.fillRect(0, 0, size, size)

  // type
  g.fillStyle = '#F4EFEA'
  g.globalAlpha = 0.92
  g.textBaseline = 'alphabetic'
  const pad = 70 * u
  g.font = `600 ${Math.round(34 * u)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`
  spaced(g, o.title.toUpperCase(), pad, size - pad - 46 * u, 6 * u)
  if (o.artist) {
    g.globalAlpha = 0.6
    g.font = `400 ${Math.round(22 * u)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`
    spaced(g, o.artist.toUpperCase(), pad, size - pad, 5 * u)
  }
  g.globalAlpha = 1
  // JPEG: film grain makes PNG huge (~20 MB); distributors want ≤ 10 MB
  return new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('cover failed'))), 'image/jpeg', 0.92))
}

function spaced(g: CanvasRenderingContext2D, text: string, x: number, y: number, track: number) {
  let cx = x
  for (const ch of text) {
    g.fillText(ch, cx, y)
    cx += g.measureText(ch).width + track
  }
}

// ---------- texts ----------

export interface ReleaseTrack { n: number; title: string; sec: number; lufs?: number; truePeak?: number }

export interface ReleaseInfo {
  kind: 'single' | 'album'
  title: string
  artist: string
  year: string
  tracks: ReleaseTrack[]
  /** YouTube chapters (single: the form's sections) */
  chapters?: Array<{ t: number; label: string }>
  keyRoot?: number
  /** source names with their medium */
  sources: Array<{ name: string; era?: string }>
  fragments?: number
  lufsTarget: number | null
  format: { bits: number; sampleRate: number }
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`

/** Bandcamp · distributor (DistroKid & co.) · YouTube — ready to paste. */
export function releaseNotes(r: ReleaseInfo): string {
  const total = r.tracks.reduce((n, t) => n + t.sec, 0)
  const media = [...new Set(r.sources.map((s) => s.era).filter((e) => e && e !== 'none'))]
  const blurb =
    `${r.kind === 'album' ? 'An album' : 'A piece'} woven from ${r.fragments ? `${r.fragments} fragments of ` : ''}` +
    `${r.sources.length} found recording${r.sources.length === 1 ? '' : 's'}` +
    (media.length ? `, each heard as if from an old ${media.join(' / ').toLowerCase()}` : '') +
    (r.keyRoot != null ? `, tuned to ${NOTE[r.keyRoot]}` : '') +
    '. Slowed, worn and looped until it sounds like a memory you never had.'
  const tags = ['ambient', 'hauntology', 'plunderphonics', 'tape loops', 'drone', 'experimental', 'sample-based', 'lo-fi']
  const L: string[] = []
  const hr = (t: string) => { L.push('', `== ${t} ${'='.repeat(Math.max(3, 56 - t.length))}`, '') }

  L.push(`${r.artist || '(artist)'} — ${r.title} (${r.year})`)
  hr('BANDCAMP')
  L.push(`Title: ${r.title}`, `Artist: ${r.artist || '(fill in)'}`, `Release date: ${r.year}`, '', 'About:', blurb, '')
  L.push('Tracks:')
  for (const t of r.tracks) L.push(`${String(t.n).padStart(2, '0')}. ${t.title} (${mmss(t.sec)})`)
  L.push('', 'Credits:', `All sounds: ${r.sources.map((s) => s.name).join(', ')}.`,
    'Woven, mixed and mastered in Exotica Décollage.', '', `Tags: ${tags.join(', ')}`)

  hr('DISTRIBUTION (DistroKid · CD Baby · TuneCore …)')
  L.push(
    `Release type: ${r.kind === 'album' ? (r.tracks.length >= 7 || total > 30 * 60 ? 'Album' : 'EP') : 'Single'}`,
    `Artist name: ${r.artist || '(fill in)'}`,
    `Release title: ${r.title}`,
    'Primary genre: Ambient · Secondary: Electronic / Experimental',
    'Language: Instrumental (no lyrics)',
    'Explicit: No',
    'Songwriter(s): (fill in — your legal name)',
    `Release date: (choose) · Year: ${r.year}`,
    'ISRC / UPC: assigned by the distributor (leave empty)',
    'Cover art: cover-3000.jpg — 3000×3000 JPEG, no text other than artist/title ✓',
    `Audio: ${r.format.bits}-bit / ${r.format.sampleRate / 1000} kHz WAV` +
      (r.lufsTarget != null ? `, mastered to ${r.lufsTarget} LUFS, true peak ≤ −1 dBTP ✓` : ''),
    'Samples: see samples.txt — every source and the exact time ranges used. Clear anything you do not own before release.',
  )
  for (const t of r.tracks) {
    if (t.lufs != null && Number.isFinite(t.lufs)) {
      L.push(`  ${String(t.n).padStart(2, '0')}. ${t.title}: ${t.lufs.toFixed(1)} LUFS · TP ${t.truePeak?.toFixed(1)} dBTP · ${mmss(t.sec)}`)
    }
  }

  hr('YOUTUBE')
  L.push(`Title: ${r.artist ? `${r.artist} — ` : ''}${r.title}`, '', 'Description:', blurb, '')
  if (r.chapters?.length) {
    for (const c of r.chapters) L.push(`${mmss(c.t)} ${c.label}`)
  } else if (r.kind === 'album') {
    let acc = 0
    for (const t of r.tracks) {
      L.push(`${mmss(acc)} ${t.title}`)
      acc += t.sec
    }
  }
  L.push('', `#ambient #hauntology #tapeloops`, '', `Tags: ${tags.join(', ')}`)
  return L.join('\n')
}
