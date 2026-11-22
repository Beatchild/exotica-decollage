/// <reference lib="webworker" />
// Off-main-thread source analysis: Meyda frame features, onset detection and
// slice building (incl. per-slice autocorrelation pitch) are the heaviest
// synchronous work in the app — running them here keeps the UI and the live
// scheduler responsive while long files / YouTube collages are ingested.
import { analyzeChannels, buildSlices, detectBounds } from './Slicer'
import type { AnalyzeRequest, AnalyzeResponse } from './analyzeAsync'

self.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
  const req = e.data
  try {
    const analysis = analyzeChannels(req.channels, req.sampleRate, req.duration)
    const bounds = req.bounds ?? detectBounds(analysis)
    const slices = req.slice
      ? buildSlices(analysis, bounds, req.manual, req.maxSlice, req.minSlice)
      : null
    const res: AnalyzeResponse = { id: req.id, analysis, bounds, slices }
    ;(self as unknown as Worker).postMessage(res, [analysis.mono.buffer])
  } catch (err) {
    const res: AnalyzeResponse = {
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    }
    ;(self as unknown as Worker).postMessage(res)
  }
}
