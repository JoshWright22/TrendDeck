import { useState, type ReactNode } from 'react'
import { SOURCE_NAMES, TREND_SOURCES, type Brand, type Site, type TrendItem, type TrendSource } from '@shared/types'
import { ExternalIcon } from '../components/Icons'
import { CardCorners } from './Marks'
import { safeHref } from './api'

// cards the agent can drop into a reply. it writes a fenced block with the
// language "trenddeck" and one json object inside, see EMBED_GUIDE in the main process

export type Embed =
  | { type: 'trend'; id?: string; title?: string; url?: string; source?: string; score?: number }
  | { type: 'idea'; title: string; notes?: string }
  | { type: 'draft'; platform?: string; title?: string; body: string }
  | { type: 'site'; site: string; url?: string }

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.slice(0, max) : '')

// agents often put real line breaks inside json strings, escape those before giving up
function looseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    let out = ''
    let inStr = false
    let esc = false
    for (const ch of raw) {
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        else if (ch === '\n') {
          out += '\\n'
          continue
        } else if (ch === '\r') continue
        else if (ch === '\t') {
          out += '\\t'
          continue
        }
      } else if (ch === '"') inStr = true
      out += ch
    }
    return JSON.parse(out)
  }
}

export function parseEmbed(raw: string): Embed | null {
  let j: Record<string, unknown>
  try {
    j = looseJson(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  switch (j.type) {
    case 'trend':
      if (!str(j.id) && !str(j.title)) return null
      return {
        type: 'trend',
        id: str(j.id, 200),
        title: str(j.title, 300),
        url: str(j.url, 2000),
        source: str(j.source, 40),
        score: typeof j.score === 'number' ? Math.max(0, Math.min(100, Math.round(j.score))) : undefined
      }
    case 'idea':
      return str(j.title) ? { type: 'idea', title: str(j.title, 300), notes: str(j.notes, 1000) } : null
    case 'draft':
      return str(j.body) ? { type: 'draft', platform: str(j.platform, 40), title: str(j.title, 300), body: str(j.body, 10000) } : null
    case 'site':
      return str(j.site) ? { type: 'site', site: str(j.site, 100), url: str(j.url, 2000) } : null
    default:
      return null
  }
}

export interface EmbedActions {
  brand: Brand
  trends: Map<string, TrendItem>
  savedTitles: Set<string>
  onSaveIdea: (title: string, url: string, source: TrendSource | 'manual') => void
  onOpenSite: (siteId: string, url?: string) => void
}

const PLATFORM_HOSTS: Record<string, string[]> = {
  x: ['x.com', 'twitter.com'],
  twitter: ['x.com', 'twitter.com'],
  reddit: ['reddit.com'],
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  youtube: ['studio.youtube.com', 'youtube.com'],
  threads: ['threads.net', 'threads.com'],
  linkedin: ['linkedin.com'],
  facebook: ['facebook.com']
}

const PLATFORM_NAMES: Record<string, string> = {
  x: 'X',
  twitter: 'X',
  reddit: 'Reddit',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  threads: 'Threads',
  linkedin: 'LinkedIn',
  facebook: 'Facebook'
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

const sameSite = (h: string, base: string): boolean => h === base || h.endsWith(`.${base}`)

function siteForPlatform(sites: Site[], platform: string): Site | undefined {
  const hosts = PLATFORM_HOSTS[platform.toLowerCase()] ?? []
  for (const want of hosts) {
    const hit = sites.find((s) => host(s.url) === want)
    if (hit) return hit
  }
  return sites.find((s) => s.name.toLowerCase() === platform.toLowerCase())
}

function findSite(sites: Site[], name: string): Site | undefined {
  const n = name.toLowerCase().trim()
  return (
    sites.find((s) => s.id === name) ??
    sites.find((s) => s.name.toLowerCase() === n) ??
    sites.find((s) => host(s.url) === n.replace(/^www\./, '')) ??
    siteForPlatform(sites, n)
  )
}

// a page the agent points at only opens if it's on the same site as the tab
function pageOnSite(site: Site, url: string | undefined): string | undefined {
  const href = url ? safeHref(url) : null
  if (!href) return undefined
  return sameSite(host(href), host(site.url)) ? href : undefined
}

function SaveButton({ saved, onSave }: { saved: boolean; onSave: () => void }): ReactNode {
  const [popped, setPopped] = useState(false)
  return (
    <button
      className={`pill${saved ? ' done' : ''}${popped ? ' cx-pop' : ''}`}
      disabled={saved}
      onClick={() => {
        setPopped(true)
        onSave()
      }}
    >
      {saved ? 'Saved' : 'Save idea'}
    </button>
  )
}

function TrendEmbed({ e, a }: { e: Extract<Embed, { type: 'trend' }>; a: EmbedActions }): ReactNode {
  const known = e.id ? a.trends.get(e.id) : undefined
  const title = known?.title ?? e.title ?? 'Trend'
  const url = safeHref(known?.url ?? e.url ?? '') ?? ''
  const rawSource = known?.source ?? e.source ?? ''
  const source = (TREND_SOURCES as readonly string[]).includes(rawSource) ? (rawSource as TrendSource) : undefined
  const score = known?.score ?? e.score
  const hot = (score ?? 0) >= 85
  return (
    <article className="cx-card cx-trend">
      <CardCorners tone={hot ? 'hot' : undefined} />
      <header>
        <span className="cx-kind">Trend</span>
        {source && <span className="muted">{SOURCE_NAMES[source]}</span>}
      </header>
      <p className="cx-card-title">{title}</p>
      {known?.detail && <p className="cx-card-detail">{known.detail}</p>}
      {!known && e.id && <p className="cx-card-detail">Not in the current feed</p>}
      <footer>
        {score !== undefined && <span className={`score-chip${hot ? ' hot' : ''}`}>{score}</span>}
        <span className="spacer" />
        <SaveButton saved={a.savedTitles.has(title)} onSave={() => a.onSaveIdea(title, url, source ?? 'manual')} />
        {url && (
          <a className="icon-btn small" href={url} target="_blank" rel="noreferrer" title="Open in your browser">
            <ExternalIcon />
          </a>
        )}
      </footer>
    </article>
  )
}

function IdeaEmbed({ e, a }: { e: Extract<Embed, { type: 'idea' }>; a: EmbedActions }): ReactNode {
  return (
    <article className="cx-card cx-idea">
      <CardCorners />
      <header>
        <span className="cx-kind">Idea</span>
      </header>
      <p className="cx-card-title">{e.title}</p>
      {e.notes && <p className="cx-card-notes">{e.notes}</p>}
      <footer>
        <span className="spacer" />
        <SaveButton saved={a.savedTitles.has(e.title)} onSave={() => a.onSaveIdea(e.title, '', 'manual')} />
      </footer>
    </article>
  )
}

function DraftEmbed({ e, a }: { e: Extract<Embed, { type: 'draft' }>; a: EmbedActions }): ReactNode {
  const [copied, setCopied] = useState(false)
  const platform = (e.platform ?? '').toLowerCase()
  const site = platform ? siteForPlatform(a.brand.sites, platform) : undefined
  const label = PLATFORM_NAMES[platform] ?? (e.platform || 'Draft')
  const ideaTitle = e.title || e.body.split('\n')[0].slice(0, 120)
  const copy = (): void => {
    const text = e.title ? `${e.title}\n\n${e.body}` : e.body
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <article className="cx-card cx-draft">
      <CardCorners />
      <header>
        <span className="cx-kind">Draft</span>
        <span className="muted">{label}</span>
        <span className="spacer" />
        <span className="muted cx-count">{e.body.length} chars</span>
      </header>
      {e.title && <p className="cx-card-title">{e.title}</p>}
      <div className="cx-draft-body">{e.body}</div>
      <footer>
        <button className="pill teal" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <SaveButton saved={a.savedTitles.has(ideaTitle)} onSave={() => a.onSaveIdea(ideaTitle, '', 'manual')} />
        {site && (
          <button className="pill" onClick={() => a.onOpenSite(site.id)} title={`Copy the draft, then paste it in ${site.name}`}>
            Open {site.name}
          </button>
        )}
      </footer>
    </article>
  )
}

function SiteEmbed({ e, a }: { e: Extract<Embed, { type: 'site' }>; a: EmbedActions }): ReactNode {
  const site = findSite(a.brand.sites, e.site)
  const page = site ? pageOnSite(site, e.url) : undefined
  return (
    <article className="cx-card cx-site">
      <CardCorners />
      <header>
        <span className="cx-kind">Site tab</span>
      </header>
      <span className="cx-site-letter">{(site?.name ?? e.site).slice(0, 1).toUpperCase()}</span>
      <p className="cx-card-title">{site?.name ?? e.site}</p>
      <p className="cx-card-detail">{site ? host(page ?? site.url) : 'No tab with that name in this brand'}</p>
      <footer>
        <span className="spacer" />
        {site && (
          <button className="pill teal" onClick={() => a.onOpenSite(site.id, page)}>
            Open tab
          </button>
        )}
      </footer>
    </article>
  )
}

export function EmbedCard({ raw, closed, actions }: { raw: string; closed: boolean; actions: EmbedActions }): ReactNode {
  if (!closed) {
    return (
      <article className="cx-card cx-dealing" aria-label="Card on the way">
        <CardCorners />
      </article>
    )
  }
  const e = parseEmbed(raw)
  if (!e) {
    return (
      <pre className="cx-bad-embed" title="This card couldn't be read">
        {raw}
      </pre>
    )
  }
  switch (e.type) {
    case 'trend':
      return <TrendEmbed e={e} a={actions} />
    case 'idea':
      return <IdeaEmbed e={e} a={actions} />
    case 'draft':
      return <DraftEmbed e={e} a={actions} />
    case 'site':
      return <SiteEmbed e={e} a={actions} />
  }
}
