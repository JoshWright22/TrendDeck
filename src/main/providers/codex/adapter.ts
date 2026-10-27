import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { ModelOption, UsageWindow } from '@shared/chat'
import type { ApprovalDecision, PermissionMode, PlanStep, ProviderCapabilities, UserInputQuestion } from '@shared/providers'
import { CLIS } from '../../agents/catalog'
import { resolveLaunch, which, type Launch } from '../../agents/detect'
import { Steps } from '../../agents/parse'
import { agentEnv, killTree, MAX_RUN_MS, workDir } from '../../agents/run'
import { answerSignal, approvalRequest, sinkFor, userInputRequest, Waiting } from '../common'
import {
  ProviderUnavailable,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderHealth,
  type ProviderSession,
  type SessionStart,
  type TurnInput
} from '../types'
import { RpcError, StdioRpc } from './rpc'

// codex through `codex app-server`: a thread per chat that resumes between turns, tool
// approvals as requests from the server, turn/steer for input mid turn, turn/interrupt to stop

const SPEC = CLIS.find((c) => c.id === 'codex')!
const MODELS_TTL_MS = 30 * 60_000
const START_TIMEOUT_MS = 30_000

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0)

interface Mapped {
  approvalPolicy: 'untrusted' | 'on-request' | 'never'
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  sandboxPolicy: Json
}

// codex has no "edits only" switch. auto-accept-edits (the default) lets it write inside the
// agent's own empty folder and never asks, like the old `codex exec` run did, so a window
// that can't show approvals still works. supervised and auto are the ones that ask
function mapMode(mode: PermissionMode, cwd: string): Mapped {
  switch (mode) {
    case 'supervised':
      return { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
    case 'auto-accept-edits':
      return {
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false }
      }
    case 'auto':
      return {
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false }
      }
    case 'full-access':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  }
}

async function findCodex(): Promise<{ path: string; launch: Launch } | null> {
  for (const bin of SPEC.bins) {
    const path = await which(bin)
    if (path) return { path, launch: await resolveLaunch(path) }
  }
  return null
}

interface Server {
  child: ChildProcess
  rpc: StdioRpc
}

// starts `codex app-server` with the turn's extra config and does the handshake
async function startServer(extraArgs: string[], env: Record<string, string>): Promise<Server> {
  const codex = await findCodex()
  if (!codex) throw new ProviderUnavailable(`${SPEC.name} isn't installed or isn't on PATH`)
  // the -c values carry quotes and braces that cmd.exe would mangle
  if (codex.launch.shell) throw new ProviderUnavailable(`Couldn't start ${SPEC.name} without a shell`)
  const child = spawn(codex.launch.file, [...codex.launch.prefix, 'app-server', ...extraArgs], {
    cwd: await workDir(),
    env: agentEnv({ ...env, RUST_LOG: 'error' }),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const rpc = new StdioRpc(child)
  try {
    await rpc.request(
      'initialize',
      { clientInfo: { name: 'trenddeck', title: 'TrendDeck', version: app.getVersion() }, capabilities: { experimentalApi: false } },
      START_TIMEOUT_MS
    )
    rpc.notify('initialized')
  } catch (err) {
    killTree(child)
    // an old codex without app-server exits right away or doesn't know the method
    const why = err instanceof Error ? err.message : String(err)
    throw new ProviderUnavailable(`codex app-server didn't start: ${why}`)
  }
  return { child, rpc }
}

function stopServer(s: Server | null): void {
  if (!s) return
  s.child.stdin?.end()
  killTree(s.child)
}

const capabilities: ProviderCapabilities = {
  steer: true,
  approvals: true,
  userInput: true,
  resume: true,
  interrupt: true,
  liveModels: true,
  permissionModes: true
}

function toolOf(item: Json): [string, Json] | null {
  switch (item.type) {
    case 'commandExecution':
      return ['shell', { command: str(item.command) }]
    case 'webSearch': {
      const action = obj(item.action)
      return ['web_search', { query: str(item.query) || str(action.query), url: str(action.url) }]
    }
    case 'fileChange':
      return ['edit', { path: ((item.changes as Json[] | undefined) ?? []).map((c) => str(c.path)).join(', ') }]
    case 'mcpToolCall':
      return [`${str(item.server)} ${str(item.tool)}`.trim(), obj(item.arguments)]
    case 'dynamicToolCall':
      return [`${str(item.namespace)} ${str(item.tool)}`.trim(), obj(item.arguments)]
    default:
      return null
  }
}

function failed(item: Json): boolean {
  const s = str(item.status)
  if (s === 'failed' || s === 'declined') return true
  if (item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0) return true
  if (item.type === 'dynamicToolCall' && item.success === false) return true
  return false
}

function limitsFrom(raw: Json): UsageWindow[] {
  const out: UsageWindow[] = []
  for (const key of ['primary', 'secondary']) {
    const w = obj(raw[key])
    if (!Object.keys(w).length) continue
    const mins = num(w.windowDurationMins)
    const resets = num(w.resetsAt)
    out.push({
      label: mins >= 10_000 ? 'Weekly limit' : mins ? `${Math.round(mins / 60)} hour limit` : key,
      used: typeof w.usedPercent === 'number' ? w.usedPercent / 100 : null,
      // seconds since the epoch
      resetsAt: resets ? (resets < 1e12 ? resets * 1000 : resets) : null
    })
  }
  return out
}

type Answer = { decision: ApprovalDecision; feedback?: string; remember?: boolean }

class CodexSession implements ProviderSession {
  readonly agentId = 'codex'
  private server: Server | null = null
  private thread: string | undefined
  private turnId: string | null = null
  private mode: PermissionMode
  private interrupted = false
  private closed = false
  private approvals = new Waiting<Answer>()
  private inputs = new Waiting<Record<string, string> | null>()
  // file paths per item, the approval request only has the item id
  private changes = new Map<string, string>()

  constructor(private start: SessionStart) {
    this.thread = start.resume
    this.mode = start.permissionMode
  }

  private emit(e: ProviderEvent): void {
    if (e.type === 'session') this.thread = e.id
    this.start.emit(e)
  }

  private async ask(req: ReturnType<typeof approvalRequest>, signal: AbortSignal): Promise<Answer> {
    this.emit({ type: 'approval-request', request: req })
    return this.approvals.wait(req.requestId, answerSignal(signal), { decision: 'deny', feedback: 'No answer from the user.' })
  }

  // requests codex sends us mid turn
  private async onRequest(method: string, p: Json, signal: AbortSignal): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const cmd = str(p.command)
        const detail = [cmd, p.cwd ? `in ${str(p.cwd)}` : ''].filter(Boolean).join('\n')
        const a = await this.ask(
          approvalRequest('command', 'Run a command', detail || 'A command', { tool: 'shell', reason: str(p.reason), canRemember: true }),
          signal
        )
        return { decision: a.decision === 'allow' ? (a.remember ? 'acceptForSession' : 'accept') : 'decline' }
      }
      case 'item/fileChange/requestApproval': {
        const paths = this.changes.get(str(p.itemId)) || str(p.grantRoot) || 'Some files'
        const a = await this.ask(
          approvalRequest('file-change', 'Change files', paths, { tool: 'edit', reason: str(p.reason), canRemember: true }),
          signal
        )
        return { decision: a.decision === 'allow' ? (a.remember ? 'acceptForSession' : 'accept') : 'decline' }
      }
      case 'mcpServer/elicitation/request': {
        const server = str(p.serverName)
        const a = await this.ask(
          approvalRequest('tool', `${server === 'trenddeck' ? 'TrendDeck' : server} wants to go ahead`, str(p.message) || str(p.description) || str(p.title), {
            tool: server
          }),
          signal
        )
        return a.decision === 'allow' ? { action: 'accept', content: {} } : { action: 'decline', content: null }
      }
      case 'item/tool/requestUserInput': {
        const questions: UserInputQuestion[] = ((p.questions as Json[] | undefined) ?? []).map((q) => ({
          id: str(q.id),
          question: str(q.question),
          header: str(q.header) || undefined,
          multi: false,
          options: ((q.options as Json[] | null | undefined) ?? []).map((o) => ({
            label: str(o.label),
            description: str(o.description) || undefined
          }))
        }))
        const request = userInputRequest(questions)
        this.emit({ type: 'user-input-request', request })
        const answers = await this.inputs.wait(request.requestId, answerSignal(signal), null)
        const out: Record<string, { answers: string[] }> = {}
        for (const q of questions) out[q.id] = { answers: answers?.[q.id] ? [answers[q.id]] : [] }
        return { answers: out }
      }
      // v1 names, only sent for turns started the old way, answered in case an old codex does
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        const isCmd = method === 'execCommandApproval'
        const detail = isCmd
          ? (Array.isArray(p.command) ? p.command.map(String).join(' ') : str(p.command))
          : Object.keys(obj(p.fileChanges)).join(', ')
        const a = await this.ask(
          approvalRequest(isCmd ? 'command' : 'file-change', isCmd ? 'Run a command' : 'Change files', detail, {
            reason: str(p.reason),
            canRemember: true
          }),
          signal
        )
        return {
          decision:
            a.decision === 'allow'
              ? a.remember
                ? 'approved_for_session'
                : 'approved'
              : { denied: { rejection: a.feedback || 'The user said no.' } }
        }
      }
      default:
        throw new RpcError(`TrendDeck doesn't handle ${method}`, -32601)
    }
  }

  async sendTurn(input: TurnInput): Promise<void> {
    if (this.closed) throw new Error('This session is closed')
    const signal = this.start.signal
    if (signal.aborted) return
    const cwd = await workDir()
    const mapped = mapMode(this.mode, cwd)
    const server = await startServer(this.start.mcp?.attach.args ?? [], this.start.mcp?.attach.env ?? {})
    this.server = server
    this.interrupted = false
    const { rpc } = server
    const sink = sinkFor((e) => this.emit(e))
    const steps = new Steps(sink)
    // agent message items that streamed deltas, so their completed text isn't added twice
    const streamed = new Set<string>()
    let wroteText = false
    let lastTextItem = ''
    let error = ''

    let finish: (status: string) => void = () => {}
    const ended = new Promise<string>((resolve) => (finish = resolve))

    rpc.requests((method, params) => this.onRequest(method, params, signal))
    rpc.notifications((method, p) => {
      if (p.turnId && this.turnId && p.turnId !== this.turnId) return
      const item = obj(p.item)
      const id = str(item.id) || str(p.itemId)
      switch (method) {
        case 'item/agentMessage/delta': {
          const delta = str(p.delta)
          if (!delta) return
          if (wroteText && lastTextItem && lastTextItem !== id) sink.text('\n\n')
          lastTextItem = id
          streamed.add(id)
          wroteText = true
          sink.text(delta)
          return
        }
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta':
          sink.thinking(str(p.delta))
          return
        case 'item/reasoning/summaryPartAdded':
          sink.thinking('\n\n')
          return
        case 'item/started': {
          const t = toolOf(item)
          if (t) steps.start(id, t[0], t[1])
          if (item.type === 'fileChange') this.changes.set(id, String(toolOf(item)?.[1].path ?? ''))
          return
        }
        case 'item/completed': {
          if (item.type === 'agentMessage') {
            if (!streamed.has(id) && str(item.text)) {
              if (wroteText) sink.text('\n\n')
              wroteText = true
              lastTextItem = id
              sink.text(str(item.text))
            }
            return
          }
          const t = toolOf(item)
          if (t) {
            steps.update(id, t[0], t[1])
            steps.end(id, failed(item))
          }
          return
        }
        case 'turn/plan/updated': {
          const plan = ((p.plan as Json[] | undefined) ?? []).slice(0, 50).map(
            (s): PlanStep => ({
              text: str(s.step),
              status: s.status === 'completed' ? 'done' : s.status === 'inProgress' ? 'in-progress' : 'pending'
            })
          )
          this.emit({ type: 'plan', plan })
          return
        }
        case 'thread/tokenUsage/updated': {
          const usage = obj(p.tokenUsage)
          const last = obj(usage.last)
          const total = obj(usage.total)
          this.emit({
            type: 'usage',
            contextTokens: num(last.totalTokens) || undefined,
            inputTokens: num(total.inputTokens) || undefined,
            outputTokens: num(total.outputTokens) || undefined
          })
          return
        }
        case 'account/rateLimits/updated': {
          const windows = limitsFrom(obj(p.rateLimits))
          if (windows.length) this.emit({ type: 'limits', windows })
          return
        }
        case 'error':
          if (p.willRetry !== true) error = str(obj(p.error).message) || 'Codex returned an error'
          return
        case 'turn/completed': {
          const turn = obj(p.turn)
          if (this.turnId && str(turn.id) && str(turn.id) !== this.turnId) return
          const terr = str(obj(turn.error).message)
          if (terr) error = terr
          finish(str(turn.status) || 'completed')
          return
        }
      }
    })

    const stop = (): void => {
      void this.interrupt()
      // a server that ignores the interrupt gets killed
      setTimeout(() => {
        stopServer(server)
        finish('interrupted')
      }, 5000).unref()
    }
    signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, MAX_RUN_MS)
    try {
      const runtime = { cwd, approvalPolicy: mapped.approvalPolicy, sandbox: mapped.sandbox, model: this.start.model || undefined }
      // a thread codex lost throws here, the chat then starts over with the full prompt
      const res = this.thread
        ? await rpc.request<Json>('thread/resume', { threadId: this.thread, excludeTurns: true, ...runtime }, START_TIMEOUT_MS)
        : await rpc.request<Json>('thread/start', runtime, START_TIMEOUT_MS)
      const threadId = str(obj(res.thread).id) || this.thread
      if (!threadId) throw new Error("Codex didn't start a thread")
      this.emit({ type: 'session', id: threadId })
      if (signal.aborted) return
      const effort = this.start.effort && /^[a-z]{2,20}$/.test(this.start.effort) ? this.start.effort : undefined
      const turn = await rpc.request<Json>(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text: input.text }],
          model: this.start.model || undefined,
          effort,
          approvalPolicy: mapped.approvalPolicy,
          sandboxPolicy: mapped.sandboxPolicy
        },
        START_TIMEOUT_MS
      )
      this.turnId = str(obj(turn.turn).id) || null
      // the process dying mid turn ends it too
      const died = new Promise<string>((resolve) => server.child.once('close', () => resolve('died')))
      const status = await Promise.race([ended, died])
      steps.close()
      if (signal.aborted || this.interrupted || status === 'interrupted') return
      if (status === 'died') throw new Error(rpc.stderrTail() || 'Codex quit in the middle of the reply')
      if (status === 'failed' || error) throw new Error(error || 'Codex returned an error')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      this.approvals.flush({ decision: 'deny', feedback: 'The turn ended.' })
      this.inputs.flush(null)
      this.turnId = null
      this.server = null
      stopServer(server)
    }
  }

  async steer(text: string): Promise<boolean> {
    const s = this.server
    if (!s || !this.thread || !this.turnId || this.interrupted) return false
    try {
      await s.rpc.request('turn/steer', { threadId: this.thread, input: [{ type: 'text', text }], expectedTurnId: this.turnId }, 15_000)
      this.emit({ type: 'steered', text })
      return true
    } catch {
      return false
    }
  }

  async interrupt(): Promise<void> {
    const s = this.server
    if (!s) return
    this.interrupted = true
    this.approvals.flush({ decision: 'deny', feedback: 'The user stopped the reply.' })
    this.inputs.flush(null)
    if (this.thread && this.turnId) {
      await s.rpc.request('turn/interrupt', { threadId: this.thread, turnId: this.turnId }, 10_000).catch(() => {})
    }
  }

  respondToApproval(requestId: string, decision: ApprovalDecision, opts: { feedback?: string; remember?: boolean } = {}): boolean {
    return this.approvals.answer(requestId, { decision, ...opts })
  }

  respondToUserInput(requestId: string, answers: Record<string, string>): boolean {
    return this.inputs.answer(requestId, answers)
  }

  // codex takes the policy per turn, so this applies from the next one
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode
  }

  sessionId(): string | undefined {
    return this.thread
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.approvals.flush({ decision: 'deny', feedback: 'The session closed.' })
    this.inputs.flush(null)
    stopServer(this.server)
    this.server = null
  }
}

let modelCache: { at: number; models: ModelOption[] } | null = null

async function liveModels(): Promise<ModelOption[]> {
  // no thread and no prompt, just the list
  const server = await startServer([], {})
  try {
    const out: ModelOption[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const res: Json = await server.rpc.request<Json>('model/list', cursor ? { cursor, limit: 100 } : { limit: 100 }, 15_000)
      for (const m of (res.data as Json[] | undefined) ?? []) {
        if (m.hidden === true) continue
        const id = str(m.model) || str(m.id)
        if (!id) continue
        const efforts = ((m.supportedReasoningEfforts as Json[] | undefined) ?? []).map((e) => str(e.reasoningEffort)).filter(Boolean)
        out.push({ id, label: str(m.displayName) || id, efforts: efforts.length ? efforts : undefined })
      }
      cursor = str(res.nextCursor) || null
      if (!cursor) break
    }
    return out
  } finally {
    stopServer(server)
  }
}

// signed in when codex's own auth file is there, or an api key is set. never asks codex to log in
async function signedIn(): Promise<boolean> {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return true
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  return fs
    .access(join(home, 'auth.json'))
    .then(() => true)
    .catch(() => false)
}

export const codexAdapter: ProviderAdapter = {
  kind: 'codex-app-server',
  capabilities,
  handles: (agentId) => agentId === 'codex',

  async health(): Promise<ProviderHealth> {
    const codex = await findCodex()
    if (!codex) return { installed: false, detail: '', signedIn: null, note: `Sign in with: ${SPEC.setup}` }
    const auth = await signedIn()
    return { installed: true, detail: codex.path, signedIn: auth, note: auth ? undefined : `Not signed in. Run: ${SPEC.setup}` }
  },

  async listModels(): Promise<ModelOption[]> {
    const fallback = SPEC.models ?? [{ id: '', label: 'Model' }]
    if (modelCache && Date.now() - modelCache.at < MODELS_TTL_MS) return modelCache.models
    try {
      const live = await liveModels()
      if (!live.length) return fallback
      const models = [{ id: '', label: 'Model' }, ...live]
      modelCache = { at: Date.now(), models }
      return models
    } catch {
      return fallback
    }
  },

  async startSession(start: SessionStart): Promise<ProviderSession> {
    if (!(await findCodex())) throw new ProviderUnavailable(`${SPEC.name} isn't installed or isn't on PATH`)
    return new CodexSession(start)
  }
}
