import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_SITES, hostOf, isHttpUrl, partitionFor, TAB_CAP_DEFAULT, type Brand, type Site } from '@shared/types'
import { pickSite } from './links'
import { useAppData } from './useAppData'
import { useLiveTabs } from './useLiveTabs'
import Sidebar, { type View } from './components/Sidebar'
import SiteView from './components/SiteView'
import TitleBar, { type SearchPick } from './components/TitleBar'
import { ChatToggle } from './components/PageHeader'
import { PAGE_VIEWS } from './pages'
import ShareTab from './components/mcp/ShareTab'
import { useAgentEvents } from './components/mcp/useAgentEvents'
import CodePrompt from './components/vault/CodePrompt'

const ChatView = lazy(() => import('./chat/ChatView'))
const Settings = lazy(() => import('./components/Settings'))
// modals only load the first time one opens
const BrandModal = lazy(() => import('./components/BrandModal'))
const SiteModal = lazy(() => import('./components/SiteModal'))
const Onboarding = lazy(() => import('./components/Onboarding'))
const PhoneView = lazy(() => import('./emulator/PhoneView'))

type ModalState =
  | { kind: 'brand'; id: string | null }
  | { kind: 'site' }
  | null

const HOME: View = { kind: 'chat' }
const TRENDS: View = { kind: 'page', page: 'Trends' }

const newId = (): string => crypto.randomUUID()

export default function App(): ReactNode {
  const { data, update } = useAppData()
  const [modal, setModal] = useState<ModalState>(null)
  // what each brand has open, not saved so the app always starts on the chat
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
  // a removed site falls back to the chat
  const view: View = picked.kind === 'site' && !site ? HOME : picked
  const { tabs, isLive } = useLiveTabs(
    data?.brands ?? [],
    temps,
    brand && site ? { brandId: brand.id, siteId: site.id } : null,
    // nothing warms up behind the first run setup
    data?.onboarded ? (brand?.id ?? null) : null,
    data?.settings.tabCap ?? TAB_CAP_DEFAULT
  )

  // agents asking to open a site or save an idea
  useAgentEvents(update, (brandId, siteId, url) => {
    const key = `${brandId}:${siteId}`
    // a new tab reads its start url once when it mounts, a loaded one gets sent there
    lastUrl.current[key] = url
    if (isLive(brandId, siteId)) setNav({ key, url, n: Date.now() })
    setViews((all) => ({ ...all, [brandId]: { kind: 'site', id: siteId } }))
  })

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

  if (!data.onboarded && brand) {
    return (
      <Suspense fallback={<div className="boot" />}>
        <Onboarding
          brand={brand}
          onDone={(patch) =>
            update((d) => ({
              ...d,
              onboarded: true,
              brands: d.brands.map((b) =>
                patch && b.id === brand.id
                  ? {
                      ...b,
                      name: patch.name,
                      keywords: patch.keywords,
                      sites: b.sites.filter((s) => patch.siteIds.includes(s.id))
                    }
                  : b
              )
            }))
          }
        />
      </Suspense>
    )
  }

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
      // a tab that's already loaded, even out of view, just goes to the link
      if (isLive(brand.id, match.id)) setNav({ key, url, n: Date.now() })
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

  // from a card in the chat, url is already checked to be on the same site
  const openSite = (siteId: string, url?: string): void => {
    if (!brand) return
    const key = `${brand.id}:${siteId}`
    if (url) {
      lastUrl.current[key] = url
      if (isLive(brand.id, siteId)) setNav({ key, url, n: Date.now() })
    }
    setView({ kind: 'site', id: siteId })
  }

  const onSearch = (pick: SearchPick): void => {
    if (pick.kind === 'brand') {
      update((d) => ({ ...d, activeBrandId: pick.id }))
    } else if (pick.kind === 'url') {
      openUrl(pick.url)
    } else if (pick.kind === 'trends') {
      setTrendQuery(pick.query)
      setView(TRENDS)
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
          onSettings={() => setView({ kind: 'settings' })}
        />

        {/* home is the chat, it sits on the same surface as the sidebar */}
        <main className={`main${brand && view.kind === 'chat' ? ' home' : ''}`}>
          {!brand && (
            <div className="empty">
              <p>No brands yet</p>
              <button className="btn primary" onClick={() => setModal({ kind: 'brand', id: null })}>
                Add a brand
              </button>
            </div>
          )}
          {/* sites you've visited stay loaded and hidden, so going back is instant */}
          <div className="site-stack">
            {tabs.map((t) => (
              <SiteView
                key={t.key}
                site={t.site}
                hidden={t.key !== siteKey}
                partition={partitionFor(t.brandId)}
                startUrl={lastUrl.current[t.key] ?? t.site.url}
                onUrl={(url) => (lastUrl.current[t.key] = url)}
                navigate={nav?.key === t.key ? nav : null}
                right={
                  <>
                    <ShareTab brandId={t.brandId} siteId={t.site.id} siteName={t.site.name} />
                    <ChatToggle chatOpen={data.chatOpen} onToggleChat={toggleChat} />
                  </>
                }
              />
            ))}
          </div>
          {brand && view.kind === 'settings' && (
            <Suspense fallback={<div className="page" />}>
              <Settings
                data={data}
                brand={brand}
                update={update}
                editBrand={editBrand}
                onDeleteBrand={deleteBrand}
                onAddSite={() => setModal({ kind: 'site' })}
                onOpenUrl={openUrl}
                chatOpen={data.chatOpen}
                onToggleChat={toggleChat}
              />
            </Suspense>
          )}
          {brand && view.kind === 'chat' && (
            <Suspense fallback={<div className="page" />}>
              <ChatView
                key={brand.id}
                brand={brand}
                editBrand={(fn) => editBrand(brand.id, fn)}
                onOpenSite={openSite}
              />
            </Suspense>
          )}
          {brand && view.kind === 'phone' && (
            <Suspense fallback={<div className="page" />}>
              <PhoneView
                key={brand.id}
                brand={brand}
                right={<ChatToggle chatOpen={data.chatOpen} onToggleChat={toggleChat} />}
              />
            </Suspense>
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

        {data.chatOpen && brand && view.kind !== 'chat' && (
          <Suspense fallback={<aside className="chat" />}>
            <ChatView
              key={brand.id}
              compact
              brand={brand}
              editBrand={(fn) => editBrand(brand.id, fn)}
              onOpenSite={openSite}
              onClose={toggleChat}
            />
          </Suspense>
        )}
      </div>

      <Suspense fallback={null}>
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
      </Suspense>
      <CodePrompt />
    </div>
  )
}
