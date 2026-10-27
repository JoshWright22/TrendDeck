import { useEffect, useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import type { ThreadSummary } from '@shared/chat'
import { chatProjectIds, videoProjects, withChatProjects, type ProjectStatus } from '@shared/workspace'
import { Menu, type MenuItem } from '../chat/ui'
import { chat } from '../chat/api'
import { PlusIcon, SettingsIcon } from '../components/Icons'
import JobsStrip from './JobsStrip'
import { isUnread, usePendingState, waitingThreads } from '../chat/pending'
import { useLoginRequests } from '../chat/useLoginRequests'

interface Props {
  brands: Brand[]
  activeBrandId: string | null
  threadsByBrand: Record<string, ThreadSummary[]>
  // the open chat in the active brand, null for a new one
  threadId: string | null
  view: 'chat' | 'videos'
  onOpenThread: (brandId: string, threadId: string) => void
  // a fresh chat in that brand
  onNewThread: (brandId: string) => void
  onOpenVideos: (brandId: string) => void
  onAddBrand: () => void
  onEditBrand: (id: string) => void
  editBrand: (brandId: string, fn: (b: Brand) => Brand) => void
  onSettings: () => void
}

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  idle: 'Idle',
  running: 'Agent working',
  waiting: 'Needs you',
  done: 'Done'
}

const mod = navigator.platform.startsWith('Mac') ? 'Cmd' : 'Ctrl'
// chats a brand shows before "Show more"
const SHOWN = 8

// t3code style: 5m, 3h, 2d, then the date
export function ago(at: number, now = Date.now()): string {
  const min = Math.floor((now - at) / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  if (min < 60 * 24) return `${Math.floor(min / 60)}h`
  if (min < 60 * 24 * 7) return `${Math.floor(min / 60 / 24)}d`
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function Spinner(): ReactNode {
  return (
    <svg className="sb-spinner" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg className={`sb-caret${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// an inline text box that saves on enter or blur, esc puts it back
export function RenameBox({ value, label, onDone }: { value: string; label: string; onDone: (v: string | null) => void }): ReactNode {
  return (
    <input
      className="sb-rename"
      defaultValue={value}
      aria-label={label}
      autoFocus
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.target.value.trim() || null)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') onDone(null)
      }}
    />
  )
}

const COLLAPSED_KEY = 'trenddeck.sidebar-collapsed'

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

// brands are the groups, each with one flat list of its chats, newest first. a chat sees the
// whole brand, the videos it's linked to show under its title
export default function Sidebar(props: Props): ReactNode {
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const [width, setWidth] = useState(() => {
    try { return Math.max(260, Math.min(480, Number(localStorage.getItem('trenddeck.sidebar-width')) || 300)) } catch { return 300 }
  })
  useEffect(() => () => document.body.classList.remove('resizing'), [])

  const toggle = (id: string): void =>
    setCollapsed((c) => {
      const next = { ...c, [id]: !c[id] }
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)) } catch {}
      return next
    })

  return (
    <aside className="sb" style={{ width }} aria-label="Brands and chats">
      <div className="sb-scroll" role="tree" aria-label="Chats">
        {props.brands.map((b, i) => (
          <BrandGroup
            key={b.id}
            brand={b}
            index={i}
            props={props}
            threads={props.threadsByBrand[b.id] ?? []}
            open={!collapsed[b.id]}
            onToggle={() => toggle(b.id)}
          />
        ))}
        <button className="sb-add-brand" onClick={props.onAddBrand}>
          <PlusIcon />
          Add brand
        </button>
      </div>

      <JobsStrip />

      <button className="sb-foot" onClick={props.onSettings}>
        <SettingsIcon />
        Settings
      </button>
      <div className="sb-resize" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const next = Math.max(260, Math.min(480, width + (event.key === 'ArrowRight' ? 20 : -20)))
          setWidth(next)
          try { localStorage.setItem('trenddeck.sidebar-width', String(next)) } catch {}
        }}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); document.body.classList.add('resizing') }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(260, Math.min(480, event.clientX))) }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId)
          document.body.classList.remove('resizing')
          try { localStorage.setItem('trenddeck.sidebar-width', String(width)) } catch {}
        }}
        onPointerCancel={() => document.body.classList.remove('resizing')}
      />
    </aside>
  )
}

interface GroupProps {
  brand: Brand
  index: number
  props: Props
  threads: ThreadSummary[]
  open: boolean
  onToggle: () => void
}

function BrandGroup({ brand, index, props, threads, open, onToggle }: GroupProps): ReactNode {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const pend = usePendingState()
  const logins = useLoginRequests(brand.id)
  const active = brand.id === props.activeBrandId
  const openId = active && props.view === 'chat' ? props.threadId : null
  // chats with an approval, a question or a login waiting on the user
  const waiting = new Set([...waitingThreads(pend, brand.id), ...logins.flatMap((r) => (r.threadId ? [r.threadId] : []))])
  const videos = videoProjects(brand.projects)
  const archived = threads.filter((t) => t.archived)
  const list = showArchived ? archived : threads.filter((t) => !t.archived)
  const shown = showAll || showArchived ? list : list.slice(0, SHOWN)
  const linkedNames = (threadId: string): string =>
    chatProjectIds(brand, threadId)
      .map((id) => videos.find((p) => p.id === id)?.name)
      .filter(Boolean)
      .join(', ')

  const setLinks = (threadId: string, ids: string[], mode: 'add' | 'remove'): void =>
    props.editBrand(brand.id, (b) => ({ ...b, chatProjects: withChatProjects(b.chatProjects, b.projects, threadId, ids, mode) }))

  const deleteThread = async (tid: string): Promise<void> => {
    setConfirmDelete(null)
    await chat().deleteThread(brand.id, tid)
    props.editBrand(brand.id, (b) => ({ ...b, chatProjects: withChatProjects(b.chatProjects, b.projects, tid, [], 'set') }))
    if (tid === openId) props.onNewThread(brand.id)
  }

  const chatMenu = (t: ThreadSummary): MenuItem[] => {
    const linked = chatProjectIds(brand, t.id)
    return [
      { label: 'Rename', shortcut: 'F2', onSelect: () => setRenaming(t.id) },
      ...videos.map((p, i) =>
        linked.includes(p.id)
          ? { label: `Unlink ${p.name}`, divider: i === 0, onSelect: () => setLinks(t.id, [p.id], 'remove') }
          : { label: `Link to ${p.name}`, divider: i === 0, onSelect: () => setLinks(t.id, [p.id], 'add') }
      ),
      {
        label: t.archived ? 'Unarchive' : 'Archive',
        divider: true,
        onSelect: () => {
          void chat().archiveThread(brand.id, t.id, !t.archived)
          if (!t.archived && t.id === openId) props.onNewThread(brand.id)
        }
      },
      { label: 'Delete', shortcut: 'Del', danger: true, onSelect: () => setConfirmDelete(t.id) }
    ]
  }

  const chatRow = (t: ThreadSummary): ReactNode => {
    const needsYou = waiting.has(t.id)
    const unread = !needsYou && !t.busy && t.id !== openId && isUnread(pend, brand.id, t.id)
    const projects = linkedNames(t.id)
    return (
      <div
        key={t.id}
        role="treeitem"
        tabIndex={0}
        aria-selected={t.id === openId}
        aria-current={t.id === openId ? 'page' : undefined}
        className={`sb-chat${t.id === openId ? ' active' : ''}${unread ? ' unread' : ''}${t.archived ? ' archived' : ''}`}
        onClick={() => renaming !== t.id && confirmDelete !== t.id && props.onOpenThread(brand.id, t.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter') props.onOpenThread(brand.id, t.id)
          if (e.key === 'F2') setRenaming(t.id)
          if (e.key === 'Delete') setConfirmDelete(t.id)
        }}
      >
        {renaming === t.id ? (
          <RenameBox
            value={t.title}
            label="Chat name"
            onDone={(v) => {
              setRenaming(null)
              if (v) void chat().renameThread(brand.id, t.id, v)
            }}
          />
        ) : confirmDelete === t.id ? (
          <span className="sb-confirm" onClick={(e) => e.stopPropagation()}>
            Delete this chat?
            <button className="pill danger" autoFocus onClick={() => void deleteThread(t.id)}>
              Delete
            </button>
            <button className="pill" onClick={() => setConfirmDelete(null)}>
              Keep
            </button>
          </span>
        ) : (
          <>
            <span className="sb-chat-text">
              <span className="sb-chat-title" title={t.title}>{t.title}</span>
              {projects && <span className="sb-chat-projects" title={projects}>{projects}</span>}
            </span>
            <span className="sb-chat-state">
              {needsYou ? (
                <span className="sb-needs-you">Needs you</span>
              ) : t.busy ? (
                <span className="sb-working" title={t.activity || undefined}>
                  <Spinner />
                  Working
                </span>
              ) : unread ? (
                <span className="sb-unread" aria-label="New reply">New</span>
              ) : (
                <time dateTime={new Date(t.updatedAt).toISOString()} title={new Date(t.updatedAt).toLocaleString()}>
                  {ago(t.updatedAt)}
                </time>
              )}
            </span>
            <Menu label="Chat options" className="sb-menu" items={chatMenu(t)} />
          </>
        )}
      </div>
    )
  }

  return (
    <section className={`sb-brand${active ? ' active' : ''}`} aria-label={brand.name}>
      <div className="sb-brand-head">
        <button
          className="sb-brand-name"
          role="treeitem"
          aria-expanded={open}
          title={index < 9 ? `${brand.name} (${mod}+${index + 1})` : brand.name}
          onClick={onToggle}
        >
          <Chevron open={open} />
          <span>{brand.name}</span>
        </button>
        <button className="sb-icon" title={`New chat in ${brand.name} (${mod}+Shift+N)`} aria-label={`New chat in ${brand.name}`} onClick={() => props.onNewThread(brand.id)}>
          <PlusIcon />
        </button>
        <Menu
          label="Brand options"
          className="sb-menu"
          items={[
            { label: 'New chat', onSelect: () => props.onNewThread(brand.id) },
            { label: 'Videos', onSelect: () => props.onOpenVideos(brand.id) },
            { label: 'Edit brand and keywords', divider: true, onSelect: () => props.onEditBrand(brand.id) }
          ]}
        />
      </div>
      {open && (
        <div role="group" className="sb-group">
          <button
            className={`sb-videos${active && props.view === 'videos' ? ' active' : ''}`}
            aria-current={active && props.view === 'videos' ? 'page' : undefined}
            onClick={() => props.onOpenVideos(brand.id)}
          >
            <span>Videos</span>
            <span className="sb-count">{videos.length}</span>
          </button>
          {shown.map(chatRow)}
          {list.length === 0 && <p className="sb-empty">{showArchived ? 'Nothing archived' : 'No chats yet'}</p>}
          <div className="sb-more">
            {!showArchived && list.length > SHOWN && (
              <button onClick={() => setShowAll((s) => !s)}>{showAll ? 'Show less' : `Show ${list.length - SHOWN} more`}</button>
            )}
            {(archived.length > 0 || showArchived) && (
              <button onClick={() => setShowArchived((s) => !s)}>{showArchived ? 'Back to chats' : `Archived (${archived.length})`}</button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
