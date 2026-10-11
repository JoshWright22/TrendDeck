import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Update } from '../../useAppData'
import type { View } from '../Sidebar'

// main checks access first, these only move the ui and keep the saved data in one place
export function useAgentEvents(
  update: Update,
  setViews: Dispatch<SetStateAction<Record<string, View>>>,
  lastUrl: MutableRefObject<Record<string, string>>
): void {
  useEffect(() => {
    const api = window.trenddeckMcp
    const offOpen = api.onOpenSite(({ brandId, siteId, url }) => {
      // the site view reads its start url once when it mounts, so set it before switching
      lastUrl.current[`${brandId}:${siteId}`] = url
      setViews((all) => ({ ...all, [brandId]: { kind: 'site', id: siteId } }))
    })
    // post audit: switch to the brand and its tab for the site, posting fills it in from main
    const offPost = window.trenddeck.posting.onOpenSite(({ brandId, siteId, url }) => {
      lastUrl.current[`${brandId}:${siteId}`] = url
      setViews((all) => ({ ...all, [brandId]: { kind: 'site', id: siteId } }))
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
  }, [update, setViews, lastUrl])
}
