import { useEffect, useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import type { ThreadSummary } from '@shared/chat'
import { GENERAL_PROJECT_ID, PROJECT_STATUSES, projectIdForThread, type Project, type ProjectStatus } from '@shared/workspace'
import { Menu } from '../chat/ui'
import { chat, newId, when } from '../chat/api'
import { PlusIcon, SettingsIcon } from '../components/Icons'
import JobsStrip from './JobsStrip'
import { isUnread, usePendingState, waitingThreads } from '../chat/pending'
import { useLoginRequests } from '../chat/useLoginRequests'

interface Props {
  brands: Brand[]
  brand: Brand | null
  threads: ThreadSummary[]
  projectId: string
  threadId: string | null
  onSelectBrand: (id: string) => void
  onAddBrand: () => void
  onEditBrand: (id: string) => void
  editBrand: (fn: (b: Brand) => Brand) => void
  onOpenProject: (projectId: string) => void
  onOpenThread: (threadId: string) => void
  // a fresh chat in this project
  onNewThread: (projectId: string) => void
  onOpenPipeline: () => void
  onSettings: () => void
}

const STATUS_LABEL: Record<ProjectStatus, string> = {
  idle: 'Idle',
  running: 'Agent working',
  waiting: 'Needs you',
  done: 'Done'
}

export function StatusDot({ status }: { status: ProjectStatus }): ReactNode {
  return <span className={`dot ${status}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />
}

const mod = navigator.platform.startsWith('Mac') ? 'Cmd' : 'Ctrl'

function Chevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg className={`tree-caret${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// an inline text box that saves on enter or blur, esc puts it back
function RenameBox({ value, label, onDone }: { value: string; label: string; onDone: (v: string | null) => void }): ReactNode {
  return (
    <input
      className="tree-rename"
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

// brands, their projects, and each project's chats. t3code style: plain rows, small dots
export default function Sidebar(props: Props): ReactNode {
  const { brand, threads, projectId, threadId } = props
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [width, setWidth] = useState(() => {
    try { return Math.max(280, Math.min(480, Number(localStorage.getItem('trenddeck.sidebar-width')) || 330)) } catch { return 330 }
  })
  useEffect(() => () => document.body.classList.remove('resizing'), [])

  const projects = brand?.projects ?? []
  const brandId = brand?.id ?? ''
  const pend = usePendingState()
  // chats with an approval or a question waiting
  const loginRequests = useLoginRequests(brandId)
  const waiting = new Set([...waitingThreads(pend, brandId), ...loginRequests.flatMap((request) => request.threadId ? [request.threadId] : [])])
  const working = threads.filter((thread) => thread.busy && !thread.archived)
  const needsYou = threads.filter((thread) => waiting.has(thread.id) && !thread.archived)
  const isOpen = (id: string): boolean => open[id] ?? id === projectId

  const threadsOf = (p: Project): ThreadSummary[] =>
    threads.filter((t) => projectIdForThread(projects, t.id) === p.id).sort((a, b) => b.updatedAt - a.updatedAt)

  // the dot: needs you while any of its chats waits on an answer, working while one is mid
  // reply, otherwise what was set on it
  const statusOf = (p: Project): ProjectStatus => {
    const list = threadsOf(p)
    if (list.some((t) => waiting.has(t.id))) return 'waiting'
    return list.some((t) => t.busy) ? 'running' : p.status
  }

  const editProject = (id: string, fn: (p: Project) => Project): void =>
    props.editBrand((b) => ({ ...b, projects: b.projects.map((p) => (p.id === id ? fn(p) : p)) }))

  const addProject = (name: string | null): void => {
    setNaming(false)
    if (!name || !brand) return
    const p: Project = {
      id: newId(),
      name: name.slice(0, 80),
      createdAt: Date.now(),
      stageId: brand.pipeline[0]?.id ?? '',
      status: 'idle',
      threadIds: []
    }
    props.editBrand((b) => ({ ...b, projects: [...b.projects, p] }))
    props.onOpenProject(p.id)
    setOpen((o) => ({ ...o, [p.id]: true }))
  }

  // its chats fall back into General, nothing is deleted with it
  const removeProject = (id: string): void => {
    props.editBrand((b) => ({ ...b, projects: b.projects.filter((p) => p.id !== id) }))
    if (id === projectId) props.onOpenProject(GENERAL_PROJECT_ID)
  }

  const moveThread = (tid: string, to: string): void =>
    props.editBrand((b) => ({
      ...b,
      projects: b.projects.map((p) => ({
        ...p,
        threadIds: p.id === to && to !== GENERAL_PROJECT_ID ? [...p.threadIds.filter((x) => x !== tid), tid] : p.threadIds.filter((x) => x !== tid)
      }))
    }))

  const deleteThread = async (tid: string): Promise<void> => {
    setConfirmDelete(null)
    await chat().deleteThread(brandId, tid)
    props.editBrand((b) => ({ ...b, projects: b.projects.map((p) => ({ ...p, threadIds: p.threadIds.filter((x) => x !== tid) })) }))
    if (tid === threadId) props.onNewThread(projectId)
  }

  const threadRow = (t: ThreadSummary): ReactNode => (
    <div
      key={t.id}
      role="treeitem"
      tabIndex={0}
      aria-selected={t.id === threadId}
      className={`tree-row thread${t.id === threadId ? ' active' : ''}${t.archived ? ' archived' : ''}`}
      onClick={() => renaming !== t.id && props.onOpenThread(t.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') props.onOpenThread(t.id)
        if (e.key === 'F2') setRenaming(t.id)
        if (e.key === 'Delete') setConfirmDelete(t.id)
      }}
    >
      {waiting.has(t.id) ? (
        <StatusDot status="waiting" />
      ) : t.busy ? (
        <StatusDot status="running" />
      ) : t.id !== threadId && isUnread(pend, brandId, t.id) ? (
        <span className="dot unread" title="New reply" aria-label="New reply" />
      ) : (
        <span className="dot-space" />
      )}
      {renaming === t.id ? (
        <RenameBox
          value={t.title}
          label="Chat name"
          onDone={(v) => {
            setRenaming(null)
            if (v) void chat().renameThread(brandId, t.id, v)
          }}
        />
      ) : confirmDelete === t.id ? (
        <span className="tree-confirm" onClick={(e) => e.stopPropagation()}>
          Delete it?
          <button className="pill danger" autoFocus onClick={() => void deleteThread(t.id)}>
            Delete
          </button>
          <button className="pill" onClick={() => setConfirmDelete(null)}>
            Keep
          </button>
        </span>
      ) : (
        <>
          <span className="tree-chat-info">
            <span className="tree-chat-title">{t.title}</span>
            <span className="tree-chat-details">
              <span className={waiting.has(t.id) ? 'tree-needs-you' : t.busy ? 'tree-working' : ''}>{waiting.has(t.id) ? 'Needs you' : t.busy ? 'Working' : isUnread(pend, brandId, t.id) ? 'New reply' : 'Idle'}</span>
              {t.agentName && <span>{t.agentName}</span>}
              <time dateTime={new Date(t.updatedAt).toISOString()}>{when(t.updatedAt)}</time>
            </span>
            <span className="tree-chat-preview" title={t.activity || t.preview || t.model || ''}>{t.activity || t.preview || t.model || 'Ready for your next message'}</span>
          </span>
          <Menu
            label="Chat options"
            className="tree-menu"
            items={[
              { label: 'Rename', shortcut: 'F2', onSelect: () => setRenaming(t.id) },
              ...projects
                .filter((p) => p.id !== projectIdForThread(projects, t.id))
                .map((p) => ({ label: `Move to ${p.name}`, onSelect: () => moveThread(t.id, p.id) })),
              {
                label: t.archived ? 'Unarchive' : 'Archive',
                onSelect: () => {
                  void chat().archiveThread(brandId, t.id, !t.archived)
                  if (!t.archived && t.id === threadId) props.onNewThread(projectId)
                }
              },
              { label: 'Delete', shortcut: 'Del', danger: true, onSelect: () => setConfirmDelete(t.id) }
            ]}
          />
        </>
      )}
    </div>
  )

  const projectNode = (p: Project): ReactNode => {
    const expanded = isOpen(p.id)
    const list = threadsOf(p)
    const archived = list.filter((t) => t.archived)
    const shown = showArchived === p.id ? archived : list.filter((t) => !t.archived)
    const general = p.id === GENERAL_PROJECT_ID
    return (
      <div key={p.id} role="group" className="tree-project">
        <div
          role="treeitem"
          tabIndex={0}
          aria-expanded={expanded}
          aria-selected={p.id === projectId}
          className={`tree-row project${p.id === projectId ? ' active' : ''}`}
          onClick={() => {
            if (renaming === p.id) return
            if (p.id === projectId) setOpen((o) => ({ ...o, [p.id]: !expanded }))
            else {
              props.onOpenProject(p.id)
              setOpen((o) => ({ ...o, [p.id]: true }))
            }
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter') props.onOpenProject(p.id)
            if (e.key === 'ArrowRight') setOpen((o) => ({ ...o, [p.id]: true }))
            if (e.key === 'ArrowLeft') setOpen((o) => ({ ...o, [p.id]: false }))
            if (e.key === 'F2' && !general) setRenaming(p.id)
          }}
        >
          <Chevron open={expanded} />
          {renaming === p.id ? (
            <RenameBox
              value={p.name}
              label="Project name"
              onDone={(v) => {
                setRenaming(null)
                if (v) editProject(p.id, (x) => ({ ...x, name: v.slice(0, 80) }))
              }}
            />
          ) : (
            <span className="tree-name">{p.name}</span>
          )}
          <StatusDot status={statusOf(p)} />
          <Menu
            label="Project options"
            className="tree-menu"
            items={[
              { label: 'New chat', onSelect: () => props.onNewThread(p.id) },
              ...(general ? [] : [{ label: 'Rename', shortcut: 'F2', onSelect: () => setRenaming(p.id) }]),
              ...PROJECT_STATUSES.filter((s) => s !== 'running' && s !== p.status).map((s) => ({
                label: `Mark ${STATUS_LABEL[s].toLowerCase()}`,
                onSelect: () => editProject(p.id, (x) => ({ ...x, status: s }))
              })),
              ...(general
                ? []
                : [{ label: 'Delete project', danger: true, onSelect: () => removeProject(p.id) }])
            ]}
          />
        </div>
        {expanded && (
          <div role="group" className="tree-children">
            {shown.map(threadRow)}
            {shown.length === 0 && <p className="tree-empty">{showArchived === p.id ? 'Nothing archived' : 'No chats yet'}</p>}
            <div className="tree-row-actions">
              <button className="tree-add" onClick={() => props.onNewThread(p.id)}>
                <PlusIcon />
                New chat
              </button>
              {(archived.length > 0 || showArchived === p.id) && (
                <button className="tree-add" onClick={() => setShowArchived((s) => (s === p.id ? null : p.id))}>
                  {showArchived === p.id ? 'Back' : `Archived ${archived.length}`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <aside className="sb" style={{ width }} aria-label="Brands and projects">
      <div className="sb-overview">
        <strong>{brand?.name ?? 'Your workspace'}</strong>
        <span>{working.length} working / {needsYou.length} need you</span>
      </div>
      {(working.length > 0 || needsYou.length > 0) && <div className="sb-attention">
        {([{ title: 'Needs you', list: needsYou }, { title: 'Working', list: working.filter((thread) => !waiting.has(thread.id)) }]).map((group) => group.list.length > 0 && (
          <section key={group.title} aria-label={`${group.title} chats`}>
            <h3>{group.title} <span>{group.list.length}</span></h3>
            {group.list.map((thread) => <button key={thread.id} className="sb-attention-chat" onClick={() => props.onOpenThread(thread.id)}>
              <StatusDot status={waiting.has(thread.id) ? 'waiting' : 'running'} />
              <span><strong>{thread.title}</strong><small>{thread.activity || projects.find((project) => project.id === projectIdForThread(projects, thread.id))?.name || 'General'}</small></span>
            </button>)}
          </section>
        ))}
      </div>}
      <div className="sb-scroll" role="tree">
        {props.brands.map((b, i) => {
          const active = b.id === brand?.id
          return (
            <section key={b.id} className={`tree-brand${active ? ' active' : ''}`} aria-label={b.name}>
              <div
                className="tree-row brand"
                role="treeitem"
                tabIndex={0}
                aria-expanded={active}
                title={i < 9 ? `${b.name} (${mod}+${i + 1})` : b.name}
                onClick={() => !active && props.onSelectBrand(b.id)}
                onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && props.onSelectBrand(b.id)}
              >
                <Chevron open={active} />
                <span className="tree-name">{b.name}</span>
                <Menu
                  label="Brand options"
                  className="tree-menu"
                  items={[{ label: 'Edit brand and keywords', onSelect: () => props.onEditBrand(b.id) }]}
                />
              </div>
              {active && (
                <div className="tree-children">
                  <button className="tree-row pipeline" onClick={props.onOpenPipeline}>
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                      <circle cx="2.5" cy="6" r="1.6" fill="currentColor" />
                      <circle cx="9.5" cy="6" r="1.6" fill="none" stroke="currentColor" />
                      <path d="M4.2 6h3.6" stroke="currentColor" />
                    </svg>
                    <span className="tree-name">Ask agent to set up workflow</span>
                  </button>
                  {projects.map(projectNode)}
                  {naming ? (
                    <div className="tree-row">
                      <RenameBox value="" label="Project name" onDone={addProject} />
                    </div>
                  ) : (
                    <button className="tree-add" onClick={() => setNaming(true)}>
                      <PlusIcon />
                      New project
                    </button>
                  )}
                </div>
              )}
            </section>
          )
        })}
        <button className="tree-add brand-add" onClick={props.onAddBrand}>
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
          const next = Math.max(280, Math.min(480, width + (event.key === 'ArrowRight' ? 20 : -20)))
          setWidth(next)
          try { localStorage.setItem('trenddeck.sidebar-width', String(next)) } catch {}
        }}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); document.body.classList.add('resizing') }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(280, Math.min(480, event.clientX))) }}
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
