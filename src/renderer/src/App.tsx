import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_SITES, hostOf, isHttpUrl, partitionFor, TAB_CAP_DEFAULT, type Brand, type Site } from '@shared/types'
import { chatProjectIds, DEFAULT_PIPELINE, generalProject, mainProjectId, withChatProjects } from '@shared/workspace'
import { pickSite } from './links'
import { useAppData } from './useAppData'
import { useLiveTabs } from './useLiveTabs'
import Sidebar from './shell/Sidebar'
import { useThreads } from './shell/useThreads'
import VideosList from './shell/VideosList'
import SiteView from './components/SiteView'
import TitleBar from './components/TitleBar'
import { PanelIcon } from './components/Icons'
import ShareTab from './components/mcp/ShareTab'
import { useAgentEvents } from './components/mcp/useAgentEvents'
import CodePrompt from './components/vault/CodePrompt'
import WorkspacePane, { MAX_WS, MIN_WS, type WsView } from './workspace/WorkspacePane'
import SiteStrip from './workspace/SiteStrip'
import { useInbox } from './pages/inbox/useInbox'
import { setNames, syncThread } from './chat/pending'
import { onOpenSettings } from './settings-link'

const ChatView = lazy(() => import('./chat/ChatView'))
const Settings = lazy(() => import('./components/Settings'))
// modals only load the first time one opens
const BrandModal = lazy(() => import('./components/BrandModal'))
const SiteModal = lazy(() => import('./components/SiteModal'))
const Onboarding = lazy(() => import('./components/Onboarding'))

type ModalState = { kind: 'brand'; id: string | null } | { kind: 'site' } | { kind: 'settings'; section?: string } | null

// where each brand is: which chat, what the workspace shows. not saved, the app always opens
// on a new chat. link is a video project a new chat gets linked to once its first message is sent
interface Place {
  threadId: string | null
  view: 'chat' | 'videos'
  link: string | null
  ws: WsView | null
}

const START: Place = { threadId: null, view: 'chat', link: null, ws: null }

// the workspace pane's width and whether it's hidden, saved on this machine only
const WS_KEY = 'trenddeck.workspace'
function loadPane(): { width: number; collapsed: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(WS_KEY) ?? '{}') as { width?: number; collapsed?: boolean }
    const width = Number(raw.width)
    return {
      width: width >= MIN_WS && width <= MAX_WS ? width : Math.round(window.innerWidth * 0.42),
      collapsed: true
    }
  } catch {
    return { width: Math.round(window.innerWidth * 0.42), collapsed: true }
  }
}

const newId = (): string => crypto.randomUUID()

export default function App(): ReactNode {
  const { data, update } = useAppData()
  const [modal, setModal] = useState<ModalState>(null)
  // e.g. the composer's mic menu opens Settings at Dictation
  useEffect(() => onOpenSettings((section) => setModal({ kind: 'settings', section })), [])
  const [places, setPlaces] = useState<Record<string, Place>>({})
  const [pane, setPane] = useState(loadPane)
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
  useEffect(() => localStorage.setItem(WS_KEY, JSON.stringify(pane)), [pane])

  const brand = data?.brands.find((b) => b.id === data.activeBrandId) ?? null
  const { byBrand } = useThreads(data?.brands.map((b) => b.id) ?? [])
  const threads = (brand && byBrand[brand.id]) || []
  const inbox = useInbox(brand?.id)
  const place = (brand && places[brand.id]) || START
  // a chat sees the whole brand. its first linked video is where files, runs and the workspace go,
  // General when it isn't linked to one
  const linkedIds = brand ? (place.threadId ? chatProjectIds(brand, place.threadId) : place.link ? [place.link] : []) : []
  const linked = brand ? linkedIds.flatMap((id) => brand.projects.filter((p) => p.id === id)) : []
  const projectId = brand ? (place.threadId ? mainProjectId(brand, place.threadId) : linked[0]?.id) : undefined
  const project = brand?.projects.find((p) => p.id === projectId) ?? brand?.projects[0] ?? null
  const ws: WsView = place.ws ?? { kind: 'stage', stageId: project?.stageId ?? brand?.pipeline[0]?.id ?? '' }
  const brandTemps = (brand && temps[brand.id]) || []
  const site =
    ws.kind === 'site' ? (brand?.sites.find((s) => s.id === ws.id) ?? brandTemps.find((s) => s.id === ws.id)) : undefined
  const { tabs, isLive } = useLiveTabs(
    data?.brands ?? [],
    temps,
    brand && site && !pane.collapsed ? { brandId: brand.id, siteId: site.id } : null,
    // nothing warms up behind the first run setup
    data?.onboarded ? (brand?.id ?? null) : null,
    data?.settings.tabCap ?? TAB_CAP_DEFAULT
  )

  const setPlace = (brandId: string, fn: (p: Place) => Place): void =>
    setPlaces((all) => ({ ...all, [brandId]: fn(all[brandId] ?? START) }))

  const showWs = (brandId: string, v: WsView): void => {
    setPlace(brandId, (p) => ({ ...p, ws: v }))
    setPane((p) => (p.collapsed ? { ...p, collapsed: false } : p))
  }

  // agents asking to open a site or save an idea
  useAgentEvents(update, (brandId, siteId, url) => {
    const key = `${brandId}:${siteId}`
    // a new tab reads its start url once when it mounts, a loaded one gets sent there
    lastUrl.current[key] = url
    if (isLive(brandId, siteId)) setNav({ key, url, n: Date.now() })
    showWs(brandId, { kind: 'site', id: siteId })
  })

  const brandIds = data?.brands.map((b) => b.id).join(',') ?? ''
  useEffect(() => {
    const ids = brandIds.split(',').filter(Boolean)
    const pick = (i: number): void => {
      if (ids[i]) update((d) => ({ ...d, activeBrandId: ids[i] }))
    }
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setPane((p) => ({ ...p, collapsed: !p.collapsed }))
        return
      }
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

  // notifications name the chat and brand they're about
  const brandsRef = useRef(data?.brands ?? [])
  brandsRef.current = data?.brands ?? []
  const threadsRef = useRef(byBrand)
  threadsRef.current = byBrand
  useEffect(
    () =>
      setNames({
        brand: (id) => brandsRef.current.find((b) => b.id === id)?.name ?? 'TrendDeck',
        thread: (brandId, id) => {
          const title = threadsRef.current[brandId]?.find((t) => t.id === id)?.title
          const name = brandsRef.current.find((b) => b.id === brandId)?.name
          return title && name ? `${title} in ${name}` : title || name || 'A chat'
        }
      }),
    []
  )

  // a busy chat may be waiting on an approval main has from before a reload, for the sidebar's
  // Needs you. every brand's, the sidebar shows them all
  const busyIds = Object.entries(byBrand)
    .flatMap(([brandId, list]) => list.filter((t) => t.busy).map((t) => `${brandId}/${t.id}`))
    .join(',')
  useEffect(() => {
    for (const pair of busyIds.split(',').filter(Boolean)) {
      const [brandId, id] = pair.split('/')
      void syncThread(brandId, id)
    }
  }, [busyIds])

  // a notification was clicked: go to that brand and chat
  const jumpRef = useRef<(brandId: string, threadId: string | null) => void>(() => {})
  jumpRef.current = (brandId, threadId) => {
    const b = data?.brands.find((x) => x.id === brandId)
    if (!b) return
    if (data?.activeBrandId !== brandId) update((d) => ({ ...d, activeBrandId: brandId }))
    if (threadId) setPlace(brandId, (p) => ({ ...p, view: 'chat', link: null, threadId }))
  }
  useEffect(() => {
    const on = (e: Event): void => {
      const d = (e as CustomEvent<{ brandId: string; threadId: string | null }>).detail
      if (d) jumpRef.current(d.brandId, d.threadId)
    }
    window.addEventListener('trenddeck:open-thread', on)
    return () => window.removeEventListener('trenddeck:open-thread', on)
  }, [])

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

  const openWs = (v: WsView): void => {
    if (brand) showWs(brand.id, v)
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
      openWs({ kind: 'site', id: match.id })
      return
    }
    const temp: Site = { id: newId(), name: hostOf(url) || 'Page', url }
    setTemps((all) => ({ ...all, [brand.id]: [...(all[brand.id] ?? []), temp] }))
    openWs({ kind: 'site', id: temp.id })
  }
  openUrlRef.current = openUrl

  const closeTemp = (id: string): void => {
    if (!brand) return
    setTemps((all) => ({ ...all, [brand.id]: (all[brand.id] ?? []).filter((s) => s.id !== id) }))
    if (ws.kind === 'site' && ws.id === id) setPlace(brand.id, (p) => ({ ...p, ws: null }))
  }

  // keep a temporary tab as one of the brand's sites
  const keepTemp = (id: string): void => {
    const temp = brandTemps.find((s) => s.id === id)
    if (!brand || !temp) return
    const key = `${brand.id}:${id}`
    editBrand(brand.id, (b) => ({ ...b, sites: [...b.sites, { ...temp, url: lastUrl.current[key] ?? temp.url }] }))
    setTemps((all) => ({ ...all, [brand.id]: (all[brand.id] ?? []).filter((s) => s.id !== id) }))
  }

  const saveBrand = (name: string, keywords: string[], subreddits: string[]): void => {
    if (modal?.kind !== 'brand') return
    if (modal.id) {
      editBrand(modal.id, (b) => ({ ...b, name, keywords, subreddits }))
    } else {
      const id = newId()
      const sites = DEFAULT_SITES.map((s) => ({ ...s, id: newId() }))
      const pipeline = DEFAULT_PIPELINE.map((s) => ({ ...s }))
      update((d) => ({
        ...d,
        activeBrandId: id,
        brands: [
          ...d.brands,
          {
            id,
            name,
            keywords,
            subreddits,
            adblock: true,
            adblockAllow: [],
            sites,
            threads: [],
            ideas: [],
            pipeline,
            projects: [generalProject(pipeline[0].id, Date.now())]
          }
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
    openWs({ kind: 'site', id })
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
    openWs({ kind: 'site', id: siteId })
  }

  // the newest chat linked to it, or a new chat that gets linked once it's sent
  const openProject = (projectId: string): void => {
    if (!brand) return
    const latest = threads.find((t) => !t.archived && chatProjectIds(brand, t.id).includes(projectId))
    const p = brand.projects.find((x) => x.id === projectId)
    setPlace(brand.id, () => ({
      view: 'chat',
      threadId: latest?.id ?? null,
      link: latest ? null : projectId,
      ws: p ? { kind: 'stage', stageId: p.stageId } : null
    }))
  }

  const newChatFor = (projectId: string): void => {
    if (brand) setPlace(brand.id, (p) => ({ ...p, view: 'chat', threadId: null, link: projectId }))
  }

  const openThread = (threadId: string | null): void => {
    if (!brand) return
    setPlace(brand.id, (p) => ({ ...p, view: 'chat', threadId, link: threadId ? null : p.link }))
  }

  // a sidebar row may be in another brand
  const openChatIn = (brandId: string, threadId: string | null): void => {
    if (data.activeBrandId !== brandId) update((d) => ({ ...d, activeBrandId: brandId }))
    setPlace(brandId, (p) => ({ ...p, view: 'chat', threadId, link: null }))
  }

  // the composer's first message made this chat. one started from a video gets linked to it
  const fileThread = (threadId: string): void => {
    if (!brand || !place.link) return
    const link = place.link
    editBrand(brand.id, (b) => ({ ...b, chatProjects: withChatProjects(b.chatProjects, b.projects, threadId, [link], 'add') }))
  }

  const editing = modal?.kind === 'brand' ? data.brands.find((b) => b.id === modal.id) : undefined
  const siteKey = brand && site && !pane.collapsed ? `${brand.id}:${site.id}` : ''

  const wsToggle = (
    <button
      className={`icon-btn${pane.collapsed ? '' : ' on'}`}
      title={pane.collapsed ? 'Show workspace (Ctrl+B)' : 'Hide workspace (Ctrl+B)'}
      aria-label="Toggle workspace"
      aria-pressed={!pane.collapsed}
      onClick={() => setPane((p) => ({ ...p, collapsed: !p.collapsed }))}
    >
      <PanelIcon />
    </button>
  )

  return (
    <div className="app">
      <TitleBar />
      <div className="shell">
        <Sidebar
          brands={data.brands}
          activeBrandId={brand?.id ?? null}
          threadsByBrand={byBrand}
          threadId={place.threadId}
          view={place.view}
          onOpenThread={openChatIn}
          onNewThread={(brandId) => openChatIn(brandId, null)}
          onOpenVideos={(brandId) => {
            if (data.activeBrandId !== brandId) update((d) => ({ ...d, activeBrandId: brandId }))
            setPlace(brandId, (p) => ({ ...p, view: 'videos' }))
          }}
          onAddBrand={() => setModal({ kind: 'brand', id: null })}
          onEditBrand={(id) => setModal({ kind: 'brand', id })}
          editBrand={editBrand}
          onSettings={() => setModal({ kind: 'settings' })}
        />

        <main className="center">
          {!brand && (
            <div className="empty">
              <p>No brands yet</p>
              <button className="btn primary" onClick={() => setModal({ kind: 'brand', id: null })}>
                Add a brand
              </button>
            </div>
          )}
          {brand && place.view === 'videos' && (
            <VideosList brand={brand} threads={threads} editBrand={(fn) => editBrand(brand.id, fn)} onOpenProject={openProject} onNewChatFor={newChatFor} />
          )}
          {brand && place.view === 'chat' && (
            <Suspense fallback={<div className="cx" />}>
              <ChatView
                key={brand.id}
                brand={brand}
                editBrand={(fn) => editBrand(brand.id, fn)}
                onOpenSite={openSite}
                openId={place.threadId}
                onOpenId={openThread}
                onThreadCreated={fileThread}
                context={linked.map((p) => p.name).join(', ') || undefined}
                headerRight={wsToggle}
                project={project ?? undefined}
                linkedProjects={linked}
              />
            </Suspense>
          )}
        </main>

        {brand && project && (
          <WorkspacePane
            brand={brand}
            project={project}
            view={ws}
            onView={openWs}
            onSetStage={(stageId) =>
              editBrand(brand.id, (b) => ({
                ...b,
                projects: b.projects.map((p) => (p.id === project.id ? { ...p, stageId } : p))
              }))
            }
            collapsed={pane.collapsed}
            onCollapse={() => setPane((p) => ({ ...p, collapsed: true }))}
            width={pane.width}
            onWidth={(width) => setPane((p) => ({ ...p, width }))}
            editBrand={(fn) => editBrand(brand.id, fn)}
            onEditBrand={() => setModal({ kind: 'brand', id: brand.id })}
            onOpenUrl={openUrl}
            trendQuery={trendQuery}
            onTrendQuery={setTrendQuery}
            siteStrip={
              <SiteStrip
                sites={brand.sites}
                temps={brandTemps}
                activeId={site?.id ?? null}
                onSelect={(id) => openWs({ kind: 'site', id })}
                onCloseTemp={closeTemp}
                onKeepTemp={keepTemp}
                onAdd={() => setModal({ kind: 'site' })}
                onMove={moveSite}
                health={inbox?.health}
              />
            }
            sites={
              // sites you've visited stay loaded and hidden, so going back is instant
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
                    right={<ShareTab brandId={t.brandId} siteId={t.site.id} siteName={t.site.name} />}
                  />
                ))}
              </div>
            }
          />
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
        {modal?.kind === 'settings' && brand && (
          <SettingsModal onClose={() => setModal(null)}>
            <Settings
              data={data}
              brand={brand}
              update={update}
              editBrand={editBrand}
              onDeleteBrand={deleteBrand}
              onAddSite={() => setModal({ kind: 'site' })}
              onOpenUrl={(url) => {
                setModal(null)
                openUrl(url)
              }}
              onClose={() => setModal(null)}
              section={modal.section}
            />
          </SettingsModal>
        )}
      </Suspense>
      <CodePrompt />
    </div>
  )
}

// settings sits over the app in a big sheet, esc or a click outside closes it
function SettingsModal({ onClose, children }: { onClose: () => void; children: ReactNode }): ReactNode {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // a modal opened from inside settings closes first
      if (e.key === 'Escape' && document.querySelectorAll('[aria-modal="true"]').length === 1) close.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings">
        {children}
      </div>
    </div>
  )
}
