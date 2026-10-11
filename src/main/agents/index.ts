import { app, BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { ID_PATTERN } from '@shared/types'
import type { AgentInfo, ChatEvent, CustomAgentInput, Thread, ThreadMessage } from '@shared/chat'
import { getData } from '../store'
import { CLIS } from './catalog'
import { which } from './detect'
import { getConfig, getCustom, removeCustom, saveCustom, setDefault } from './config'
import { brandContext, flatPrompt, history } from './context'
import { addThread, dropChats, findThread, persist, removeThread, threadsFor } from './history'
import { runApi, runCli, runCommand } from './run'

export { dropChats }

// agents only ever start from a chat message the user sent, nothing here runs on its own

const MAX_MESSAGE = 8000
// streaming replies get saved this often, the rest is saved when they finish
const SAVE_EVERY_MS = 3000

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
        url: c.url
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
    return { id: a.id, name: a.name, kind: a.kind, installed: true, detail }
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

async function startRun(brandId: string, thread: Thread, reply: ThreadMessage, agentId: string): Promise<void> {
  const key = runKey(brandId, thread.id)
  const ctl = new AbortController()
  runs.set(key, ctl)
  let lastSave = Date.now()

  const onText = (text: string): void => {
    reply.text = (reply.text + text).slice(0, 100_000)
    send({ type: 'delta', brandId, threadId: thread.id, messageId: reply.id, text })
    if (Date.now() - lastSave > SAVE_EVERY_MS) {
      lastSave = Date.now()
      void persist(brandId).catch(() => {})
    }
  }

  const finish = (status: ThreadMessage['status'], error?: string): void => {
    reply.status = status
    if (error) reply.error = error.slice(0, 2000)
    thread.updatedAt = Date.now()
    runs.delete(key)
    void persist(brandId).catch(() => {})
    send({ type: 'done', brandId, threadId: thread.id, messageId: reply.id, status: status ?? 'done', error })
    send({ type: 'threads', brandId })
  }

  try {
    const brand = getData()?.brands.find((b) => b.id === brandId)
    if (!brand) throw new Error('That brand is gone')
    const context = await brandContext(brand)
    // the user message and the empty reply are the last two
    const past = history(thread, 2)
    const message = thread.messages[thread.messages.length - 2]?.text ?? ''
    const hooks = { onText, signal: ctl.signal }

    const cli = CLIS.find((c) => c.id === agentId)
    if (cli) {
      await runCli(cli, flatPrompt(context, past, message), hooks)
    } else {
      const custom = await getCustom(agentId)
      if (!custom) throw new Error('That agent was removed. Pick another one.')
      if (custom.kind === 'command') {
        await runCommand(custom.command, flatPrompt(context, past, message), hooks)
      } else {
        await runApi(
          { baseUrl: custom.baseUrl, apiKey: custom.apiKey, model: custom.model },
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
      .map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt, busy: runs.has(runKey(brandId, t.id)) }))
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

  ipcMain.handle('chat:send', async (_e, brandId: unknown, threadId: unknown, text: unknown, agentId: unknown) => {
    if (!validId(brandId)) throw new Error('bad brand id')
    if (typeof text !== 'string' || !text.trim()) throw new Error('empty message')
    if (typeof agentId !== 'string' || !agentId) throw new Error('Pick an agent first')
    const body = text.trim().slice(0, MAX_MESSAGE)
    const now = Date.now()

    let thread = validId(threadId) ? await findThread(brandId, threadId) : null
    if (thread && runs.has(runKey(brandId, thread.id))) throw new Error('Still answering the last message')
    if (!thread) {
      thread = { id: randomUUID(), title: titleFrom(body), updatedAt: now, agentId, messages: [] }
      await addThread(brandId, thread)
    }
    const reply: ThreadMessage = { id: randomUUID(), role: 'agent', text: '', at: now, agentId, status: 'streaming' }
    thread.messages.push({ id: randomUUID(), role: 'user', text: body, at: now }, reply)
    thread.agentId = agentId
    thread.updatedAt = now
    await persist(brandId)
    send({ type: 'threads', brandId })
    void startRun(brandId, thread, reply, agentId)
    return { threadId: thread.id, messageId: reply.id }
  })

  ipcMain.handle('chat:stop', (_e, brandId: unknown, threadId: unknown) => {
    if (!validId(brandId) || !validId(threadId)) return
    runs.get(runKey(brandId, threadId))?.abort()
  })
}
