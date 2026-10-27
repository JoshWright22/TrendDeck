import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  clock,
  countText,
  FORMAT_NAMES,
  PLATFORM_NAMES,
  ratioText,
  SNAPSHOT_NAMES,
  type ContentMapView,
  type MapRow,
  type VideoDetail
} from '@shared/content-map'
import type { Project } from '@shared/workspace'
import { Dropdown } from '../../chat/ui'
import RetentionChart from './RetentionChart'
import './content-map.css'

// the brand's content map: the usual numbers per format, pillars, and every past video against
// its baseline. click a video for its numbers and where people left. used by the chat card and
// by Settings, Channels

type SortKey = 'title' | 'publishedAt' | 'format' | 'views' | 'ratio'

const FLAG_WORDS: Record<MapRow['flag'], string> = {
  top: 'well above usual',
  bottom: 'well below usual',
  normal: '',
  early: 'first week',
  none: ''
}

export function when(at: number | null): string {
  if (!at) return 'not posted'
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

export function ago(at: number | null): string {
  if (!at) return 'never'
  const m = Math.round((Date.now() - at) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`
  return `${Math.round(m / 1440)}d ago`
}

export function useContentMap(brandId: string): { view: ContentMapView | null; error: string; reload: () => void } {
  const [view, setView] = useState<ContentMapView | null>(null)
  const [error, setError] = useState('')
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    const api = window.trenddeckContentMap
    const load = (): void => {
      void api
        .view(brandId)
        .then((v) => alive && (setView(v), setError('')))
        .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)))
    }
    load()
    const off = api.onChanged((id) => id === brandId && load())
    return () => {
      alive = false
      off()
    }
  }, [brandId, n])
  return { view, error, reload: () => setN((x) => x + 1) }
}

function SortHead({ k, label, sort, setSort, numeric }: { k: SortKey; label: string; sort: { key: SortKey; dir: 1 | -1 }; setSort: (s: { key: SortKey; dir: 1 | -1 }) => void; numeric?: boolean }): ReactNode {
  const on = sort.key === k
  return (
    <th scope="col" aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={numeric ? 'num' : undefined}>
      <button type="button" className="cm-sort" onClick={() => setSort({ key: k, dir: on ? (sort.dir === 1 ? -1 : 1) : k === 'title' || k === 'format' ? 1 : -1 })}>
        {label}
        <span className="cm-sort-mark" aria-hidden="true">
          {on ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
        </span>
      </button>
    </th>
  )
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }): ReactNode {
  return (
    <div className="cm-metric">
      <dt>{label}</dt>
      <dd title={hint}>{value}</dd>
    </div>
  )
}

function Detail({ brandId, id, projects, onClose }: { brandId: string; id: string; projects: Project[]; onClose: () => void }): ReactNode {
  const [d, setD] = useState<VideoDetail | null | undefined>(undefined)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const load = (): void => void window.trenddeckContentMap.detail(brandId, id).then((x) => alive && setD(x))
    load()
    const off = window.trenddeckContentMap.onChanged((b) => b === brandId && load())
    return () => {
      alive = false
      off()
    }
  }, [brandId, id])
  if (d === undefined) return <p className="cm-hint">Loading the video...</p>
  if (d === null) return <p className="cm-hint">That video isn't in the map anymore.</p>
  const v = d.video
  const m = v.metrics
  const num = (x: number | null | undefined): string => (x === null || x === undefined ? 'not available' : countText(Math.round(x)))
  const options = [{ value: '', label: 'No project' }, ...projects.filter((p) => p.id !== 'general').map((p) => ({ value: p.id, label: p.name }))]
  return (
    <section className="cm-detail" aria-label={`Numbers for ${v.title}`}>
      <header className="cm-detail-head">
        <div>
          <h4>{v.title || 'Untitled'}</h4>
          <p className="cm-hint">
            {PLATFORM_NAMES[v.platform]}, {FORMAT_NAMES[v.format].toLowerCase().replace(/s$/, '')}
            {v.duration !== null ? `, ${clock(v.duration)} long` : ''}, {v.publishedAt ? `posted ${when(v.publishedAt)}` : 'not posted yet'}
            {d.row.ratio !== null ? `. ${ratioText(d.row.ratio)} the usual ${countText(Math.round(d.row.baseline ?? 0))}` : ''}
          </p>
        </div>
        <button type="button" className="cm-quiet" onClick={onClose}>
          Close
        </button>
      </header>
      {m ? (
        <dl className="cm-metrics">
          <Metric label="Views" value={num(m.views)} />
          {v.format === 'short' && <Metric label="Engaged views" value={num(m.engagedViews)} />}
          <Metric label="Average view" value={m.avgViewDuration === null ? 'not available' : clock(m.avgViewDuration)} />
          <Metric label="Average viewed" value={m.avgViewPercent === null ? 'not available' : `${Math.round(m.avgViewPercent)}%`} />
          <Metric label="Likes" value={num(m.likes)} />
          <Metric label="Comments" value={num(m.comments)} />
          <Metric label="Shares" value={num(m.shares)} />
          <Metric label="Subscribers gained" value={num(m.subsGained)} />
          <Metric label="Impressions" value={num(m.impressions)} hint="From a YouTube Studio export, Settings, Channels" />
          <Metric label="Click-through rate" value={m.ctr === null ? 'not available' : `${m.ctr.toFixed(1)}%`} hint="From a YouTube Studio export, Settings, Channels" />
        </dl>
      ) : (
        <p className="cm-hint">No numbers for this one yet.</p>
      )}
      {d.snapshots.length > 0 && (
        <table className="cm-table cm-table-small">
          <caption>After it went up</caption>
          <thead>
            <tr>
              <th scope="col">Age</th>
              <th scope="col" className="num">
                Views
              </th>
              <th scope="col" className="num">
                Likes
              </th>
              <th scope="col">Read</th>
            </tr>
          </thead>
          <tbody>
            {d.snapshots.map((s) => (
              <tr key={s.label}>
                <td>{SNAPSHOT_NAMES[s.label]}</td>
                <td className="num">{countText(s.views)}</td>
                <td className="num">{countText(s.likes)}</td>
                <td>{s.at - s.due > 3600_000 ? `late, ${ago(s.at)}` : ago(s.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {v.retention.length > 1 && v.duration ? (
        <>
          <RetentionChart points={v.retention} duration={v.duration} dips={d.retention.dips} />
          {d.retention.at30 !== null && <p className="cm-hint">{Math.round(d.retention.at30 * 100)}% were still watching at 30 seconds.</p>}
          {d.retention.dips.length > 0 && (
            <ol className="cm-dips">
              {d.retention.dips.map((x, i) => (
                <li key={i}>
                  <strong>
                    {clock(x.from)} to {clock(x.to)}
                  </strong>{' '}
                  {Math.round(x.drop * 100)}% left{x.recurring ? ', same spot as other recent videos' : ''}
                  {x.line && <span className="cm-dip-line">"{x.line}"</span>}
                </li>
              ))}
            </ol>
          )}
        </>
      ) : (
        <p className="cm-hint">No retention curve. It needs the channel connected with Google and about 100 views.</p>
      )}
      {v.hook && (
        <div className="cm-hook">
          <span className="cm-label">First 30 seconds{v.hookSource === 'script' ? ', from the script' : ''}</span>
          <p>{v.hook}</p>
        </div>
      )}
      {v.pacing && (
        <p className="cm-hint">
          {v.pacing.wpm} words a minute, {v.pacing.pausesPerMin} pauses a minute{v.pacing.approximate ? ' (estimated from captions)' : ''}.
        </p>
      )}
      <div className="cm-project">
        <span className="cm-label">Project</span>
        <Dropdown
          label="Project for this video"
          value={v.projectId ?? ''}
          options={options}
          onChange={(p) => void window.trenddeckContentMap.setProject(brandId, v.id, p || null).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}
        />
        {!v.projectPinned && v.projectId && <span className="cm-hint">matched by name</span>}
      </div>
      {error && <p className="cm-error">{error}</p>}
    </section>
  )
}

export default function ContentMap({ brandId, projects, focus = null }: { brandId: string; projects: Project[]; focus?: string | null }): ReactNode {
  const { view, error } = useContentMap(brandId)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'publishedAt', dir: -1 })
  const [open, setOpen] = useState<string | null>(focus)
  const [showAll, setShowAll] = useState(false)

  const sorted = useMemo(() => {
    const rows = [...(view?.rows ?? [])]
    const val = (r: MapRow): string | number => {
      switch (sort.key) {
        case 'title':
          return r.title.toLowerCase()
        case 'format':
          return r.format
        case 'publishedAt':
          return r.publishedAt ?? Infinity
        case 'views':
          return r.views ?? -1
        case 'ratio':
          return r.ratio ?? -1
      }
    }
    return rows.sort((a, b) => {
      const x = val(a)
      const y = val(b)
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
    })
  }, [view, sort])

  if (error) return <p className="cm-error">{error}</p>
  if (!view) return <p className="cm-hint">Loading the content map...</p>
  if (!view.rows.length) {
    return (
      <p className="cm-hint">
        No videos mapped yet. Connect your channel in Settings, Channels, or add a script or an export to a video project.
      </p>
    )
  }
  const rows = showAll ? sorted : sorted.slice(0, 25)
  const ch = view.channel
  return (
    <div className="cm">
      <p className="cm-hint">
        {view.rows.length} videos{ch.channelTitle ? ` from ${ch.channelTitle}` : ''}, synced {ago(ch.lastSync)}.
        {ch.lastSyncNote ? ` ${ch.lastSyncNote}` : ''}
      </p>
      {view.baselines.length > 0 && (
        <ul className="cm-baselines">
          {view.baselines.map((b) => (
            <li key={`${b.platform}-${b.format}`}>
              <strong>
                {FORMAT_NAMES[b.format]} on {PLATFORM_NAMES[b.platform]}
              </strong>
              {b.median === null ? ' have no settled videos to compare with yet.' : `: usually ${countText(Math.round(b.median))} ${b.metric}, the median of the last ${b.count}.`}
            </li>
          ))}
        </ul>
      )}

      {view.pillars.length > 0 ? (
        <table className="cm-table">
          <caption>Pillars</caption>
          <thead>
            <tr>
              <th scope="col">Pillar</th>
              <th scope="col" className="num">
                Videos
              </th>
              <th scope="col" className="num">
                Median vs usual
              </th>
              <th scope="col" className="num">
                Beat usual
              </th>
            </tr>
          </thead>
          <tbody>
            {view.pillars.map((p) => (
              <tr key={p.id || p.label}>
                <td>
                  {p.label}
                  {p.keywords.length > 0 && <span className="cm-sub">{p.keywords.slice(0, 6).join(', ')}</span>}
                </td>
                <td className="num">{p.count}</td>
                <td className="num">{ratioText(p.median)}</td>
                <td className="num">{p.beat === null ? 'no data' : `${Math.round(p.beat * 100)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="cm-hint">
          No pillars yet. Ask your agent to propose some from your videos{view.keywords.length ? `, the words that come back most are ${view.keywords.slice(0, 6).map((k) => k.word).join(', ')}` : ''}.
        </p>
      )}

      <table className="cm-table cm-videos">
        <caption>Videos, click one for its numbers</caption>
        <thead>
          <tr>
            <SortHead k="title" label="Title" sort={sort} setSort={setSort} />
            <SortHead k="publishedAt" label="Posted" sort={sort} setSort={setSort} />
            <SortHead k="format" label="Format" sort={sort} setSort={setSort} />
            <SortHead k="views" label="Views" sort={sort} setSort={setSort} numeric />
            <SortHead k="ratio" label="vs usual" sort={sort} setSort={setSort} numeric />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={open === r.id ? 'on' : undefined}>
              <td>
                <button type="button" className="cm-title" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {r.title || 'Untitled'}
                </button>
                {r.pillar && <span className="cm-sub">{r.pillar}</span>}
              </td>
              <td>{when(r.publishedAt)}</td>
              <td>{r.platform === 'local' ? 'not posted' : r.format === 'short' ? 'Short' : 'Long'}</td>
              <td className="num">{r.views === null ? '' : countText(r.views)}</td>
              <td className="num">
                {r.ratio === null ? '' : ratioText(r.ratio)}
                {FLAG_WORDS[r.flag] && <span className="cm-sub">{FLAG_WORDS[r.flag]}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > rows.length && (
        <button type="button" className="cm-quiet" onClick={() => setShowAll(true)}>
          Show all {sorted.length}
        </button>
      )}
      {open && view.rows.some((r) => r.id === open) && <Detail key={open} brandId={brandId} id={open} projects={projects} onClose={() => setOpen(null)} />}
    </div>
  )
}
