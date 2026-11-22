import { useEffect } from 'react'
import { X } from 'lucide-react'

const BURNT = '#D35400'

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl / ⌘ + K', 'Command palette — every action by name'],
  ['Space', 'Play / pause'],
  ['R', 'Live recording on / off'],
  ['Esc', 'Stop the running render or bounce · close panels'],
  ['1 – 4', 'Scene A–D: morph to it (save it if empty)'],
  ['Alt + 1 – 6', 'Jump to Sources · Waveform · Compose · Arrange · Mixer · Master'],
  ['Shift-click a dot', 'Pin it: the composition draws on pinned dots (see COMPOSE)'],
  ['Alt-click a dot', 'Pin it and its closest sound-alikes'],
  ['Drag a dot', 'Onto ARRANGE (places that slice) or the pin strip (pins it)'],
  ['A – L', 'Play the armed slice chromatically (click a timbre-map dot to arm)'],
  ['Shift + A – L', 'Same, an octave down'],
  ['Ctrl + Z', 'Undo (Ctrl + Shift + Z / Ctrl + Y: redo) — mixer, pins, weave, master, everything in the patch'],
  ['?', 'This help'],
]

const STEPS: Array<[string, string]> = [
  ['SOURCES', 'Add material: a bundled stem, an upload, the mic, YouTube links, or a cover image to sonify.'],
  ['COMPOSE', 'WEAVE A MEMORY makes one haunted, tonal track from every source in four sections. Or: pin the dots you like, pick a mood (eerie, mythic…), shape it with DARKNESS / SPACE / MOTION. MIXER has every detail.'],
  ['PLAY', 'Listen. Reroll the seed (🎲) until a take feels right; the URL keeps the patch.'],
  ['MASTER', 'Balance the buses (voices, clouds, melody, ghosts, surface), pick a master preset — you hear it live — and RENDER FINAL MASTER.'],
  ['EXPORT', 'Render one track, stems or a loop — or open ALBUM to build and render a whole release.'],
]

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault()
        onClose()
      }
    }
    // capture phase: closes before anything else reacts to the key
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center pt-[8vh] px-3 overflow-y-auto"
      style={{ background: 'rgba(26,26,26,0.35)' }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-xl border-2 p-4 flex flex-col gap-4 shadow-xl" style={{ background: '#F4EFEA', borderColor: '#1A1A1A' }}
        role="dialog" aria-label="Help">
        <div className="flex items-center">
          <span className="text-xs tracking-[0.3em] font-bold">HOW IT WORKS</span>
          <button onClick={onClose} className="ml-auto p-1 hover:opacity-60" aria-label="Close"><X size={16} /></button>
        </div>
        <ol className="flex flex-col gap-2">
          {STEPS.map(([k, v], i) => (
            <li key={k} className="flex gap-3 text-[11px] leading-relaxed">
              <b className="tracking-widest shrink-0 w-20" style={{ color: BURNT }}>{i + 1} {k}</b>
              <span className="opacity-80">{v}</span>
            </li>
          ))}
        </ol>
        <div>
          <div className="text-[9px] tracking-[0.3em] opacity-60 mb-1.5">KEYBOARD</div>
          <table className="w-full text-[11px]">
            <tbody>
              {SHORTCUTS.map(([k, v]) => (
                <tr key={k} className="border-t border-charcoal/15">
                  <td className="py-1 pr-3 whitespace-nowrap"><kbd className="border border-charcoal/40 px-1.5 text-[10px]">{k}</kbd></td>
                  <td className="py-1 opacity-80">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
