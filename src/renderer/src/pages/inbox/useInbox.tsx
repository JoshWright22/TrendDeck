import { useEffect, useState, type ReactNode } from 'react'
import './inbox.css'
import type { BrandInbox, Health } from '@shared/inbox'
import { useDataChanged } from '../../useDataChanged'

export function useInbox(brandId: string | undefined): BrandInbox | null {
  const [inbox, setInbox] = useState<BrandInbox | null>(null)
  useEffect(() => {
    setInbox(null)
    if (!brandId) return
    let alive = true
    void window.trenddeckInbox.load(brandId).then((i) => alive && setInbox(i))
    const off = window.trenddeckInbox.onUpdate((id, i) => {
      if (id === brandId) setInbox({ ...i })
    })
    return () => {
      alive = false
      off()
    }
  }, [brandId])
  // an agent drafted or sent a reply
  useDataChanged(brandId, 'inbox', () => {
    if (brandId) void window.trenddeckInbox.load(brandId).then((i) => setInbox(i))
  })
  return inbox
}

export const HEALTH_LABEL: Record<Health, string> = {
  in: 'Logged in',
  out: 'Needs login',
  unknown: 'Unknown'
}

// small status dot next to a site
export function HealthDot({ state }: { state: Health | undefined }): ReactNode {
  const s = state ?? 'unknown'
  return <span className={`health-dot ${s}`} title={HEALTH_LABEL[s]} aria-label={HEALTH_LABEL[s]} />
}

export function InboxIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
      <path d="M4 13h4.5l1 2h5l1-2H20" />
    </svg>
  )
}
