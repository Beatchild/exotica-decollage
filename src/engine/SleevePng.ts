import { mulberry32 } from './rng'

const DEFAULT_PALETTE = ['#D35400', '#1A1A1A', '#C7B9A5', '#8A7F72', '#E8DFD3', '#A04000']

/**
 * Standalone seeded sleeve for album-mode exports: same constructivist
 * vocabulary as the live artwork, rendered offscreen so each track of a batch
 * gets its own deterministic cover.
 */
export function renderSleevePng(
  seed: number,
  palette: string[] | null,
  size = 1200,
): Promise<Blob | null> {
  const pal = palette && palette.length ? palette : DEFAULT_PALETTE
  const rng = mulberry32(seed)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')!
  g.fillStyle = '#EFE7DC'
  g.fillRect(0, 0, size, size)

  const shapes = 7 + Math.floor(rng() * 5)
  for (let i = 0; i < shapes; i++) {
    const kind = Math.floor(rng() * 4)
    const cx = rng() * size
    const cy = rng() * size
    const sz = (0.06 + rng() * 0.3) * size
    g.save()
    g.translate(cx, cy)
    g.rotate(rng() * Math.PI * 2)
    g.fillStyle = pal[Math.floor(rng() * pal.length)]
    g.globalAlpha = 0.92
    switch (kind) {
      case 0:
        g.beginPath()
        g.arc(0, 0, sz / 2, 0, Math.PI * 2)
        g.fill()
        break
      case 1:
        g.beginPath()
        g.arc(0, 0, sz / 2, 0, Math.PI)
        g.closePath()
        g.fill()
        break
      case 2:
        g.fillRect(-sz / 2, -sz / 4, sz, sz / 2)
        break
      default: {
        const sides = 3 + Math.floor(rng() * 3)
        g.beginPath()
        for (let k = 0; k <= sides; k++) {
          const a = (k / sides) * Math.PI * 2
          if (k === 0) g.moveTo(Math.cos(a) * (sz / 2), Math.sin(a) * (sz / 2))
          else g.lineTo(Math.cos(a) * (sz / 2), Math.sin(a) * (sz / 2))
        }
        g.fill()
      }
    }
    g.restore()
  }

  // archival footer stamp
  g.globalAlpha = 0.85
  g.fillStyle = '#1A1A1A'
  g.font = `${Math.round(size * 0.018)}px monospace`
  g.fillText(`EXOTICA DÉCOLLAGE · SEED ${seed}`, size * 0.04, size * 0.965)

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}
