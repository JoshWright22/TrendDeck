import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

const SHOW_MS = 6000

export interface Undoable {
  label: string
  undo: () => void
}

// one undo at a time, a new delete replaces the old toast
export function useUndo(): {
  pending: Undoable | null
  offer: (u: Undoable) => void
  run: () => void
  dismiss: () => void
} {
  const [pending, setPending] = useState<Undoable | null>(null)
  const timer = useRef<number>(0)

  const dismiss = useCallback(() => {
    window.clearTimeout(timer.current)
    setPending(null)
  }, [])

  const offer = useCallback((u: Undoable) => {
    window.clearTimeout(timer.current)
    setPending(u)
    timer.current = window.setTimeout(() => setPending(null), SHOW_MS)
  }, [])

  const latest = useRef<Undoable | null>(null)
  latest.current = pending

  const run = useCallback(() => {
    const p = latest.current
    latest.current = null
    window.clearTimeout(timer.current)
    setPending(null)
    p?.undo()
  }, [])

  // ctrl+z undoes the last delete, unless you're typing somewhere
  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, run])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return { pending, offer, run, dismiss }
}

export function UndoToast({
  pending,
  onUndo,
  onDismiss
}: {
  pending: Undoable | null
  onUndo: () => void
  onDismiss: () => void
}): ReactNode {
  if (!pending) return null
  return (
    <div className="pl-toast" role="status">
      <span className="pl-toast-text">{pending.label}</span>
      <button className="pill" onClick={onUndo}>
        Undo
      </button>
      <button className="pl-toast-x" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  )
}
