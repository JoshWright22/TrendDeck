import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_SITES, hostOf, isHttpUrl, partitionFor, type Brand, type Site } from '@shared/types'
import { pickSite } from './links'
import { useAppData } from './useAppData'
import Sidebar, { type View } from './components/Sidebar'
import BrandModal from './components/BrandModal'
import SiteModal from './components/SiteModal'
import SettingsModal from './components/SettingsModal'
import SiteView from './components/SiteView'
import TitleBar, { type SearchPick } from './components/TitleBar'
import { ChatToggle } from './components/PageHeader'
import { PAGE_VIEWS } from './pages'

const ChatPane = lazy(() => import('./components/ChatPane'))

type ModalState =
  | { kind: 'brand'; id: string | null }
  | { kind: 'site' }
  | { kind: 'settings' }
  | null

const HOME: View = { kind: 'page', page: 'Trends' }

const newId = (): string => crypto.randomUUID()

export default function App(): ReactNode {
  const { data, update } = useAppData()
  const [modal, setModal] = useState<ModalState>(null)
  // what each brand has open, not saved so the app always starts on trends
  const [views, setViews] = useState<Record<string, View>>({})
  // last page each site was on, so going back to a site picks up where you left it
  const lastUrl = useRef<Record<string, string>>({})
  // set from the title bar search, trends filters on it
  const [trendQuery, setTrendQuery] = useState('')
  // tabs opened from links that aren't one of the brand's sites, gone when the app closes
  const [temps, setTemps] = useState<Record<string, Site[]>>({})
  // asks an open site tab to go to a url
  const [nav, setNav] = useState<{ key: string; url: string; n: number } | null>(null)
  const openUrlRef = useRef<(url: string) => void>(() => {})

  useEffect(() => window.trenddeck.onOpenUrl((url) => openUrlRef.current(url)), [])

  const brand = data?.brands.find((b) => b.id === data.activeBrandId) ?? null
  const picked = (brand && views[brand.id]) || HOME
  const brandTemps = (brand && temps[brand.id]) || []
  const site =
    picked.kind === 'site'
      ? (brand?.sites.find((s) => s.id === picked.id) ?? brandTemps.find((s) => s.id === picked.id))
      : undefined
  // a removed site falls back to trends
  const view: View = picked.kind === 'site' && !site ? HOME : picked

  const brandIds = data?.brands.map((b) => b.id).join(',') ?? ''
  useEffect(() => {
    const ids = brandIds.split(',').filter(Boolean)
    const pick = (i: number): void => {
      if (ids[i]) update((d) => ({ ...d, activeBrandId: ids[i] }))
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key)) return
      e.preventDefault()
      pick(Number(e.key) - 1)
    }
    window.addEventListener('keydown', onKey)
    const off = window.trenddeck.onBrandShortcut(pick)
    return () => {
      window.removeEventListener('keydown', onKey)
      off()
    }
  }, [brandIds, update])

  if (!data) return <div className="boot" />

  const editBrand = (id: string, fn: (b: Brand) => Brand): void => {
    update((d) => ({ ...d, brands: d.brands.map((b) => (b.id === id ? fn(b) : b)) }))
  }

  const setView = (v: View): void => {
    if (brand) setViews((all) => ({ ...all, [brand.id]: v }))
  }

  // every link in the app lands here, never in the system browser
  const openUrl = (url: string): void => {
    if (!brand || !isHttpUrl(url)) return
    const match = pickSite([...brand.sites, ...brandTemps], url)
    if (match) {
      const key = `${brand.id}:${match.id}`
      lastUrl.current[key] = url
      if (site?.id === match.id) setNav({ key, url, n: Date.now() })
      setView({ kind: 'site', id: match.id })
      return
    }
    const temp: Site = { id: newId(), name: hostOf(url) || 'Page', url }
    setTemps((all) => ({ ...all, [brand.id]: [...(all[brand.id] ?? []), temp] }))
    setView({ kind: 'site', id: temp.id })
  }
  openUrlRef.current = openUrl

  const closeTemp = (id: string): void => {
    if (brand) setTemps((all) => ({ ...all, [brand.id]: (all[brand.id] ?? []).filter((s) => s.id !== id) }))
  }

  // keep a temporary tab as one of the brand's sites
  const keepTemp = (id: string): void => {
    const temp = brandTemps.find((s) => s.id === id)
    if (!brand || !temp) return
    const key = `${brand.id}:${id}`
    editBrand(brand.id, (b) => ({ ...b, sites: [...b.sites, { ...temp, url: lastUrl.current[key] ?? temp.url }] }))
    closeTemp(id)
  }

  const toggleChat = (): void => update((d) => ({ ...d, chatOpen: !d.chatOpen }))

  const saveBrand = (name: string, keywords: string[], subreddits: string[]): void => {
    if (modal?.kind !== 'brand') return
    if (modal.id) {
      editBrand(modal.id, (b) => ({ ...b, name, keywords, subreddits }))
    } else {
      const id = newId()
      const sites = DEFAULT_SITES.map((s) => ({ ...s, id: newId() }))
      update((d) => ({
        ...d,
        activeBrandId: id,
        brands: [
          ...d.brands,
          { id, name, keywords, subreddits, adblock: true, adblockAllow: [], sites, threads: [], ideas: [] }
        ]
      }))
    }
    setModal(null)
  }

  const deleteBrand = (id: string): void => {
    update((d) => {
      const brands = d.brands.filter((b) => b.id !== id)
      const activeBrandId = d.activeBrandId === id ? (brands[0]?.id ?? null) : d.activeBrandId
      return { ...d, brands, activeBrandId }
    })
    setModal(null)
    // wipe its cookies too so the logins don't sit on disk forever
    void window.trenddeck.clearBrandSession(id)
  }

  const addSite = (name: string, url: string): void => {
    if (!brand) return
    const id = newId()
    editBrand(brand.id, (b) => ({ ...b, sites: [...b.sites, { id, name, url }] }))
    setView({ kind: 'site', id })
    setModal(null)
  }

  const moveSite = (fromId: string, toId: string): void => {
    if (!brand) return
    editBrand(brand.id, (b) => {
      const sites = [...b.sites]
      const from = sites.findIndex((s) => s.id === fromId)
      const to = sites.findIndex((s) => s.id === toId)
      if (from < 0 || to < 0) return b
      const [moved] = sites.splice(from, 1)
      sites.splice(to, 0, moved)
      return { ...b, sites }
    })
  }

  const onSearch = (pick: SearchPick): void => {
    if (pick.kind === 'brand') {
      update((d) => ({ ...d, activeBrandId: pick.id }))
    } else if (pick.kind === 'url') {
      openUrl(pick.url)
    } else if (pick.kind === 'trends') {
      setTrendQuery(pick.query)
      setView(HOME)
    } else {
      setView(pick.view)
    }
  }

  const editing = modal?.kind === 'brand' ? data.brands.find((b) => b.id === modal.id) : undefined
  const PageView = view.kind === 'page' ? PAGE_VIEWS[view.page] : null
  const siteKey = brand && site ? `${brand.id}:${site.id}` : ''

  return (
    <div className="app">
      <TitleBar
        brands={data.brands}
        brand={brand}
        onSelectBrand={(id) => update((d) => ({ ...d, activeBrandId: id }))}
        onEditBrand={(id) => setModal({ kind: 'brand', id })}
        onAddBrand={() => setModal({ kind: 'brand', id: null })}
        onPick={onSearch}
      />
      <div className="shell">
        <Sidebar
          brand={brand}
          view={view}
          onView={setView}
          onEditBrand={(id) => setModal({ kind: 'brand', id })}
          onAddSite={() => setModal({ kind: 'site' })}
          temps={brandTemps}
          onRemoveSite={(id) =>
            brand && editBrand(brand.id, (b) => ({ ...b, sites: b.sites.filter((s) => s.id !== id) }))
          }
          onCloseTemp={closeTemp}
          onKeepTemp={keepTemp}
          onMoveSite={moveSite}
          onSettings={() => setModal({ kind: 'settings' })}
        />

        <main className="main">
          {!brand && (
            <div className="empty">
              <p>No brands yet</p>
              <button className="btn primary" onClick={() => setModal({ kind: 'brand', id: null })}>
                Add a brand
              </button>
            </div>
          )}
          {/* only the open site gets a webview, the rest aren't rendered at all */}
          {brand && site && (
            <SiteView
              key={siteKey}
              site={site}
              partition={partitionFor(brand.id)}
              startUrl={lastUrl.current[siteKey] ?? site.url}
              onUrl={(url) => (lastUrl.current[siteKey] = url)}
              navigate={nav?.key === siteKey ? nav : null}
              right={<ChatToggle chatOpen={data.chatOpen} onToggleChat={toggleChat} />}
            />
          )}
          {brand && PageView && view.kind === 'page' && (
            <Suspense fallback={<div className="page" />}>
              <PageView
                key={`${brand.id}:${view.page}`}
                page={view.page}
                brand={brand}
                editBrand={(fn) => editBrand(brand.id, fn)}
                onEditBrand={() => setModal({ kind: 'brand', id: brand.id })}
                chatOpen={data.chatOpen}
                onToggleChat={toggleChat}
                trendQuery={trendQuery}
                onTrendQuery={setTrendQuery}
              />
            </Suspense>
          )}
        </main>

        {data.chatOpen && brand && (
          <Suspense fallback={<aside className="chat" />}>
            <ChatPane
              key={brand.id}
              brandName={brand.name}
              threads={brand.threads}
              onChange={(fn) => editBrand(brand.id, (b) => ({ ...b, threads: fn(b.threads) }))}
              onClose={toggleChat}
            />
          </Suspense>
        )}
      </div>

      {modal?.kind === 'brand' && (
        <BrandModal
          key={modal.id ?? 'new'}
          brand={editing ?? null}
          onSave={saveBrand}
          onDelete={() => modal.id && deleteBrand(modal.id)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'site' && <SiteModal onSave={addSite} onClose={() => setModal(null)} />}
      {modal?.kind === 'settings' && (
        <SettingsModal
          settings={data.settings}
          brands={data.brands}
          activeId={data.activeBrandId}
          onSave={(settings, adblock) => {
            update((d) => ({
              ...d,
              settings,
              brands: d.brands.map((b) =>
                adblock[b.id] ? { ...b, adblock: adblock[b.id].on, adblockAllow: adblock[b.id].allow } : b
              )
            }))
            setModal(null)
          }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
