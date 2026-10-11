import { useEffect, useRef, useState, type RefObject } from 'react'

// open state that closes on a click outside or when focus leaves
export function usePopover(): {
  open: boolean
  setOpen: (v: boolean) => void
  root: RefObject<HTMLDivElement | null>
} {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onFocus = (e: FocusEvent): void => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open])
  return { open, setOpen, root }
}
