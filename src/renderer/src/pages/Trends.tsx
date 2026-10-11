import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Dropdown } from '../chat/ui'
import { SOURCE_NAMES, TREND_SOURCES, type TrendFeed, type TrendItem, type TrendSource } from '@shared/types'
import PageHeader from '../components/PageHeader'
import { age, HeroCard, TrendCard } from '../components/TrendBits'
import { CloseIcon, ReloadIcon, SearchIcon } from '../components/Icons'
import type { PageProps } from './types'

type Sort = 'score' | 'newest' | 'source'

const newId = (): string => crypto.randomUUID()

export default function Trends(props: PageProps): ReactNode {
  const { brand, editBrand, chatOpen, onToggleChat, onEditBrand, trendQuery: query, onTrendQuery } = props
  const [feed, setFeed] = useState<TrendFeed | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [sources, setSources] = useState<ReadonlySet<TrendSource>>(new Set(TREND_SOURCES))
  const [sort, setSort] = useState<Sort>('score')

  useEffect(() => {
    let alive = true
    void window.trenddeck.getTrends(brand.id).then((f) => {
      if (!alive) return
      setFeed((now) => now ?? f)
      setLoaded(true)
    })
    const off = window.trenddeck.onTrends((f) => {
      if (f.brandId === brand.id) setFeed(f)
    })
    return () => {
      alive = false
      off()
    }
  }, [brand.id])

  const savedUrls = useMemo(() => new Set(brand.ideas.map((i) => i.url)), [brand.ideas])

  const save = (item: TrendItem): void => {
    editBrand((b) =>
      b.ideas.some((i) => i.url === item.url)
        ? b
        : {
            ...b,
            ideas: [
              { id: newId(), title: item.title, url: item.url, source: item.source, savedAt: Date.now() },
              ...b.ideas
            ]
          }
    )
  }

  const items = feed?.items ?? []
  const top = items.slice(0, 3)
  const filtering = query.trim() !== '' || sources.size !== TREND_SOURCES.length
  const q = query.trim().toLowerCase()
  const shown = items
    .filter((i) => sources.has(i.source))
    .filter((i) => !q || i.title.toLowerCase().includes(q) || i.detail.toLowerCase().includes(q))
    // the top three are already up top unless you're filtering
    .filter((i) => filtering || sort !== 'score' || !top.includes(i))
    .sort((a, b) => {
      if (sort === 'newest') return (b.publishedAt ?? 0) - (a.publishedAt ?? 0)
      if (sort === 'source') return a.source.localeCompare(b.source) || b.score - a.score
      return b.score - a.score
    })

  const toggle = (s: TrendSource): void => {
    setSources((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next.size === 0 ? new Set(TREND_SOURCES) : next
    })
  }

  const refreshing = feed?.refreshing ?? false
  const errors = Object.entries(feed?.errors ?? {}) as [TrendSource, string][]
  const noNiche = brand.keywords.length === 0 && brand.subreddits.length === 0
  const counts = TREND_SOURCES.map((s) => [s, items.filter((i) => i.source === s).length] as const)

  return (
    <div className="page">
      <PageHeader title="Trends" chatOpen={chatOpen} onToggleChat={onToggleChat}>
        <span className="muted small">
          {refreshing ? 'Dealing fresh trends...' : feed?.fetchedAt ? `Updated ${age(feed.fetchedAt)} ago` : ''}
        </span>
        <button
          className={`icon-btn${refreshing ? ' spinning' : ''}`}
          title="Refresh"
          aria-label="Refresh trends"
          disabled={refreshing}
          onClick={() => void window.trenddeck.refreshTrends(brand.id)}
        >
          <ReloadIcon />
        </button>
      </PageHeader>

      <div className="scroll">
        {noNiche && (
          <div className="notice">
            <p>
              Add niche keywords and subreddits so there's something to deal. Until then you only get
              what's trending on TikTok overall.
            </p>
            <button className="pill teal" onClick={onEditBrand}>
              Add keywords
            </button>
          </div>
        )}

        {top.length > 0 && (
          <section className="hero" aria-label="Top trends today">
            <h3 className="section-title">Today's top three</h3>
            <div className="hero-row">
              {top.map((item, i) => (
                <HeroCard
                  key={item.id}
                  item={item}
                  index={i}
                  saved={savedUrls.has(item.url)}
                  onSave={() => save(item)}
                />
              ))}
            </div>
          </section>
        )}

        <div className="filters">
          <div className="source-chips" role="group" aria-label="Sources">
            {counts.map(([s, n]) => (
              <button
                key={s}
                className={`filter-chip${sources.has(s) ? ' on' : ''}`}
                aria-pressed={sources.has(s)}
                onClick={() => toggle(s)}
              >
                {SOURCE_NAMES[s]}
                <span className="n">{n}</span>
              </button>
            ))}
          </div>
          <span className="spacer" />
          {q && (
            <span className="filter-chip on query-chip">
              <SearchIcon />
              {query.trim()}
              <button title="Clear search" aria-label="Clear search" onClick={() => onTrendQuery('')}>
                <CloseIcon />
              </button>
            </span>
          )}
          <Dropdown<Sort>
            label="Sort"
            value={sort}
            options={[
              { value: 'score', label: 'Top score' },
              { value: 'newest', label: 'Newest' },
              { value: 'source', label: 'By source' }
            ]}
            onChange={setSort}
          />
        </div>

        {errors.length > 0 && (
          <p className="errors">
            {errors.map(([s, e]) => `Couldn't reach ${SOURCE_NAMES[s]} (${e})`).join('. ')}
          </p>
        )}

        {shown.length > 0 ? (
          <div className="trend-grid">
            {shown.map((item, i) => (
              <TrendCard
                key={item.id}
                item={item}
                index={i}
                saved={savedUrls.has(item.url)}
                onSave={() => save(item)}
              />
            ))}
          </div>
        ) : (
          <div className="feed-empty">
            {!loaded || (refreshing && items.length === 0) ? (
              <div className="trend-grid">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="trend-card ghost" style={{ animationDelay: `${i * 35}ms` }} />
                ))}
              </div>
            ) : items.length === 0 ? (
              <p>Nothing yet. Hit refresh to deal the first hand.</p>
            ) : filtering || sort !== 'score' ? (
              <p>No trends match that.</p>
            ) : (
              <p>That's the whole hand for now.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
