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
import { getData } from '../store'
import { CLIS } from './catalog'
import { which } from './detect'
import { getConfig, getCustom, removeCustom, saveCustom, setDefault } from './config'
import { brandContext, flatPrompt, history, historyRoom, turnText, voiceHash, voiceRoom } from './context'
import { getBrandContext } from '../voice'
import { addThread, cleanAttachments, dropChats, findThread, persist, removeThread, threadsFor } from './history'
import { runApi, runCli, runCommand, type RunHooks } from './run'
import { beginAgentTurn, type AgentKind, type AgentSession } from '../mcp'
import { recordLimits, usageFor } from './usage'

export { dropChats }

// agents only ever start from a chat message the user sent, nothing here runs on its own

const MAX_MESSAGE = 8000
// streaming replies get saved this often, the rest is saved when they finish
const SAVE_EVERY_MS = 3000
const DEFAULT_MODEL: ModelOption[] = [{ id: '', label: 'Model' }]

let detected: AgentInfo[] | null = null

async function detect(): Promise<AgentInfo[]> {
  const found = await Promise.all(
    CLIS.map(async (c): Promise<AgentInfo> => {
      let path: string | null = null
      for (const bin of c.bins) {
        path = await which(bin)
        if (path) break
      }
      return {
        id: c.id,
        name: c.name,
        kind: 'cli',
        installed: path !== null,
        detail: path ?? '',
        setup: c.setup,
        url: c.url,
        models: c.modelFlag ? (c.models ?? DEFAULT_MODEL) : DEFAULT_MODEL,
        efforts: c.efforts
      }
    })
  )
  detected = found
  return found
}

async function listAgents(rescan: boolean): Promise<AgentInfo[]> {
  const builtins = !detected || rescan ? await detect() : detected
  const { custom } = await getConfig()
  const extra = custom.map((a): AgentInfo => {
    let detail = a.command
    if (a.kind === 'api') {
      try {
        detail = `${new URL(a.baseUrl).host}, ${a.model || 'no model set'}`
      } catch {
        detail = a.baseUrl
      }
    }
    const models = a.kind === 'api' ? [{ id: '', label: a.model || 'Default' }] : DEFAULT_MODEL
    return { id: a.id, name: a.name, kind: a.kind, installed: true, detail, models }
  })
  return [...builtins, ...extra]
}

// one run per thread at a time
const runs = new Map<string, AbortController>()
const runKey = (brandId: string, threadId: string): string => `${brandId}:${threadId}`

function send(event: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('chat:event', event)
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

function startRun(brandId: string, thread: Thread, reply: ThreadMessage, agentId: string): void {
  const ctl = new AbortController()
  runs.set(runKey(brandId, thread.id), ctl)
  void runReply(brandId, thread, reply, agentId, ctl)
}

async function runReply(
  brandId: string,
  thread: Thread,
  reply: ThreadMessage,
  agentId: string,
  ctl: AbortController
): Promise<void> {
  const key = runKey(brandId, thread.id)
  let lastSave = Date.now()
  const ids = { brandId, threadId: thread.id, messageId: reply.id }
  const saveSoon = (): void => {
    if (Date.now() - lastSave > SAVE_EVERY_MS) {
      lastSave = Date.now()
      void persist(brandId).catch(() => {})
    }
  }

  const hooks: RunHooks = {
    signal: ctl.signal,
    text(text) {
      reply.text = (reply.text + text).slice(0, 100_000)
      send({ type: 'delta', ...ids, text })
      saveSoon()
    },
    thinking(text) {
      reply.thinking = ((reply.thinking ?? '') + text).slice(0, 100_000)
      send({ type: 'delta', ...ids, text, kind: 'thinking' })
      saveSoon()
    },
    thinkingTokens(tokens) {
      reply.thinkingTokens = tokens
      send({ type: 'thinking-tokens', ...ids, tokens })
    },
    step(step: WorkStep) {
      const steps = (reply.steps ??= [])
      const i = steps.findIndex((s) => s.id === step.id)
      if (i >= 0) steps[i] = step
      else if (steps.length < 200) steps.push(step)
      send({ type: 'step', ...ids, step })
      saveSoon()
    },
    session(id) {
      if (id) thread.sessions = { ...thread.sessions, [agentId]: id.slice(0, 200) }
    },
    contextTokens(n) {
      reply.contextTokens = n
    },
    limits(windows) {
      void recordLimits(agentId, windows)
    }
  }

  const finish = (status: ThreadMessage['status'], error?: string): void => {
    reply.status = status
    reply.finishedAt = Date.now()
    if (error) reply.error = error.slice(0, 2000)
    for (const s of reply.steps ?? []) if (s.status === 'running') s.status = status === 'done' ? 'done' : 'error'
    thread.updatedAt = Date.now()
    runs.delete(key)
    void persist(brandId).catch(() => {})
    send({ type: 'done', ...ids, status: status ?? 'done', error })
    send({ type: 'threads', brandId })
  }

  // the agent server only lets an agent in while its turn is open, the turn ends when the agent exits
  let turn: AgentSession | null = null
  const openTurn = async (): Promise<AgentSession> => (turn ??= await beginAgentTurn(brandId, attachKind(agentId)))

  try {
    const brand = getData()?.brands.find((b) => b.id === brandId)
    if (!brand) throw new Error('That brand is gone')
    const base = await brandContext(brand)
    // the user message and the empty reply are the last two
    const userMsg = thread.messages[thread.messages.length - 2]
    const message = userMsg ? turnText(userMsg) : ''
    // every prompt carries the brand voice pack, cut to the brand's own size or to what still fits
    let voice = await getBrandContext(brandId)
    const room = voiceRoom(base.length + message.length)
    if (voice.chars > room) voice = await getBrandContext(brandId, undefined, room)
    const context = `${base}\n\n${voice.text}`
    const past = history(thread, 2, historyRoom(context.length + message.length))
    const sentVoice = voiceHash(voice.text)
    const model = thread.models?.[agentId] || undefined
    const effort = thread.efforts?.[agentId] || undefined

    const cli = CLIS.find((c) => c.id === agentId)
    if (cli) {
      const session = cli.resume ? thread.sessions?.[agentId] : undefined
      // a resumed session already has the brand, the voice and the chat so far. it gets the new
      // message, plus the voice pack again only when it changed since the session last got it
      const voiceChanged = thread.voiceSent?.[agentId] !== sentVoice
      const prompt = !session
        ? flatPrompt(context, past, message)
        : voiceChanged
          ? `${voice.text}\n\n## New message from the user\n${message}`
          : message
      thread.voiceSent = { ...thread.voiceSent, [agentId]: sentVoice }
      const { attach } = await openTurn()
      try {
        await runCli(cli, prompt, { model, effort, session }, hooks, attach)
      } catch (err) {
        // the agent lost the session (cleared, other machine), start over with the full prompt
        if (!session || ctl.signal.aborted || reply.text) throw err
        if (thread.sessions) delete thread.sessions[agentId]
        await runCli(cli, flatPrompt(context, past, message), { model, effort }, hooks, attach)
      }
    } else {
      const custom = await getCustom(agentId)
      if (!custom) throw new Error('That agent was removed. Pick another one.')
      if (custom.kind === 'command') {
        const { attach } = await openTurn()
        await runCommand(custom.command, flatPrompt(context, past, message), hooks, attach)
      } else {
        // an api agent is one plain request with no process and no tool calls, so it gets no turn
        await runApi(
          { baseUrl: custom.baseUrl, apiKey: custom.apiKey, model: model || custom.model },
          [
            { role: 'system', content: context },
            ...past.map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: m.text })),
            { role: 'user', content: message }
          ],
          hooks
        )
      }
    }
    if (ctl.signal.aborted) finish('stopped')
    else if (!reply.text.trim()) finish('error', 'The agent finished without saying anything')
    else finish('done')
  } catch (err) {
    if (ctl.signal.aborted) finish('stopped')
    else finish('error', err instanceof Error ? err.message : String(err))
  } finally {
    // the process has exited by now, its token dies with the turn
    await (turn as AgentSession | null)?.end()
  }
}

function newReply(agentId: string, model: string | undefined): ThreadMessage {
  const reply: ThreadMessage = { id: randomUUID(), role: 'agent', text: '', at: Date.now(), agentId, status: 'streaming' }
  if (model) reply.model = model
  return reply
}

// asks an api agent's /models endpoint. only lists models, never sends a prompt
async function apiModels(agentId: string): Promise<ModelOption[]> {
  const custom = await getCustom(agentId)
  if (!custom) return DEFAULT_MODEL
  const fallback: ModelOption[] = [{ id: '', label: custom.model || 'Default' }]
  if (custom.kind !== 'api') return fallback
  try {
    const headers: Record<string, string> = {}
    if (custom.apiKey) headers.authorization = `Bearer ${custom.apiKey}`
    const res = await fetch(`${custom.baseUrl}/models`, { headers, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return fallback
    const j = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string }[] }
    const ids = (j.data?.map((m) => m.id) ?? j.models?.map((m) => m.name) ?? []).filter(
      (id): id is string => typeof id === 'string'
    )
    return [...fallback, ...ids.slice(0, 200).filter((id) => id !== custom.model).map((id) => ({ id, label: id }))]
  } catch {
    return fallback
  }
}

export function stopBrand(brandId: string): void {
  for (const [key, ctl] of runs) if (key.startsWith(`${brandId}:`)) ctl.abort()
}

export function setupAgents(): void {
  // don't leave agents running after the app is gone
  app.on('before-quit', () => {
    for (const ctl of runs.values()) ctl.abort()
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
        archived: t.archived === true
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  })

  ipcMain.handle('chat:thread', async (_e, brandId: unknown, threadId: unknown) => {
    if (!validId(brandId) || !validId(threadId)) return null
    return findThread(brandId, threadId)
  })

  ipcMain.handle('chat:delete', async (_e, brandId: unknown, threadId: unknown) => {
    if (!validId(brandId) || !validId(threadId)) return
    runs.get(runKey(brandId, threadId))?.abort()
    await removeThread(brandId, threadId)
    send({ type: 'threads', brandId })
  })

  ipcMain.handle(
    'chat:send',
    async (_e, brandId: unknown, threadId: unknown, text: unknown, agentId: unknown, opts: unknown) => {
      if (!validId(brandId)) throw new Error('bad brand id')
      if (typeof text !== 'string' || !text.trim()) throw new Error('empty message')
      if (typeof agentId !== 'string' || !agentId) throw new Error('Pick an agent first')
      const o = (opts ?? {}) as SendOptions
      const body = text.trim().slice(0, MAX_MESSAGE)
      const now = Date.now()

      let thread = validId(threadId) ? await findThread(brandId, threadId) : null
      if (thread && runs.has(runKey(brandId, thread.id))) throw new Error('Still answering the last message')
      if (!thread) {
        thread = { id: randomUUID(), title: titleFrom(body), updatedAt: now, agentId, messages: [] }
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
      return { threadId: thread.id, messageId: reply.id }
    }
  )

  // retry and edit both change what came before, so the agent's own session can't be reused
  const rerun = async (brandId: string, thread: Thread, agentId: string): Promise<SendResult> => {
    thread.sessions = {}
    thread.voiceSent = {}
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

  ipcMain.handle('chat:models', async (_e, agentId: unknown) => {
    if (typeof agentId !== 'string') return DEFAULT_MODEL
    const cli = CLIS.find((c) => c.id === agentId)
    if (cli) return cli.modelFlag ? (cli.models ?? DEFAULT_MODEL) : DEFAULT_MODEL
    return apiModels(agentId)
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
    runs.get(runKey(brandId, threadId))?.abort()
  })
}
