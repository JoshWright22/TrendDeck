import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Brand, TrendItem, TrendSource } from '@shared/types'
import type {
  AgentConfig,
  AgentInfo,
  Attachment,
  ChatEvent,
  Decision,
  ModelOption,
  Thread,
  ThreadMessage,
  ThreadSummary
} from '@shared/chat'
import { CloseIcon, PlusIcon, SendIcon } from '../components/Icons'
import Markdown from './Markdown'
import { EmbedCard, type EmbedActions } from './Embeds'
import AgentSettings from './AgentSettings'
import SetupSteps from './SetupSteps'
import WorkLog from './WorkLog'
import UsagePopover from './UsagePopover'
import { RisingMark } from './Marks'
import { Dropdown, Menu } from './ui'
import { fileSize, onAttach, toAttachment } from './attachments'
import { chat, newId, when } from './api'
import './chat.css'

interface Props {
  brand: Brand
  editBrand: (fn: (b: Brand) => Brand) => void
  onOpenSite: (siteId: string, url?: string) => void
  // the narrow pane on the right of other pages
  compact?: boolean
  onClose?: () => void
  // extra buttons for the header, e.g. the chat pane toggle
  headerRight?: ReactNode
}

// a message typed while the agent was still answering, sent when it's done
interface Queued {
  id: string
  text: string
  agentId: string
  attachments: Attachment[]
}

// the chat each brand had open, kept while the app runs so leaving the page doesn't lose it
const lastOpen = new Map<string, string | null>()
// follow ups per thread, kept outside the view so switching chats doesn't drop them
const queues = new Map<string, Queued[]>()

const STARTERS = [
  'Give me 5 post ideas from my top trends',
  'Which trend should I jump on today, and why?',
  'Write an X post and a Reddit post about my best trend'
]

const SHORTCUTS = 'Ctrl+Shift+N new chat, Ctrl+L type, Esc stop, Alt+Up/Down switch chats'

function StopIcon(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  )
}

function ClipIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M9.5 4.5L5.2 8.8a1.2 1.2 0 0 0 1.7 1.7l4.6-4.6a2.5 2.5 0 0 0-3.5-3.5L3.4 7a3.7 3.7 0 0 0 5.3 5.3l3.6-3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

const cleanError = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

function applyEvent(t: Thread, ev: Exclude<ChatEvent, { type: 'threads' | 'done' }>): Thread {
  return {
    ...t,
    messages: t.messages.map((m): ThreadMessage => {
      if (m.id !== ev.messageId) return m
      if (ev.type === 'delta') {
        return ev.kind === 'thinking' ? { ...m, thinking: (m.thinking ?? '') + ev.text } : { ...m, text: m.text + ev.text }
      }
      if (ev.type === 'thinking-tokens') return { ...m, thinkingTokens: ev.tokens }
      const steps = m.steps ?? []
      const i = steps.findIndex((s) => s.id === ev.step.id)
      return { ...m, steps: i >= 0 ? steps.map((s, j) => (j === i ? ev.step : s)) : [...steps, ev.step] }
    })
  }
}

export default function ChatView({ brand, editBrand, onOpenSite, compact, onClose, headerRight }: Props): ReactNode {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [config, setConfig] = useState<AgentConfig>({ defaultAgentId: null, custom: [] })
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [thread, setThread] = useState<Thread | null>(null)
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [picked, setPicked] = useState<string | null>(null)
  // model picked before the chat exists, per agent
  const [newModels, setNewModels] = useState<Record<string, string>>({})
  const [modelLists, setModelLists] = useState<Record<string, ModelOption[]>>({})
  const [error, setError] = useState('')
  const [manage, setManage] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [trends, setTrends] = useState<Map<string, TrendItem>>(new Map())
  const [showThreads, setShowThreads] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Set<string> | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [queued, setQueued] = useState<Queued[]>([])
  const [dragging, setDragging] = useState(false)
  const listEnd = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const openRef = useRef<string | null>(null)
  openRef.current = openId

  const brandId = brand.id

  const loadAgents = useCallback(async (rescan = false) => {
    setScanning(true)
    try {
      const [list, cfg] = await Promise.all([chat().listAgents(rescan), chat().getAgentConfig()])
      setAgents(list)
      setConfig(cfg)
    } finally {
      setScanning(false)
    }
  }, [])

  const loadThreads = useCallback(async () => {
    setThreads(await chat().listThreads(brandId))
  }, [brandId])

  const loadThread = useCallback(
    async (id: string) => {
      const t = await chat().getThread(brandId, id)
      if (openRef.current === id) setThread(t)
    },
    [brandId]
  )

  useEffect(() => {
    void loadAgents()
  }, [loadAgents])

  useEffect(() => {
    const remembered = lastOpen.get(brandId)
    setOpenId(remembered ?? null)
    void chat()
      .listThreads(brandId)
      .then((list) => {
        setThreads(list)
        // first time round the side pane picks up the newest chat, the main view starts fresh
        const first = list.find((t) => !t.archived)
        if (remembered === undefined && compact && first) setOpenId(first.id)
      })
  }, [brandId, compact])

  useEffect(() => {
    lastOpen.set(brandId, openId)
  }, [brandId, openId])

  useEffect(() => {
    // each chat remembers its own agent, a pick only sticks to the chat it was made in
    setPicked(null)
    setEditing(null)
    setQueued(openId ? (queues.get(openId) ?? []) : [])
    if (openId) void loadThread(openId)
    else setThread(null)
  }, [openId, loadThread])

  const setQueue = useCallback((threadId: string, list: Queued[]) => {
    if (list.length) queues.set(threadId, list)
    else queues.delete(threadId)
    if (openRef.current === threadId) setQueued(list)
  }, [])

  // sends the next queued follow up once a reply finishes
  const drainQueue = useCallback(
    async (threadId: string) => {
      const list = queues.get(threadId) ?? []
      const next = list[0]
      if (!next) return
      setQueue(threadId, list.slice(1))
      try {
        await chat().send(brandId, threadId, next.text, next.agentId, { attachments: next.attachments })
        if (openRef.current === threadId) void loadThread(threadId)
      } catch (err) {
        setQueue(threadId, [next, ...(queues.get(threadId) ?? [])])
        if (openRef.current === threadId) setError(cleanError(err))
      }
    },
    [brandId, loadThread, setQueue]
  )

  useEffect(
    () =>
      chat().onEvent((ev) => {
        if (ev.brandId !== brandId) return
        if (ev.type === 'threads') {
          void loadThreads()
          return
        }
        if (ev.type === 'done') {
          // a stopped or failed reply holds the queue so you can look first
          if (ev.status === 'done') void drainQueue(ev.threadId)
          if (ev.threadId === openRef.current) void loadThread(ev.threadId)
          return
        }
        if (ev.threadId !== openRef.current) return
        setThread((t) => (t && t.id === ev.threadId ? applyEvent(t, ev) : t))
      }),
    [brandId, loadThreads, loadThread, drainQueue]
  )

  // files handed over from elsewhere in the app
  useEffect(
    () =>
      onAttach((list) => {
        setFiles((f) => [...f, ...list.filter((a) => !f.some((x) => x.id === a.id))].slice(0, 20))
        input.current?.focus()
      }),
    []
  )

  // search runs in the main process so it can look inside messages too
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      void chat()
        .searchThreads(brandId, q)
        .then((ids) => alive && setHits(new Set(ids)))
    }, 150)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, brandId, threads])

  // trend cards look themselves up in the cached feed, only fetched once a trend card shows up
  const wantsTrends = !!thread?.messages.some((m) => m.role === 'agent' && m.text.includes('"trend"'))
  useEffect(() => {
    if (!wantsTrends) return
    let alive = true
    void window.trenddeck.getTrends(brandId).then((feed) => {
      if (alive && feed) setTrends(new Map(feed.items.map((i) => [i.id, i])))
    })
    const off = window.trenddeck.onTrends((feed) => {
      if (feed.brandId === brandId) setTrends(new Map(feed.items.map((i) => [i.id, i])))
    })
    return () => {
      alive = false
      off()
    }
  }, [wantsTrends, brandId])

  const last = thread?.messages.at(-1)
  const lastSize = (last?.text.length ?? 0) + (last?.thinking?.length ?? 0) + (last?.steps?.length ?? 0)
  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: 'end' })
  }, [thread?.messages.length, lastSize, openId])

  const usable = useMemo(() => (agents ?? []).filter((a) => a.installed), [agents])
  const agentId =
    [picked, thread?.agentId, config.defaultAgentId].find((id) => id && usable.some((a) => a.id === id)) ??
    usable[0]?.id ??
    null
  const agent = usable.find((a) => a.id === agentId)
  const agentName = (id?: string): string => agents?.find((a) => a.id === id)?.name ?? 'Agent'
  const busy = !!thread?.messages.some((m) => m.status === 'streaming')

  const model = agentId ? ((thread ? thread.models?.[agentId] : newModels[agentId]) ?? '') : ''
  const modelOptions = useMemo(() => {
    const list = (agentId && modelLists[agentId]) || agent?.models || [{ id: '', label: 'Default' }]
    return list.some((m) => m.id === model) ? list : [...list, { id: model, label: model }]
  }, [agentId, agent, modelLists, model])

  const send = async (text = draft): Promise<void> => {
    const body = text.trim()
    if (!body || !agentId) return
    setError('')
    if (busy && thread) {
      // typed while the agent works, goes out when it's done
      setQueue(thread.id, [...(queues.get(thread.id) ?? []), { id: newId(), text: body, agentId, attachments: files }])
      setDraft('')
      setFiles([])
      return
    }
    const sending = files
    setDraft('')
    setFiles([])
    try {
      const res = await chat().send(brandId, openId, body, agentId, {
        attachments: sending,
        ...(thread ? {} : { model: newModels[agentId] ?? '' })
      })
      if (res.threadId !== openId) setOpenId(res.threadId)
      else void loadThread(res.threadId)
    } catch (err) {
      setDraft(body)
      setFiles(sending)
      setError(cleanError(err))
    }
  }

  const stop = (): void => {
    if (thread && busy) void chat().stop(brandId, thread.id)
  }

  const retry = async (): Promise<void> => {
    if (!thread || !agentId || busy) return
    setError('')
    try {
      await chat().retry(brandId, thread.id, agentId)
      void loadThread(thread.id)
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (!thread || !editing || !agentId || busy || !editing.text.trim()) return
    setError('')
    try {
      await chat().editAndResend(brandId, thread.id, editing.id, editing.text, agentId)
      setEditing(null)
      void loadThread(thread.id)
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const pickAgent = (id: string): void => {
    setPicked(id)
    void chat().setDefaultAgent(id).then(setConfig)
  }

  const pickModel = (id: string): void => {
    if (!agentId) return
    if (thread) {
      setThread({ ...thread, models: { ...thread.models, [agentId]: id } })
      void chat().setModel(brandId, thread.id, agentId, id)
    } else {
      setNewModels((m) => ({ ...m, [agentId]: id }))
    }
  }

  const loadModels = (): void => {
    if (!agentId || modelLists[agentId]) return
    const id = agentId
    void chat()
      .listModels(id)
      .then((list) => list.length && setModelLists((m) => ({ ...m, [id]: list })))
  }

  const remove = async (id: string): Promise<void> => {
    setConfirmDelete(null)
    queues.delete(id)
    await chat().deleteThread(brandId, id)
    if (openId === id) setOpenId(null)
    void loadThreads()
  }

  const rename = async (id: string, title: string): Promise<void> => {
    setRenaming(null)
    if (title.trim()) await chat().renameThread(brandId, id, title)
  }

  const addFiles = (list: FileList | null): void => {
    if (!list) return
    const added = Array.from(list).flatMap((f) => {
      const a = toAttachment({ id: newId(), name: f.name, type: f.type, size: f.size })
      return a ? [a] : []
    })
    setFiles((f) => [...f, ...added].slice(0, 20))
  }

  const visible = useMemo(
    () => threads.filter((t) => (hits ? hits.has(t.id) : t.archived === showArchived)),
    [threads, hits, showArchived]
  )
  const archivedCount = threads.filter((t) => t.archived).length

  // keyboard: new chat, focus the composer, stop, step through chats
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setOpenId(null)
        setTimeout(() => input.current?.focus(), 0)
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        input.current?.focus()
      } else if (e.key === 'Escape' && busy && !e.defaultPrevented && document.querySelector('.ui-pop') === null) {
        stop()
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const list = visible
        if (!list.length) return
        e.preventDefault()
        const i = list.findIndex((t) => t.id === openRef.current)
        const next = e.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)
        setOpenId(list[next].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const savedTitles = useMemo(() => new Set(brand.ideas.map((i) => i.title)), [brand.ideas])
  const baseActions = {
    brand,
    trends,
    savedTitles,
    onOpenSite,
    onSaveIdea: (title: string, url: string, source: TrendSource | 'manual') =>
      editBrand((b) =>
        b.ideas.some((i) => i.title === title || (url && i.url === url))
          ? b
          : { ...b, ideas: [{ id: newId(), title, url, source, savedAt: Date.now() }, ...b.ideas] }
      )
  }
  const embedFor = (m: ThreadMessage) => {
    const actions: EmbedActions = {
      ...baseActions,
      decision: (card) => m.decisions?.[card],
      // nothing can be approved while the reply is still coming in
      onDecide:
        m.status === 'streaming' || !thread
          ? null
          : (card: string, d: Decision) => {
              const threadId = thread.id
              setThread((t) =>
                t && t.id === threadId
                  ? {
                      ...t,
                      messages: t.messages.map((x) =>
                        x.id === m.id ? { ...x, decisions: { ...x.decisions, [card]: d } } : x
                      )
                    }
                  : t
              )
              void chat().decide(brandId, threadId, m.id, card, d)
            }
    }
    const embed = (raw: string, closed: boolean, key: string): ReactNode => (
      <EmbedCard key={key} card={key} raw={raw} closed={closed} actions={actions} />
    )
    return embed
  }

  const noAgents = agents !== null && usable.length === 0
  const lastAgentId = [...(thread?.messages ?? [])].reverse().find((m) => m.role === 'agent')?.id

  const threadList = (
    <div className="cx-threads-wrap">
      <input
        className="cx-search"
        type="search"
        placeholder="Search chats"
        aria-label="Search chats"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
      />
      <div className="cx-threads" role="list" aria-label="Chats">
        {visible.length === 0 && (
          <p className="cx-threads-empty">{query ? 'Nothing matches' : showArchived ? 'Nothing archived' : 'No chats yet'}</p>
        )}
        {visible.map((t) => (
          <div
            key={t.id}
            role="listitem"
            tabIndex={0}
            className={`cx-thread${t.id === openId ? ' active' : ''}`}
            onClick={() => {
              if (renaming === t.id) return
              setOpenId(t.id)
              setShowThreads(false)
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter') setOpenId(t.id)
              if (e.key === 'F2') setRenaming(t.id)
              if (e.key === 'Delete') setConfirmDelete(t.id)
            }}
          >
            {t.busy && <RisingMark className="cx-busy-mark" />}
            {renaming === t.id ? (
              <input
                className="cx-rename"
                defaultValue={t.title}
                aria-label="Chat name"
                autoFocus
                onFocus={(e) => e.target.select()}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => void rename(t.id, e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') void rename(t.id, e.currentTarget.value)
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : confirmDelete === t.id ? (
              <span className="cx-thread-confirm" onClick={(e) => e.stopPropagation()}>
                Delete it?
                <button className="pill danger" autoFocus onClick={() => void remove(t.id)}>
                  Delete
                </button>
                <button className="pill" onClick={() => setConfirmDelete(null)}>
                  Keep
                </button>
              </span>
            ) : (
              <>
                <span className="cx-thread-title">{t.title}</span>
                <span className="cx-thread-when">{when(t.updatedAt)}</span>
                <Menu
                  label="Chat options"
                  className="cx-thread-menu"
                  items={[
                    { label: 'Rename', shortcut: 'F2', onSelect: () => setRenaming(t.id) },
                    {
                      label: t.archived ? 'Unarchive' : 'Archive',
                      onSelect: () => {
                        void chat().archiveThread(brandId, t.id, !t.archived)
                        if (!t.archived && openId === t.id) setOpenId(null)
                      }
                    },
                    { label: 'Delete', shortcut: 'Del', danger: true, onSelect: () => setConfirmDelete(t.id) }
                  ]}
                />
              </>
            )}
          </div>
        ))}
      </div>
      {!query && (archivedCount > 0 || showArchived) && (
        <button className="cx-archived-toggle" onClick={() => setShowArchived((s) => !s)}>
          {showArchived ? 'Back to chats' : `Archived (${archivedCount})`}
        </button>
      )}
    </div>
  )

  const agentMessage = (m: ThreadMessage): ReactNode => (
    <div key={m.id} className={`cx-msg agent${m.status === 'streaming' ? ' streaming' : ''}`}>
      <div className="cx-who">
        <RisingMark className="cx-who-mark" />
        {agentName(m.agentId)}
        {m.model && <span className="muted"> {agents?.find((a) => a.id === m.agentId)?.models?.find((o) => o.id === m.model)?.label ?? m.model}</span>}
        {m.status === 'stopped' && <span className="muted"> stopped</span>}
      </div>
      <WorkLog m={m} />
      {m.text ? (
        <Markdown text={m.text} embed={embedFor(m)} />
      ) : m.status === 'streaming' && !m.steps?.length && !m.thinking && !m.thinkingTokens ? (
        <div className="cx-thinking" aria-label="Thinking">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      {m.status === 'error' && <p className="cx-error">{m.error || 'Something went wrong'}</p>}
      {m.id === lastAgentId && m.status !== 'streaming' && (
        <div className="cx-msg-tools">
          <button className="cx-tool" onClick={() => void retry()} disabled={!agentId}>
            Retry
          </button>
          {m.text && (
            <button className="cx-tool" onClick={() => void navigator.clipboard.writeText(m.text)}>
              Copy
            </button>
          )}
        </div>
      )}
    </div>
  )

  const userMessage = (m: ThreadMessage): ReactNode =>
    editing?.id === m.id ? (
      <div key={m.id} className="cx-msg user editing">
        <textarea
          className="cx-edit"
          value={editing.text}
          autoFocus
          aria-label="Edit message"
          onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void saveEdit()
            }
            if (e.key === 'Escape') {
              e.stopPropagation()
              setEditing(null)
            }
          }}
        />
        <div className="cx-msg-tools">
          <span className="muted small">Everything after this message gets redone</span>
          <span className="spacer" />
          <button className="pill" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <button className="pill teal" onClick={() => void saveEdit()} disabled={!editing.text.trim() || busy}>
            Send
          </button>
        </div>
      </div>
    ) : (
      <div key={m.id} className="cx-msg-user-wrap">
        <div className="cx-msg user">
          {m.text}
          {m.attachments?.length ? (
            <div className="cx-files in-msg">
              {m.attachments.map((f) => (
                <span key={f.id} className="cx-file">
                  {f.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {!busy && (
          <button className="cx-tool cx-edit-btn" onClick={() => setEditing({ id: m.id, text: m.text })}>
            Edit
          </button>
        )}
      </div>
    )

  return (
    <section className={`cx${compact ? ' compact' : ''}`} aria-label="Chat">
      {!compact && (
        <aside className="cx-side">
          <button className="cx-new" onClick={() => setOpenId(null)} title="New chat (Ctrl+Shift+N)">
            <PlusIcon />
            New chat
          </button>
          {threadList}
          <p className="cx-keys muted small">{SHORTCUTS}</p>
        </aside>
      )}

      <div className="cx-main">
        <header className="cx-head">
          {compact ? (
            <button
              className="cx-title-btn"
              onClick={() => setShowThreads((s) => !s)}
              aria-expanded={showThreads}
              title="Your chats"
            >
              <h3>{thread?.title ?? 'Chat'}</h3>
              <span className="muted small">{threads.filter((t) => !t.archived).length}</span>
            </button>
          ) : (
            <h2>{thread?.title ?? 'New chat'}</h2>
          )}
          <span className="spacer" />
          {compact && (
            <button className="icon-btn" title="New chat (Ctrl+Shift+N)" aria-label="New chat" onClick={() => setOpenId(null)}>
              <PlusIcon />
            </button>
          )}
          {headerRight}
          {onClose && (
            <button className="icon-btn" title="Hide chat" aria-label="Hide chat" onClick={onClose}>
              <CloseIcon />
            </button>
          )}
        </header>

        {compact && showThreads && <div className="cx-threads-pop">{threadList}</div>}

        <div className="cx-messages">
          <div className="cx-column">
            {thread && thread.messages.length > 0 ? (
              thread.messages.map((m) => (m.role === 'user' ? userMessage(m) : agentMessage(m)))
            ) : noAgents ? (
              <SetupSteps agents={agents ?? []} scanning={scanning} onRescan={() => void loadAgents(true)} onAdd={() => setManage(true)} />
            ) : (
              <div className="cx-empty">
                <p className="cx-hello">What are we posting for {brand.name}?</p>
                <p className="muted">
                  Your agent gets this brand's keywords, top trends and saved ideas. Never your logins or what's in your
                  tabs.
                </p>
                <div className="cx-starters">
                  {STARTERS.map((s) => (
                    <button key={s} className="cx-starter" disabled={!agentId} onClick={() => void send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div ref={listEnd} />
          </div>
        </div>

        <form
          className={`cx-composer${dragging ? ' dragging' : ''}`}
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault()
              setDragging(true)
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            addFiles(e.dataTransfer.files)
          }}
        >
          {error && <p className="cx-error">{error}</p>}
          {queued.length > 0 && (
            <ul className="cx-queue" aria-label="Queued messages">
              {queued.map((q) => (
                <li key={q.id}>
                  <span className="cx-queue-tag">Next</span>
                  <span className="cx-queue-text">{q.text}</span>
                  <button
                    type="button"
                    className="row-close"
                    aria-label="Remove from queue"
                    title="Remove from queue"
                    onClick={() =>
                      thread && setQueue(thread.id, (queues.get(thread.id) ?? []).filter((x) => x.id !== q.id))
                    }
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="cx-box">
            {files.length > 0 && (
              <div className="cx-files">
                {files.map((f) => (
                  <span key={f.id} className="cx-file" title={`${f.type || 'file'}, ${fileSize(f.size)}`}>
                    {f.name}
                    <span className="muted">{fileSize(f.size)}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => setFiles((list) => list.filter((x) => x.id !== f.id))}
                    >
                      <CloseIcon />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={input}
              value={draft}
              rows={compact ? 2 : 3}
              placeholder={
                !agentId
                  ? 'Set up an agent to start chatting'
                  : busy
                    ? 'Type a follow up, it goes out when this reply is done'
                    : `Message ${agentName(agentId)}`
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault()
                  addFiles(e.clipboardData.files)
                }
              }}
            />
            <div className="cx-box-row">
              <Dropdown
                className="cx-agent"
                label="Agent"
                title="Agent for this chat"
                up
                value={agentId ?? ''}
                options={agentId ? usable.map((a) => ({ value: a.id, label: a.name })) : [{ value: '', label: 'No agent' }]}
                onChange={pickAgent}
                actions={[{ label: 'Add or edit agents...', onSelect: () => setManage(true) }]}
              />
              {agentId && (
                <Dropdown
                  className="cx-model"
                  label="Model"
                  title="Model for this chat, you can switch any time"
                  up
                  value={model}
                  options={modelOptions.map((o) => ({ value: o.id, label: o.label }))}
                  onChange={pickModel}
                  onOpen={loadModels}
                />
              )}
              <button
                type="button"
                className="ui-menu-btn"
                title="Attach files"
                aria-label="Attach files"
                onClick={() => filePicker.current?.click()}
              >
                <ClipIcon />
              </button>
              <input
                ref={filePicker}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
              <span className="spacer" />
              <UsagePopover agents={agents ?? []} thread={thread} />
              {busy && thread && (
                <button type="button" className="cx-send stop" title="Stop (Esc)" aria-label="Stop" onClick={stop}>
                  <StopIcon />
                </button>
              )}
              {(!busy || draft.trim()) && (
                <button
                  type="submit"
                  className="cx-send"
                  title={busy ? 'Queue it' : 'Send'}
                  aria-label={busy ? 'Queue message' : 'Send'}
                  disabled={!draft.trim() || !agentId}
                >
                  <SendIcon />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>

      {manage && (
        <AgentSettings
          agents={agents ?? []}
          config={config}
          scanning={scanning}
          onRescan={() => void loadAgents(true)}
          onChange={(cfg) => {
            setConfig(cfg)
            setModelLists({})
            void loadAgents()
          }}
          onClose={() => setManage(false)}
        />
      )}
    </section>
  )
}
