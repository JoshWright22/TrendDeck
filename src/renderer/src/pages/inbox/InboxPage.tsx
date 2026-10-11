import { useMemo, useState, type ReactNode } from 'react'
import { Dropdown } from '../../chat/ui'
import { hostOf } from '@shared/types'
import {
  blockKey,
  INBOX_SITES,
  type BrandInbox,
  type InboxComment,
  type InboxSite,
  type RefreshResult
} from '@shared/inbox'
import PageHeader from '../../components/PageHeader'
import type { PageProps } from '../types'
import { HEALTH_LABEL, HealthDot, useInbox } from './useInbox'

type Tab = 'comments' | 'accounts' | 'spam'

const SITE_NAMES: Record<InboxSite, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  x: 'X',
  reddit: 'Reddit'
}

function ago(at: number): string {
  if (!at) return ''
  const m = Math.round((Date.now() - at) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.round(m / 60)}h ago`
  return new Date(at).toLocaleDateString()
}

// hidden by the blocked list or a keyword
function isHidden(inbox: BrandInbox, c: InboxComment): boolean {
  if (inbox.blocked.includes(blockKey(c))) return true
  const text = c.text.toLowerCase()
  return inbox.keywords.some((k) => text.includes(k.toLowerCase()))
}

export default function InboxPage({ brand, chatOpen, onToggleChat }: PageProps): ReactNode {
  const inbox = useInbox(brand.id)
  const [tab, setTab] = useState<Tab>('comments')
  const [busy, setBusy] = useState<'' | 'check' | 'refresh'>('')
  const [results, setResults] = useState<RefreshResult[]>([])

  const unread = inbox ? inbox.comments.filter((c) => !c.read && !isHidden(inbox, c)).length : 0

  const check = async (): Promise<void> => {
    setBusy('check')
    try {
      await window.trenddeckInbox.checkHealth(brand.id)
    } finally {
      setBusy('')
    }
  }
  const refresh = async (): Promise<void> => {
    setBusy('refresh')
    try {
      setResults(await window.trenddeckInbox.refresh(brand.id))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="page inbox">
      <PageHeader title="Inbox" chatOpen={chatOpen} onToggleChat={onToggleChat}>
        <div className="inbox-tabs" role="tablist">
          {(['comments', 'accounts', 'spam'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`filter-chip${tab === t ? ' on' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'comments' ? `Comments${unread ? ` (${unread})` : ''}` : t === 'accounts' ? 'Accounts' : 'Spam'}
            </button>
          ))}
        </div>
      </PageHeader>
      <div className="scroll">
        {!inbox ? null : tab === 'comments' ? (
          <Comments brandId={brand.id} inbox={inbox} busy={busy === 'refresh'} onRefresh={refresh} results={results} />
        ) : tab === 'accounts' ? (
          <Accounts inbox={inbox} sites={brand.sites} busy={busy === 'check'} onCheck={check} />
        ) : (
          <Spam brandId={brand.id} inbox={inbox} />
        )}
      </div>
    </div>
  )
}

function Accounts(props: {
  inbox: BrandInbox
  sites: PageProps['brand']['sites']
  busy: boolean
  onCheck: () => void
}): ReactNode {
  const { inbox, sites } = props
  return (
    <>
      <div className="inbox-bar">
        <button className="pill teal" disabled={props.busy} onClick={props.onCheck}>
          {props.busy ? 'Checking' : 'Check'}
        </button>
        <span className="inbox-note">
          Read from this brand&apos;s own session. A site also updates when its tab loads.
        </span>
      </div>
      {sites.length === 0 && <p className="feed-empty">No sites yet. Add one in the sidebar.</p>}
      <div className="accounts">
        {sites.map((s) => {
          const h = inbox.health[s.id]
          return (
            <div key={s.id} className="account">
              <HealthDot state={h?.state} />
              <div>
                {s.name}
                <small>
                  {HEALTH_LABEL[h?.state ?? 'unknown']} · {hostOf(s.url)}
                  {h?.checkedAt ? ` · ${ago(h.checkedAt)}` : ''}
                </small>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

function Comments(props: {
  brandId: string
  inbox: BrandInbox
  busy: boolean
  onRefresh: () => void
  results: RefreshResult[]
}): ReactNode {
  const { inbox, brandId } = props
  const [site, setSite] = useState<InboxSite | ''>('')
  const [account, setAccount] = useState('')
  const [onlyUnread, setOnlyUnread] = useState(false)
  const [replying, setReplying] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')

  const accounts = useMemo(() => [...new Set(inbox.comments.map((c) => c.account))].filter(Boolean), [inbox])
  const visible = inbox.comments.filter(
    (c) =>
      !isHidden(inbox, c) &&
      (!site || c.site === site) &&
      (!account || c.account === account) &&
      (!onlyUnread || !c.read)
  )
  const hiddenCount = inbox.comments.filter((c) => isHidden(inbox, c)).length
  const api = window.trenddeckInbox

  const sendReply = async (c: InboxComment): Promise<void> => {
    const r = await api.reply(brandId, c.id, draft)
    setNote(r.message)
    if (r.ok) {
      setReplying(null)
      setDraft('')
      void api.markRead(brandId, [c.id], true)
    }
  }

  const problems = props.results.filter((r) => !r.ok || r.message)

  return (
    <>
      <div className="inbox-bar">
        <button className="pill teal" disabled={props.busy} onClick={props.onRefresh}>
          {props.busy ? 'Refreshing' : 'Refresh'}
        </button>
        <Dropdown<InboxSite | ''>
          label="Site"
          value={site}
          options={[{ value: '', label: 'All sites' }, ...INBOX_SITES.map((s) => ({ value: s, label: SITE_NAMES[s] }))]}
          onChange={setSite}
        />
        <Dropdown
          label="Account"
          value={account}
          options={[{ value: '', label: 'All accounts' }, ...accounts.map((a) => ({ value: a, label: a }))]}
          onChange={setAccount}
        />
        <button className={`filter-chip${onlyUnread ? ' on' : ''}`} onClick={() => setOnlyUnread(!onlyUnread)}>
          Unread
        </button>
        <button
          className="btn ghost"
          disabled={visible.every((c) => c.read)}
          onClick={() =>
            void api.markRead(
              brandId,
              visible.map((c) => c.id),
              true
            )
          }
        >
          Mark all read
        </button>
        {hiddenCount > 0 && <span className="inbox-note">{hiddenCount} hidden by spam rules</span>}
        {inbox.refreshedAt > 0 && <span className="inbox-note">Refreshed {ago(inbox.refreshedAt)}</span>}
      </div>
      {problems.length > 0 && (
        <p className="inbox-note">{problems.map((r) => `${SITE_NAMES[r.site]}: ${r.message}`).join(' · ')}</p>
      )}
      {note && <p className="inbox-note">{note}</p>}
      {visible.length === 0 && (
        <p className="feed-empty">
          {inbox.comments.length === 0
            ? 'No comments yet. Press Refresh to pull them from your logged in tabs.'
            : 'Nothing matches these filters.'}
        </p>
      )}
      <div className="inbox-list">
        {visible.map((c) => (
          <div key={c.id} className={`inbox-item${c.read ? '' : ' unread'}`}>
            <div className="inbox-meta">
              <b>{c.author}</b>
              <span>{SITE_NAMES[c.site]}</span>
              {c.account && <span>on {c.account}</span>}
              {c.postTitle && <span>· {c.postTitle}</span>}
              <span>{ago(c.at)}</span>
            </div>
            <p className="inbox-text">{c.text}</p>
            <div className="inbox-actions">
              <button className="btn ghost" onClick={() => void api.markRead(brandId, [c.id], !c.read)}>
                {c.read ? 'Mark unread' : 'Mark read'}
              </button>
              <button
                className="btn ghost"
                disabled={!c.url.startsWith('http')}
                onClick={() => {
                  // the main window turns any link into a site tab on this brand's session
                  window.open(c.url)
                  void api.markRead(brandId, [c.id], true)
                }}
              >
                Open in tab
              </button>
              <button className="btn ghost" onClick={() => setReplying(replying === c.id ? null : c.id)}>
                Reply
              </button>
              <button
                className="btn ghost"
                title="Hide everything from this person in the inbox"
                onClick={() => void api.setBlocked(brandId, [...inbox.blocked, blockKey(c)])}
              >
                Hide commenter
              </button>
              <button
                className="btn ghost"
                disabled={!c.authorUrl.startsWith('http')}
                title={`Opens their profile on ${SITE_NAMES[c.site]} so you can block or report them there`}
                onClick={() => void api.openBlock(brandId, c.id)}
              >
                Block on {SITE_NAMES[c.site]}
              </button>
            </div>
            {replying === c.id && (
              <div className="inbox-reply">
                <textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Your reply" />
                <button className="pill teal" disabled={!draft.trim()} onClick={() => void sendReply(c)}>
                  Type it in
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

function ChipList(props: { items: string[]; label: (s: string) => string; onRemove: (s: string) => void }): ReactNode {
  if (props.items.length === 0) return <p className="inbox-note">None yet.</p>
  return (
    <div className="inbox-chips">
      {props.items.map((s) => (
        <button key={s} className="filter-chip" title="Remove" onClick={() => props.onRemove(s)}>
          {props.label(s)} ×
        </button>
      ))}
    </div>
  )
}

function Spam({ brandId, inbox }: { brandId: string; inbox: BrandInbox }): ReactNode {
  const [word, setWord] = useState('')
  const api = window.trenddeckInbox
  const addWord = (): void => {
    const w = word.trim()
    if (!w) return
    void api.setKeywords(brandId, [...inbox.keywords, w])
    setWord('')
  }
  const label = (key: string): string => {
    const i = key.indexOf(':')
    const site = key.slice(0, i) as InboxSite
    return `${key.slice(i + 1)} (${SITE_NAMES[site] ?? site})`
  }
  return (
    <>
      <h3 className="posting-head">Hidden commenters</h3>
      <p className="inbox-note">Hidden everywhere in this brand&apos;s inbox. Use Block on a comment to block them on the site too.</p>
      <ChipList
        items={inbox.blocked}
        label={label}
        onRemove={(s) =>
          void api.setBlocked(
            brandId,
            inbox.blocked.filter((b) => b !== s)
          )
        }
      />
      <h3 className="posting-head">Keyword filters</h3>
      <p className="inbox-note">Comments with any of these words are hidden.</p>
      <div className="inbox-add">
        <input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addWord()}
          placeholder="e.g. giveaway"
        />
        <button className="pill teal" disabled={!word.trim()} onClick={addWord}>
          Add
        </button>
      </div>
      <ChipList
        items={inbox.keywords}
        label={(s) => s}
        onRemove={(s) =>
          void api.setKeywords(
            brandId,
            inbox.keywords.filter((k) => k !== s)
          )
        }
      />
    </>
  )
}
