import { useCallback, useEffect, useRef, useState } from 'react'
import type { WriterDoc } from '@shared/types'
import { useDataChanged } from '../../useDataChanged'

const SAVE_DELAY_MS = 400

// loads the brand's drafts once, saves a moment after you stop typing and when you leave
export function useDrafts(brandId: string): {
  doc: WriterDoc | null
  update: (fn: (doc: WriterDoc) => WriterDoc) => void
} {
  const [doc, setDoc] = useState<WriterDoc | null>(null)
  const loaded = useRef<WriterDoc | null>(null)
  const pending = useRef<WriterDoc | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    void window.trenddeck.loadDrafts(brandId).then((d) => {
      if (!alive) return
      loaded.current = d
      setDoc(d)
    })
    return () => {
      alive = false
    }
  }, [brandId])

  const reload = useCallback(() => {
    void window.trenddeck.loadDrafts(brandId).then((d) => {
      // typed something meanwhile: that wins, it saves over the agent's copy as before
      if (pending.current) return
      loaded.current = d
      setDoc(d)
    })
  }, [brandId])
  // an agent changed a draft. unsaved typing goes out first, then the agent's change loads
  const reloadAfter = useRef(false)

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const saving = pending.current ? window.trenddeck.saveDrafts(brandId, pending.current) : null
    pending.current = null
    if (reloadAfter.current) {
      reloadAfter.current = false
      void Promise.resolve(saving).then(reload)
    }
  }, [brandId, reload])

  useDataChanged(brandId, 'writer', () => {
    if (pending.current) reloadAfter.current = true
    else reload()
  })

  useEffect(() => {
    if (!doc || doc === loaded.current) return
    pending.current = doc
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY_MS)
  }, [doc, flush])

  // leaving the page or switching brands saves right away
  useEffect(() => flush, [flush])

  const update = useCallback((fn: (doc: WriterDoc) => WriterDoc) => {
    setDoc((d) => (d ? fn(d) : d))
  }, [])

  return { doc, update }
}
