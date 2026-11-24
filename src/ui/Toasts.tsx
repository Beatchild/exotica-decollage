import { X } from 'lucide-react'
import { dismissToast, useToasts } from './toast'

const COLORS = { info: '#1A1A1A', success: '#2E7D4F', error: '#B03A2E' } as const

/** Bottom-right stack; screen readers get it via aria-live. */
export function Toasts() {
  const toasts = useToasts()
  return (
    <div
      className="fixed bottom-3 right-3 z-[60] flex flex-col gap-2 items-end pointer-events-none max-w-[min(26rem,calc(100vw-1.5rem))]"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className="pointer-events-auto flex items-start gap-2 border-2 px-3 py-2 text-[10px] tracking-wider leading-relaxed shadow-md whitespace-pre-line"
          style={{ background: '#F4EFEA', borderColor: COLORS[t.kind], color: COLORS[t.kind] }}
        >
          <span className="flex-1">{t.text}</span>
          <button onClick={() => dismissToast(t.id)} className="opacity-60 hover:opacity-100" aria-label="Dismiss">
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}
