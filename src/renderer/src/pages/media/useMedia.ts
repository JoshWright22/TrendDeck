import { useCallback, useEffect, useState } from 'react'
import type { MediaLibrary } from '@shared/media'
import { probeLater } from './probe'

// the brand's library, refetched whenever the main process says it changed
export function useMediaLibrary(brandId: string): MediaLibrary | null {
  const [lib, setLib] = useState<MediaLibrary | null>(null)

  const load = useCallback(() => {
    void window.trenddeck.media.library(brandId).then((l) => {
      setLib(l)
      probeLater(l.items)
    })
  }, [brandId])

  useEffect(() => {
    setLib(null)
    load()
    const off = window.trenddeck.media.onChange((id) => {
      if (id === brandId) load()
    })
    // catches files that moved while the app was in the background
    const onFocus = (): void => load()
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [brandId, load])

  return lib
}
