import { useEffect, useState, type ReactNode } from 'react'
import {
  STAT_PLATFORMS,
  type AnalyticsConfig,
  type AnalyticsDoc,
  type StatPlatform,
  type StatPost,
  type StatSnapshot
} from '@shared/types'
import PageHeader from '../../components/PageHeader'
import { ExternalIcon, ReloadIcon, SettingsIcon } from '../../components/Icons'
import { age } from '../../components/TrendBits'
import type { PageProps } from '../types'
import { CardCorners } from '../writer/Mark'
import Chart, { short, type Point } from './Chart'
import Sources from './Sources'
import './analytics.css'

const NAMES: Record<StatPlatform, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram'
}

const FOLLOWER_WORD: Record<StatPlatform, string> = {
  youtube: 'Subscribers',
  tiktok: 'Followers',
  instagram: 'Followers'
}

const RANGES = [
  { label: '7 days', ms: 7 * 864e5 },
  { label: '30 days', ms: 30 * 864e5 },
  { label: '90 days', ms: 90 * 864e5 },
  { label: 'All', ms: Infinity }
] as const

const sum = (posts: StatPost[]): number | null => {
  const known = posts.filter((p) => p.views !== null)
  return known.length ? known.reduce((n, p) => n + (p.views ?? 0), 0) : null
}

function series(snaps: StatSnapshot[], pick: (s: StatSnapshot) => number | null): Point[] {
  return snaps.flatMap((s) => {
    const v = pick(s)
    return v === null ? [] : [[s.at, v] as Point]
  })
}

function Delta({ now, before }: { now: number | null; before: number | null }): ReactNode {
  if (now === null || before === null || now === before) return null
  const d = now - before
  return (
    <span className={`an-delta ${d > 0 ? 'up' : 'down'}`}>
      {d > 0 ? '+' : '-'}
      {short(Math.abs(d))}
    </span>
  )
}

function Stat(props: {
  label: string
  now: number | null
  before: number | null
  title?: string
}): ReactNode {
  return (
    <div className="an-stat" title={props.title}>
      <span className="an-stat-label">{props.label}</span>
      <span className="an-stat-value">{props.now === null ? '-' : props.now.toLocaleString()}</span>
      <Delta now={props.now} before={props.before} />
    </div>
  )
}

function Posts({ latest, prev }: { latest: StatSnapshot; prev: StatSnapshot | undefined }): ReactNode {
  const before = new Map(prev?.posts.map((p) => [p.id, p]) ?? [])
  if (latest.posts.length === 0) return <p className="muted small">No recent posts were read.</p>
  return (
    <table className="an-posts">
      <thead>
        <tr>
          <th>Recent posts</th>
          <th>Posted</th>
          <th>Views</th>
          <th>Likes</th>
          <th>Comments</th>
          <th aria-label="Open" />
        </tr>
      </thead>
      <tbody>
        {latest.posts.map((p) => (
          <tr key={p.id}>
            <td className="an-post-title" title={p.title}>
              {p.title || <span className="muted">No caption</span>}
            </td>
            <td className="muted">{p.publishedAt ? `${age(p.publishedAt)} ago` : '-'}</td>
            <td>
              {p.views === null ? '-' : short(p.views)}
              <Delta now={p.views} before={before.get(p.id)?.views ?? null} />
            </td>
            <td>{p.likes === null ? '-' : short(p.likes)}</td>
            <td>{p.comments === null ? '-' : short(p.comments)}</td>
            <td>
              {p.url && (
                <a className="icon-btn small" href={p.url} target="_blank" rel="noreferrer" title="Open">
                  <ExternalIcon />
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface PanelProps {
  platform: StatPlatform
  doc: AnalyticsDoc
  since: number
  busy: StatPlatform | null
  refreshing: boolean
  onRefresh: () => void
}

function Panel({ platform, doc, since, busy, refreshing, onRefresh }: PanelProps): ReactNode {
  const all = doc.snapshots.filter((s) => s.platform === platform)
  const snaps = all.filter((s) => s.at >= since)
  const latest = all[all.length - 1]
  const prev = all[all.length - 2]
  // compare against the first reading in the range, or the one before if that's all there is
  const base = snaps.length > 1 ? snaps[0] : prev
  const run = doc.lastRun[platform]
  const hasLifetime = snaps.some((s) => s.views !== null)
  const viewsLabel = hasLifetime ? 'Total views' : `Views on last ${latest?.posts.length || ''} posts`
  const views = (s: StatSnapshot | undefined): number | null =>
    s ? (hasLifetime ? s.views : sum(s.posts)) : null

  return (
    <section className="an-panel">
      <CardCorners tone={run && !run.ok ? 'pink' : 'teal'} />
      <header className="an-panel-head">
        <h3>{NAMES[platform]}</h3>
        {latest?.account && <span className="muted">{latest.account}</span>}
        <span className="spacer" />
        {run && (
          <span className={`small ${run.ok ? 'muted' : 'an-error'}`} title={run.message}>
            {run.ok ? `Read ${age(run.at)} ago, ${run.message}` : run.message}
          </span>
        )}
        <button
          className={`icon-btn small${busy === platform ? ' spinning' : ''}`}
          title={`Refresh ${NAMES[platform]}`}
          aria-label={`Refresh ${NAMES[platform]}`}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <ReloadIcon />
        </button>
      </header>

      {!latest ? (
        <p className="muted small an-none">
          No numbers yet. Log into {platform === 'youtube' ? 'YouTube Studio' : NAMES[platform]} in this
          brand's tab, then press Refresh.
        </p>
      ) : (
        <>
          <div className="an-stats">
            <Stat label={FOLLOWER_WORD[platform]} now={latest.followers} before={base?.followers ?? null} />
            <Stat
              label={viewsLabel}
              now={views(latest)}
              before={views(base)}
              title={hasLifetime ? undefined : 'Only the recent posts the page showed, not the whole account'}
            />
            {latest.likes !== null && <Stat label="Likes" now={latest.likes} before={base?.likes ?? null} />}
            {latest.postCount !== null && (
              <Stat label="Posts" now={latest.postCount} before={base?.postCount ?? null} />
            )}
          </div>
          <div className="an-charts">
            <div>
              <h4>{FOLLOWER_WORD[platform]}</h4>
              <Chart points={series(snaps, (s) => s.followers)} label={FOLLOWER_WORD[platform]} />
            </div>
            <div>
              <h4>{viewsLabel}</h4>
              <Chart points={series(snaps, views)} label="Views" />
            </div>
          </div>
          <Posts latest={latest} prev={prev} />
        </>
      )}
    </section>
  )
}

export default function Analytics({ brand, chatOpen, onToggleChat }: PageProps): ReactNode {
  const [doc, setDoc] = useState<AnalyticsDoc | null>(null)
  const [range, setRange] = useState(1)
  const [busy, setBusy] = useState<StatPlatform | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [showSources, setShowSources] = useState(false)

  useEffect(() => {
    let alive = true
    void window.trenddeck.loadAnalytics(brand.id).then((d) => alive && setDoc(d))
    const off = window.trenddeck.onAnalyticsProgress((id, platform) => {
      if (id === brand.id) setBusy(platform)
    })
    return () => {
      alive = false
      off()
    }
  }, [brand.id])

  if (!doc) return <div className="page" />

  const enabled = STAT_PLATFORMS.filter((p) => doc.config.enabled[p])

  const refresh = async (platforms: StatPlatform[]): Promise<void> => {
    if (!platforms.length) return
    setRefreshing(true)
    try {
      setDoc(await window.trenddeck.refreshAnalytics(brand.id, platforms))
    } finally {
      setRefreshing(false)
      setBusy(null)
    }
  }

  const saveConfig = async (config: AnalyticsConfig): Promise<void> => {
    setDoc(await window.trenddeck.saveAnalyticsConfig(brand.id, config))
    setShowSources(false)
  }

  const clear = async (): Promise<void> => {
    if (!window.confirm(`Delete every saved reading for ${brand.name}? Charts start over.`)) return
    setDoc(await window.trenddeck.clearAnalytics(brand.id))
  }

  const since = Date.now() - RANGES[range].ms

  return (
    <div className="page">
      <PageHeader title="Analytics" chatOpen={chatOpen} onToggleChat={onToggleChat}>
        <div className="an-head-bar">
          <div className="an-ranges" role="group" aria-label="Range">
            {RANGES.map((r, i) => (
              <button
                key={r.label}
                className={`filter-chip${range === i ? ' on' : ''}`}
                aria-pressed={range === i}
                onClick={() => setRange(i)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button
            className={`icon-btn${showSources ? ' on' : ''}`}
            title="Sources and api keys"
            aria-label="Sources and api keys"
            onClick={() => setShowSources((s) => !s)}
          >
            <SettingsIcon />
          </button>
          <button
            className={`pill teal${refreshing ? ' spinning' : ''}`}
            disabled={refreshing || enabled.length === 0}
            onClick={() => void refresh(enabled)}
          >
            <ReloadIcon />
            {refreshing ? `Reading ${busy ? NAMES[busy] : ''}...` : 'Refresh'}
          </button>
        </div>
      </PageHeader>
      <div className="scroll">
        {showSources && (
          <Sources
            config={doc.config}
            onSave={(c) => void saveConfig(c)}
            onClear={() => void clear()}
            onClose={() => setShowSources(false)}
          />
        )}
        {doc.snapshots.length === 0 && !showSources && (
          <div className="notice">
            <p>
              Refresh opens your own YouTube Studio, TikTok and Instagram pages in the background with this
              brand's logins and reads your numbers. It only runs when you press it, and everything stays on
              this computer.
            </p>
          </div>
        )}
        {enabled.length === 0 && (
          <p className="feed-empty">Every site is switched off. Turn one on in sources.</p>
        )}
        <div className="an-panels">
          {enabled.map((p) => (
            <Panel
              key={p}
              platform={p}
              doc={doc}
              since={since}
              busy={busy}
              refreshing={refreshing}
              onRefresh={() => void refresh([p])}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
