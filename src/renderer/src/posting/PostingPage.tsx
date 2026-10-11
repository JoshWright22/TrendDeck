import { useState, type ReactNode } from 'react'
import { PLATFORM_NAMES, type BrandPosting, type PostItem, type PostingState } from '@shared/posting'
import PageHeader from '../components/PageHeader'
import { PlusIcon } from '../components/Icons'
import type { PageProps } from '../pages/types'
import Composer from './Composer'
import Setup from './Setup'
import { RisingMark, StatusChip, usePosting, when } from './bits'
import './posting.css'

type Tab = 'queue' | 'log' | 'setup'

const UP_NEXT = ['review', 'running', 'queued', 'failed', 'closed', 'missed', 'scheduled', 'draft']

function blankSettings(): BrandPosting {
  return {
    autoPost: false,
    modes: { youtube: 'tabs', tiktok: 'tabs', instagram: 'tabs', x: 'tabs', reddit: 'tabs' },
    keys: { youtube: [], tiktok: [], instagram: [], x: [], reddit: [] }
  }
}

export default function PostingPage({ brand, chatOpen, onToggleChat }: PageProps): ReactNode {
  const state = usePosting()
  const [tab, setTab] = useState<Tab>('queue')
  // undefined is closed, null is a new post
  const [editing, setEditing] = useState<PostItem | null | undefined>(undefined)
  const settings = state?.brands[brand.id] ?? blankSettings()

  return (
    <div className="page posting">
      <PageHeader title="Posting" chatOpen={chatOpen} onToggleChat={onToggleChat}>
        <div className="posting-tabs" role="tablist">
          {(['queue', 'log', 'setup'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`filter-chip${tab === t ? ' on' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'queue' ? 'Queue' : t === 'log' ? 'Log' : 'Setup'}
            </button>
          ))}
        </div>
        <button className="pill teal new-post" onClick={() => setEditing(null)}>
          <PlusIcon />
          New post
        </button>
      </PageHeader>
      <div className="scroll">
        {!state ? null : tab === 'queue' ? (
          <Queue state={state} brandId={brand.id} onReview={setEditing} />
        ) : tab === 'log' ? (
          <Log state={state} brandId={brand.id} />
        ) : (
          <Setup brand={brand} settings={settings} />
        )}
      </div>
      {editing !== undefined && (
        <Composer
          key={editing?.id ?? 'new'}
          brand={brand}
          settings={settings}
          post={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  )
}

function Queue(props: {
  state: PostingState
  brandId: string
  onReview: (p: PostItem) => void
}): ReactNode {
  const mine = props.state.posts.filter((p) => p.brandId === props.brandId)
  const next = mine
    .filter((p) => p.status !== 'posted')
    .sort(
      (a, b) =>
        UP_NEXT.indexOf(a.status) - UP_NEXT.indexOf(b.status) ||
        (a.scheduledAt ?? a.updatedAt) - (b.scheduledAt ?? b.updatedAt)
    )
  const done = mine
    .filter((p) => p.status === 'posted')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 24)

  if (!mine.length) {
    return (
      <p className="feed-empty">
        Nothing queued. Hit New post, pick your sites and TrendDeck fills in each one in your logged
        in tabs.
      </p>
    )
  }
  return (
    <>
      <h3 className="posting-head">Up next</h3>
      {next.length ? (
        <div className="post-grid">
          {next.map((p, i) => (
            <PostCard key={p.id} post={p} index={i} onReview={() => props.onReview(p)} />
          ))}
        </div>
      ) : (
        <p className="feed-empty">All caught up.</p>
      )}
      {done.length > 0 && (
        <>
          <h3 className="posting-head">Posted</h3>
          <div className="post-grid">
            {done.map((p, i) => (
              <PostCard key={p.id} post={p} index={i} onReview={() => props.onReview(p)} />
            ))}
          </div>
        </>
      )}
    </>
  )
}

function PostCard({ post, index, onReview }: { post: PostItem; index: number; onReview: () => void }): ReactNode {
  const api = window.trenddeck.posting
  const busy = post.status === 'running' || post.status === 'queued'
  const hot = post.status === 'failed' || post.status === 'missed'
  const canRun = !busy && post.status !== 'review' && post.status !== 'posted'
  return (
    <article className={`post-card ${post.status}`} style={{ animationDelay: `${index * 30}ms` }}>
      <RisingMark className={`mark tl${hot ? ' hot' : ''}`} />
      <RisingMark className={`mark br${hot ? ' hot' : ''}`} />
      <header>
        <span className="post-platform">{PLATFORM_NAMES[post.platform]}</span>
        <StatusChip status={post.status} />
      </header>
      <div className="post-text">
        {post.title && <strong>{post.title}</strong>}
        {post.body && <span>{post.body}</span>}
        {!post.title && !post.body && <span className="muted">No text</span>}
      </div>
      <div className="post-meta">
        {post.platform === 'reddit' && post.subreddit && <span>r/{post.subreddit}</span>}
        {post.mediaId && <span>has media</span>}
        {post.byAgent && <span>from an agent</span>}
        <span>
          {post.status === 'scheduled' && post.scheduledAt
            ? `Goes out ${when(post.scheduledAt)}`
            : post.status === 'posted'
              ? `Posted ${when(post.updatedAt)}`
              : `Updated ${when(post.updatedAt)}`}
        </span>
        {post.note && <span className={`post-note${hot ? ' hot' : ''}`}>{post.note}</span>}
      </div>
      <div className="post-actions">
        {post.status === 'review' && (
          <button className="pill teal" onClick={() => void api.focus(post.id)}>
            Show window
          </button>
        )}
        {canRun && (
          <button className="pill teal" onClick={() => void api.run(post.id)}>
            {post.status === 'failed' || post.status === 'closed' ? 'Try again' : 'Post now'}
          </button>
        )}
        {(post.status === 'review' || post.status === 'closed' || post.status === 'failed') && (
          <button className="pill" onClick={() => void api.markPosted(post.id)}>
            It went out
          </button>
        )}
        {post.url && (
          <a className="pill" href={post.url} target="_blank" rel="noreferrer">
            Open
          </a>
        )}
        <span className="spacer" />
        {!busy && post.status !== 'posted' && (
          <button className="btn ghost small-btn" onClick={onReview}>
            Edit
          </button>
        )}
        <button
          className="btn ghost small-btn"
          disabled={post.status === 'running'}
          onClick={() => void api.remove(post.id)}
        >
          Remove
        </button>
      </div>
    </article>
  )
}

function Log({ state, brandId }: { state: PostingState; brandId: string }): ReactNode {
  const rows = state.log.filter((l) => l.brandId === brandId)
  if (!rows.length) return <p className="feed-empty">Every post, failure and self-check shows up here.</p>
  return (
    <>
      <div className="log-head">
        <span className="muted small">{rows.length === 1 ? '1 entry' : `${rows.length} entries`}, newest first</span>
        <span className="spacer" />
        <button className="btn ghost small-btn" onClick={() => void window.trenddeck.posting.clearLog(brandId)}>
          Clear log
        </button>
      </div>
      <table className="post-log">
        <tbody>
          {rows.map((l) => (
            <tr key={l.id}>
              <td className="log-time">{when(l.at)}</td>
              <td>{PLATFORM_NAMES[l.platform]}</td>
              <td className="muted">{l.mode === 'api' ? 'API' : 'Tab'}</td>
              <td>
                <span className={`log-result ${l.result}`}>{l.result}</span>
              </td>
              <td className="log-msg">{l.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
