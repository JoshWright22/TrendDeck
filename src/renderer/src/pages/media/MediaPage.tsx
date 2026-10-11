import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Dropdown } from '../../chat/ui'
import {
  filterMedia,
  formatDuration,
  formatSize,
  mediaUrl,
  type MediaFilter,
  type MediaItem,
  type MediaKind
} from '@shared/media'
import PageHeader from '../../components/PageHeader'
import { CloseIcon, PlusIcon } from '../../components/Icons'
import type { PageProps } from '../types'
import { addedWhen, postedLine, resolution, Thumb } from './MediaBits'
import { FolderIcon, GridIcon, ListIcon } from './MediaIcons'
import { useMediaLibrary } from './useMedia'
import './media.css'

type Side =
  | { kind: 'all' }
  | { kind: 'type'; type: MediaKind }
  | { kind: 'unposted' }
  | { kind: 'missing' }
  | { kind: 'agent' }
  | { kind: 'collection'; name: string }
  | { kind: 'tag'; name: string }

const api = (): typeof window.trenddeck.media => window.trenddeck.media

const KIND_NAMES: Record<MediaKind, string> = { video: 'Videos', image: 'Images', audio: 'Audio', file: 'Other files' }

function sideFilter(side: Side, query: string, notOn: string): MediaFilter {
  const f: MediaFilter = { query, includeMissing: true }
  if (side.kind === 'type') f.kind = side.type
  if (side.kind === 'unposted') f.notPostedTo = notOn || true
  if (side.kind === 'agent') f.agentOnly = true
  if (side.kind === 'collection') f.collection = side.name
  if (side.kind === 'tag') f.tag = side.name
  return f
}

function sameSide(a: Side, b: Side): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export default function MediaPage({ brand, chatOpen, onToggleChat }: PageProps): ReactNode {
  const lib = useMediaLibrary(brand.id)
  const [side, setSide] = useState<Side>({ kind: 'all' })
  const [query, setQuery] = useState('')
  const [notOn, setNotOn] = useState('')
  const [view, setView] = useState<'grid' | 'list'>(
    () => (localStorage.getItem('media-view') as 'grid' | 'list') || 'grid'
  )
  const [selected, setSelected] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [undo, setUndo] = useState<{ ids: string[]; label: string } | null>(null)
  const [note, setNote] = useState('')
  const [newCollection, setNewCollection] = useState<string | null>(null)
  const dragDepth = useRef(0)

  useEffect(() => localStorage.setItem('media-view', view), [view])
  useEffect(() => {
    setSelected([])
    setSide({ kind: 'all' })
  }, [brand.id])
  useEffect(() => {
    if (!undo) return
    const t = setTimeout(() => setUndo(null), 8000)
    return () => clearTimeout(t)
  }, [undo])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(''), 4000)
    return () => clearTimeout(t)
  }, [note])

  const items = useMemo(() => lib?.items ?? [], [lib])
  const shown = useMemo(() => {
    const list = filterMedia(items, sideFilter(side, query, notOn))
    return side.kind === 'missing' ? list.filter((m) => m.missing) : list
  }, [items, side, query, notOn])
  const tags = useMemo(() => [...new Set(items.flatMap((m) => m.tags))].sort(), [items])
  const kinds = useMemo(() => (['video', 'image', 'audio', 'file'] as MediaKind[]).filter((k) => items.some((m) => m.kind === k)), [items])
  const platforms = useMemo(
    () => [...new Set([...brand.sites.map((s) => s.name.toLowerCase()), ...items.flatMap((m) => m.posts.map((p) => p.platform))])],
    [brand.sites, items]
  )
  const sel = items.filter((m) => selected.includes(m.id))
  const missingCount = items.filter((m) => m.missing).length
  const unpostedCount = items.filter((m) => !m.posts.length).length

  const report = (r: { added: number; skipped: number }): void => {
    if (r.added || r.skipped) {
      setNote(`${r.added} added${r.skipped ? `, ${r.skipped} already here or unreadable` : ''}`)
    }
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const paths = [...e.dataTransfer.files].map((f) => api().pathForFile(f)).filter(Boolean)
    if (paths.length) void api().addPaths(brand.id, paths).then(report)
  }

  const remove = (ids: string[]): void => {
    if (!ids.length) return
    const label = ids.length === 1 ? (items.find((m) => m.id === ids[0])?.name ?? 'File') : `${ids.length} files`
    void api().remove(brand.id, ids)
    setSelected([])
    setUndo({ ids, label })
  }

  const click = (id: string, e: React.MouseEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
    } else if (e.shiftKey && selected.length) {
      const ids = shown.map((m) => m.id)
      const a = ids.indexOf(selected[selected.length - 1])
      const b = ids.indexOf(id)
      setSelected(ids.slice(Math.min(a, b), Math.max(a, b) + 1))
    } else {
      setSelected([id])
    }
  }

  const sideBtn = (s: Side, label: string, count?: number, extra?: ReactNode): ReactNode => (
    <button
      key={label}
      className={`media-side-item${sameSide(side, s) ? ' active' : ''}`}
      onClick={() => {
        setSide(s)
        setSelected([])
      }}
    >
      <span className="media-side-name">{label}</span>
      {count !== undefined && count > 0 && <span className="count">{count}</span>}
      {extra}
    </button>
  )

  return (
    <div
      className="page media-page"
      onKeyDown={(e) => {
        if (e.key === 'Delete' && selected.length && !(e.target instanceof HTMLInputElement)) remove(selected)
        if (e.key === 'Escape') setSelected([])
      }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        dragDepth.current++
        setDragging(true)
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <PageHeader title="Media" chatOpen={chatOpen} onToggleChat={onToggleChat}>
        <input
          className="media-search"
          type="search"
          value={query}
          placeholder="Search names and tags"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="media-seg" role="group" aria-label="View">
          <button className={view === 'grid' ? 'on' : ''} title="Grid" aria-label="Grid" onClick={() => setView('grid')}>
            <GridIcon />
          </button>
          <button className={view === 'list' ? 'on' : ''} title="List" aria-label="List" onClick={() => setView('list')}>
            <ListIcon />
          </button>
        </div>
        <button className="pill" onClick={() => void api().pickAndAdd(brand.id, true).then(report)}>
          <FolderIcon />
          Add folder
        </button>
        <button className="pill teal" onClick={() => void api().pickAndAdd(brand.id, false).then(report)}>
          <PlusIcon />
          Add files
        </button>
      </PageHeader>

      <div className="media-body">
        <aside className="media-side">
          {sideBtn({ kind: 'all' }, 'All files', items.length)}
          {kinds.map((k) => sideBtn({ kind: 'type', type: k }, KIND_NAMES[k]))}
          {sideBtn({ kind: 'unposted' }, 'Not posted yet', unpostedCount)}
          {side.kind === 'unposted' && (
            <Dropdown
              className="media-select"
              label="Not posted on"
              value={notOn}
              options={[{ value: '', label: 'Anywhere' }, ...platforms.map((p) => ({ value: p, label: `Not on ${p}` }))]}
              onChange={setNotOn}
            />
          )}
          {sideBtn({ kind: 'agent' }, 'Agents can use')}
          {missingCount > 0 && sideBtn({ kind: 'missing' }, 'Missing', missingCount)}

          <div className="media-side-head">
            <span>Collections</span>
            <button className="icon-btn small" title="New collection" onClick={() => setNewCollection('')}>
              <PlusIcon />
            </button>
          </div>
          {newCollection !== null && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const name = newCollection.trim()
                if (name && lib && !lib.collections.includes(name)) {
                  void api().setCollections(brand.id, [...lib.collections, name])
                }
                setNewCollection(null)
              }}
            >
              <input
                className="media-inline-input"
                autoFocus
                maxLength={60}
                value={newCollection}
                placeholder="Name"
                onChange={(e) => setNewCollection(e.target.value)}
                onBlur={(e) => e.currentTarget.form?.requestSubmit()}
                onKeyDown={(e) => e.key === 'Escape' && setNewCollection(null)}
              />
            </form>
          )}
          {lib?.collections.map((c) =>
            sideBtn(
              { kind: 'collection', name: c },
              c,
              items.filter((m) => m.collections.includes(c)).length,
              <span
                className="media-side-x"
                role="button"
                title="Delete collection, files stay"
                onClick={(e) => {
                  e.stopPropagation()
                  void api().setCollections(brand.id, lib.collections.filter((x) => x !== c))
                  if (side.kind === 'collection' && side.name === c) setSide({ kind: 'all' })
                }}
              >
                <CloseIcon />
              </span>
            )
          )}
          {lib && !lib.collections.length && newCollection === null && (
            <p className="muted small media-side-hint">Group files for a series or a client.</p>
          )}

          {tags.length > 0 && (
            <>
              <div className="media-side-head">
                <span>Tags</span>
              </div>
              <div className="media-tags">
                {tags.map((t) => (
                  <button
                    key={t}
                    className={`media-tag${side.kind === 'tag' && side.name === t ? ' on' : ''}`}
                    onClick={() => setSide(side.kind === 'tag' && side.name === t ? { kind: 'all' } : { kind: 'tag', name: t })}
                  >
                    #{t}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="media-side-head">
            <span>Watch folders</span>
            <button className="icon-btn small" title="Watch a folder" onClick={() => void api().addWatch(brand.id)}>
              <PlusIcon />
            </button>
          </div>
          {lib?.watch.map((w) => (
            <div key={w.id} className="media-watch" title={w.path}>
              <span className="media-watch-path">{w.path.split(/[\\/]/).filter(Boolean).pop() ?? w.path}</span>
              <label className="media-check small" title="New files from this folder can be used by agents">
                <input
                  type="checkbox"
                  checked={w.agentAllowed}
                  onChange={(e) => void api().editWatch(brand.id, w.id, e.target.checked)}
                />
                Agents
              </label>
              <button className="icon-btn small" title="Stop watching" onClick={() => void api().removeWatch(brand.id, w.id)}>
                <CloseIcon />
              </button>
            </div>
          ))}
          {lib && !lib.watch.length && (
            <p className="muted small media-side-hint">Point at your exports folder and new files show up here.</p>
          )}

          <span className="spacer" />
          <label className="media-check small media-copy-default">
            <input
              type="checkbox"
              checked={lib?.copyByDefault ?? false}
              onChange={(e) => void api().setCopyByDefault(brand.id, e.target.checked)}
            />
            Copy new files into TrendDeck
          </label>
        </aside>

        <section className="media-main" onClick={(e) => e.target === e.currentTarget && setSelected([])}>
          {!lib ? null : items.length === 0 ? (
            <div className="media-empty">
              <h3>Drop your videos and images here</h3>
              <p className="muted">
                Or add files, a folder, or watch your exports folder. Files stay where they are unless you copy them in.
              </p>
            </div>
          ) : shown.length === 0 ? (
            <p className="feed-empty">Nothing matches.</p>
          ) : view === 'grid' ? (
            <ul className="media-grid" onClick={(e) => e.target === e.currentTarget && setSelected([])}>
              {shown.map((m, i) => (
                <li
                  key={m.id}
                  className={`media-card${selected.includes(m.id) ? ' sel' : ''}${m.missing ? ' gone' : ''}`}
                  style={{ animationDelay: `${Math.min(i, 12) * 18}ms` }}
                  tabIndex={0}
                  onClick={(e) => click(m.id, e)}
                  onDoubleClick={() => void api().reveal(brand.id, m.id)}
                >
                  <Thumb item={m} />
                  <div className="media-card-name" title={m.name}>
                    {m.name}
                  </div>
                  <div className="muted small media-card-meta">
                    {[m.ext.toUpperCase(), formatSize(m.size), resolution(m)].filter(Boolean).join(' · ')}
                  </div>
                  {m.posts.length > 0 && <span className="media-posted-dot" title={postedLine(m)} />}
                </li>
              ))}
            </ul>
          ) : (
            <table className="media-table">
              <thead>
                <tr>
                  <th />
                  <th>Name</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Length</th>
                  <th>Resolution</th>
                  <th>Posted</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <tr
                    key={m.id}
                    className={`${selected.includes(m.id) ? 'sel' : ''}${m.missing ? ' gone' : ''}`}
                    tabIndex={0}
                    onClick={(e) => click(m.id, e)}
                    onDoubleClick={() => void api().reveal(brand.id, m.id)}
                  >
                    <td className="media-row-thumb">
                      <Thumb item={m} />
                    </td>
                    <td className="media-row-name" title={m.name}>
                      {m.name}
                      {m.missing && <span className="media-flag">Missing</span>}
                    </td>
                    <td>{m.ext.toUpperCase()}</td>
                    <td className="num">{formatSize(m.size)}</td>
                    <td className="num">{formatDuration(m.duration)}</td>
                    <td className="num">{resolution(m)}</td>
                    <td className="muted">{m.posts.length ? [...new Set(m.posts.map((p) => p.platform))].join(', ') : 'Not yet'}</td>
                    <td className="muted num">{addedWhen(m.addedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {dragging && (
            <div className="media-drop">
              <span>Drop to add to {brand.name}</span>
            </div>
          )}
        </section>

        {sel.length > 0 && lib && (
          <Details
            key={sel.map((m) => m.id).join()}
            brandId={brand.id}
            items={sel}
            collections={lib.collections}
            platforms={platforms}
            onRemove={() => remove(sel.map((m) => m.id))}
            onClose={() => setSelected([])}
          />
        )}
      </div>

      {(undo || note) && (
        <div className="media-toast" role="status">
          {undo ? (
            <>
              <span>{undo.label} removed from Media</span>
              <button
                className="pill"
                onClick={() => {
                  void api().undoRemove(brand.id, undo.ids)
                  setUndo(null)
                }}
              >
                Undo
              </button>
            </>
          ) : (
            <span>{note}</span>
          )}
        </div>
      )}
    </div>
  )
}

interface DetailsProps {
  brandId: string
  items: MediaItem[]
  collections: string[]
  platforms: string[]
  onRemove: () => void
  onClose: () => void
}

function Details({ brandId, items, collections, platforms, onRemove, onClose }: DetailsProps): ReactNode {
  const one = items.length === 1 ? items[0] : null
  const ids = items.map((m) => m.id)
  const [name, setName] = useState(one?.name ?? '')
  const [tag, setTag] = useState('')
  const [platform, setPlatform] = useState(platforms[0] ?? '')
  const [postUrl, setPostUrl] = useState('')
  const allAgent = items.every((m) => m.agentAllowed)

  const rename = (): void => {
    if (one && name.trim() && name.trim() !== one.name) void api().edit(brandId, [one.id], { name: name.trim() })
    else if (one) setName(one.name)
  }

  const addTag = (): void => {
    const t = tag.trim().replace(/^#/, '')
    if (!t) return
    for (const m of items) {
      if (!m.tags.includes(t)) void api().edit(brandId, [m.id], { tags: [...m.tags, t] })
    }
    setTag('')
  }

  return (
    <aside className="media-details" aria-label="File details">
      <div className="media-details-head">
        <span className="muted small">{one ? 'File' : `${items.length} files`}</span>
        <span className="spacer" />
        <button className="icon-btn small" title="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      {one && (
        <div className="media-preview">
          {one.missing ? (
            <Thumb item={one} />
          ) : one.kind === 'video' ? (
            <video src={mediaUrl(brandId, one.id)} controls muted preload="metadata" />
          ) : one.kind === 'image' ? (
            <img src={mediaUrl(brandId, one.id)} alt="" draggable={false} />
          ) : one.kind === 'audio' ? (
            <audio src={mediaUrl(brandId, one.id)} controls preload="metadata" />
          ) : (
            <Thumb item={one} />
          )}
        </div>
      )}

      {one && (
        <input
          className="media-name-input"
          value={name}
          maxLength={200}
          aria-label="Name"
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setName(one.name)
          }}
        />
      )}

      {one && (
        <dl className="media-facts">
          <dt>Type</dt>
          <dd>{one.ext.toUpperCase() || 'File'}</dd>
          <dt>Size</dt>
          <dd>{formatSize(one.size)}</dd>
          {one.duration !== null && (
            <>
              <dt>Length</dt>
              <dd>{formatDuration(one.duration)}</dd>
            </>
          )}
          {resolution(one) && (
            <>
              <dt>Resolution</dt>
              <dd>{resolution(one)}</dd>
            </>
          )}
          <dt>Added</dt>
          <dd>{new Date(one.addedAt).toLocaleString()}</dd>
          <dt>Where</dt>
          <dd className="media-path" title={one.path}>
            {one.copied ? 'In TrendDeck' : one.path}
          </dd>
        </dl>
      )}

      {one?.missing && (
        <div className="media-warn">
          <span>This file moved or was deleted.</span>
          <button className="pill" onClick={() => void api().relink(brandId, one.id)}>
            Find it
          </button>
        </div>
      )}

      <label className="media-check">
        <input
          type="checkbox"
          checked={allAgent}
          onChange={(e) => void api().edit(brandId, ids, { agentAllowed: e.target.checked })}
        />
        Agents can use {one ? 'this' : 'these'}
      </label>
      <p className="muted small media-hint">Agents only see the name, type, size and length, never the file itself.</p>

      <h4>Tags</h4>
      <div className="chips media-chips">
        {[...new Set(items.flatMap((m) => m.tags))].map((t) => (
          <span key={t} className="chip">
            #{t}
            <button
              aria-label={`Remove tag ${t}`}
              onClick={() => {
                for (const m of items) {
                  if (m.tags.includes(t)) void api().edit(brandId, [m.id], { tags: m.tags.filter((x) => x !== t) })
                }
              }}
            >
              <CloseIcon />
            </button>
          </span>
        ))}
      </div>
      <form
        className="media-row-form"
        onSubmit={(e) => {
          e.preventDefault()
          addTag()
        }}
      >
        <input value={tag} maxLength={40} placeholder="Add a tag" onChange={(e) => setTag(e.target.value)} />
      </form>

      {collections.length > 0 && (
        <>
          <h4>Collections</h4>
          {collections.map((c) => {
            const all = items.every((m) => m.collections.includes(c))
            return (
              <label key={c} className="media-check">
                <input
                  type="checkbox"
                  checked={all}
                  onChange={() => {
                    for (const m of items) {
                      const next = all ? m.collections.filter((x) => x !== c) : [...new Set([...m.collections, c])]
                      void api().edit(brandId, [m.id], { collections: next })
                    }
                  }}
                />
                {c}
              </label>
            )
          })}
        </>
      )}

      {one && (
        <>
          <h4>Posted</h4>
          {one.posts.length === 0 ? (
            <p className="muted small">Not posted yet.</p>
          ) : (
            <ul className="media-posts">
              {one.posts.map((p) => (
                <li key={`${p.platform}-${p.at}`}>
                  <span className="media-post-name">
                    {p.url ? (
                      <a href={p.url} target="_blank" rel="noreferrer">
                        {p.platform}
                      </a>
                    ) : (
                      p.platform
                    )}
                  </span>
                  <span className="muted small">{new Date(p.at).toLocaleDateString()}</span>
                  <button
                    className="icon-btn small"
                    title="Remove"
                    onClick={() => void api().unmarkPosted(brandId, one.id, p.platform, p.at)}
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="media-row-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (!platform) return
              void api().markPosted(brandId, one.id, platform, postUrl.trim())
              setPostUrl('')
            }}
          >
            <Dropdown
              className="media-select"
              label="Posted on"
              value={platform}
              options={platforms.map((p) => ({ value: p, label: p }))}
              onChange={setPlatform}
            />
            <input value={postUrl} placeholder="Link (optional)" onChange={(e) => setPostUrl(e.target.value)} />
            <button className="pill" type="submit" disabled={!platform}>
              Mark posted
            </button>
          </form>
        </>
      )}

      <div className="media-actions">
        {one && !one.missing && (
          <button className="btn ghost" onClick={() => void api().reveal(brandId, one.id)}>
            Show in folder
          </button>
        )}
        {items.some((m) => !m.copied && !m.missing) && (
          <button
            className="btn ghost"
            title="Keeps working if the original moves"
            onClick={() => void api().copyIn(brandId, ids)}
          >
            Copy into TrendDeck
          </button>
        )}
        <button className="btn ghost media-remove" onClick={onRemove}>
          Remove from Media
        </button>
      </div>
    </aside>
  )
}
