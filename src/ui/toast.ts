import { useSyncExternalStore } from 'react'

/**
 * Non-blocking notifications. Replaces window.alert(), which froze the whole
 * page (and the audio scheduler) until dismissed.
 */
export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  text: string
  kind: ToastKind
}

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function toast(text: string, kind: ToastKind = 'info', ms?: number) {
  const id = nextId++
  // identical toast already showing → don't stack duplicates
  toasts = [...toasts.filter((t) => t.text !== text), { id, text, kind }].slice(-4)
  emit()
  window.setTimeout(() => dismissToast(id), ms ?? (kind === 'error' ? 9000 : 4500))
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => toasts,
  )
}
