/** Drag payload for timbre-map dots: JSON array of slice ids. */
export const SLICE_MIME = 'application/x-exotica-slices'

export function readSliceIds(dt: DataTransfer): number[] {
  try {
    const v = JSON.parse(dt.getData(SLICE_MIME) || '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []
  } catch {
    return []
  }
}

export const hasSlices = (dt: DataTransfer) => dt.types.includes(SLICE_MIME)
