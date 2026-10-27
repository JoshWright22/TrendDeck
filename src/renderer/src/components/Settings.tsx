import { useEffect, useState, type ReactNode } from 'react'
import {
  cleanDomain,
  DEFAULT_SITES,
  hostOf,
  TAB_CAP_DEFAULT,
  TAB_CAP_MAX,
  type AppData,
  type Brand
} from '@shared/types'
import { Chips, cleanKeyword, cleanSub, type ChipList } from './BrandModal'
import { CloseIcon, PlusIcon } from './Icons'
import AgentAccess from './mcp/AgentAccess'
import AgentsSection from '../chat/AgentsSection'
import PacePanel from '../pages/reuse/PacePanel'
import SavedLogins from './vault/SavedLogins'
import CraftSettings from '../workspace/craft/CraftSettings'
import ContextSection from './context/ContextSection'
import ChannelsSection from './content-map/ChannelsSection'
import McpServersSection from './mcp-servers/McpServersSection'
import StorageSection from './storage/StorageSection'
import DictationSettings from './dictation/DictationSettings'
import ObsSettings from './obs/ObsSettings'

const REPO_URL = 'https://github.com/JoshWright22/TrendDeck'
const SECTIONS = ['Brand', 'Sites', 'Ad blocker', 'Tabs', 'Trends', 'Posting pace', 'Agents', 'Agent access', 'MCP servers', 'Context', 'Channels', 'Dictation', 'OBS', 'Craft apps', 'Storage', 'Saved logins', 'About'] as const

interface Props {
  data: AppData
  brand: Brand
  update: (fn: (d: AppData) => AppData) => void
  editBrand: (id: string, fn: (b: Brand) => Brand) => void
  onDeleteBrand: (id: string) => void
  onAddSite: () => void
  onOpenUrl: (url: string) => void
  onClose: () => void
  // the section to open at
  section?: string
}

const sectionId = (s: string): string => `settings-${s.toLowerCase().replace(/\s+/g, '-')}`

function BrandSection({ brand, editBrand, onDelete }: { brand: Brand } & Pick<Props, 'editBrand'> & { onDelete: () => void }): ReactNode {
  const [name, setName] = useState(brand.name)
  const [keywords, setKeywords] = useState<ChipList>({ values: brand.keywords, draft: '' })
  const [subs, setSubs] = useState<ChipList>({ values: brand.subreddits, draft: '' })
  const [confirm, setConfirm] = useState(false)
  const edit = (fn: (b: Brand) => Brand): void => editBrand(brand.id, fn)

  const saveName = (): void => {
    const clean = name.trim().slice(0, 60)
    if (clean && clean !== brand.name) edit((b) => ({ ...b, name: clean }))
    else setName(brand.name)
  }

  return (
    <>
      <p className="form-hint">For {brand.name}. Switch brands in the sidebar.</p>
      <label>
        Name
        <input
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      <Chips
        label="Niche keywords"
        placeholder="Type one and press Enter"
        list={keywords}
        clean={cleanKeyword}
        onChange={(list) => {
          setKeywords(list)
          if (list.values !== keywords.values) edit((b) => ({ ...b, keywords: list.values }))
        }}
      />
      <Chips
        label="Subreddits"
        placeholder="buildapc"
        prefix="r/"
        list={subs}
        clean={cleanSub}
        onChange={(list) => {
          setSubs(list)
          if (list.values !== subs.values) edit((b) => ({ ...b, subreddits: list.values }))
        }}
      />
      {confirm ? (
        <div className="row-actions">
          <button type="button" className="btn danger" onClick={onDelete}>
            Delete and log out of its sites
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
            Keep it
          </button>
        </div>
      ) : (
        <button type="button" className="btn ghost" onClick={() => setConfirm(true)}>
          Delete brand
        </button>
      )}
    </>
  )
}

function SitesSection({ brand, editBrand, onAddSite }: { brand: Brand } & Pick<Props, 'editBrand' | 'onAddSite'>): ReactNode {
  const edit = (fn: (b: Brand) => Brand): void => editBrand(brand.id, fn)
  // defaults you removed, one click to get them back
  const missing = DEFAULT_SITES.filter((d) => !brand.sites.some((s) => hostOf(s.url) === hostOf(d.url)))

  return (
    <>
      <p className="form-hint">Every site logs in separately for each brand. Drag the tabs above an open site to reorder them.</p>
      <ul className="settings-sites">
        {brand.sites.map((s) => (
          <li key={s.id}>
            <span className="site-dot">{s.name.slice(0, 1).toUpperCase()}</span>
            <input
              key={s.name}
              defaultValue={s.name}
              maxLength={60}
              aria-label={`Name for ${hostOf(s.url)}`}
              onBlur={(e) => {
                const name = e.target.value.trim()
                if (name && name !== s.name) {
                  edit((b) => ({ ...b, sites: b.sites.map((x) => (x.id === s.id ? { ...x, name } : x)) }))
                } else e.target.value = s.name
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            <span className="settings-host">{hostOf(s.url)}</span>
            <button
              type="button"
              className="row-close"
              title={`Remove ${s.name}`}
              aria-label={`Remove ${s.name}`}
              onClick={() => edit((b) => ({ ...b, sites: b.sites.filter((x) => x.id !== s.id) }))}
            >
              <CloseIcon />
            </button>
          </li>
        ))}
        {brand.sites.length === 0 && <li className="muted">No sites yet</li>}
      </ul>
      <div className="suggest">
        <button type="button" className="pill teal" onClick={onAddSite}>
          <PlusIcon />
          Add site
        </button>
        {missing.map((d) => (
          <button
            key={d.url}
            type="button"
            className="filter-chip"
            onClick={() => edit((b) => ({ ...b, sites: [...b.sites, { ...d, id: crypto.randomUUID() }] }))}
          >
            + {d.name}
          </button>
        ))}
      </div>
    </>
  )
}

function BrandAdblock({ brand, editBrand }: { brand: Brand } & Pick<Props, 'editBrand'>): ReactNode {
  const [draft, setDraft] = useState('')
  const [bad, setBad] = useState(false)
  const edit = (fn: (b: Brand) => Brand): void => editBrand(brand.id, fn)
  // the brand's own sites as one click suggestions
  const suggestions = [...new Set(brand.sites.map((s) => hostOf(s.url)))].filter(
    (h) => h && !brand.adblockAllow.includes(h)
  )

  const add = (raw: string): void => {
    const domain = cleanDomain(raw)
    if (!domain) {
      setBad(true)
      return
    }
    if (!brand.adblockAllow.includes(domain)) edit((b) => ({ ...b, adblockAllow: [...b.adblockAllow, domain] }))
    setDraft('')
    setBad(false)
  }

  return (
    <div className="adblock-brand">
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={brand.adblock}
          onChange={(e) => edit((b) => ({ ...b, adblock: e.target.checked }))}
        />
        <span>Block ads for {brand.name}</span>
      </label>
      {brand.adblock && (
        <>
          <p className="form-hint">Sites on the allowlist load with their ads. Subdomains count too.</p>
          {brand.adblockAllow.length > 0 && (
            <div className="chips">
              {brand.adblockAllow.map((d) => (
                <span key={d} className="chip">
                  {d}
                  <button
                    type="button"
                    aria-label={`Remove ${d}`}
                    onClick={() => edit((b) => ({ ...b, adblockAllow: b.adblockAllow.filter((x) => x !== d) }))}
                  >
                    <CloseIcon />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="allow-add">
            <input
              value={draft}
              placeholder="example.com"
              spellCheck={false}
              aria-label={`Allow a site for ${brand.name}`}
              onChange={(e) => {
                setDraft(e.target.value)
                setBad(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add(draft)
                }
              }}
            />
            <button type="button" className="btn ghost" disabled={!draft.trim()} onClick={() => add(draft)}>
              Allow
            </button>
          </div>
          {bad && <p className="form-error">That doesn't look like a domain.</p>}
          {suggestions.length > 0 && (
            <div className="suggest">
              {suggestions.map((h) => (
                <button key={h} type="button" className="filter-chip" onClick={() => add(h)}>
                  + {h}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// one screen, every change saves as you make it
export default function Settings(props: Props): ReactNode {
  const { data, brand, update, editBrand } = props
  const [cap, setCap] = useState(String(data.settings.tabCap))
  const [key, setKey] = useState(data.settings.youtubeApiKey)
  const [at, setAt] = useState<string>(SECTIONS[0])
  useEffect(() => {
    if (props.section) document.getElementById(sectionId(props.section))?.scrollIntoView({ block: 'start' })
  }, [props.section])
  // the open brand first
  const ordered = [...data.brands].sort((a, b) => Number(b.id === brand.id) - Number(a.id === brand.id))
  const setSettings = (patch: Partial<AppData['settings']>): void =>
    update((d) => ({ ...d, settings: { ...d.settings, ...patch } }))

  const saveCap = (): void => {
    const n = Math.round(Number(cap))
    const tabCap = n >= 1 ? Math.min(n, TAB_CAP_MAX) : TAB_CAP_DEFAULT
    setCap(String(tabCap))
    if (tabCap !== data.settings.tabCap) setSettings({ tabCap })
  }

  const body: Record<(typeof SECTIONS)[number], ReactNode> = {
    Brand: (
      <BrandSection key={brand.id} brand={brand} editBrand={editBrand} onDelete={() => props.onDeleteBrand(brand.id)} />
    ),
    Sites: <SitesSection brand={brand} editBrand={editBrand} onAddSite={props.onAddSite} />,
    'Ad blocker': (
      <>
        <p className="form-hint">
          On for every brand to start, using the same lists as uBlock Origin. They update every few hours. Login
          pages are always left alone.
        </p>
        {ordered.map((b) => (
          <BrandAdblock key={b.id} brand={b} editBrand={editBrand} />
        ))}
      </>
    ),
    Tabs: (
      <>
        <label>
          Sites kept open per brand
          <input
            className="short"
            type="number"
            min={1}
            max={TAB_CAP_MAX}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            onBlur={saveCap}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </label>
        <p className="form-hint">
          Sites you leave stay loaded in the background so switching back is instant. More uses more memory, fewer
          means more reloads. Up to {TAB_CAP_MAX}.
        </p>
      </>
    ),
    Trends: (
      <>
        <label>
          YouTube Data API key (optional)
          <input
            value={key}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Leave empty to use YouTube search pages"
            onChange={(e) => setKey(e.target.value)}
            onBlur={() => key.trim() !== data.settings.youtubeApiKey && setSettings({ youtubeApiKey: key.trim() })}
          />
        </label>
        <p className="form-hint">
          Without a key, Trends reads YouTube's public search pages. A key from Google Cloud gives exact view counts.
          It stays on this computer.
        </p>
      </>
    ),
    'Posting pace': <PacePanel />,
    Agents: <AgentsSection />,
    'Agent access': <AgentAccess brandId={brand.id} />,
    'MCP servers': <McpServersSection key={brand.id} brand={brand} />,
    Context: <ContextSection key={brand.id} brand={brand} />,
    Channels: <ChannelsSection key={brand.id} brand={brand} />,
    Dictation: <DictationSettings />,
    OBS: <ObsSettings key={brand.id} brand={brand} />,
    'Craft apps': <CraftSettings />,
    Storage: <StorageSection key={brand.id} brand={brand} />,
    'Saved logins': <SavedLogins brandId={brand.id} />,
    About: (
      <>
        <p className="about-line">
          <strong>TrendDeck</strong> <span className="muted">version {__APP_VERSION__}</span>
        </p>
        <p className="form-hint">Free and open source under the MIT license. Everything stays on this computer.</p>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={data.settings.autoUpdate}
            onChange={(e) => setSettings({ autoUpdate: e.target.checked })}
          />
          <span>Update from GitHub releases</span>
        </label>
        <div className="suggest">
          <UpdateButton />
          <button type="button" className="pill" onClick={() => props.onOpenUrl(REPO_URL)}>
            Source on GitHub
          </button>
        </div>
      </>
    )
  }

  return (
    <div className="page settings">
      <header className="page-head">
        <h2>Settings</h2>
        <span className="spacer" />
        <button className="icon-btn" title="Close (Esc)" aria-label="Close settings" onClick={props.onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`side-item${at === s ? ' active' : ''}`}
              onClick={() => {
                setAt(s)
                document.getElementById(sectionId(s))?.scrollIntoView({ block: 'start' })
              }}
            >
              <span className="side-name">{s}</span>
            </button>
          ))}
        </nav>
        <div
          className="scroll settings-scroll"
          onScroll={(e) => {
            // the section nearest the top lights up in the nav
            const top = e.currentTarget.getBoundingClientRect().top
            let current: string = SECTIONS[0]
            for (const s of SECTIONS) {
              const el = document.getElementById(sectionId(s))
              if (el && el.getBoundingClientRect().top - top < 80) current = s
            }
            if (current !== at) setAt(current)
          }}
        >
          {SECTIONS.map((s) => (
            <section key={s} id={sectionId(s)} className="settings-section">
              <h3 className="modal-section">{s}</h3>
              {body[s]}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

const UPDATE_TEXT = {
  idle: 'Check for updates',
  checking: 'Checking...',
  latest: "You're on the latest version",
  downloading: 'Downloading; use Update when ready',
  installing: 'Restarting to update',
  error: "Couldn't reach GitHub, try again",
  dev: 'Updates only work in the installed app'
} as const

function UpdateButton(): ReactNode {
  const [state, setState] = useState<keyof typeof UPDATE_TEXT>('idle')
  const busy = state === 'checking' || state === 'downloading' || state === 'installing'
  return (
    <button
      type="button"
      className="pill teal"
      disabled={busy}
      onClick={() => {
        setState('checking')
        void window.trenddeck.checkUpdate().then(setState)
      }}
    >
      {UPDATE_TEXT[state]}
    </button>
  )
}
