import { useEffect, useRef } from 'react'
import type { DataChanged } from '@shared/gateway'

// an agent changed this brand's data of this kind in main, so a view holding its own copy
// loads it again. 'app' (ideas, schedule) comes in whole on data:changed, see useAppData
export function useDataChanged(brandId: string | undefined, kind: DataChanged['kind'], fn: () => void): void {
  const cb = useRef(fn)
  cb.current = fn
  useEffect(() => {
    if (!brandId) return
    return window.trenddeckGateway.onDataChanged((c) => {
      if (c.brandId === brandId && c.kind === kind) cb.current()
    })
  }, [brandId, kind])
}
