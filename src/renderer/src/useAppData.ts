import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppData } from '@shared/types'

export type Update = (fn: (data: AppData) => AppData) => void

// loads the json once, then writes it back on every change
export function useAppData(): { data: AppData | null; update: Update } {
  const [data, setData] = useState<AppData | null>(null)
  const loaded = useRef<AppData | null>(null)

  useEffect(() => {
    let alive = true
    void window.trenddeck.loadData().then((d) => {
      if (!alive) return
      loaded.current = d
      setData(d)
    })
    return () => {
      alive = false
    }
  }, [])

  // main saved a change itself, e.g. an agent edited a pipeline. take it as is, no save back
  useEffect(
    () =>
      window.trenddeckWorkspace.onDataChanged((d) => {
        loaded.current = d
        setData(d)
      }),
    []
  )

  useEffect(() => {
    if (!data || data === loaded.current) return
    void window.trenddeck.saveData(data)
  }, [data])

  const update = useCallback<Update>((fn) => {
    setData((d) => (d ? fn(d) : d))
  }, [])

  return { data, update }
}
