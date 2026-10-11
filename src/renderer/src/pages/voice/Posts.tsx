import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IMPORT_PLATFORMS,
  mergePosts,
  parseFile,
  performance,
  PLATFORM_NAMES,
  shortNum,
  splitText,
  VOICE_PLATFORMS,
  type FilePost,
  type ImportPlatform,
  type VoiceImportResult,
  type VoicePlatform,
  type VoicePost
} from '@shared/voice'
import { CloseIcon, PlusIcon, TrashIcon } from '../../components/Icons'

interface Props {
  posts: VoicePost[]
  onChange: (fn: (posts: VoicePost[]) => VoicePost[]) => void
  onImport: (platforms: ImportPlatform[]) => Promise<VoiceImportResult[]>
}

const newId = (): string => crypto.randomUUID()
const PAGE = 100

function toPost(f: FilePost, source: VoicePost['source']): VoicePost {
  return { ...f, id: newId(), starred: false, tags: [], addedAt: Date.now(), source }
}

function day(at: number | null): string {
  return at ? new Date(at).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : 'date unknown'
}

function PostRow(props: {
  post: VoicePost
  onEdit: (fn: (p: VoicePost) => VoicePost) => void
  onDelete: () => void
}): ReactNode {
  const { post, onEdit, onDelete } = props
  const [open, setOpen] = useState(false)
  const [tag, setTag] = useState('')
  const addTag = (): void => {
    const t = tag.trim().toLowerCase().slice(0, 40)
    if (t && !post.tags.includes(t)) onEdit((p) => ({ ...p, tags: [...p.tags, t] }))
    setTag('')
  }
  return (
    <li className={`v-post${post.starred ? ' starred' : ''}`}>
      <div className="v-post-meta">
        <span className={`v-plat ${post.platform}`}>{PLATFORM_NAMES[post.platform]}</span>
        <span className="muted small">{day(post.postedAt)}</span>
        {post.views !== null && <span className="muted small num">{shortNum(post.views)} views</span>}
        {post.likes !== null && <span className="muted small num">{shortNum(post.likes)} likes</span>}
        <span className="spacer" />
        <button
          className={`icon-btn small v-star${post.starred ? ' on' : ''}`}
          title={post.starred ? 'Unstar' : 'Star, the agent sees starred posts first'}
          aria-pressed={post.starred}
          onClick={() => onEdit((p) => ({ ...p, starred: !p.starred }))}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"
              fill={post.starred ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button className="icon-btn small" title="Delete" aria-label="Delete post" onClick={onDelete}>
          <TrashIcon />
        </button>
      </div>
      <p
        className={`v-post-text${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        title={open ? undefined : 'Click to show all'}
      >
        {post.text}
      </p>
      <div className="v-post-foot">
        {post.tags.map((t) => (
          <span key={t} className="chip">
            {t}
            <button
              aria-label={`Remove tag ${t}`}
              onClick={() => onEdit((p) => ({ ...p, tags: p.tags.filter((x) => x !== t) }))}
            >
              <CloseIcon />
            </button>
          </span>
        ))}
        <input
          className="v-tag-input"
          value={tag}
          placeholder="+ tag"
          onChange={(e) => setTag(e.target.value)}
          onBlur={() => tag.trim() && addTag()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addTag()
          }}
        />
        {post.url && (
          <a className="link small v-post-link" href={post.url} target="_blank" rel="noreferrer">
            open
          </a>
        )}
      </div>
    </li>
  )
}

export default function Posts({ posts, onChange, onImport }: Props): ReactNode {
  const [draft, setDraft] = useState('')
  const [platform, setPlatform] = useState<VoicePlatform>('x')
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [pick, setPick] = useState<ImportPlatform[]>([...IMPORT_PLATFORMS])
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<VoiceImportResult[] | null>(null)
  const [filter, setFilter] = useState<VoicePlatform | 'all'>('all')
  const [query, setQuery] = useState('')
  const [starredOnly, setStarredOnly] = useState(false)
  const [sort, setSort] = useState<'new' | 'best'>('new')
  const [shown, setShown] = useState(PAGE)
  const fileRef = useRef<HTMLInputElement>(null)

  const add = (fresh: VoicePost[], what: string): void => {
    const m = mergePosts(posts, fresh)
    onChange(() => m.posts)
    setNote({ text: `${what}: ${m.added} new, ${fresh.length - m.added} already here` })
  }

  const paste = (): void => {
    const chunks = /\n\s*-{3,}\s*\n/.test(draft) ? splitText(draft) : [draft.trim()]
    const fresh = chunks.filter(Boolean).map((text) =>
      toPost({ platform, postedAt: null, text, url: '', views: null, likes: null }, 'paste')
    )
    if (!fresh.length) return
    add(fresh, 'Pasted')
    setDraft('')
  }

  const readFile = async (file: File): Promise<void> => {
    if (file.size > 20 * 1024 * 1024) {
      setNote({ text: 'That file is over 20 MB', bad: true })
      return
    }
    try {
      const parsed = parseFile(file.name, await file.text(), platform)
      if (!parsed.length) {
        setNote({ text: `No posts found in ${file.name}`, bad: true })
        return
      }
      add(parsed.map((f) => toPost(f, 'file')), file.name)
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : String(err), bad: true })
    }
  }

  const runImport = async (): Promise<void> => {
    setBusy(true)
    setResults(null)
    setNote(null)
    try {
      setResults(await onImport(pick))
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : String(err), bad: true })
    } finally {
      setBusy(false)
    }
  }

  const perf = useMemo(() => performance(posts), [posts])
  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = posts.filter(
      (p) =>
        (filter === 'all' || p.platform === filter) &&
        (!starredOnly || p.starred) &&
        (!q || p.text.toLowerCase().includes(q) || p.tags.some((t) => t.includes(q)))
    )
    return sort === 'best'
      ? out.sort((a, b) => (perf.get(b.id) ?? -1) - (perf.get(a.id) ?? -1))
      : out.sort((a, b) => (b.postedAt ?? b.addedAt) - (a.postedAt ?? a.addedAt))
  }, [posts, filter, query, starredOnly, sort, perf])

  const edit = (id: string, fn: (p: VoicePost) => VoicePost): void =>
    onChange((all) => all.map((p) => (p.id === id ? fn(p) : p)))

  return (
    <div className="v-posts">
      <section className="v-card">
        <h3>Add posts</h3>
        <textarea
          className="v-paste"
          rows={4}
          value={draft}
          placeholder="Paste a post you wrote. Put a line of --- between posts to add a few at once."
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="v-row">
          <label className="muted small">
            Site{' '}
            <select value={platform} onChange={(e) => setPlatform(e.target.value as VoicePlatform)}>
              {VOICE_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_NAMES[p]}
                </option>
              ))}
            </select>
          </label>
          <button className="pill teal" disabled={!draft.trim()} onClick={paste}>
            <PlusIcon />
            Add
          </button>
          <button className="pill" onClick={() => fileRef.current?.click()} title="txt, csv or json">
            Import a file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.json,.js"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void readFile(f)
              e.target.value = ''
            }}
          />
        </div>
        <p className="muted small">
          Files: txt splits on blank lines, csv and json need a text column. Views, likes, dates and a site column are
          picked up if they're there. An X archive tweets.js works too.
        </p>
      </section>

      <section className="v-card">
        <h3>Import from my accounts</h3>
        <p className="muted small">
          Reads your own recent posts from this brand's logged in tabs. Only runs when you press the button, takes about
          10 seconds a site.
        </p>
        <div className="v-row">
          {IMPORT_PLATFORMS.map((p) => (
            <button
              key={p}
              className={`filter-chip${pick.includes(p) ? ' on' : ''}`}
              aria-pressed={pick.includes(p)}
              onClick={() => setPick(pick.includes(p) ? pick.filter((x) => x !== p) : [...pick, p])}
            >
              {PLATFORM_NAMES[p]}
            </button>
          ))}
          <button className="pill teal" disabled={busy || !pick.length} onClick={() => void runImport()}>
            {busy ? 'Reading...' : 'Import'}
          </button>
        </div>
        {results && (
          <ul className="v-results">
            {results.map((r) => (
              <li key={r.platform} className={r.error ? 'bad' : ''}>
                {PLATFORM_NAMES[r.platform]}:{' '}
                {r.error ? r.error : `found ${r.found}, ${r.added} new`}
              </li>
            ))}
          </ul>
        )}
      </section>

      {note && <p className={`v-note${note.bad ? ' bad' : ''}`}>{note.text}</p>}

      <div className="filters">
        <select value={filter} onChange={(e) => setFilter(e.target.value as VoicePlatform | 'all')}>
          <option value="all">All sites ({posts.length})</option>
          {VOICE_PLATFORMS.map((p) => {
            const n = posts.filter((x) => x.platform === p).length
            return n ? (
              <option key={p} value={p}>
                {PLATFORM_NAMES[p]} ({n})
              </option>
            ) : null
          })}
        </select>
        <button
          className={`filter-chip${starredOnly ? ' on' : ''}`}
          aria-pressed={starredOnly}
          onClick={() => setStarredOnly(!starredOnly)}
        >
          Starred
        </button>
        <select value={sort} onChange={(e) => setSort(e.target.value as 'new' | 'best')}>
          <option value="new">Newest</option>
          <option value="best">Best performing</option>
        </select>
        <input
          className="v-search"
          value={query}
          placeholder="Search posts and tags"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {list.length === 0 ? (
        <p className="feed-empty">
          {posts.length ? 'Nothing matches.' : 'No posts yet. Paste a few you liked or import them.'}
        </p>
      ) : (
        <ul className="v-post-list">
          {list.slice(0, shown).map((p) => (
            <PostRow
              key={p.id}
              post={p}
              onEdit={(fn) => edit(p.id, fn)}
              onDelete={() => onChange((all) => all.filter((x) => x.id !== p.id))}
            />
          ))}
        </ul>
      )}
      {list.length > shown && (
        <button className="btn ghost v-more" onClick={() => setShown(shown + PAGE)}>
          Show more ({list.length - shown} left)
        </button>
      )}
    </div>
  )
}
