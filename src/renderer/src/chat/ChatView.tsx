import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react'
import type { VisualAsset } from '@shared/visuals'
import type { Brand, TrendItem, TrendSource } from '@shared/types'
import type { Project } from '@shared/workspace'
import LoginRequests from './LoginRequests'
import ProjectProgress from './ProjectProgress'
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
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  type ApprovalRecord,
  type PermissionMode,
  type QueuedMessage
} from '@shared/providers'
import { CloseIcon, SendIcon } from '../components/Icons'
import Markdown from './Markdown'
import { EmbedCard, type EmbedActions } from './Embeds'
import MediaReview from './MediaReview'
import CardList from './cards/CardList'
import EmbedPicker from './cards/EmbedPicker'
import { useCards, type CardActions } from './cards/useCards'
import ComposerMic from './ComposerMic'
import TakeRecorder from './TakeRecorder'
import { useTakeTranscriber } from './useTakeTranscriber'
import { joinTranscripts, useDictation } from '../dictation/useDictation'
import type { Transcription } from '@shared/speech'
import type { BrandMemoryState } from '@shared/brand-memory'
import AgentSettings from './AgentSettings'
import SetupSteps from './SetupSteps'
import WorkLog from './WorkLog'
import QuestionDeck, { questionsIn, readAnswers } from './Questions'
import UsagePopover from './UsagePopover'
import ApprovalPanel, { type ApprovalChoice } from './ApprovalPanel'
import PendingQuestion, { providerAnswers } from './PendingQuestion'
import PlanCard from './PlanCard'
import { isApproval, pendingFor, resolveLocal, setFocus, syncThread, usePendingState, type PendingItem } from './pending'
import { RisingMark } from './Marks'
import { Dropdown, Menu } from './ui'
import { fileSize, fromMedia, onAttach } from './attachments'
import MediaPicker from '../pages/media/MediaPicker'
import { chat, newId } from './api'
import { onDraft } from '../pages/voice/chatDraft'
import { useChatDraft } from './useChatDraft'
import SketchPad from './visuals/SketchPad'
import FindVisuals from './visuals/FindVisuals'
import { VisualAttachment } from './visuals/VisualItems'
import { attachVisual, onChatNote, onSketch, type SketchRequest } from './visuals/actions'
import './chat.css'

interface Props {
  brand: Brand
  editBrand: (fn: (b: Brand) => Brand) => void
  onOpenSite: (siteId: string, url?: string) => void
  // the open chat, null for a new one. the sidebar picks it, so the shell owns it
  openId: string | null
  onOpenId: (id: string | null) => void
  // a first message just made this chat, the shell links it to the video it was started from
  onThreadCreated?: (id: string) => void
  // shown after the chat's title, the videos it's linked to
  context?: string
  // extra buttons for the header, e.g. the workspace toggle
  headerRight?: ReactNode
  // where the chat's files and runs go: its first linked video, General when it has none
  project?: Project
  // every video the chat is linked to, each gets a progress row
  linkedProjects?: Project[]
  onInlineCraft?: () => void
}

// talking modes for the composer: what you say goes to the agent with this ask in front
const TALK_MODES = {
  script: {
    label: 'Talk-first script',
    hint: "Talk the video through, no need for order. Send when you're done.",
    prefix:
      "Talk-first script. Below is the video in my own words (saved as a dump with word times). Build the script with script_write: beats from my sentences quoted word for word as spoken lines, only short connecting lines of your own as suggestions. Then show it and tell me in one line what's missing."
  },
  intake: {
    label: 'Brand intake',
    hint: 'Talk about who it is for, the promise, how you talk, what you are not, and your content pillars.',
    prefix: ''
  }
} as const
type TalkMode = keyof typeof TALK_MODES

const STARTERS = [
  {
    title: 'Start a new video',
    hint: 'Plan it and set up its checklist',
    prompt:
      "Let's start a new video. Ask me what it's about and who it's for, make a video project for it and link this chat to it, then set up its checklist from idea to post and tell me the first thing I should do."
  },
  {
    title: 'Get ready to record',
    hint: 'Shot list and beats for the camera',
    prompt:
      "Make a shot list and beat sheet for the video I'm recording next, with the lines I need to say and any B-roll to grab. Ask me what's missing."
  },
  {
    title: 'How are my videos doing',
    hint: 'What worked and what to change',
    prompt:
      'Check how my latest videos are doing: views, retention and where people drop off. Tell me what worked and one thing to change in the next video.'
  },
  {
    title: 'Titles and thumbnail',
    hint: 'Ten pairs for the video you pick',
    prompt: 'Write 10 titles with matching thumbnail text for the video this chat is about. If it is not linked to one yet, ask me which. Keep the thumbnail text under 5 words.'
  }
]

// anything esc should close before it stops a reply
const OVERLAYS = '.modal-backdrop, .ui-pop, [aria-modal="true"]'

const SHORTCUTS =
  'Ctrl+Shift+N new chat, Ctrl+L type, Esc stop, Alt+Up/Down switch chats. While a reply runs: Enter steers it, Alt+Enter queues'

const MODE_LABELS: Record<PermissionMode, { label: string; hint: string }> = {
  supervised: { label: 'Supervised', hint: 'Asks before every tool and change' },
  'auto-accept-edits': { label: 'Auto-accept edits', hint: 'Edits go through, the rest asks' },
  auto: { label: 'Auto', hint: "The agent's judgement, asks when unsure" },
  'full-access': { label: 'Full access', hint: 'Never asks' }
}

function PlusIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 2.5v9M2.5 7h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function StopIcon(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
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

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low effort',
  medium: 'Medium effort',
  high: 'High effort',
  xhigh: 'Extra high effort',
  max: 'Max effort'
}

export default function ChatView({
  brand,
  editBrand,
  onOpenSite,
  openId,
  onOpenId: setOpenId,
  onThreadCreated,
  context,
  headerRight,
  project,
  linkedProjects = [],
  onInlineCraft
}: Props): ReactNode {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [config, setConfig] = useState<AgentConfig>({ defaultAgentId: null, custom: [] })
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [thread, setThread] = useState<Thread | null>(null)
  const [draft, setDraft, draftSaved] = useChatDraft(brand.id, openId, project?.id ?? 'general')
  const [files, setFiles] = useState<Attachment[]>([])
  const [picked, setPicked] = useState<string | null>(null)
  // model picked before the chat exists, per agent
  const [newModels, setNewModels] = useState<Record<string, string>>({})
  const [newEfforts, setNewEfforts] = useState<Record<string, string>>({})
  const [modelLists, setModelLists] = useState<Record<string, ModelOption[]>>({})
  const [error, setError] = useState('')
  const [manage, setManage] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [trends, setTrends] = useState<Map<string, TrendItem>>(new Map())
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  // lives in main per thread, this is the copy for the open chat
  const [queued, setQueued] = useState<QueuedMessage[]>([])
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE)
  const pend = usePendingState()
  const [dragging, setDragging] = useState(false)
  const listEnd = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [picking, setPicking] = useState(false)
  // the sketch pad: false when closed, null for a blank page
  const [sketch, setSketch] = useState<SketchRequest | null | false>(false)
  const [finding, setFinding] = useState(false)
  const openRef = useRef<string | null>(null)
  openRef.current = openId

  const brandId = brand.id
  // cards the agent's tools put in this chat: videos to review, suggestions, copies, history
  const cards = useCards(brandId, openId)
  useTakeTranscriber(brandId, cards)
  // dictation: finished words go into the draft, the part still being transcribed shows lighter
  const [partial, setPartial] = useState('')
  const dictated = useRef<{ t: Transcription; offset: number }[]>([])
  const [talkMode, setTalkMode] = useState<TalkMode | null>(null)
  const [recording, setRecording] = useState(false)
  const [takeBusy, setTakeBusy] = useState(false)
  const [memory, setMemory] = useState<BrandMemoryState | null>(null)

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
  useEffect(() => onDraft(setDraft), [setDraft])

  useEffect(() => {
    void loadThreads()
  }, [loadThreads])

  useEffect(() => {
    let alive = true
    const api = window.trenddeckBrandMemory
    const load = (): void => void api.state(brandId).then((m) => alive && setMemory(m)).catch(() => {})
    load()
    const off = api.onChanged((b) => b === brandId && load())
    return () => {
      alive = false
      off()
    }
  }, [brandId])

  useEffect(() => {
    // each chat remembers its own agent, a pick only sticks to the chat it was made in
    setPicked(null)
    setEditing(null)
    setQueued([])
    setNotice('')
    setFocus(brandId, openId)
    if (openId) {
      void loadThread(openId)
      void syncThread(brandId, openId)
      void chat()
        .listQueue(brandId, openId)
        .then((q) => openRef.current === openId && setQueued(q))
    } else setThread(null)
  }, [openId, loadThread, brandId])

  useEffect(() => () => setFocus(null, null), [])

  // brand default for a new chat, the chat's own once it exists
  useEffect(() => {
    let alive = true
    void chat()
      .getPermissionMode(brandId, openId)
      .then((m) => alive && setMode(m))
    return () => {
      alive = false
    }
  }, [brandId, openId])

  // the provider layer: plans, steered messages, the queue, handoffs, approvals in the log
  useEffect(
    () =>
      chat().onProviderEvent((ev) => {
        if (ev.brandId !== brandId || ev.threadId !== openRef.current) return
        if (ev.type === 'queue') return setQueued(ev.queue)
        if (ev.type === 'permission-mode') return setMode(ev.mode)
        if (ev.type === 'usage' || ev.type === 'user-input' || ev.type === 'user-input-resolved') return
        setThread((t) => {
          if (!t || t.id !== ev.threadId) return t
          if (ev.type === 'steer') {
            if (t.messages.some((m) => m.id === ev.message.id)) return t
            const at = t.messages.findIndex((m) => m.id === ev.messageId)
            const messages = [...t.messages]
            messages.splice(at < 0 ? messages.length : at, 0, ev.message)
            return { ...t, messages }
          }
          const patch = (fn: (m: ThreadMessage) => ThreadMessage): Thread => ({
            ...t,
            messages: t.messages.map((m) => (m.id === ev.messageId ? fn(m) : m))
          })
          if (ev.type === 'plan') return patch((m) => ({ ...m, plan: ev.plan }))
          if (ev.type === 'handoff') return patch((m) => ({ ...m, handoffFrom: ev.fromAgentIds }))
          if (ev.type === 'approval') {
            const rec: ApprovalRecord = { ...ev.request, status: 'pending' }
            return patch((m) => ({ ...m, approvals: [...(m.approvals ?? []).filter((a) => a.requestId !== rec.requestId), rec] }))
          }
          if (ev.type === 'approval-resolved') {
            return patch((m) => ({
              ...m,
              approvals: (m.approvals ?? []).map((a) => (a.requestId === ev.requestId ? { ...a, status: ev.status } : a))
            }))
          }
          return t
        })
      }),
    [brandId]
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
          // main sends the next queued message itself, the reload picks it up
          if (ev.threadId === openRef.current) void loadThread(ev.threadId)
          return
        }
        if (ev.threadId !== openRef.current) return
        setThread((t) => (t && t.id === ev.threadId ? applyEvent(t, ev) : t))
      }),
    [brandId, loadThreads, loadThread]
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

  // the sketch pad opened from a card (draw on it), and lines handed to the draft
  useEffect(() => onSketch(setSketch), [])
  useEffect(
    () =>
      onChatNote((text) => {
        setDraft((d) => (d.trim() ? `${d.trimEnd()}\n${text}` : text))
        input.current?.focus()
      }),
    [setDraft]
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
    if (document.documentElement.dataset.embedFill) {
      setFollowing(false)
      return
    }
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
    const list = (agentId && modelLists[agentId]) || agent?.models || [{ id: '', label: 'Model' }]
    return list.some((m) => m.id === model) ? list : [...list, { id: model, label: model }]
  }, [agentId, agent, modelLists, model])

  // what this chat waits on: approvals go in the composer, questions at the end of the chat
  const waiting = pendingFor(pend, brandId, openId)
  const approvals = waiting.filter(isApproval)
  const approval = approvals[0]
  const asked = waiting.filter(
    (p): p is Extract<PendingItem, { kind: 'provider-input' | 'pipeline-question' }> =>
      p.kind === 'provider-input' || p.kind === 'pipeline-question'
  )

  // deny takes whatever is in the composer as the note, the way t3code does it
  const respond = async (choice: ApprovalChoice): Promise<void> => {
    const a = approval
    if (!a) return
    const note = choice === 'deny' ? draft.trim() : ''
    if (note) setDraft('')
    resolveLocal(a.id)
    setError('')
    try {
      if (a.kind === 'gateway-approval') {
        await window.trenddeckGateway.respond({
          id: a.request.id,
          approve: choice !== 'deny',
          scope: choice === 'turn' ? 'turn' : 'once',
          ...(note ? { note } : {})
        })
      } else {
        await chat().respondApproval(a.brandId, a.threadId, a.request.requestId, choice === 'deny' ? 'deny' : 'allow', {
          ...(note ? { feedback: note } : {}),
          remember: choice === 'turn'
        })
      }
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const answer = async (item: (typeof asked)[number], picks: string[][] | null): Promise<void> => {
    resolveLocal(item.id)
    try {
      if (item.kind === 'provider-input') {
        await chat().respondUserInput(item.brandId, item.threadId, item.request.requestId, providerAnswers(item, picks ?? []))
      } else {
        await window.trenddeckPipeline.answer({ id: item.question.id, picks: picks ?? [], ...(picks ? {} : { dismissed: true }) })
      }
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const pickMode = (m: PermissionMode): void => {
    setMode(m)
    void chat()
      .setPermissionMode(brandId, openId, m)
      .catch((err) => setError(cleanError(err)))
  }

  // steer: into the running reply. queue: waits for it to end. main falls back to the queue
  // when the agent can't take input mid reply
  const sendDuring = async (threadId: string, body: string, how: 'steer' | 'queue'): Promise<void> => {
    if (!agentId) return
    setDraft('')
    try {
      if (how === 'queue') {
        setQueued(await chat().queue(brandId, threadId, body, agentId))
        return
      }
      const res = await chat().steer(brandId, threadId, body, agentId)
      if (res.mode === 'queued') {
        setNotice(`${agentName(agentId)} can't take messages mid reply, so it's queued for when this one is done`)
        setQueued(await chat().listQueue(brandId, threadId))
      } else if (res.mode === 'sent') void loadThread(threadId)
    } catch (err) {
      setDraft(body)
      setError(cleanError(err))
    }
  }

  const steerNow = async (q: QueuedMessage): Promise<void> => {
    if (!thread) return
    try {
      const res = await chat().steerQueued(brandId, thread.id, q.id)
      if (res.mode === 'queued') setNotice(`${agentName(q.agentId)} can't take messages mid reply`)
      else if (res.mode === 'sent') void loadThread(thread.id)
    } catch (err) {
      setError(cleanError(err))
    }
  }

  // what was dictated since the last send, saved with its word times. returns a note for the agent
  const keepDictation = async (): Promise<string> => {
    const joined = joinTranscripts(dictated.current)
    dictated.current = []
    if (!joined || !joined.text) return ''
    try {
      if (project) {
        const dump = await window.trenddeckScripts.saveDump(brandId, project.id, joined)
        return `\n\n(Dictated. Saved as dump ${dump.id} with word times.)`
      }
      await window.trenddeckScripts.addSpeech(brandId, joined)
    } catch {
      // the message still goes, only the word times are lost
    }
    return ''
  }

  const send = async (text = draft, how: 'steer' | 'queue' = 'steer'): Promise<void> => {
    let body = text.trim()
    if ((!body && !(text === draft && files.length)) || !agentId) return
    // a sketch or picked visual can go out on its own
    if (!body) body = files.some((f) => f.visual) ? 'Here is what I picked, take a look.' : 'Take a look at the attached files.'
    if (text === draft) {
      if (!body) dictated.current = []
      const note = await keepDictation()
      const mode = talkMode ? TALK_MODES[talkMode] : null
      const prefix = talkMode === 'intake' ? await window.trenddeckBrandMemory.intakePrompt().catch(() => '') : mode?.prefix ?? ''
      body = `${prefix ? `${prefix}\n\n` : ''}${body}${note}`
      setTalkMode(null)
    }
    setError('')
    setNotice('')
    if (busy && thread) {
      if (files.length) {
        setError('Files go out with a new message. Wait for this reply, or remove them first.')
        return
      }
      await sendDuring(thread.id, body, how)
      return
    }
    const sending = files
    setDraft('')
    setFiles([])
    try {
      const res = await chat().send(brandId, openId, body, agentId, {
        attachments: sending,
        ...(thread ? {} : { model: newModels[agentId] ?? '', effort: newEfforts[agentId] ?? '' })
      })
      if (res.threadId !== openId) {
        onThreadCreated?.(res.threadId)
        setOpenId(res.threadId)
      } else void loadThread(res.threadId)
    } catch (err) {
      setDraft(body)
      setFiles(sending)
      setError(cleanError(err))
    }
  }

  // what a card says goes straight to the agent: into the running reply, or as a new message.
  // the composer and its files are left alone
  const sendToAgent = async (text: string): Promise<void> => {
    const body = text.trim()
    if (!body) return
    if (!agentId) throw new Error('Set up an agent first.')
    if (busy && thread) {
      const res = await chat().steer(brandId, thread.id, body, agentId)
      if (res.mode === 'queued') {
        setNotice(`${agentName(agentId)} can't take messages mid reply, so it's queued for when this one is done`)
        setQueued(await chat().listQueue(brandId, thread.id))
      } else if (res.mode === 'sent') void loadThread(thread.id)
      return
    }
    const res = await chat().send(brandId, openId, body, agentId, {})
    if (res.threadId !== openId) {
      onThreadCreated?.(res.threadId)
      setOpenId(res.threadId)
    } else void loadThread(res.threadId)
  }
  const cardActions: CardActions = { brand, project, sendToAgent, hasAgent: !!agentId, threadId: openId }

  const dictation = useDictation({
    onPartial: setPartial,
    onText: (text, t) => {
      // hands-free while a reply runs: what you say goes straight in as a steer
      if (dictation.config?.handsFree && busy && thread) {
        dictated.current.push({ t, offset: 0 })
        void keepDictation().then((note) => sendToAgent(`${text}${note}`).catch((err) => setError(cleanError(err))))
        return
      }
      const offset = dictated.current.reduce((n, p) => n + p.t.duration, 0)
      dictated.current.push({ t, offset })
      setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, '')} ${text}` : text))
    },
    onPause: () => void send()
  })
  const startTalking = (mode: TalkMode): void => {
    setTalkMode(mode)
    input.current?.focus()
    dictation.start('click')
  }
  // a different chat starts with the mic off
  useEffect(() => {
    dictation.stop()
    dictated.current = []
    setTalkMode(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, brandId])

  const wrapUp = async (): Promise<void> => {
    try {
      await sendToAgent(await window.trenddeckBrandMemory.wrapUp(brandId))
    } catch (err) {
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

  const effort = agentId ? ((thread ? thread.efforts?.[agentId] : newEfforts[agentId]) ?? '') : ''
  const pickEffort = (level: string): void => {
    if (!agentId) return
    if (thread) {
      setThread({ ...thread, efforts: { ...thread.efforts, [agentId]: level } })
      void chat().setEffort(brandId, thread.id, agentId, level)
    } else {
      setNewEfforts((m) => ({ ...m, [agentId]: level }))
    }
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

  const attach = (list: Attachment[]): void =>
    setFiles((f) => [...f, ...list.filter((a) => !f.some((x) => x.id === a.id))].slice(0, 20))

  // a pasted or dropped image as a visual: a card in an open chat, an attachment in a new one
  const addVisual = async (make: () => Promise<VisualAsset>): Promise<void> => {
    try {
      const asset = await make()
      if (openId) await window.trenddeckVisuals.showCard(brandId, openId, asset.id)
      else attachVisual(asset)
    } catch (err) {
      setError(cleanError(err))
    }
  }
  const imageAsset = async (f: File): Promise<VisualAsset> => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error("That image couldn't be read."))
      r.readAsDataURL(f)
    })
    return window.trenddeckVisuals.saveImage({ brandId, threadId: openId, dataUrl, origin: 'paste', name: f.name && f.name !== 'image.png' ? f.name : 'Pasted image' })
  }
  // a link dragged from a browser: the image it points at, or the page's preview image
  const dropLink = (e: DragEvent): boolean => {
    const raw = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    const url = raw.split(/\r?\n/).find((l) => /^https?:\/\//i.test(l.trim()))?.trim()
    if (!url) return false
    void addVisual(() => window.trenddeckVisuals.fetchLink(brandId, url))
    return true
  }

  // dropped or pasted files go into the brand's media library first, then get attached from there
  const addFiles = async (list: FileList | null): Promise<void> => {
    if (!list?.length) return
    const media = window.trenddeck.media
    const onDisk = Array.from(list).filter((f) => media.pathForFile(f))
    // a copied screenshot or an image dragged out of a browser isn't a file on disk: it becomes a
    // visual, a card in this chat with the same actions as everything else
    const loose = Array.from(list).filter((f) => !media.pathForFile(f))
    const images = loose.filter((f) => f.type.startsWith('image/'))
    for (const f of images) await addVisual(() => imageAsset(f))
    if (loose.length > images.length) setError("Only images can come straight from the clipboard or a browser. Save other files first, then drop them in.")
    const paths = onDisk.map((f) => media.pathForFile(f))
    if (!paths.length) return
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

  // alt+up/down steps through these
  const visible = useMemo(() => threads.filter((t) => !t.archived), [threads])

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
        // an approval waiting: esc says no, with the composer text as the note
        if (approval) void respond('deny')
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
      onSendToAgent: agentId ? sendToAgent : null,
      project,
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

  // cards that came from outside a reply (an editor you opened, OBS) sit in the chat where they
  // came in, by time, so later messages go under them and they scroll up with the chat
  const loose = thread ? cards.filter((c) => !c.messageId || !thread.messages.some((m) => m.id === c.messageId)) : []
  const looseIndex = (at: number): number => {
    const msgs = thread?.messages ?? []
    let i = -1
    while (i + 1 < msgs.length && msgs[i + 1].at <= at) i++
    return i
  }
  const looseAfter = (i: number): ReactNode => {
    const here = loose.filter((c) => looseIndex(c.at) === i)
    return here.length ? <CardList key={`loose-${i}`} cards={here} a={cardActions} /> : null
  }

  // who answered shows once, then again only when the agent or model changes
  const showWho = (m: ThreadMessage, i: number): boolean => {
    if (m.status === 'stopped' || m.handoffFrom?.length) return true
    const prev = thread?.messages.slice(0, i).reverse().find((p) => p.role === 'agent')
    return !prev || prev.agentId !== m.agentId || (prev.model ?? '') !== (m.model ?? '')
  }

  const agentMessage = (m: ThreadMessage, i: number): ReactNode => (
    <div key={m.id} className="cx-msg-agent-wrap">
      {m.handoffFrom?.length ? (
        <div className="cx-handoff" role="separator">
          <span>Continued from {[...new Set(m.handoffFrom.map((id) => agentName(id)))].join(', ')}</span>
        </div>
      ) : null}
    <div className={`cx-msg agent${m.status === 'streaming' ? ' streaming' : ''}`}>
      {showWho(m, i) && (
      <div className="cx-who">
        <RisingMark className="cx-who-mark" />
        {agentName(m.agentId)}
        {m.model && <span className="muted"> {agents?.find((a) => a.id === m.agentId)?.models?.find((o) => o.id === m.model)?.label ?? m.model}</span>}
        {m.status === 'stopped' && <span className="muted"> stopped</span>}
      </div>
      )}
      <WorkLog m={m} />
      {m.plan?.length ? <PlanCard plan={m.plan} /> : null}
      {m.approvals?.some((a) => a.status !== 'pending') && (
        <ul className="cx-approvals-log" aria-label="Approvals">
          {m.approvals
            .filter((a) => a.status !== 'pending')
            .map((a) => (
              <li key={a.requestId} className={a.status}>
                <span className="cx-approvals-word">
                  {a.status === 'allowed' ? 'Allowed' : a.status === 'denied' ? 'Denied' : 'Expired'}
                </span>
                <span className="cx-approvals-title">{a.title}</span>
                {a.feedback && <span className="muted">{a.feedback}</span>}
              </li>
            ))}
        </ul>
      )}
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
      <CardList cards={cards.filter((c) => c.messageId === m.id)} a={cardActions} />
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
        <div className={`cx-msg user${m.steer ? ' steer' : ''}`}>
          {m.steer && <span className="cx-steer-tag">Steered</span>}
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
        {m.attachments?.filter((file) => file.media).map((file) => (
          <MediaReview key={`${brandId}:${file.id}`} brandId={brandId} mediaId={file.id} project={project}
            onSend={agentId ? sendToAgent : null} />
        ))}
        {m.attachments?.filter((file) => !file.media && file.visual).map((file) => (
          <VisualAttachment key={`${brandId}:${file.id}`} id={file.id} a={cardActions} />
        ))}
        {!busy && (
          <button className="cx-tool cx-edit-btn" onClick={() => setEditing({ id: m.id, text: m.text })}>
            Edit
          </button>
        )}
      </div>
    )

  return (
    <section className="cx" aria-label="Chat">
      <div
        className={`cx-main${home ? ' home' : ''}`}
        // files, images and links dropped anywhere on the chat
        onDragOver={(e) => {
          const t = e.dataTransfer.types
          if (t.includes('Files') || t.includes('text/uri-list')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e) => {
          setDragging(false)
          if (e.dataTransfer.files.length) {
            e.preventDefault()
            void addFiles(e.dataTransfer.files)
          } else if (dropLink(e)) e.preventDefault()
        }}
      >
        <header className="cx-head">
          <h2 title={SHORTCUTS}>
            <span className="cx-head-title">{thread?.title ?? 'New chat'}</span>
            {context && <span className="cx-head-context" title={`Linked to ${context}`}>{context}</span>}
          </h2>
          <span className="spacer" />
          {project && <EmbedPicker brandId={brand.id} threadId={thread?.id ?? null} project={project} onOpened={onInlineCraft} />}
          {headerRight}
        </header>

        {linkedProjects.length > 0 && (
          <div className="cx-progress-list">
            {linkedProjects.slice(0, 3).map((p) => (
              <ProjectProgress key={`progress:${brand.id}:${p.id}`} brand={brand} project={p} actions={cardActions} />
            ))}
          </div>
        )}
        <div className="cx-messages" ref={scroller} onScroll={onScroll}>
          <div className="cx-column">
            <LoginRequests brandId={brand.id} threadId={openId} onOpenSite={onOpenSite} />
            {thread && thread.messages.length > 0 ? (
              <>
                {looseAfter(-1)}
                {thread.messages.map((m, i) => (
                  <Fragment key={m.id}>
                    {m.role === 'user' ? userMessage(m) : agentMessage(m, i)}
                    {looseAfter(i)}
                  </Fragment>
                ))}
              </>
            ) : noAgents ? (
              <SetupSteps agents={agents ?? []} scanning={scanning} onRescan={() => void loadAgents(true)} onAdd={() => setManage(true)} />
            ) : (
              <div className="cx-empty">
                <h1 className="cx-hello">{context ? `New chat about ${context}` : `New chat in ${brand.name}`}</h1>
                <p className="cx-home-note">
                  Your agent sees everything in {brand.name}: its voice, every video project and how the posted ones are doing. Never
                  your logins or what's in your tabs.
                </p>
                <ul className="cx-starters" aria-label="Ways to start">
                  {memory && !memory.intakeDone && (
                    <li>
                      <button className="cx-starter" disabled={!agentId} title={TALK_MODES.intake.hint} onClick={() => startTalking('intake')}>
                        <span className="cx-starter-title">Set up this brand by talking</span>
                        <span className="cx-starter-hint">Your agent drafts the voice guide from what you say</span>
                      </button>
                    </li>
                  )}
                  <li>
                    <button className="cx-starter" disabled={!agentId} title={TALK_MODES.script.hint} onClick={() => startTalking('script')}>
                      <span className="cx-starter-title">Talk through a video</span>
                      <span className="cx-starter-hint">Your words become the script</span>
                    </button>
                  </li>
                  {STARTERS.map((s) => (
                    <li key={s.title}>
                      <button className="cx-starter" disabled={!agentId} title={s.prompt} onClick={() => void send(s.prompt)}>
                        <span className="cx-starter-title">{s.title}</span>
                        <span className="cx-starter-hint">{s.hint}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {thread && !thread.messages.length && <CardList cards={loose} a={cardActions} />}
            {asked.map((item) => (
              <PendingQuestion
                key={item.id}
                item={item}
                onAnswer={(picks) => void answer(item, picks)}
                onDismiss={item.kind === 'pipeline-question' ? () => void answer(item, null) : undefined}
              />
            ))}
            <div ref={listEnd} />
          </div>
        </div>
        {!following && !home && (
          <button type="button" className="cx-jump" onClick={jumpDown}>
            Jump to latest
          </button>
        )}

        {finding && (
          <div className="cx-find-wrap">
            <FindVisuals a={cardActions} onClose={() => setFinding(false)} />
          </div>
        )}
        <form
          className={`cx-composer${dragging ? ' dragging' : ''}`}
          onSubmit={(e) => {
            e.preventDefault()
            if (approval) {
              if (draft.trim()) void respond('deny')
            } else void send()
          }}
        >
          {error && <p className="cx-error">{error}</p>}
          {notice && <p className="cx-notice">{notice}</p>}
          {queued.length > 0 && (
            <ul className="cx-queue" aria-label="Queued messages">
              {queued.map((q) => (
                <li key={q.id}>
                  <span className="cx-queue-tag">Queued</span>
                  <span className="cx-queue-text" title={q.text}>
                    {q.text}
                  </span>
                  {busy && agents?.find((x) => x.id === q.agentId)?.capabilities?.steer && (
                    <button type="button" className="cx-tool" title="Put it into the running reply" onClick={() => void steerNow(q)}>
                      Send now
                    </button>
                  )}
                  <button
                    type="button"
                    className="row-close"
                    aria-label="Remove from queue"
                    title="Remove from queue"
                    onClick={() =>
                      thread &&
                      void chat()
                        .unqueue(brandId, thread.id, q.id)
                        .then((list) => openRef.current === thread.id && setQueued(list))
                    }
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {dictation.error && (
            <p className="cx-error">
              {dictation.error}{' '}
              <button type="button" className="cx-tool" onClick={dictation.clearError}>
                Dismiss
              </button>
            </p>
          )}
          {memory && memory.pending >= 3 && !busy && agentId && (
            <p className="cx-notice cx-wrap">
              You changed or turned down {memory.pending} things this session.{' '}
              <button type="button" className="cx-tool" onClick={() => void wrapUp()}>
                Wrap up
              </button>
            </p>
          )}
          <div className={`cx-box${approval ? ' approving' : ''}`}>
            {!draftSaved && <p className="cx-error" role="alert">This draft could not be saved on this device. Copy it before closing TrendDeck.</p>}
            {approval && (
              <ApprovalPanel
                key={approval.id}
                item={approval}
                count={approvals.length}
                hasNote={!!draft.trim()}
                onRespond={(c) => void respond(c)}
              />
            )}
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
            {talkMode && (
              <div className="cx-talk-mode">
                <strong>{TALK_MODES[talkMode].label}</strong>
                <span>{TALK_MODES[talkMode].hint}</span>
                <button type="button" className="cx-tool" onClick={() => setTalkMode(null)}>
                  Cancel
                </button>
              </div>
            )}
            {recording && (
              <div className="cx-take-pop" role="dialog" aria-label="Record a take">
                <TakeRecorder
                  brandId={brandId}
                  projectId={project?.id}
                  threadId={openId}
                  onAttach={(list) => {
                    attach(list)
                    setRecording(false)
                  }}
                  onSaved={() => setRecording(false)}
                  onBusyChange={setTakeBusy}
                />
              </div>
            )}
            <div className="cx-input">
            <div className="cx-input-mirror" aria-hidden="true">
              <span className="cx-input-ghost">{draft}</span>
              {partial && <span className="cx-input-partial">{draft.trim() ? ' ' : ''}{partial}</span>}
              {'\n'}
            </div>
            <textarea
              ref={input}
              value={draft}
              rows={approval ? 1 : 3}
              placeholder={
                !agentId
                  ? 'Set up an agent to start chatting'
                  : approval
                    ? 'Type a note to deny with feedback, or approve above'
                    : busy
                      ? 'Steer this reply (Enter), or queue it for after (Alt+Enter)'
                      : `Message ${agentName(agentId)}`
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey && !(e.ctrlKey || e.metaKey)) return
                if (approval) {
                  e.preventDefault()
                  // ctrl+enter approves, ctrl+shift+enter approves for the turn, enter with a note denies
                  if (e.ctrlKey || e.metaKey) void respond(e.shiftKey ? 'turn' : 'approve')
                  else if (draft.trim()) void respond('deny')
                  return
                }
                if (e.shiftKey) return
                e.preventDefault()
                void send(draft, busy && (e.altKey || e.ctrlKey || e.metaKey) ? 'queue' : 'steer')
              }}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault()
                  void addFiles(e.clipboardData.files)
                }
              }}
              onScroll={(e) => {
                const mirror = e.currentTarget.previousElementSibling as HTMLElement | null
                if (mirror) mirror.scrollTop = e.currentTarget.scrollTop
              }}
            />
            </div>
            <div className="cx-box-row">
              <Menu
                label="Add to your message"
                className="cx-add"
                up
                align="left"
                trigger={<PlusIcon />}
                items={[
                  { label: 'Attach from Media', onSelect: () => setPicking(true) },
                  { label: 'Draw a sketch', onSelect: () => setSketch(null) },
                  { label: finding ? 'Close the online search' : 'Find visuals online', onSelect: () => setFinding(!finding) },
                  {
                    label: recording ? 'Close the take recorder' : 'Record a take',
                    onSelect: () => setRecording(!recording),
                    disabled: takeBusy || dictation.state !== 'idle',
                    divider: true
                  },
                  ...(project ? [{ label: 'Show OBS in the chat', onSelect: () => openId && void window.trenddeckObs.showCard(brandId, openId, project.id).catch((err: unknown) => setError(cleanError(err))), disabled: !openId }] : [])
                ]}
              />
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
              {agent?.efforts && (
                <Dropdown
                  className="cx-effort"
                  label="Effort"
                  title="How hard the agent thinks, more is slower and uses more of your limits"
                  up
                  value={effort}
                  options={[
                    { value: '', label: 'Effort' },
                    ...agent.efforts.map((l) => ({ value: l, label: EFFORT_LABELS[l] ?? l }))
                  ]}
                  onChange={pickEffort}
                />
              )}
              <Dropdown
                className="cx-mode"
                label="Permissions"
                title={
                  thread
                    ? 'How much the agent may do without asking, for this chat'
                    : 'How much the agent may do without asking, the default for new chats'
                }
                up
                value={mode}
                options={PERMISSION_MODES.map((m) => ({ value: m, label: MODE_LABELS[m].label, hint: MODE_LABELS[m].hint }))}
                onChange={pickMode}
              />
              <span className="spacer" />
              <ComposerMic d={dictation} disabled={!agentId || !!approval || recording} />
              <UsagePopover agents={agents ?? []} thread={thread} />
              {busy && thread && !approval && draft.trim() && (
                <button type="submit" className="cx-send" title="Steer the reply (Enter)" aria-label="Steer">
                  <SendIcon />
                </button>
              )}
              {busy && thread && (
                <button type="button" className="cx-send stop" title="Stop (Esc)" aria-label="Stop" onClick={stop}>
                  <StopIcon />
                </button>
              )}
              {/* stop while a reply runs, send otherwise. typing during a reply shows steer next to stop */}
              {!busy && !approval && (
                <button
                  type="submit"
                  className="cx-send"
                  title={busy ? 'Queue it' : 'Send'}
                  aria-label={busy ? 'Queue message' : 'Send'}
                  disabled={(!draft.trim() && !files.length) || !agentId}
                >
                  <SendIcon />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>

      {sketch !== false && (
        <SketchPad key={sketch?.src ?? 'blank'} a={cardActions} start={sketch} onClose={() => setSketch(false)} />
      )}

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
