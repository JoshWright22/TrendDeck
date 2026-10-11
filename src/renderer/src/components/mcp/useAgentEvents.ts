import { useEffect, useRef } from 'react'
import type { Update } from '../../useAppData'

// shows a brand's site at a url, App sends a tab that's already loaded to the url
export type OpenSite = (brandId: string, siteId: string, url: string) => void

// main checks access first, these only move the ui and keep the saved data in one place
export function useAgentEvents(update: Update, openSite: OpenSite): void {
  const openRef = useRef(openSite)
  openRef.current = openSite
  useEffect(() => {
    const api = window.trenddeckMcp
    const offOpen = api.onOpenSite(({ brandId, siteId, url }) => openRef.current(brandId, siteId, url))
    // post audit: switch to the brand and its tab for the site, posting fills it in from main
    const offPost = window.trenddeck.posting.onOpenSite(({ brandId, siteId, url }) => {
      openRef.current(brandId, siteId, url)
      update((d) => (d.activeBrandId === brandId ? d : { ...d, activeBrandId: brandId }))
    })
    const offIdea = api.onIdea(({ brandId, title, url }) => {
      update((d) => ({
        ...d,
        brands: d.brands.map((b) =>
          b.id !== brandId || b.ideas.some((i) => i.title === title && i.url === url)
            ? b
            : {
                ...b,
                ideas: [
                  ...b.ideas,
                  { id: crypto.randomUUID(), title, url, source: 'manual', savedAt: Date.now() }
                ]
              }
        )
      }))
    })
    return () => {
      offOpen()
      offPost()
      offIdea()
    }
  }, [update])
}
