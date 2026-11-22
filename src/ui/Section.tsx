import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

const KEY = 'exotica.collapsed'

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

/**
 * A titled, collapsible page section with a scroll anchor. Collapsed state
 * is remembered per section, so the page opens the way you left it.
 */
export function Section({
  id,
  title,
  hint,
  right,
  children,
}: {
  id: string
  title: string
  hint?: string
  /** extra controls on the header line (kept visible when collapsed) */
  right?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(() => !readCollapsed()[id])

  const set = useCallback((v: boolean) => {
    setOpen(v)
    try {
      const c = readCollapsed()
      c[id] = !v
      localStorage.setItem(KEY, JSON.stringify(c))
    } catch { /* storage unavailable */ }
  }, [id])

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; open: boolean }>).detail
      if (d.id === id) set(d.open)
    }
    window.addEventListener('exotica:section', on)
    return () => window.removeEventListener('exotica:section', on)
  }, [id, set])

  return (
    <section id={id} data-section={id} className="scroll-mt-28 flex flex-col">
      <div className="flex items-center gap-2 px-1 pb-1">
        <button
          onClick={() => set(!open)}
          className="flex items-center gap-1.5 text-[10px] tracking-[0.3em] font-bold hover:opacity-70"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          title={open ? 'Collapse' : 'Expand'}
        >
          <ChevronDown size={12} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }} />
          {title}
        </button>
        {hint && <span className="text-[9px] tracking-wider opacity-45 truncate hidden md:inline">{hint}</span>}
        <span className="flex-1" />
        {right}
      </div>
      {open && <div id={`${id}-body`}>{children}</div>}
    </section>
  )
}
