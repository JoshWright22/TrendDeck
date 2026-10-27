import { app, BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { ID_PATTERN } from '@shared/types'
import type {
  AgentInfo,
  ChatEvent,
  CustomAgentInput,
  ModelOption,
  SendOptions,
  SendResult,
  Thread,
  ThreadMessage,
  WorkStep
} from '@shared/chat'
import {
  isPermissionMode,
  type ApprovalRecord,
  type PermissionMode,
  type ProviderChatEvent,
  type ProviderInfo,
  type QueuedMessage,
  type SteerResult,
  type UserInputRequest
} from '@shared/providers'
import { getData } from '../store'
import { CLIS } from './catalog'
import { getConfig, getCustom, removeCustom, saveCustom, setDefault } from './config'
import { brandContext, flatPrompt, history, historyRoom, turnText, voiceHash, voiceRoom } from './context'
import { getBrandContext } from '../voice'
import { addThread, cleanAttachments, dropChats, findThread, persist, removeThread, threadsFor } from './history'
import { beginAgentTurn, type AgentKind, type AgentSession } from '../mcp'
import { recordLimits, usageFor } from './usage'
import { adapterFor, fallbackAdapter, markUnavailable, providerInfo } from '../providers/registry'
import { buildHandoff, missedSince } from '../providers/handoff'
import { brandMode, setBrandMode } from '../providers/settings'
import { ProviderUnavailable, type ProviderAdapter, type ProviderEvent, type ProviderSession, type SessionStart } from '../providers/types'

export { dropChats }

// agents only ever start from a chat message the user sent, nothing here runs on its own.
// every agent goes through a provider adapter (providers/), this file is the chat around it:
// threads, prompts, the tool server turn, approvals, steering and the queue

const MAX_MESSAGE = 8000
const MAX_QUEUE = 20
// streaming replies get saved this often, the rest is saved when they finish
const SAVE_EVERY_MS = 3000
const DEFAULT_MODEL: ModelOption[] = [{ id: '', label: 'Model' }]

let detected: AgentInfo[] | null = null

async function detect(): Promise<AgentInfo[]> {
  const found = await Promise.all(
    CLIS.map(async (c): Promise<AgentInfo> => {
      const adapter = adapterFor(c.id)
      const health = await adapter.health(c.id)
      const info = await providerInfo(c.id)
      return {
        id: c.id,
        name: c.name,
        kind: 'cli',
        installed: health.installed,
        detail: health.detail,
        setup: c.setup,
        url: c.url,
        models: c.modelFlag ? (c.models ?? DEFAULT_MODEL) : DEFAULT_MODEL,
        efforts: c.efforts,
        provider: info.kind,
        capabilities: info.capabilities
      }
    })
  )
  detected = found
  return found
}

async function listAgents(rescan: boolean): Promise<AgentInfo[]> {
  const builtins = !detected || rescan ? await detect() : detected
  const { custom } = await getConfig()
  const extra = await Promise.all(
    custom.map(async (a): Promise<AgentInfo> => {
      let detail = a.command
      if (a.kind === 'api') {
        try {
          detail = `${new URL(a.baseUrl).host}, ${a.model || 'no model set'}`
        } catch {
          detail = a.baseUrl
        }
      }
      const models = a.kind === 'api' ? [{ id: '', label: a.model || 'Default' }] : DEFAULT_MODEL
      const info = await providerInfo(a.id)
      return { id: a.id, name: a.name, kind: a.kind, installed: true, detail, models, provider: info.kind, capabilities: info.capabilities }
    })
  )
  return [...builtins, ...extra]
}

function agentName(agentId: string): string {
  return CLIS.find((c) => c.id === agentId)?.name ?? detected?.find((a) => a.id === agentId)?.name ?? agentId
}

// one run per thread at a time
interface Live {
  ctl: AbortController
  agentId: string
  thread: Thread
  reply: ThreadMessage
  // set once the adapter started, steering and approvals go through it
  session: ProviderSession | null
  inputs: UserInputRequest[]
}
const runs = new Map<string, Live>()
const runKey = (brandId: string, threadId: string): string => `${brandId}:${threadId}`

function send(event: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('chat:event', event)
}

// the new events go on their own channel, the old chat view never sees them
function sendProvider(event: ProviderChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('chat:provider-event', event)
}

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 48 ? `${line.slice(0, 48)}...` : line || 'New chat'
}

function validId(v: unknown): v is string {
  return typeof v === 'string' && ID_PATTERN.test(v)
}

// which config the agent server writes for this agent, the rest read the generic env and file
function attachKind(agentId: string): AgentKind {
  return agentId === 'claude' || agentId === 'codex' || agentId === 'opencode' ? agentId : 'generic'
}

async function modeFor(brandId: string, thread: Thread | null): Promise<PermissionMode> {
  return thread?.permissionMode ?? (await brandMode(brandId))
}

function startRun(brandId: string, thread: Thread, reply: ThreadMessage, agentId: string): void {
  const live: Live = { ctl: new AbortController(), agentId, thread, reply, session: null, inputs: [] }
  runs.set(runKey(brandId, thread.id), live)
  void runReply(brandId, live)
}

async function runReply(brandId: string, live: Live): Promise<void> {
  const { thread, reply, agentId, ctl } = live
  const key = runKey(brandId, thread.id)
  let lastSave = Date.now()
  const ids = { brandId, threadId: thread.id, messageId: reply.id }
  const saveSoon = (): void => {
    if (Date.now() - lastSave > SAVE_EVERY_MS) {
      lastSave = Date.now()
      void persist(brandId).catch(() => {})
    }
  }

  // every adapter event lands here, the old ones go out as chat:event like before
  const emit = (e: ProviderEvent): void => {
    if (runs.get(key) !== live) return
    switch (e.type) {
      case 'text-delta':
        reply.text = (reply.text + e.text).slice(0, 100_000)
        send({ type: 'delta', ...ids, text: e.text })
        saveSoon()
        return
      case 'thinking-delta':
        reply.thinking = ((reply.thinking ?? '') + e.text).slice(0, 100_000)
        send({ type: 'delta', ...ids, text: e.text, kind: 'thinking' })
        saveSoon()
        return
      case 'thinking-tokens':
        reply.thinkingTokens = e.tokens
        send({ type: 'thinking-tokens', ...ids, tokens: e.tokens })
        return
      case 'tool': {
        const step: WorkStep = e.step
        const steps = (reply.steps ??= [])
        const i = steps.findIndex((s) => s.id === step.id)
        if (i >= 0) steps[i] = step
        else if (steps.length < 200) steps.push(step)
        send({ type: 'step', ...ids, step })
        saveSoon()
        return
      }
      case 'session':
        if (e.id) thread.sessions = { ...thread.sessions, [agentId]: e.id.slice(0, 200) }
        return
      case 'usage': {
        const ctx = e.contextTokens ?? (e.inputTokens || e.outputTokens ? (e.inputTokens ?? 0) + (e.outputTokens ?? 0) : 0)
        if (ctx) reply.contextTokens = ctx
        sendProvider({ type: 'usage', ...ids, contextTokens: e.contextTokens, inputTokens: e.inputTokens, outputTokens: e.outputTokens })
        return
      }
      case 'limits':
        void recordLimits(agentId, e.windows)
        return
      case 'plan':
        reply.plan = e.plan
        sendProvider({ type: 'plan', ...ids, plan: e.plan })
        saveSoon()
        return
      case 'approval-request': {
        const rec: ApprovalRecord = { ...e.request, status: 'pending' }
        reply.approvals = [...(reply.approvals ?? []), rec].slice(-100)
        sendProvider({ type: 'approval', ...ids, request: e.request })
        void persist(brandId).catch(() => {})
        return
      }
      case 'user-input-request':
        live.inputs.push(e.request)
        sendProvider({ type: 'user-input', ...ids, request: e.request })
        return
      // steer() saves the message itself, errors come back as a throw from sendTurn
      case 'steered':
      case 'error':
      case 'turn-end':
        return
    }
  }

  const finish = (status: ThreadMessage['status'], error?: string): void => {
    reply.status = status
    reply.finishedAt = Date.now()
    if (error) reply.error = error.slice(0, 2000)
    for (const s of reply.steps ?? []) if (s.status === 'running') s.status = status === 'done' ? 'done' : 'error'
    for (const a of reply.approvals ?? []) {
      if (a.status !== 'pending') continue
      a.status = 'expired'
      sendProvider({ type: 'approval-resolved', ...ids, requestId: a.requestId, status: 'expired' })
    }
    for (const r of live.inputs.splice(0)) sendProvider({ type: 'user-input-resolved', ...ids, requestId: r.requestId })
    // the agent's session now knows everything up to this reply
    if (status === 'done') thread.seen = { ...thread.seen, [agentId]: reply.id }
    thread.updatedAt = Date.now()
    runs.delete(key)
    void persist(brandId).catch(() => {})
    send({ type: 'done', ...ids, status: status ?? 'done', error })
    send({ type: 'threads', brandId })
    // a stopped reply holds the queue so the user can look first
    if (status !== 'stopped') void drainQueue(brandId, thread)
  }

  // the agent server only lets an agent in while its turn is open, the turn ends with the reply
  let turn: AgentSession | null = null
  let session: ProviderSession | null = null

  try {
    const brand = getData()?.brands.find((b) => b.id === brandId)
    if (!brand) throw new Error('That brand is gone')
    const base = await brandContext(brand, thread.id)
    // the user message and the empty reply are the last two
    const userMsg = thread.messages[thread.messages.length - 2]
    const message = userMsg ? turnText(userMsg) : ''
    // every prompt carries the brand voice pack, cut to the brand's own size or to what still fits
    let voice = await getBrandContext(brandId)
    const room = voiceRoom(base.length + message.length)
    if (voice.chars > room) voice = await getBrandContext(brandId, undefined, room)
    const context = `${base}\n\n${voice.text}`
    const histRoom = historyRoom(context.length + message.length)
    const past = history(thread, 2, histRoom)
    const sentVoice = voiceHash(voice.text)
    const model = thread.models?.[agentId] || undefined
    const effort = thread.efforts?.[agentId] || undefined
    const permissionMode = await modeFor(brandId, thread)
    const custom = CLIS.some((c) => c.id === agentId) ? null : await getCustom(agentId)
    if (!CLIS.some((c) => c.id === agentId) && !custom) throw new Error('That agent was removed. Pick another one.')

    // the prompt for a fresh session or a resumed one. a resumed session already has the
    // brand, the voice and the chat so far: it gets the new message, the voice pack again
    // only when it changed, and a handoff of turns other agents answered since it last looked
    const promptFor = (resumed: boolean): string => {
      if (!resumed) {
        const handoff = buildHandoff(thread.messages.slice(0, -2), agentId, agentName, histRoom)
        if (handoff) {
          reply.handoffFrom = handoff.from
          sendProvider({ type: 'handoff', ...ids, fromAgentIds: handoff.from, toAgentId: agentId })
          return [context, '', handoff.text, '', '## New message from the user', message].join('\n')
        }
        return flatPrompt(context, past, message)
      }
      const parts: string[] = []
      if (thread.voiceSent?.[agentId] !== sentVoice) parts.push(voice.text, '')
      const handoff = buildHandoff(missedSince(thread, agentId, 2), agentId, agentName, histRoom)
      if (handoff) {
        reply.handoffFrom = handoff.from
        sendProvider({ type: 'handoff', ...ids, fromAgentIds: handoff.from, toAgentId: agentId })
        parts.push(handoff.text, '')
      }
      if (!parts.length) return message
      return [...parts, '## New message from the user', message].join('\n')
    }

    // plain api agents are one request with no process and no tool calls, so they get no turn
    const needsTools = !(custom && custom.kind === 'api')
    const openTurn = async (): Promise<AgentSession | null> =>
      needsTools ? (turn ??= await beginAgentTurn(brandId, attachKind(agentId), { threadId: thread.id, messageId: reply.id })) : null

    const run = async (adapter: ProviderAdapter, resume: string | undefined): Promise<void> => {
      const start: SessionStart = {
        agentId,
        brandId,
        threadId: thread.id,
        resume,
        model,
        effort,
        permissionMode,
        mcp: await openTurn(),
        emit,
        signal: ctl.signal
      }
      await session?.close()
      session = await adapter.startSession(start)
      live.session = session
      const text = promptFor(resume !== undefined)
      thread.voiceSent = { ...thread.voiceSent, [agentId]: sentVoice }
      await session.sendTurn({ text, system: context, history: past, message })
    }

    let adapter = adapterFor(agentId)
    // legacy clis only resume when the catalog says they can
    const canResume = (a: ProviderAdapter): boolean =>
      a.capabilities.resume || (a === fallbackAdapter && !!CLIS.find((c) => c.id === agentId)?.resume)
    let resume = canResume(adapter) ? thread.sessions?.[agentId] : undefined
    try {
      await run(adapter, resume)
    } catch (err) {
      if (ctl.signal.aborted) throw err
      if (err instanceof ProviderUnavailable && adapter !== fallbackAdapter) {
        // e.g. a codex too old for app-server: this turn and the next go the old way
        markUnavailable(agentId)
        adapter = fallbackAdapter
        resume = canResume(adapter) ? thread.sessions?.[agentId] : undefined
        if (!reply.text) await run(adapter, resume)
        else throw err
      } else if (resume && !reply.text) {
        // the agent lost the session (cleared, other machine), start over with the full prompt
        if (thread.sessions) delete thread.sessions[agentId]
        if (thread.seen) delete thread.seen[agentId]
        await run(adapter, undefined)
      } else throw err
    }
    if (ctl.signal.aborted) finish('stopped')
    else if (!reply.text.trim()) finish('error', 'The agent finished without saying anything')
    else finish('done')
  } catch (err) {
    if (ctl.signal.aborted) finish('stopped')
    else finish('error', err instanceof Error ? err.message : String(err))
  } finally {
    await (session as ProviderSession | null)?.close().catch(() => {})
    live.session = null
    // the process has exited by now, its token dies with the turn
    await (turn as AgentSession | null)?.end()
  }
}

function newReply(agentId: string, model: string | undefined): ThreadMessage {
  const reply: ThreadMessage = { id: randomUUID(), role: 'agent', text: '', at: Date.now(), agentId, status: 'streaming' }
  if (model) reply.model = model
  return reply
}

// saves a user message and its empty reply, then starts the agent
async function sendMessage(
  brandId: string,
  threadId: string | null,
  text: string,
  agentId: string,
  o: SendOptions = {}
): Promise<SendResult & { userId: string }> {
  const body = text.trim().slice(0, MAX_MESSAGE)
  if (!body) throw new Error('empty message')
  const now = Date.now()
  let thread = threadId ? await findThread(brandId, threadId) : null
  if (thread && runs.has(runKey(brandId, thread.id))) throw new Error('Still answering the last message')
  if (!thread) {
    thread = { id: randomUUID(), title: titleFrom(body), updatedAt: now, agentId, messages: [] }
    const mode = await brandMode(brandId)
    thread.permissionMode = mode
    await addThread(brandId, thread)
  }
  if (typeof o.model === 'string') thread.models = { ...thread.models, [agentId]: o.model.slice(0, 120) }
  if (typeof o.effort === 'string') thread.efforts = { ...thread.efforts, [agentId]: o.effort.slice(0, 20) }
  const reply = newReply(agentId, thread.models?.[agentId] || undefined)
  const files = cleanAttachments(o.attachments)
  const userMsg: ThreadMessage = { id: randomUUID(), role: 'user', text: body, at: now }
  if (files.length) userMsg.attachments = files
  thread.messages.push(userMsg, reply)
  thread.agentId = agentId
  thread.archived = false
  thread.updatedAt = now
  await persist(brandId)
  send({ type: 'threads', brandId })
  startRun(brandId, thread, reply, agentId)
  return { threadId: thread.id, messageId: reply.id, userId: userMsg.id }
}

function queueChanged(brandId: string, thread: Thread): void {
  sendProvider({ type: 'queue', brandId, threadId: thread.id, queue: thread.queued ?? [] })
}

// the next queued message goes out once the reply before it is done
async function drainQueue(brandId: string, thread: Thread): Promise<void> {
  const next = thread.queued?.[0]
  if (!next || runs.has(runKey(brandId, thread.id))) return
  thread.queued = thread.queued!.slice(1)
  queueChanged(brandId, thread)
  try {
    await sendMessage(brandId, thread.id, next.text, next.agentId)
  } catch {
    // put it back, the user can send it by hand
    thread.queued = [next, ...(thread.queued ?? [])]
    queueChanged(brandId, thread)
    await persist(brandId).catch(() => {})
  }
}

async function enqueue(brandId: string, thread: Thread, text: string, agentId: string, front = false): Promise<QueuedMessage> {
  const q: QueuedMessage = { id: randomUUID(), text: text.trim().slice(0, MAX_MESSAGE), agentId: agentId.slice(0, 80), at: Date.now() }
  const list = thread.queued ?? []
  if (list.length >= MAX_QUEUE) throw new Error('The queue is full')
  thread.queued = front ? [q, ...list] : [...list, q]
  await persist(brandId)
  queueChanged(brandId, thread)
  return q
}

// into the running reply when the agent can take it, otherwise queued, or sent when idle
async function steer(brandId: string, thread: Thread, text: string, agentId: string, front = false): Promise<SteerResult> {
  const body = text.trim().slice(0, MAX_MESSAGE)
  if (!body) throw new Error('empty message')
  const live = runs.get(runKey(brandId, thread.id))
  if (!live) {
    const r = await sendMessage(brandId, thread.id, body, agentId)
    return { mode: 'sent', threadId: thread.id, messageId: r.userId, replyId: r.messageId }
  }
  if (live.agentId === agentId && live.session && (await live.session.steer(body).catch(() => false))) {
    const msg: ThreadMessage = { id: randomUUID(), role: 'user', text: body, at: Date.now(), steer: true }
    // saved right before the reply it went into
    const i = thread.messages.indexOf(live.reply)
    thread.messages.splice(i >= 0 ? i : thread.messages.length, 0, msg)
    await persist(brandId)
    sendProvider({ type: 'steer', brandId, threadId: thread.id, messageId: live.reply.id, message: msg })
    return { mode: 'steered', threadId: thread.id, messageId: msg.id }
  }
  const q = await enqueue(brandId, thread, body, agentId, front)
  return { mode: 'queued', threadId: thread.id, queueId: q.id }
}

export function stopBrand(brandId: string): void {
  for (const [key, live] of runs) if (key.startsWith(`${brandId}:`)) live.ctl.abort()
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

export function setupAgents(): void {
  // don't leave agents running after the app is gone
  app.on('before-quit', () => {
    for (const live of runs.values()) live.ctl.abort()
  })

  ipcMain.handle('chat:agents', (_e, rescan: unknown) => listAgents(rescan === true))
  ipcMain.handle('chat:config', () => getConfig())
  ipcMain.handle('chat:save-agent', (_e, input: CustomAgentInput) => saveCustom(input))
  ipcMain.handle('chat:remove-agent', (_e, id: unknown) => (validId(id) ? removeCustom(id) : getConfig()))
  ipcMain.handle('chat:default-agent', (_e, id: unknown) => setDefault(typeof id === 'string' ? id : null))

  ipcMain.handle('chat:threads', async (_e, brandId: unknown) => {
    if (!validId(brandId)) return []
    const threads = await threadsFor(brandId)
    return threads
      .map((t) => ({
        id: t.id,
        title: t.title,
        updatedAt: t.updatedAt,
        busy: runs.has(runKey(brandId, t.id)),
        archived: t.archived === true,
        agentName: t.agentId ? agentName(t.agentId) : '',
        model: t.agentId ? t.models?.[t.agentId] ?? '' : '',
        activity: [...(t.messages.at(-1)?.steps ?? [])].reverse().find((step) => step.status === 'running')?.label ?? '',
        preview: t.messages.at(-1)?.text.replace(/\s+/g, ' ').slice(0, 140) ?? ''
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  })

  ipcMain.handle('chat:thread', async (_e, brandId: unknown, threadId: unknown) => {
    if (!validId(brandId) || !validId(threadId)) return null
    return findThread(brandId, threadId)
  })

  ipcMain.handle('chat:delete', async (_e, brandId: unknown, threadId: unknown) => {
    if (!validId(brandId) || !validId(threadId)) return
    runs.get(runKey(brandId, threadId))?.ctl.abort()
    await removeThread(brandId, threadId)
    send({ type: 'threads', brandId })
  })

  ipcMain.handle(
    'chat:send',
    async (_e, brandId: unknown, threadId: unknown, text: unknown, agentId: unknown, opts: unknown) => {
      if (!validId(brandId)) throw new Error('bad brand id')
      if (typeof text !== 'string' || !text.trim()) throw new Error('empty message')
      if (typeof agentId !== 'string' || !agentId) throw new Error('Pick an agent first')
      const { threadId: id, messageId } = await sendMessage(
        brandId,
        validId(threadId) ? threadId : null,
        text,
        agentId,
        (opts ?? {}) as SendOptions
      )
      return { threadId: id, messageId }
    }
  )

  // retry and edit both change what came before, so the agent's own session can't be reused
  const rerun = async (brandId: string, thread: Thread, agentId: string): Promise<SendResult> => {
    thread.sessions = {}
    thread.voiceSent = {}
    thread.seen = {}
    thread.agentId = agentId
    const reply = newReply(agentId, thread.models?.[agentId] || undefined)
    thread.messages.push(reply)
    thread.updatedAt = Date.now()
    await persist(brandId)
    send({ type: 'threads', brandId })
    startRun(brandId, thread, reply, agentId)
    return { threadId: thread.id, messageId: reply.id }
  }

  ipcMain.handle('chat:retry', async (_e, brandId: unknown, threadId: unknown, agentId: unknown) => {
    if (!validId(brandId) || !validId(threadId)) throw new Error('bad id')
    if (typeof agentId !== 'string' || !agentId) throw new Error('Pick an agent first')
    const thread = await findThread(brandId, threadId)
    if (!thread) throw new Error('That chat is gone')
    if (runs.has(runKey(brandId, threadId))) throw new Error('Still answering the last message')
    while (thread.messages.at(-1)?.role === 'agent') thread.messages.pop()
    if (!thread.messages.length) throw new Error('Nothing to retry')
    return rerun(brandId, thread, agentId)
  })

  ipcMain.handle(
    'chat:edit',
    async (_e, brandId: unknown, threadId: unknown, messageId: unknown, text: unknown, agentId: unknown) => {
      if (!validId(brandId) || !validId(threadId) || !validId(messageId)) throw new Error('bad id')
      if (typeof text !== 'string' || !text.trim()) throw new Error('empty message')
      if (typeof agentId !== 'string' || !agentId) throw new Error('Pick an agent first')
      const thread = await findThread(brandId, threadId)
      if (!thread) throw new Error('That chat is gone')
      if (runs.has(runKey(brandId, threadId))) throw new Error('Still answering the last message')
      const i = thread.messages.findIndex((m) => m.id === messageId && m.role === 'user')
      if (i < 0) throw new Error('That message is gone')
      thread.messages[i] = { ...thread.messages[i], text: text.trim().slice(0, MAX_MESSAGE), at: Date.now() }
      thread.messages.splice(i + 1)
      return rerun(brandId, thread, agentId)
    }
  )

  ipcMain.handle('chat:rename', async (_e, brandId: unknown, threadId: unknown, title: unknown) => {
    if (!validId(brandId) || !validId(threadId) || typeof title !== 'string' || !title.trim()) return
    const thread = await findThread(brandId, threadId)
    if (!thread) return
    thread.title = title.replace(/\s+/g, ' ').trim().slice(0, 80)
    await persist(brandId)
    send({ type: 'threads', brandId })
  })

  ipcMain.handle('chat:archive', async (_e, brandId: unknown, threadId: unknown, archived: unknown) => {
    if (!validId(brandId) || !validId(threadId)) return
    const thread = await findThread(brandId, threadId)
    if (!thread) return
    thread.archived = archived === true
    await persist(brandId)
    send({ type: 'threads', brandId })
  })

  ipcMain.handle('chat:search', async (_e, brandId: unknown, query: unknown) => {
    if (!validId(brandId) || typeof query !== 'string') return []
    const q = query.trim().toLowerCase().slice(0, 200)
    if (!q) return []
    const threads = await threadsFor(brandId)
    return threads
      .filter((t) => t.title.toLowerCase().includes(q) || t.messages.some((m) => m.text.toLowerCase().includes(q)))
      .map((t) => t.id)
  })

  ipcMain.handle('chat:model', async (_e, brandId: unknown, threadId: unknown, agentId: unknown, model: unknown) => {
    if (!validId(brandId) || !validId(threadId) || typeof agentId !== 'string' || typeof model !== 'string') return
    const thread = await findThread(brandId, threadId)
    if (!thread) return
    thread.models = { ...thread.models, [agentId.slice(0, 80)]: model.slice(0, 120) }
    thread.agentId = agentId.slice(0, 80)
    await persist(brandId)
  })

  ipcMain.handle('chat:effort', async (_e, brandId: unknown, threadId: unknown, agentId: unknown, effort: unknown) => {
    if (!validId(brandId) || !validId(threadId) || typeof agentId !== 'string' || typeof effort !== 'string') return
    const thread = await findThread(brandId, threadId)
    if (!thread) return
    thread.efforts = { ...thread.efforts, [agentId.slice(0, 80)]: effort.slice(0, 20) }
    await persist(brandId)
  })

  // live from the agent where it can list them (claude, codex, api agents), the known list otherwise
  ipcMain.handle('chat:models', async (_e, agentId: unknown) => {
    if (typeof agentId !== 'string' || agentId.length > 80) return DEFAULT_MODEL
    return adapterFor(agentId).listModels(agentId)
  })

  ipcMain.handle(
    'chat:decide',
    async (_e, brandId: unknown, threadId: unknown, messageId: unknown, card: unknown, decision: unknown) => {
      if (!validId(brandId) || !validId(threadId) || !validId(messageId)) return
      if (typeof card !== 'string' || card.length > 20) return
      if (decision !== 'approved' && decision !== 'declined') return
      const thread = await findThread(brandId, threadId)
      const msg = thread?.messages.find((m) => m.id === messageId && m.role === 'agent')
      // a pick is final
      if (!msg || msg.decisions?.[card]) return
      msg.decisions = { ...msg.decisions, [card]: decision }
      await persist(brandId)
    }
  )

  // reads what's known, never starts an agent
  ipcMain.handle('chat:usage', async () => {
    const agents = (await listAgents(false)).filter((a) => a.installed)
    return usageFor(agents.map((a) => a.id))
  })

  ipcMain.handle('chat:stop', (_e, brandId: unknown, threadId: unknown) => {
    if (!validId(brandId) || !validId(threadId)) return
    runs.get(runKey(brandId, threadId))?.ctl.abort()
  })

  // ---- provider layer: approvals, questions, steer and queue, permission modes ----

  ipcMain.handle('chat:providers', async (): Promise<ProviderInfo[]> => {
    const agents = await listAgents(false)
    return Promise.all(agents.map((a) => providerInfo(a.id)))
  })

  ipcMain.handle(
    'chat:approval',
    async (_e, brandId: unknown, threadId: unknown, requestId: unknown, decision: unknown, opts: unknown) => {
      if (!validId(brandId) || !validId(threadId) || typeof requestId !== 'string') return false
      if (decision !== 'allow' && decision !== 'deny') return false
      const live = runs.get(runKey(brandId, threadId))
      const rec = live?.reply.approvals?.find((a) => a.requestId === requestId)
      if (!live?.session || !rec || rec.status !== 'pending') return false
      const o = (opts ?? {}) as { feedback?: unknown; remember?: unknown }
      const feedback = str(o.feedback, 2000) ?? undefined
      if (!live.session.respondToApproval(requestId, decision, { feedback, remember: o.remember === true })) return false
      rec.status = decision === 'allow' ? 'allowed' : 'denied'
      if (feedback) rec.feedback = feedback
      await persist(brandId).catch(() => {})
      sendProvider({ type: 'approval-resolved', brandId, threadId, messageId: live.reply.id, requestId, status: rec.status })
      return true
    }
  )

  ipcMain.handle('chat:user-input', async (_e, brandId: unknown, threadId: unknown, requestId: unknown, answers: unknown) => {
    if (!validId(brandId) || !validId(threadId) || typeof requestId !== 'string') return false
    const live = runs.get(runKey(brandId, threadId))
    const i = live?.inputs.findIndex((r) => r.requestId === requestId) ?? -1
    if (!live?.session || i < 0) return false
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries((answers ?? {}) as Record<string, unknown>).slice(0, 20)) {
      if (typeof v === 'string') clean[k.slice(0, 300)] = v.slice(0, 4000)
    }
    if (!live.session.respondToUserInput(requestId, clean)) return false
    live.inputs.splice(i, 1)
    sendProvider({ type: 'user-input-resolved', brandId, threadId, messageId: live.reply.id, requestId })
    return true
  })

  ipcMain.handle('chat:pending', (_e, brandId: unknown, threadId: unknown) => {
    const none = { approvals: [] as ApprovalRecord[], inputs: [] as UserInputRequest[] }
    if (!validId(brandId) || !validId(threadId)) return none
    const live = runs.get(runKey(brandId, threadId))
    if (!live) return none
    return { approvals: (live.reply.approvals ?? []).filter((a) => a.status === 'pending'), inputs: [...live.inputs] }
  })

  ipcMain.handle('chat:steer', async (_e, brandId: unknown, threadId: unknown, text: unknown, agentId: unknown) => {
    if (!validId(brandId) || !validId(threadId)) throw new Error('bad id')
    if (typeof text !== 'string' || !text.trim()) throw new Error('empty message')
    if (typeof agentId !== 'string' || !agentId) throw new Error('Pick an agent first')
    const thread = await findThread(brandId, threadId)
    if (!thread) throw new Error('That chat is gone')
    return steer(brandId, thread, text, agentId)
  })

  ipcMain.handle('chat:queue', async (_e, brandId: unknown, threadId: unknown, text: unknown, agentId: unknown) => {
    if (!validId(brandId) || !validId(threadId)) throw new Error('bad id')
    if (typeof text !== 'string' || !text.trim()) throw new Error('empty message')
    if (typeof agentId !== 'string' || !agentId) throw new Error('Pick an agent first')
    const thread = await findThread(brandId, threadId)
    if (!thread) throw new Error('That chat is gone')
    await enqueue(brandId, thread, text, agentId)
    // nothing running, so it goes right away
    if (!runs.has(runKey(brandId, threadId))) await drainQueue(brandId, thread)
    return thread.queued ?? []
  })

  ipcMain.handle('chat:unqueue', async (_e, brandId: unknown, threadId: unknown, queueId: unknown) => {
    if (!validId(brandId) || !validId(threadId) || typeof queueId !== 'string') return []
    const thread = await findThread(brandId, threadId)
    if (!thread) return []
    thread.queued = (thread.queued ?? []).filter((q) => q.id !== queueId)
    await persist(brandId)
    queueChanged(brandId, thread)
    return thread.queued
  })

  ipcMain.handle('chat:queue-steer', async (_e, brandId: unknown, threadId: unknown, queueId: unknown) => {
    if (!validId(brandId) || !validId(threadId) || typeof queueId !== 'string') throw new Error('bad id')
    const thread = await findThread(brandId, threadId)
    const q = thread?.queued?.find((x) => x.id === queueId)
    if (!thread || !q) throw new Error('That message left the queue')
    thread.queued = thread.queued!.filter((x) => x.id !== queueId)
    queueChanged(brandId, thread)
    // can't go in: it goes back to the front of the queue
    return steer(brandId, thread, q.text, q.agentId, true)
  })

  ipcMain.handle('chat:queue-list', async (_e, brandId: unknown, threadId: unknown) => {
    if (!validId(brandId) || !validId(threadId)) return []
    return (await findThread(brandId, threadId))?.queued ?? []
  })

  ipcMain.handle('chat:permission-mode', async (_e, brandId: unknown, threadId: unknown) => {
    if (!validId(brandId)) return brandMode('')
    const thread = validId(threadId) ? await findThread(brandId, threadId) : null
    return modeFor(brandId, thread)
  })

  ipcMain.handle('chat:set-permission-mode', async (_e, brandId: unknown, threadId: unknown, mode: unknown) => {
    if (!validId(brandId) || !isPermissionMode(mode)) throw new Error('bad permission mode')
    if (!validId(threadId)) {
      await setBrandMode(brandId, mode)
      return mode
    }
    const thread = await findThread(brandId, threadId)
    if (!thread) throw new Error('That chat is gone')
    thread.permissionMode = mode
    await persist(brandId)
    // a running reply picks it up from its next tool call where the agent allows it
    await runs.get(runKey(brandId, threadId))?.session?.setPermissionMode(mode).catch(() => {})
    sendProvider({ type: 'permission-mode', brandId, threadId, mode })
    return mode
  })
}
