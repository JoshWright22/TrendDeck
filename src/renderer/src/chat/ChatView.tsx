import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Brand, TrendItem, TrendSource } from '@shared/types'
import type { AgentConfig, AgentInfo, Thread, ThreadSummary } from '@shared/chat'
import { CloseIcon, PlusIcon, SendIcon, TrashIcon } from '../components/Icons'
import Markdown from './Markdown'
import { EmbedCard, type EmbedActions } from './Embeds'
import AgentSettings from './AgentSettings'
import SetupSteps from './SetupSteps'
import { RisingMark } from './Marks'
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

const MANAGE = '__manage'

// the chat each brand had open, kept while the app runs so leaving the page doesn't lose it
const lastOpen = new Map<string, string | null>()

const STARTERS = [
  'Give me 5 post ideas from my top trends',
  'Which trend should I jump on today, and why?',
  'Write an X post and a Reddit post about my best trend'
]

function StopIcon(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  )
}

export default function ChatView({ brand, editBrand, onOpenSite, compact, onClose, headerRight }: Props): ReactNode {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [config, setConfig] = useState<AgentConfig>({ defaultAgentId: null, custom: [] })
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [thread, setThread] = useState<Thread | null>(null)
  const [draft, setDraft] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [manage, setManage] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [trends, setTrends] = useState<Map<string, TrendItem>>(new Map())
  const [showThreads, setShowThreads] = useState(false)
  const listEnd = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
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
        if (remembered === undefined && compact && list[0]) setOpenId(list[0].id)
      })
  }, [brandId, compact])

  useEffect(() => {
    lastOpen.set(brandId, openId)
  }, [brandId, openId])

  useEffect(() => {
    // each chat remembers its own agent, a pick only sticks to the chat it was made in
    setPicked(null)
    if (openId) void loadThread(openId)
    else setThread(null)
  }, [openId, loadThread])

  useEffect(
    () =>
      chat().onEvent((ev) => {
        if (ev.brandId !== brandId) return
        if (ev.type === 'threads') {
          void loadThreads()
          return
        }
        if (ev.threadId !== openRef.current) return
        if (ev.type === 'delta') {
          setThread((t) =>
            t && t.id === ev.threadId
              ? { ...t, messages: t.messages.map((m) => (m.id === ev.messageId ? { ...m, text: m.text + ev.text } : m)) }
              : t
          )
        } else {
          // the saved copy is the real one, in case a chunk raced the first load
          void loadThread(ev.threadId)
        }
      }),
    [brandId, loadThreads, loadThread]
  )

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

  const lastText = thread?.messages.at(-1)?.text.length ?? 0
  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: 'end' })
  }, [thread?.messages.length, lastText, openId])

  const usable = useMemo(() => (agents ?? []).filter((a) => a.installed), [agents])
  const agentId =
    [picked, thread?.agentId, config.defaultAgentId].find((id) => id && usable.some((a) => a.id === id)) ??
    usable[0]?.id ??
    null
  const agentName = (id?: string): string => agents?.find((a) => a.id === id)?.name ?? 'Agent'
  const busy = !!thread?.messages.some((m) => m.status === 'streaming')

  const send = async (text = draft): Promise<void> => {
    const body = text.trim()
    if (!body || !agentId || busy) return
    setError('')
    setDraft('')
    try {
      const res = await chat().send(brandId, openId, body, agentId)
      if (res.threadId !== openId) setOpenId(res.threadId)
      else void loadThread(res.threadId)
    } catch (err) {
      setDraft(body)
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    }
  }

  const pickAgent = (id: string): void => {
    if (id === MANAGE) {
      setManage(true)
      return
    }
    setPicked(id)
    void chat().setDefaultAgent(id).then(setConfig)
  }

  const remove = async (id: string): Promise<void> => {
    await chat().deleteThread(brandId, id)
    if (openId === id) setOpenId(null)
    void loadThreads()
  }

  const savedTitles = useMemo(() => new Set(brand.ideas.map((i) => i.title)), [brand.ideas])
  const actions: EmbedActions = {
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
  const embed = (raw: string, closed: boolean, key: string): ReactNode => (
    <EmbedCard key={key} raw={raw} closed={closed} actions={actions} />
  )

  const noAgents = agents !== null && usable.length === 0
  const threadList = (
    <div className="cx-threads" role="list" aria-label="Chats">
      {threads.length === 0 && <p className="cx-threads-empty">No chats yet</p>}
      {threads.map((t) => (
        <div
          key={t.id}
          role="listitem"
          tabIndex={0}
          className={`cx-thread${t.id === openId ? ' active' : ''}`}
          onClick={() => {
            setOpenId(t.id)
            setShowThreads(false)
          }}
          onKeyDown={(e) => e.key === 'Enter' && setOpenId(t.id)}
        >
          {t.busy && <RisingMark className="cx-busy-mark" />}
          <span className="cx-thread-title">{t.title}</span>
          <span className="cx-thread-when">{when(t.updatedAt)}</span>
          <button
            className="row-close"
            title="Delete chat"
            aria-label="Delete chat"
            onClick={(e) => {
              e.stopPropagation()
              void remove(t.id)
            }}
          >
            <TrashIcon />
          </button>
        </div>
      ))}
    </div>
  )

  return (
    <section className={`cx${compact ? ' compact' : ''}`} aria-label="Chat">
      {!compact && (
        <aside className="cx-side">
          <button className="cx-new" onClick={() => setOpenId(null)}>
            <PlusIcon />
            New chat
          </button>
          {threadList}
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
              <span className="muted small">{threads.length}</span>
            </button>
          ) : (
            <h2>{thread?.title ?? 'New chat'}</h2>
          )}
          <span className="spacer" />
          {compact && (
            <button className="icon-btn" title="New chat" aria-label="New chat" onClick={() => setOpenId(null)}>
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
              thread.messages.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="cx-msg user">
                    {m.text}
                  </div>
                ) : (
                  <div key={m.id} className={`cx-msg agent${m.status === 'streaming' ? ' streaming' : ''}`}>
                    <div className="cx-who">
                      <RisingMark className="cx-who-mark" />
                      {agentName(m.agentId)}
                      {m.status === 'stopped' && <span className="muted"> stopped</span>}
                    </div>
                    {m.text ? (
                      <Markdown text={m.text} embed={embed} />
                    ) : m.status === 'streaming' ? (
                      <div className="cx-thinking" aria-label="Thinking">
                        <span />
                        <span />
                        <span />
                      </div>
                    ) : null}
                    {m.status === 'error' && <p className="cx-error">{m.error || 'Something went wrong'}</p>}
                  </div>
                )
              )
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
          className="cx-composer"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          {error && <p className="cx-error">{error}</p>}
          <div className="cx-box">
            <textarea
              ref={input}
              value={draft}
              rows={compact ? 2 : 3}
              placeholder={agentId ? `Message ${agentName(agentId)}` : 'Set up an agent to start chatting'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <div className="cx-box-row">
              <select
                className="cx-agent"
                value={agentId ?? ''}
                onChange={(e) => pickAgent(e.target.value)}
                title="Agent for this chat"
                aria-label="Agent"
              >
                {!agentId && <option value="">No agent</option>}
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
                <option value={MANAGE}>Add or edit agents...</option>
              </select>
              <span className="spacer" />
              {busy && thread ? (
                <button
                  type="button"
                  className="cx-send stop"
                  title="Stop"
                  aria-label="Stop"
                  onClick={() => void chat().stop(brandId, thread.id)}
                >
                  <StopIcon />
                </button>
              ) : (
                <button type="submit" className="cx-send" title="Send" aria-label="Send" disabled={!draft.trim() || !agentId}>
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
            void loadAgents()
          }}
          onClose={() => setManage(false)}
        />
      )}
    </section>
  )
}
