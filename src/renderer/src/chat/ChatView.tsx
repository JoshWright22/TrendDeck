import { createPortal } from 'react-dom'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
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
import QuestionDeck, { questionsIn, readAnswers } from './Questions'
import UsagePopover from './UsagePopover'
import { RisingMark } from './Marks'
import { Dropdown, Menu } from './ui'
import { fileSize, fromMedia, onAttach } from './attachments'
import MediaPicker from '../pages/media/MediaPicker'
import { chat, newId, when } from './api'
import { onDraft } from '../pages/voice/chatDraft'
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
  {
    title: "Video ideas from today's trends",
    hint: 'Five ideas with a hook each',
    prompt: "Give me 5 video ideas from today's top trends, with a hook and why it should work for each."
  },
  {
    title: 'Outline an idea',
    hint: 'Hook, beats and a call to action',
    prompt:
      "Outline one of my saved ideas into a short video: hook, beats and a call to action. Ask me which idea if it's not obvious."
  },
  {
    title: 'Titles and thumbnail text',
    hint: 'Ten pairs for your best trend',
    prompt: 'Write 10 titles with matching thumbnail text for my best trend right now. Keep the thumbnail text under 5 words.'
  },
  {
    title: 'Posts for every platform',
    hint: 'One trend, a draft per site',
    prompt: 'Turn my best trend into a post for each platform I use, as draft cards, each written the way that platform likes it.'
  }
]

// anything esc should close before it stops a reply
const OVERLAYS = '.modal-backdrop, .ui-pop, [aria-modal="true"]'

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

type EmbedFn = (raw: string, closed: boolean, key: string) => ReactNode

// a reply's text only redraws when that message or what its cards show changes, so a long
// chat doesn't redo every old reply on each streamed word
const ReplyText = memo(function ReplyText({
  m,
  make
}: {
  m: ThreadMessage
  // deps is only here so memo sees when cards need a redraw
  deps: object
  make: RefObject<(m: ThreadMessage) => EmbedFn>
}): ReactNode {
  return <Markdown text={m.text} embed={make.current(m)} />
})

export default function ChatView({ brand, editBrand, onOpenSite, compact, onClose, headerRight }: Props): ReactNode {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [config, setConfig] = useState<AgentConfig>({ defaultAgentId: null, custom: [] })
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [sideSlot, setSideSlot] = useState<HTMLElement | null>(null)
  useEffect(() => setSideSlot(compact ? null : document.getElementById('side-threads')), [compact])
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
  const [picking, setPicking] = useState(false)
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

  // a message drafted somewhere else, like "learn my voice", lands in the box unsent
  useEffect(() => onDraft(setDraft), [])

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
  // follow the reply only while you're at the bottom, scrolling up to read stops it
  const scroller = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const onScroll = (): void => {
    const el = scroller.current
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  }
  const jumpDown = (): void => {
    setFollowing(true)
    listEnd.current?.scrollIntoView({ block: 'end' })
  }
  useEffect(() => {
    if (following) listEnd.current?.scrollIntoView({ block: 'end' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.messages.length, lastSize])
  useEffect(() => jumpDown(), [openId])

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
    const list = (agentId && modelLists[agentId]) || agent?.models || [{ id: '', label: 'Default model' }]
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

  const attach = (list: Attachment[]): void =>
    setFiles((f) => [...f, ...list.filter((a) => !f.some((x) => x.id === a.id))].slice(0, 20))

  // dropped or pasted files go into the brand's media library first, then get attached from there
  const addFiles = async (list: FileList | null): Promise<void> => {
    if (!list?.length) return
    const media = window.trenddeck.media
    const paths = Array.from(list).map((f) => media.pathForFile(f)).filter(Boolean)
    if (!paths.length) {
      setError("That isn't a file on your computer. Save it first, then drop it in.")
      return
    }
    const { ids } = await media.addPaths(brandId, paths)
    const all = await media.list(brandId, {})
    const found = all.filter((m) => ids.includes(m.id))
    const allowed = found.filter((m) => m.agentAllowed && !m.missing)
    if (allowed.length < paths.length) {
      setError(
        found.length > allowed.length
          ? 'Some of those are in Media with agents switched off, so they were left out.'
          : "Some of those couldn't be added to Media."
      )
    }
    attach(allowed.map(fromMedia))
  }

  const visible = useMemo(
    () => threads.filter((t) => (hits ? hits.has(t.id) : t.archived === showArchived)),
    [threads, hits, showArchived]
  )
  const archivedCount = threads.filter((t) => t.archived).length

  // esc closes whatever is open first. checked in the capture phase because a modal
  // closes itself on the same key and is already gone by the time onKey runs
  const overlayOnEsc = useRef(false)
  useEffect(() => {
    const onDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') overlayOnEsc.current = document.querySelector(OVERLAYS) !== null
    }
    window.addEventListener('keydown', onDown, true)
    return () => window.removeEventListener('keydown', onDown, true)
  }, [])

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
      } else if (e.key === 'Escape') {
        if (e.defaultPrevented || overlayOnEsc.current || manage) return
        if (showThreads) setShowThreads(false)
        else if (confirmDelete) setConfirmDelete(null)
        else if (busy) stop()
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
  const embedFor = (m: ThreadMessage): EmbedFn => {
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

  const makeEmbed = useRef(embedFor)
  makeEmbed.current = embedFor
  const embedDeps = useMemo(() => ({}), [trends, savedTitles, brand, onOpenSite, editBrand, thread?.id, busy])

  const noAgents = agents !== null && usable.length === 0
  // nothing sent yet: the welcome cards with the composer right under them
  const home = !noAgents && !thread?.messages.length
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
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            e.preventDefault()
            setQuery('')
          }
        }}
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

  const questionsFor = (m: ThreadMessage, i: number): ReactNode => {
    const qs = questionsIn(m.text)
    if (!qs.length || !thread) return null
    const after = thread.messages[i + 1]
    const answered = after?.role === 'user' ? readAnswers(qs, after.text) : null
    // questions you typed past stay open, picking one later sends it as a new message
    const open = !answered && m.status !== 'streaming' && !busy && !!agentId
    return (
      <div className="cx-hand cx-q-hand">
        <QuestionDeck
          key={`${m.id}-${qs.length}`}
          questions={qs}
          answered={answered}
          onAnswer={open ? (text) => void send(text) : null}
        />
      </div>
    )
  }

  const agentMessage = (m: ThreadMessage, i: number): ReactNode => (
    <div key={m.id} className={`cx-msg agent${m.status === 'streaming' ? ' streaming' : ''}`}>
      <div className="cx-who">
        <RisingMark className="cx-who-mark" />
        {agentName(m.agentId)}
        {m.model && <span className="muted"> {agents?.find((a) => a.id === m.agentId)?.models?.find((o) => o.id === m.model)?.label ?? m.model}</span>}
        {m.status === 'stopped' && <span className="muted"> stopped</span>}
      </div>
      <WorkLog m={m} />
      {m.text ? (
        <ReplyText m={m} deps={embedDeps} make={makeEmbed} />
      ) : m.status === 'streaming' && !m.steps?.length && !m.thinking && !m.thinkingTokens ? (
        <div className="cx-thinking" aria-label="Thinking">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      {questionsFor(m, i)}
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
      {/* the full chat keeps its list of chats in the sidebar */}
      {!compact &&
        sideSlot &&
        createPortal(
          <>
            <button className="cx-new" onClick={() => setOpenId(null)} title={`New chat. ${SHORTCUTS}`}>
              <PlusIcon />
              New chat
            </button>
            {threadList}
          </>,
          sideSlot
        )}

      <div className={`cx-main${home ? ' home' : ''}`}>
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

        <div className="cx-messages" ref={scroller} onScroll={onScroll}>
          <div className="cx-column">
            {thread && thread.messages.length > 0 ? (
              thread.messages.map((m, i) => (m.role === 'user' ? userMessage(m) : agentMessage(m, i)))
            ) : noAgents ? (
              <SetupSteps agents={agents ?? []} scanning={scanning} onRescan={() => void loadAgents(true)} onAdd={() => setManage(true)} />
            ) : (
              <div className="cx-empty">
                <RisingMark className="cx-home-mark" />
                <p className="cx-home-brand">{brand.name}</p>
                <p className="cx-hello">Deal yourself in. What are we making today?</p>
                <p className="muted">
                  Your agent gets this brand's voice, keywords, top trends and saved ideas. Never your logins or what's in your
                  tabs.
                </p>
                <div className="cx-starters">
                  {STARTERS.map((s) => (
                    <button
                      key={s.title}
                      className="cx-starter"
                      disabled={!agentId}
                      title={s.prompt}
                      onClick={() => void send(s.prompt)}
                    >
                      <RisingMark className="cx-starter-mark" />
                      <span className="cx-starter-title">{s.title}</span>
                      <span className="cx-starter-hint">{s.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div ref={listEnd} />
          </div>
        </div>
        {!following && !home && (
          <button type="button" className="cx-jump" onClick={jumpDown}>
            Jump to latest
          </button>
        )}

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
            void addFiles(e.dataTransfer.files)
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
                  void addFiles(e.clipboardData.files)
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
                title="Attach from Media"
                aria-label="Attach from Media"
                onClick={() => setPicking(true)}
              >
                <ClipIcon />
              </button>
              <span className="spacer" />
              <UsagePopover agents={agents ?? []} thread={thread} />
              {busy && thread && (
                <button type="button" className="cx-send stop" title="Stop (Esc)" aria-label="Stop" onClick={stop}>
                  <StopIcon />
                </button>
              )}
              {/* one button in one spot: stop while a reply runs, send otherwise. enter still queues */}
              {!busy && (
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

      {picking && (
        <MediaPicker
          brandId={brandId}
          agentOnly
          onClose={() => setPicking(false)}
          onPick={(items) => {
            setPicking(false)
            attach(items.map(fromMedia))
          }}
        />
      )}

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
