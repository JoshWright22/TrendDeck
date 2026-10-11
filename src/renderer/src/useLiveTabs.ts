import { useEffect, useRef, useState } from 'react'
import type { Brand, Site } from '@shared/types'

export interface LiveTab {
  key: string
  brandId: string
  site: Site
}

interface Entry {
  key: string
  brandId: string
  siteId: string
  // last time it was on screen, 0 for tabs warmed in the background
  used: number
}

const IDLE_MS = 4000
const WARM_COUNT = 3
// give each warmed site this long before starting the next one
const WARM_GAP_MS = 8000

const keyOf = (brandId: string, siteId: string): string => `${brandId}:${siteId}`

// site webviews stay alive after you leave them so coming back is instant. each brand keeps
// its most recently used ones up to the cap, the rest get closed
export function useLiveTabs(
  brands: Brand[],
  temps: Record<string, Site[]>,
  open: { brandId: string; siteId: string } | null,
  activeBrandId: string | null,
  cap: number
): { tabs: LiveTab[]; isLive: (brandId: string, siteId: string) => boolean } {
  // kept in the order they were first opened. a webview that moves in the dom reloads,
  // so new ones only ever go on the end
  const [entries, setEntries] = useState<Entry[]>([])
  const [idle, setIdle] = useState(false)

  const findSite = (brandId: string, siteId: string): Site | undefined => {
    const brand = brands.find((b) => b.id === brandId)
    return brand?.sites.find((s) => s.id === siteId) ?? temps[brandId]?.find((s) => s.id === siteId)
  }

  const openKey = open ? keyOf(open.brandId, open.siteId) : ''

  // mark the open site as used and trim each brand down to the cap
  useEffect(() => {
    setEntries((list) => {
      let next = list
      if (open) {
        const now = Date.now()
        next = list.some((e) => e.key === openKey)
          ? list.map((e) => (e.key === openKey ? { ...e, used: now } : e))
          : [...list, { key: openKey, brandId: open.brandId, siteId: open.siteId, used: now }]
      }
      return trim(next, cap, openKey)
    })
    // open is only read through openKey
  }, [openKey, cap])

  // drop tabs whose site or brand is gone
  const siteKeys = brands
    .flatMap((b) => [...b.sites, ...(temps[b.id] ?? [])].map((s) => keyOf(b.id, s.id)))
    .join(',')
  useEffect(() => {
    const keep = new Set(siteKeys.split(','))
    setEntries((list) => (list.every((e) => keep.has(e.key)) ? list : list.filter((e) => keep.has(e.key))))
  }, [siteKeys])

  // idle means no input for a few seconds, any input resets it
  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), IDLE_MS)
    const poke = (): void => {
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), IDLE_MS)
    }
    const events = ['mousedown', 'keydown', 'wheel', 'mousemove'] as const
    for (const e of events) window.addEventListener(e, poke, { passive: true })
    return () => {
      window.clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, poke)
    }
  }, [])

  // once idle, open the brand's first few sites in the background, one at a time
  const warmed = useRef(new Set<string>())
  const brand = brands.find((b) => b.id === activeBrandId)
  const nextWarm =
    brand?.sites
      .slice(0, Math.min(WARM_COUNT, cap))
      .map((s) => keyOf(brand.id, s.id))
      .find((k) => !warmed.current.has(k)) ?? null
  useEffect(() => {
    if (!idle || !brand || !nextWarm) return
    const timer = window.setTimeout(
      () => {
        warmed.current.add(nextWarm)
        setEntries((list) => {
          if (list.some((e) => e.key === nextWarm)) return list
          // only into a free slot, never pushing out something you used
          if (list.filter((e) => e.brandId === brand.id).length >= cap) return list
          const siteId = nextWarm.slice(brand.id.length + 1)
          return [...list, { key: nextWarm, brandId: brand.id, siteId, used: 0 }]
        })
      },
      // the first one goes right away, the rest wait so a slow machine isn't loading three at once
      warmed.current.size === 0 ? 0 : WARM_GAP_MS
    )
    return () => window.clearTimeout(timer)
  }, [idle, nextWarm, brand?.id, cap])

  const tabs: LiveTab[] = []
  for (const e of entries) {
    const site = findSite(e.brandId, e.siteId)
    if (site) tabs.push({ key: e.key, brandId: e.brandId, site })
  }
  // the open site renders right away, before the effect above records it
  if (open && !entries.some((e) => e.key === openKey)) {
    const site = findSite(open.brandId, open.siteId)
    if (site) tabs.push({ key: openKey, brandId: open.brandId, site })
  }

  const isLive = (brandId: string, siteId: string): boolean => tabs.some((t) => t.key === keyOf(brandId, siteId))
  return { tabs, isLive }
}

// per brand, close the least recently used tabs over the cap. the open one always stays
function trim(list: Entry[], cap: number, openKey: string): Entry[] {
  const drop = new Set<string>()
  const byBrand = new Map<string, Entry[]>()
  for (const e of list) byBrand.set(e.brandId, [...(byBrand.get(e.brandId) ?? []), e])
  for (const group of byBrand.values()) {
    const old = group.filter((e) => e.key !== openKey).sort((a, b) => a.used - b.used)
    let extra = group.length - cap
    for (const e of old) {
      if (extra <= 0) break
      drop.add(e.key)
      extra--
    }
  }
  return drop.size === 0 ? list : list.filter((e) => !drop.has(e.key))
}
