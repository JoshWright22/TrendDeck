import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_SITES, partitionFor, type Brand } from '@shared/types'
import { useAppData } from './useAppData'
import Sidebar, { type View } from './components/Sidebar'
import BrandModal from './components/BrandModal'
import SiteModal from './components/SiteModal'
import SettingsModal from './components/SettingsModal'
import SiteView from './components/SiteView'
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
  // ads blocked per brand since the app started
  const [blockedTotals, setBlockedTotals] = useState<Record<string, number>>({})

  useEffect(
    () =>
      window.trenddeck.onAdblockCount((c) =>
        setBlockedTotals((t) => (t[c.brandId] === c.brandTotal ? t : { ...t, [c.brandId]: c.brandTotal }))
      ),
    []
  )

  const brand = data?.brands.find((b) => b.id === data.activeBrandId) ?? null
  const picked = (brand && views[brand.id]) || HOME
  const site = picked.kind === 'site' ? brand?.sites.find((s) => s.id === picked.id) : undefined
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

  const toggleChat = (): void => update((d) => ({ ...d, chatOpen: !d.chatOpen }))

  const saveBrand = (name: string, keywords: string[], subreddits: string[]): void => {
    if (modal?.kind !== 'brand') return
    if (modal.id) {
      editBrand(modal.id, (b) => ({ ...b, name, keywords, subreddits }))
    } else {
      const id = newId()
      const sites = DEFAULT_SITES.map((s) => ({ ...s, id: newId(), adblock: true }))
      update((d) => ({
        ...d,
        activeBrandId: id,
        brands: [
          ...d.brands,
          { id, name, keywords, subreddits, adblock: true, sites, threads: [], ideas: [] }
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
    editBrand(brand.id, (b) => ({ ...b, sites: [...b.sites, { id, name, url, adblock: true }] }))
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

  const editing = modal?.kind === 'brand' ? data.brands.find((b) => b.id === modal.id) : undefined
  const PageView = view.kind === 'page' ? PAGE_VIEWS[view.page] : null
  const siteKey = brand && site ? `${brand.id}:${site.id}` : ''

  return (
    <div className="app">
      <Sidebar
        brands={data.brands}
        brand={brand}
        view={view}
        onView={setView}
        onSelectBrand={(id) => update((d) => ({ ...d, activeBrandId: id }))}
        onEditBrand={(id) => setModal({ kind: 'brand', id })}
        onAddBrand={() => setModal({ kind: 'brand', id: null })}
        onAddSite={() => setModal({ kind: 'site' })}
        onRemoveSite={(id) =>
          brand && editBrand(brand.id, (b) => ({ ...b, sites: b.sites.filter((s) => s.id !== id) }))
        }
        onMoveSite={moveSite}
        onSettings={() => setModal({ kind: 'settings' })}
        blocked={brand ? (blockedTotals[brand.id] ?? 0) : 0}
        onToggleAdblock={() => brand && editBrand(brand.id, (b) => ({ ...b, adblock: !b.adblock }))}
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
            brandId={brand.id}
            brandAdblock={brand.adblock}
            onToggleAdblock={() =>
              editBrand(brand.id, (b) => ({
                ...b,
                sites: b.sites.map((s) => (s.id === site.id ? { ...s, adblock: !s.adblock } : s))
              }))
            }
            partition={partitionFor(brand.id)}
            startUrl={lastUrl.current[siteKey] ?? site.url}
            onUrl={(url) => (lastUrl.current[siteKey] = url)}
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
          onSave={(settings) => {
            update((d) => ({ ...d, settings }))
            setModal(null)
          }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
