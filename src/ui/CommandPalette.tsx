import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'

export interface Command {
  id: string
  label: string
  group: string
  hint?: string
  keys?: string
  disabled?: boolean
  run: () => void
}

const BURNT = '#D35400'

/** every query word must appear somewhere in label/group/hint */
function matches(c: Command, q: string): boolean {
  const hay = `${c.label} ${c.group} ${c.hint ?? ''}`.toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

/**
 * Ctrl/⌘+K: type what you want to do — "render", "pole", "add stem",
 * "mixer", "-16" — and press Enter. Every action is one search away.
 */
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const hits = useMemo(() => commands.filter((c) => !c.disabled && matches(c, q)).slice(0, 60), [commands, q])
  const cur = Math.min(sel, Math.max(0, hits.length - 1))

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cur])

  const run = (c: Command | undefined) => {
    if (!c) return
    onClose()
    c.run()
  }

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center pt-[12vh] px-3"
      style={{ background: 'rgba(26,26,26,0.35)' }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg border-2 shadow-xl" style={{ background: '#F4EFEA', borderColor: '#1A1A1A' }}
        role="dialog" aria-label="Command palette">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-charcoal/30">
          <Search size={14} className="opacity-60" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setSel(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel(Math.min(hits.length - 1, cur + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel(Math.max(0, cur - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(hits[cur])
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                onClose()
              }
            }}
            placeholder="What do you want to do?  render · pole · add stem · mixer · -16"
            className="flex-1 bg-transparent text-[12px] tracking-wider outline-none placeholder:opacity-40"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
          />
          <kbd className="text-[9px] opacity-50 border border-charcoal/30 px-1">ESC</kbd>
        </div>
        <div ref={list} id="palette-list" role="listbox" className="max-h-[55vh] overflow-y-auto py-1">
          {hits.length === 0 && <p className="px-3 py-4 text-[10px] tracking-widest opacity-50">NOTHING MATCHES</p>}
          {hits.map((c, i) => {
            const header = i === 0 || hits[i - 1].group !== c.group ? c.group : null
            return (
              <div key={c.id}>
                {header && <div className="px-3 pt-2 pb-0.5 text-[8px] tracking-[0.3em] opacity-45">{header}</div>}
                <button
                  data-i={i}
                  role="option"
                  aria-selected={i === cur}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(c)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] tracking-wider"
                  style={i === cur ? { background: BURNT, color: '#F4EFEA' } : undefined}
                >
                  <span className="truncate">{c.label}</span>
                  {c.hint && <span className="truncate text-[9px] opacity-60">{c.hint}</span>}
                  {c.keys && <kbd className="ml-auto text-[9px] opacity-70 border border-current/30 px-1 shrink-0">{c.keys}</kbd>}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
