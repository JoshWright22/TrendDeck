import { useEffect, useState, type ReactNode } from 'react'
import { DEFAULT_SITES, partitionFor, type Brand } from '@shared/types'
import { useAppData } from './useAppData'
import BrandRail from './components/BrandRail'
import BrandModal from './components/BrandModal'
import SiteModal from './components/SiteModal'
import SiteTabs from './components/SiteTabs'
import SiteView from './components/SiteView'
import ComingSoon, { PAGES, type Page } from './components/ComingSoon'
import ChatPane from './components/ChatPane'
import { ChatIcon, EditIcon } from './components/Icons'

type ModalState = { kind: 'brand'; id: string | null } | { kind: 'site' } | null

const newId = (): string => crypto.randomUUID()

export default function App(): ReactNode {
  const { data, update } = useAppData()
  const [page, setPage] = useState<Page>('Sites')
  const [modal, setModal] = useState<ModalState>(null)
  // which tab each brand has open, not saved
  const [openSite, setOpenSite] = useState<Record<string, string>>({})
  // a tab only loads once you open it, then it stays alive
  const [mounted, setMounted] = useState<ReadonlySet<string>>(new Set())

  const brand = data?.brands.find((b) => b.id === data.activeBrandId) ?? null
  const site = brand
    ? (brand.sites.find((s) => s.id === openSite[brand.id]) ?? brand.sites[0] ?? null)
    : null
  const liveKey = brand && site && page === 'Sites' ? `${brand.id}:${site.id}` : null

  useEffect(() => {
    if (!liveKey) return
    setMounted((prev) => (prev.has(liveKey) ? prev : new Set(prev).add(liveKey)))
  }, [liveKey])

  if (!data) return <div className="boot" />

  const editBrand = (id: string, fn: (b: Brand) => Brand): void => {
    update((d) => ({ ...d, brands: d.brands.map((b) => (b.id === id ? fn(b) : b)) }))
  }

  const saveBrand = (name: string, keywords: string[]): void => {
    if (modal?.kind !== 'brand') return
    if (modal.id) {
      editBrand(modal.id, (b) => ({ ...b, name, keywords }))
    } else {
      const id = newId()
      const sites = DEFAULT_SITES.map((s) => ({ ...s, id: newId() }))
      update((d) => ({
        ...d,
        activeBrandId: id,
        brands: [...d.brands, { id, name, keywords, sites }]
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
    setOpenSite((o) => ({ ...o, [brand.id]: id }))
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

  return (
    <div className="app">
      <BrandRail
        brands={data.brands}
        activeId={data.activeBrandId}
        onSelect={(id) => update((d) => ({ ...d, activeBrandId: id }))}
        onEdit={(id) => setModal({ kind: 'brand', id })}
        onAdd={() => setModal({ kind: 'brand', id: null })}
      />

      <main className="main panel">
        <header className="topbar">
          <div className="brand-title">
            {brand ? (
              <>
                <h1>{brand.name}</h1>
                <button
                  className="icon-btn"
                  title="Edit brand and keywords"
                  aria-label="Edit brand"
                  onClick={() => setModal({ kind: 'brand', id: brand.id })}
                >
                  <EditIcon />
                </button>
              </>
            ) : (
              <h1>TrendDeck</h1>
            )}
          </div>
          <nav className="pages" aria-label="Pages">
            {PAGES.map((p) => (
              <button
                key={p}
                className={`page-btn${p === page ? ' active' : ''}`}
                onClick={() => setPage(p)}
              >
                {p}
              </button>
            ))}
          </nav>
          <button
            className={`icon-btn${data.chatOpen ? ' on' : ''}`}
            title={data.chatOpen ? 'Hide chat' : 'Show chat'}
            aria-label="Toggle chat"
            onClick={() => update((d) => ({ ...d, chatOpen: !d.chatOpen }))}
          >
            <ChatIcon />
          </button>
        </header>

        <div className="content">
          {/* the site layer never unmounts, other pages just sit on top of it */}
          <div className="sites">
            {brand && (
              <SiteTabs
                sites={brand.sites}
                activeId={site?.id ?? null}
                onSelect={(id) => setOpenSite((o) => ({ ...o, [brand.id]: id }))}
                onRemove={(id) =>
                  editBrand(brand.id, (b) => ({ ...b, sites: b.sites.filter((s) => s.id !== id) }))
                }
                onMove={moveSite}
                onAdd={() => setModal({ kind: 'site' })}
              />
            )}
            <div className="views">
              {data.brands.flatMap((b) =>
                b.sites
                  .filter((s) => mounted.has(`${b.id}:${s.id}`))
                  .map((s) => (
                    <SiteView
                      key={`${b.id}:${s.id}`}
                      site={s}
                      partition={partitionFor(b.id)}
                      shown={liveKey === `${b.id}:${s.id}`}
                    />
                  ))
              )}
              {!brand && (
                <div className="empty">
                  <p>No brands yet</p>
                  <button className="btn primary" onClick={() => setModal({ kind: 'brand', id: null })}>
                    Add a brand
                  </button>
                </div>
              )}
              {brand && !site && (
                <div className="empty">
                  <p>This brand has no sites</p>
                  <button className="btn primary" onClick={() => setModal({ kind: 'site' })}>
                    Add a site
                  </button>
                </div>
              )}
            </div>
          </div>
          {page !== 'Sites' && <ComingSoon page={page} />}
        </div>
      </main>

      {data.chatOpen && <ChatPane onClose={() => update((d) => ({ ...d, chatOpen: false }))} />}

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
    </div>
  )
}
