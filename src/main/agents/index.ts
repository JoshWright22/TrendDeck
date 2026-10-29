import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { ID_PATTERN } from '@shared/types'
import { ACCOUNT_ENV, AUTO_AGENT, baseAgentId, isAccountId } from '@shared/agents'
import type {
  AgentAccount,
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
import { CLIS, cliFor } from './catalog'
import {
  accountEnv,
  getAccount,
  getConfig,
  getCustom,
  removeAccount,
  removeCustom,
  saveAccount,
  saveCustom,
  setDefault,
  setRank
} from './config'
import { which } from './detect'
import { agentEnv } from './run'
import { blockedFor, classifyAgentError, cooldownFor, limitReply, noneLeftMessage, pickAgent, plainError, type Pick } from './route'
import { brandContext, flatPrompt, history, historyRoom, turnNotes, turnText, voiceHash, voiceRoom } from './context'
import { getBrandContext } from '../voice'
import { addThread, cleanAttachments, dropChats, findThread, persist, removeThread, threadsFor } from './history'
import { beginAgentTurn, type AgentKind, type AgentSession } from '../mcp'
import { clearAuthCooldowns, clearCooldown, liveCooldowns, recordLimits, setCooldown, usageFor, windowsFor } from './usage'
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

// the builtin clis, each followed by its extra accounts
async function detect(): Promise<AgentInfo[]> {
  const { accounts } = await getConfig()
  const entries = CLIS.flatMap((c) => [
    { id: c.id, name: c.name, cli: c, folder: undefined as string | undefined },
    ...accounts.filter((a) => baseAgentId(a.id) === c.id).map((a) => ({ id: a.id, name: a.name, cli: c, folder: a.folder }))
  ])
  const found = await Promise.all(
    entries.map(async ({ id, name, cli: c, folder }): Promise<AgentInfo> => {
      const adapter = adapterFor(id)
      const health = await adapter.health(id)
      const info = await providerInfo(id)
      const out: AgentInfo = {
        id,
        name,
        kind: 'cli',
        installed: health.installed,
        detail: health.detail,
        setup: c.setup,
        url: c.url,
        models: c.modelFlag ? (c.models ?? DEFAULT_MODEL) : DEFAULT_MODEL,
        efforts: c.efforts,
        provider: info.kind,
        capabilities: info.capabilities,
        signedIn: health.signedIn
      }
      if (folder) {
        out.base = c.id
        out.folder = folder
      }
      return out
    })
  )
  detected = found
  return found
}

async function listAgents(rescan: boolean): Promise<AgentInfo[]> {
  // signing in again is what a rescan is for, so auto gives those agents another go
  if (rescan) await clearAuthCooldowns()
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
  if (agentId === AUTO_AGENT) return 'Auto'
  return CLIS.find((c) => c.id === agentId)?.name ?? detected?.find((a) => a.id === agentId)?.name ?? agentId
}

// the folder the usual account of a cli uses
function defaultFolder(base: string): string {
  if (base === 'claude') return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

const LOGIN: Record<string, string> = { claude: 'claude /login', codex: 'codex login' }

// a console window running the cli's own login with the account's folder set. you sign in there
// yourself, the app never sees what goes on in it
async function openSignIn(agentId: string): Promise<void> {
  const base = baseAgentId(agentId)
  const login = LOGIN[base]
  const cli = cliFor(agentId)
  if (!login || !cli) throw new Error('That agent signs in its own way')
  if (agentId !== base && !(await getAccount(agentId))) throw new Error('That account was removed')
  let path: string | null = null
  for (const bin of cli.bins) {
    path = await which(bin)
    if (path) break
  }
  if (!path) throw new Error(`${cli.name} isn't installed or isn't on PATH`)
  const extra = await accountEnv(agentId)
  const env: NodeJS.ProcessEnv = { ...agentEnv(extra) }
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  // the cli was found on a path the console might not have
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  env[pathKey] = [dirname(path), env[pathKey]].filter(Boolean).join(delimiter)
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/d', '/c', `start "TrendDeck sign in" cmd.exe /k ${login}`], {
      env,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true
    })
    child.on('error', () => {})
    child.unref()
    return
  }
  const q = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`
  const line = [...Object.entries(extra).map(([k, v]) => `export ${k}=${q(v)}`), `export PATH=${q(dirname(path))}:"$PATH"`, login].join('; ')
  const child =
    process.platform === 'darwin'
      ? spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`, '-e', 'tell application "Terminal" to activate'], {
          detached: true,
          stdio: 'ignore'
        })
      : spawn('x-terminal-emulator', ['-e', 'sh', '-c', `${line}; exec sh`], { env, detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

// the next agent auto would use, past the ones in exclude. sign ins are checked again for the
// ones that looked signed out, that's only a file check
async function pickAuto(exclude: string[]): Promise<Pick> {
  const [agents, cfg, cooldowns] = await Promise.all([listAgents(false), getConfig(), liveCooldowns()])
  const fresh = await Promise.all(
    agents.map(async (a) => {
      if (a.signedIn !== false) return a
      const h = await adapterFor(a.id).health(a.id)
      a.signedIn = h.signedIn
      a.installed = h.installed
      return a
    })
  )
  const usage = await windowsFor(fresh.filter((a) => a.installed).map((a) => a.id))
  return pickAgent({
    agents: fresh.map((a) => ({ id: a.id, installed: a.installed, signedIn: a.signedIn })),
    rank: cfg.rank,
    autoOff: cfg.autoOff,
    usage,
    cooldowns,
    now: Date.now(),
    exclude
  })
}

// one run per thread at a time
interface Live {
  ctl: AbortController
  // the agent answering right now. with auto it can change mid reply
  agentId: string
  auto: boolean
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
  const base = baseAgentId(agentId)
  return base === 'claude' || base === 'codex' || base === 'opencode' ? base : 'generic'
}

async function modeFor(brandId: string, thread: Thread | null): Promise<PermissionMode> {
  return thread?.permissionMode ?? (await brandMode(brandId))
}

function startRun(brandId: string, thread: Thread, reply: ThreadMessage, agentId: string, auto: boolean): void {
  const live: Live = { ctl: new AbortController(), agentId, auto, thread, reply, session: null, inputs: [] }
  runs.set(runKey(brandId, thread.id), live)
  void runReply(brandId, live)
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function runReply(brandId: string, live: Live): Promise<void> {
  const { thread, reply, ctl } = live
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
        if (e.id) thread.sessions = { ...thread.sessions, [live.agentId]: e.id.slice(0, 200) }
        return
      case 'usage': {
        const ctx = e.contextTokens ?? (e.inputTokens || e.outputTokens ? (e.inputTokens ?? 0) + (e.outputTokens ?? 0) : 0)
        if (ctx) reply.contextTokens = ctx
        sendProvider({ type: 'usage', ...ids, contextTokens: e.contextTokens, inputTokens: e.inputTokens, outputTokens: e.outputTokens })
        return
      }
      case 'limits':
        void recordLimits(live.agentId, e.windows)
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
    if (status === 'done') thread.seen = { ...thread.seen, [live.agentId]: reply.id }
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
    // auto found nobody when the message went out
    if (live.agentId === AUTO_AGENT) {
      throw new Error(noneLeftMessage(await pickAuto([]), [], agentName, Date.now()))
    }
    const base = await brandContext(brand, thread.id)
    // the user message and the empty reply are the last two
    const userMsg = thread.messages[thread.messages.length - 2]
    // with what the user changed in the chat's Craft editors since the last reply
    const message = userMsg ? turnText(userMsg) + (await turnNotes(brandId, thread.id)) : ''
    // every prompt carries the brand voice pack, cut to the brand's own size or to what still fits
    let voice = await getBrandContext(brandId)
    const room = voiceRoom(base.length + message.length)
    if (voice.chars > room) voice = await getBrandContext(brandId, undefined, room)
    const context = `${base}\n\n${voice.text}`
    const histRoom = historyRoom(context.length + message.length)
    const past = history(thread, 2, histRoom)
    const sentVoice = voiceHash(voice.text)
    const permissionMode = await modeFor(brandId, thread)

    // one agent's go at the reply. fresh skips its saved session, for an agent auto moved to
    const attempt = async (agentId: string, fresh: boolean): Promise<void> => {
      const model = thread.models?.[agentId] || undefined
      const effort = thread.efforts?.[agentId] || undefined
      const cli = cliFor(agentId)
      const custom = cli ? null : await getCustom(agentId)
      if (!cli && !custom) throw new Error('That agent was removed. Pick another one.')
      if (isAccountId(agentId) && !(await getAccount(agentId))) throw new Error('That account was removed. Pick another agent.')
      if (agentId.includes('@') && !isAccountId(agentId)) throw new Error('That agent was removed. Pick another one.')
      const env = await accountEnv(agentId)

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
          env,
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
      const canResume = (a: ProviderAdapter): boolean => a.capabilities.resume || (a === fallbackAdapter && !!cli?.resume)
      let resume = !fresh && canResume(adapter) ? thread.sessions?.[agentId] : undefined
      try {
        await run(adapter, resume)
      } catch (err) {
        if (ctl.signal.aborted) throw err
        if (err instanceof ProviderUnavailable && adapter !== fallbackAdapter) {
          // e.g. a codex too old for app-server: this turn and the next go the old way
          markUnavailable(agentId)
          adapter = fallbackAdapter
          resume = !fresh && canResume(adapter) ? thread.sessions?.[agentId] : undefined
          if (!reply.text) await run(adapter, resume)
          else throw err
        } else if (resume && !reply.text && classifyAgentError(errText(err)) === 'other') {
          // the agent lost the session (cleared, other machine), start over with the full prompt
          if (thread.sessions) delete thread.sessions[agentId]
          if (thread.seen) delete thread.seen[agentId]
          await run(adapter, undefined)
        } else throw err
      }
      if (ctl.signal.aborted) return
      // claude code sometimes prints its limit or login notice as the reply itself
      const notice = reply.steps?.length ? 'other' : limitReply(reply.text)
      if (notice !== 'other') {
        const text = reply.text
        reply.text = ''
        throw new Error(text)
      }
    }

    // agents auto already tried for this reply, and when each is back
    const tried: { agentId: string; until: number | null }[] = []
    for (let fresh = false; ; fresh = true) {
      const agentId = live.agentId
      try {
        await attempt(agentId, fresh)
        break
      } catch (err) {
        if (ctl.signal.aborted) throw err
        const text = errText(err)
        const kind = classifyAgentError(text)
        if (kind === 'other') throw err
        const now = Date.now()
        const cooldown = cooldownFor(kind, text, now)
        await setCooldown(agentId, cooldown)
        // only a reply with nothing to show and no tool run behind it moves on, so no tool runs twice
        const untouched = !reply.text.trim() && !reply.steps?.length && !reply.approvals?.length
        if (!live.auto || !untouched) throw new Error(plainError(kind, agentName(agentId), cooldown.until, now))
        tried.push({ agentId, until: cooldown.until })
        reply.skipped = [...(reply.skipped ?? []), { agentId, reason: kind }]
        // this agent's process and tool turn go, the next agent opens its own
        await (session as ProviderSession | null)?.close().catch(() => {})
        session = null
        live.session = null
        await (turn as AgentSession | null)?.end()
        turn = null
        const pick = await pickAuto(tried.map((t) => t.agentId))
        if (!pick.agentId) throw new Error(noneLeftMessage(pick, tried, agentName, Date.now()))
        live.agentId = pick.agentId
        reply.agentId = pick.agentId
        const model = thread.models?.[pick.agentId] || undefined
        if (model) reply.model = model
        else delete reply.model
        reply.thinking = undefined
        reply.thinkingTokens = undefined
        reply.handoffFrom = undefined
        reply.contextTokens = undefined
        reply.plan = undefined
        sendProvider({ type: 'reroute', ...ids, agentId: pick.agentId, model, skipped: reply.skipped })
        void persist(brandId).catch(() => {})
      }
    }
    if (ctl.signal.aborted) finish('stopped')
    else if (!reply.text.trim()) finish('error', 'The agent finished without saying anything')
    else {
      void clearCooldown(live.agentId)
      finish('done')
    }
  } catch (err) {
    if (ctl.signal.aborted) finish('stopped')
    else finish('error', errText(err))
  } finally {
    await (session as ProviderSession | null)?.close().catch(() => {})
    live.session = null
    // the process has exited by now, its token dies with the turn
    await (turn as AgentSession | null)?.end()
  }
}

// the agent a new reply starts on: the one asked for, or auto's first pick. 'auto' when auto
// has nobody, the reply then says why
async function replyAgent(agentId: string): Promise<string> {
  if (agentId !== AUTO_AGENT) return agentId
  return (await pickAuto([])).agentId ?? AUTO_AGENT
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
  const auto = agentId === AUTO_AGENT
  if (!auto && typeof o.model === 'string') thread.models = { ...thread.models, [agentId]: o.model.slice(0, 120) }
  if (!auto && typeof o.effort === 'string') thread.efforts = { ...thread.efforts, [agentId]: o.effort.slice(0, 20) }
  const answering = await replyAgent(agentId)
  const reply = newReply(answering, thread.models?.[answering] || undefined)
  const files = cleanAttachments(o.attachments)
  const userMsg: ThreadMessage = { id: randomUUID(), role: 'user', text: body, at: now }
  if (files.length) userMsg.attachments = files
  thread.messages.push(userMsg, reply)
  thread.agentId = agentId
  thread.archived = false
  thread.updatedAt = now
  await persist(brandId)
  send({ type: 'threads', brandId })
  startRun(brandId, thread, reply, answering, auto)
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
  const same = live.agentId === agentId || (live.auto && agentId === AUTO_AGENT)
  if (same && live.session &&(await live.session.steer(body).catch(() => false))) {
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

// a reply is being written somewhere, an update waits for it
export const agentsWorking = (): boolean => runs.size > 0

export function stopBrand(brandId: string): void {
  for (const [key, live] of runs) if (key.startsWith(`${brandId}:`)) live.ctl.abort()
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

export function setupAgents(): void {
  // don't leave agents running after the app is gone
  app.on('before-quit', () => {
    for (const live of runs.values()) live.ctl.abort()
  })

  // with what holds each one back from auto right now
  ipcMain.handle('chat:agents', async (_e, rescan: unknown) => {
    const agents = await listAgents(rescan === true)
    const now = Date.now()
    const [usage, cooldowns] = await Promise.all([windowsFor(agents.filter((a) => a.installed).map((a) => a.id)), liveCooldowns(now)])
    return agents.map((a): AgentInfo => {
      const b = blockedFor({ id: a.id, installed: a.installed, signedIn: a.signedIn }, usage[a.id], cooldowns[a.id], now)
      return b && b.why !== 'missing' && b.why !== 'signed_out' ? { ...a, held: { why: b.why, until: b.until } } : { ...a, held: undefined }
    })
  })
  ipcMain.handle('chat:config', () => getConfig())
  ipcMain.handle('chat:save-agent', (_e, input: CustomAgentInput) => saveCustom(input))
  ipcMain.handle('chat:remove-agent', (_e, id: unknown) => (validId(id) ? removeCustom(id) : getConfig()))
  ipcMain.handle('chat:default-agent', (_e, id: unknown) => setDefault(typeof id === 'string' ? id : null))
  ipcMain.handle('chat:rank', (_e, rank: unknown, autoOff: unknown) => setRank(rank, autoOff))

  ipcMain.handle('chat:save-account', async (_e, input: unknown) => {
    const a = (input ?? {}) as Partial<AgentAccount>
    if (typeof a.id !== 'string' || !isAccountId(a.id)) throw new Error('bad account id')
    if (typeof a.folder !== 'string' || !isAbsolute(a.folder)) throw new Error('Pick a folder for this account')
    if (a.folder.replace(/[\\/]+$/, '').toLowerCase() === defaultFolder(baseAgentId(a.id)).toLowerCase()) {
      throw new Error('That folder is the usual account already. Pick or make another one.')
    }
    // a new account starts in an empty folder the cli fills when you sign in
    await fs.mkdir(a.folder, { recursive: true })
    const cfg = await saveAccount({ id: a.id, name: String(a.name ?? ''), folder: a.folder })
    detected = null
    return cfg
  })
  ipcMain.handle('chat:remove-account', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !isAccountId(id)) return getConfig()
    const cfg = await removeAccount(id)
    detected = null
    return cfg
  })
  // names only, nothing inside the folders is read
  ipcMain.handle('chat:account-folders', async (_e, base: unknown) => {
    if (typeof base !== 'string' || !(base in ACCOUNT_ENV)) return { found: [], fresh: '' }
    const home = homedir()
    const { accounts } = await getConfig()
    // the usual account's folder and the ones other accounts use aren't offered
    const used = new Set([...accounts.map((a) => a.folder.toLowerCase()), defaultFolder(base).toLowerCase()])
    const names = await fs.readdir(home, { withFileTypes: true }).catch(() => [])
    const found = names
      .filter((d) => d.isDirectory() && d.name.toLowerCase().startsWith(`.${base}`) && d.name.toLowerCase() !== `.${base}`)
      .map((d) => join(home, d.name))
      .filter((p) => !used.has(p.toLowerCase()))
      .sort()
    const taken = new Set(names.map((d) => d.name.toLowerCase()))
    let n = 2
    while (taken.has(`.${base}-${n}`) || used.has(join(home, `.${base}-${n}`).toLowerCase())) n++
    return { found, fresh: join(home, `.${base}-${n}`) }
  })
  ipcMain.handle('chat:pick-folder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Pick the account folder',
      defaultPath: homedir(),
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles']
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle('chat:sign-in', async (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('bad agent id')
    await openSignIn(id)
  })

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
    const answering = await replyAgent(agentId)
    const reply = newReply(answering, thread.models?.[answering] || undefined)
    thread.messages.push(reply)
    thread.updatedAt = Date.now()
    await persist(brandId)
    send({ type: 'threads', brandId })
    startRun(brandId, thread, reply, answering, agentId === AUTO_AGENT)
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
