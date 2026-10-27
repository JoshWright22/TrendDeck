import { useEffect, useState } from 'react'
import type { LoginRequest } from '@shared/vault'

export function useLoginRequests(brandId: string): LoginRequest[] {
  const [requests, setRequests] = useState<LoginRequest[]>([])
  useEffect(() => {
    let alive = true
    const api = window.trenddeckVault
    const load = (): void => {
      void api.loginRequests().then((list) => {
        if (alive) setRequests(list.filter((request) => request.brandId === brandId))
      }).catch(() => alive && setRequests([]))
    }
    setRequests([])
    const off = api.onLoginRequestsChanged(load)
    load()
    return () => { alive = false; off() }
  }, [brandId])
  return requests.filter((request) => request.brandId === brandId)
}
