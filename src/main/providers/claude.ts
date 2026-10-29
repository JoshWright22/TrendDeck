import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type {
  CanUseTool,
  Options,
  PermissionMode as SdkPermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions
} from '@anthropic-ai/claude-agent-sdk'
import type { ModelOption } from '@shared/chat'
import { baseAgentId } from '@shared/agents'
import type { ApprovalDecision, PermissionMode, PlanStep, ProviderCapabilities } from '@shared/providers'
import { CLIS } from '../agents/catalog'
import { accountEnv } from '../agents/config'
import { resolveLaunch, which, type Launch } from '../agents/detect'
import { claudeParser, describeTool } from '../agents/parse'
import { agentEnv, killTree, MAX_RUN_MS, workDir } from '../agents/run'
import { PRIVATE_REASON, touchesPrivate } from './private-guard'
import { answerSignal, approvalRequest, Inbox, sinkFor, userInputRequest, Waiting } from './common'
import {
  ProviderUnavailable,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderHealth,
  type ProviderSession,
  type SessionStart,
  type TurnInput
} from './types'

// claude code through the agent sdk, on the user's own claude code install and login.
// one query per turn with streamed input, so a message can go into a running turn, tools
// ask through canUseTool, and the session id carries the chat into the next turn

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')
let sdk: Promise<Sdk> | null = null
// the sdk is esm only, the main bundle is cjs, so it comes in through import()
const loadSdk = (): Promise<Sdk> => (sdk ??= import('@anthropic-ai/claude-agent-sdk'))

const SPEC = CLIS.find((c) => c.id === 'claude')!

// everything claude code itself has: a shell, files, the web, a todo list, its own helpers. the
// permission mode decides what asks first. the app's own tools come over mcp
const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task']
const READ_ONLY = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite']
const APP_TOOLS = 'mcp__trenddeck'

// TrendDeck's own folder holds the logins and keys the agent never sees: its file tools are kept
// out of everything in it but the agent's own room, in every mode, full access too. claude code's
// rules want //c/Users/... on windows
export function privateRules(dir: string, entries: string[], room = 'agent-room'): string[] {
  const posix = dir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replace(/\/+$/, '')
  const tools = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']
  return entries.filter((n) => n !== room).flatMap((n) => tools.flatMap((t) => [`${t}(/${posix}/${n})`, `${t}(/${posix}/${n}/**)`]))
}

// the rules go in a settings file, not on the command line: one per folder and tool runs past
// windows' command length. the file is in TrendDeck's own folder, which the agent can't touch
async function guardSettings(): Promise<string> {
  const dir = app.getPath('userData')
  const file = join(dir, 'agent-guard.json')
  const deny = privateRules(dir, [...new Set([...(await fs.readdir(dir).catch(() => [])), 'agent-guard.json'])])
  await fs.writeFile(file, JSON.stringify({ permissions: { deny } }), 'utf8')
  return file
}

const MODELS_TTL_MS = 30 * 60_000
const MODELS_TIMEOUT_MS = 20_000

interface Mapped {
  permissionMode: SdkPermissionMode
  allowedTools: string[]
  allowDangerouslySkipPermissions?: boolean
}

function mapMode(mode: PermissionMode): Mapped {
  switch (mode) {
    case 'supervised':
      return { permissionMode: 'default', allowedTools: READ_ONLY }
    case 'auto-accept-edits':
      // the app's tool server checks site access itself, request_post waits for the user anyway
      // shell commands go through too, like the edits. TrendDeck's own folder stays guarded (hooks)
      return { permissionMode: 'acceptEdits', allowedTools: [...READ_ONLY, APP_TOOLS, 'Bash'] }
    case 'auto':
      return { permissionMode: 'auto', allowedTools: [...READ_ONLY, APP_TOOLS, 'Bash'] }
    case 'full-access':
      return { permissionMode: 'bypassPermissions', allowedTools: [...READ_ONLY, APP_TOOLS], allowDangerouslySkipPermissions: true }
  }
}

async function findClaude(): Promise<{ path: string; launch: Launch } | null> {
  for (const bin of SPEC.bins) {
    const path = await which(bin)
    if (path) return { path, launch: await resolveLaunch(path) }
  }
  return null
}

// the sdk's own spawn, but hidden on windows and killed as a whole tree
function spawner(claude: { path: string; launch: Launch }): (o: SpawnOptions) => SpawnedProcess {
  return (o) => {
    const mine = o.command === claude.path
    const file = mine ? claude.launch.file : o.command
    const args = mine ? [...claude.launch.prefix, ...o.args] : o.args
    const child = spawn(file, args, { cwd: o.cwd, env: o.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    // the sdk reads stderr itself only on its own spawn, drain it so the pipe can't fill up
    child.stderr?.resume()
    const plainKill = child.kill.bind(child)
    child.kill = (signal?: NodeJS.Signals | number): boolean => {
      if (process.platform === 'win32') {
        killTree(child)
        return true
      }
      return plainKill(signal)
    }
    o.signal.addEventListener('abort', () => killTree(child), { once: true })
    return child as unknown as SpawnedProcess
  }
}

async function baseOptions(claude: { path: string; launch: Launch }, env: Record<string, string>): Promise<Options> {
  return {
    cwd: await workDir(),
    pathToClaudeCodeExecutable: claude.path,
    spawnClaudeCodeProcess: spawner(claude),
    env: { ...agentEnv(env), CLAUDE_AGENT_SDK_CLIENT_APP: `trenddeck/${app.getVersion()}` },
    // the user's own settings, plugins and mcp servers stay out, like --strict-mcp-config did
    settingSources: [],
    strictMcpConfig: true,
    tools: TOOLS
  }
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

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function todoPlan(input: Json): PlanStep[] | null {
  if (!Array.isArray(input.todos)) return null
  return input.todos.slice(0, 50).map((t): PlanStep => {
    const o = obj(t)
    const s = str(o.status)
    return { text: str(o.content) || str(o.activeForm), status: s === 'completed' ? 'done' : s === 'in_progress' ? 'in-progress' : 'pending' }
  })
}

function kindOf(tool: string): 'command' | 'file-change' | 'tool' | 'web' {
  const n = tool.toLowerCase()
  if (n === 'bash' || n.includes('shell')) return 'command'
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'notebookedit') return 'file-change'
  if (n.startsWith('web')) return 'web'
  return 'tool'
}

function appToolName(tool: string): string {
  return tool.startsWith(`${APP_TOOLS}__`) ? `TrendDeck: ${tool.slice(APP_TOOLS.length + 2)}` : tool
}

class ClaudeSession implements ProviderSession {
  readonly agentId: string
  private session: string | undefined
  private query: Query | null = null
  private abort: AbortController | null = null
  private inbox: Inbox<SDKUserMessage> | null = null
  private mode: PermissionMode
  private interrupted = false
  private closed = false
  private approvals = new Waiting<{ decision: ApprovalDecision; feedback?: string; remember?: boolean }>()
  private inputs = new Waiting<Record<string, string> | null>()

  constructor(
    private start: SessionStart,
    private claude: { path: string; launch: Launch }
  ) {
    this.agentId = start.agentId
    this.session = start.resume
    this.mode = start.permissionMode
  }

  private emit(e: ProviderEvent): void {
    if (e.type === 'session') this.session = e.id
    this.start.emit(e)
  }

  private message(text: string): SDKUserMessage {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: randomUUID() as SDKUserMessage['uuid'],
      // the app wrote this prompt, so no slash commands or @file expansion from what the user typed
      client_composed: true
    }
  }

  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    const signal = answerSignal(opts.signal)
    if (toolName === 'AskUserQuestion' && Array.isArray(input.questions)) {
      const questions = input.questions.slice(0, 8).map((q, i) => {
        const o = obj(q)
        return {
          id: str(o.question) || String(i),
          question: str(o.question),
          header: str(o.header) || undefined,
          multi: o.multiSelect === true,
          options: (Array.isArray(o.options) ? o.options : []).map((x) => ({
            label: str(obj(x).label),
            description: str(obj(x).description) || undefined
          }))
        }
      })
      const request = userInputRequest(questions)
      this.emit({ type: 'user-input-request', request })
      const answers = await this.inputs.wait(request.requestId, signal, null)
      if (!answers) return { behavior: 'deny', message: 'The user did not answer.' }
      return { behavior: 'allow', updatedInput: { ...input, answers } }
    }
    const looks = describeTool(toolName, input)
    const request = approvalRequest(kindOf(toolName), opts.title || `${looks.label}: ${appToolName(toolName)}`, opts.description || looks.detail || JSON.stringify(input), {
      tool: toolName,
      reason: opts.decisionReason,
      canRemember: (opts.suggestions?.length ?? 0) > 0 && opts.suppressAlwaysAllowRule !== true
    })
    this.emit({ type: 'approval-request', request })
    const answer = await this.approvals.wait(request.requestId, signal, { decision: 'deny', feedback: 'No answer from the user.' })
    if (answer.decision === 'allow') {
      const result: PermissionResult = { behavior: 'allow', updatedInput: input }
      if (answer.remember && opts.suggestions?.length) result.updatedPermissions = opts.suggestions as PermissionUpdate[]
      return result
    }
    return { behavior: 'deny', message: answer.feedback?.trim() || 'The user said no to this.' }
  }

  async sendTurn(input: TurnInput): Promise<void> {
    if (this.closed) throw new Error('This session is closed')
    const { query } = await loadSdk().catch((err) => {
      throw new ProviderUnavailable(`Couldn't load the Claude Agent SDK: ${err instanceof Error ? err.message : err}`)
    })
    const signal = this.start.signal
    if (signal.aborted) return
    const abort = new AbortController()
    this.abort = abort
    const inbox = new Inbox<SDKUserMessage>()
    this.inbox = inbox
    this.interrupted = false
    inbox.push(this.message(input.text))

    const mcp = this.start.mcp
    const mapped = mapMode(this.mode)
    const options: Options = {
      ...(await baseOptions(this.claude, { ...(mcp?.attach.env ?? {}), ...(this.start.env ?? {}) })),
      abortController: abort,
      includePartialMessages: true,
      canUseTool: this.canUseTool,
      permissionMode: mapped.permissionMode,
      allowedTools: mapped.allowedTools,
      settings: await guardSettings(),
      // runs in every mode, full access too, where canUseTool is never asked
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash|PowerShell',
            hooks: [
              async (h) => {
                const command = h.hook_event_name === 'PreToolUse' ? String((h.tool_input as { command?: unknown })?.command ?? '') : ''
                if (!touchesPrivate(command, app.getPath('userData'))) return { continue: true }
                return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PRIVATE_REASON } }
              }
            ]
          }
        ]
      },
      allowDangerouslySkipPermissions: mapped.allowDangerouslySkipPermissions,
      model: this.start.model || undefined,
      effort: (SPEC.efforts?.includes(this.start.effort ?? '') ? this.start.effort : undefined) as Options['effort'],
      resume: this.session
    }
    if (mcp) {
      options.mcpServers = {
        trenddeck: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.turn.token}` } }
      }
    }

    const sink = sinkFor((e) => this.emit(e))
    const parser = claudeParser(sink)
    const q = query({ prompt: inbox, options })
    this.query = q

    const stop = (): void => {
      void this.interrupt()
      // a cli that ignores the interrupt gets killed
      setTimeout(() => abort.abort(), 5000).unref()
    }
    signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, MAX_RUN_MS)
    let gotAny = false
    try {
      for await (const raw of q) {
        gotAny = true
        const ev = raw as unknown as Json
        // after a stop nothing more goes into the reply
        if (this.interrupted) {
          if (ev.type === 'result') inbox.end()
          continue
        }
        parser.event(ev)
        if (ev.type === 'assistant') {
          for (const c of (obj(ev.message).content as Json[] | undefined) ?? []) {
            if (c.type === 'tool_use' && c.name === 'TodoWrite') {
              const plan = todoPlan(obj(c.input))
              if (plan) this.emit({ type: 'plan', plan })
            }
          }
        } else if (ev.type === 'result') {
          const u = obj(ev.usage)
          const inTok = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0)
          const outTok = Number(u.output_tokens ?? 0)
          if (inTok || outTok) this.emit({ type: 'usage', inputTokens: inTok, outputTokens: outTok })
          // nothing else is coming from us, the cli finishes whatever it still has queued and exits
          inbox.end()
        }
      }
    } catch (err) {
      if (signal.aborted || this.interrupted) return
      const msg = err instanceof Error ? err.message : String(err)
      if (!gotAny && /ENOENT|spawn|not found|failed to launch/i.test(msg)) throw new ProviderUnavailable(msg)
      throw err
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      inbox.end()
      this.inbox = null
      this.query = null
      this.abort = null
      this.approvals.flush({ decision: 'deny', feedback: 'The turn ended.' })
      this.inputs.flush(null)
    }
    if (signal.aborted || this.interrupted) return
    const error = parser.error()
    if (error) throw new Error(error)
  }

  async steer(text: string): Promise<boolean> {
    const inbox = this.inbox
    if (!inbox || inbox.closed || this.interrupted) return false
    const msg = this.message(text)
    // goes in at the next step of the running turn instead of after it
    msg.priority = 'next'
    if (!inbox.push(msg)) return false
    this.emit({ type: 'steered', text })
    return true
  }

  async interrupt(): Promise<void> {
    const q = this.query
    if (!q) return
    this.interrupted = true
    this.approvals.flush({ decision: 'deny', feedback: 'The user stopped the reply.' })
    this.inputs.flush(null)
    this.inbox?.end()
    const receipt = await q.interrupt().catch(() => undefined)
    // a steered message still waiting would run right after the stop, so the process goes
    if (receipt?.still_queued?.length) this.abort?.abort()
  }

  respondToApproval(requestId: string, decision: ApprovalDecision, opts: { feedback?: string; remember?: boolean } = {}): boolean {
    return this.approvals.answer(requestId, { decision, ...opts })
  }

  respondToUserInput(requestId: string, answers: Record<string, string>): boolean {
    return this.inputs.answer(requestId, answers)
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode
    await this.query?.setPermissionMode(mapMode(mode).permissionMode).catch(() => {})
  }

  sessionId(): string | undefined {
    return this.session
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.inbox?.end()
    this.approvals.flush({ decision: 'deny', feedback: 'The session closed.' })
    this.inputs.flush(null)
    this.query?.close()
  }
}

let modelCache: { at: number; models: ModelOption[] } | null = null

async function liveModels(): Promise<ModelOption[] | null> {
  const claude = await findClaude()
  if (!claude || claude.launch.shell) return null
  const { query } = await loadSdk()
  // no prompt ever goes in, the cli starts, says what models it has and gets closed
  const idle = new Inbox<SDKUserMessage>()
  const q = query({ prompt: idle, options: await baseOptions(claude, {}) })
  try {
    const list = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), MODELS_TIMEOUT_MS).unref())
    ])
    return list.slice(0, 50).map((m) => ({
      id: m.value,
      label: m.displayName || m.value,
      efforts: m.supportsEffort ? m.supportedEffortLevels : undefined
    }))
  } finally {
    idle.end()
    q.close()
  }
}

// signed in when claude code's own credentials file is there. on macos it's in the keychain,
// and we don't go poking at that, so the answer is "can't tell". only checks the file exists
async function signedIn(folder: string | undefined): Promise<boolean | null> {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return true
  const dir = folder || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  try {
    await fs.access(join(dir, '.credentials.json'))
    return true
  } catch {
    return process.platform === 'darwin' ? null : false
  }
}

export const claudeAdapter: ProviderAdapter = {
  kind: 'claude-sdk',
  capabilities,
  handles: (agentId) => baseAgentId(agentId) === 'claude',

  async health(agentId): Promise<ProviderHealth> {
    const claude = await findClaude()
    if (!claude) return { installed: false, detail: '', signedIn: null, note: `Sign in with: ${SPEC.setup}` }
    const auth = await signedIn((await accountEnv(agentId)).CLAUDE_CONFIG_DIR)
    return {
      installed: true,
      detail: claude.path,
      signedIn: auth,
      note: auth === false ? `Not signed in. Run: ${SPEC.setup}` : undefined
    }
  },

  async listModels(): Promise<ModelOption[]> {
    const fallback = SPEC.models ?? [{ id: '', label: 'Model' }]
    if (modelCache && Date.now() - modelCache.at < MODELS_TTL_MS) return modelCache.models
    try {
      const live = await liveModels()
      if (!live?.length) return fallback
      const models = [{ id: '', label: 'Model' }, ...live.filter((m) => m.id && m.id !== 'default')]
      modelCache = { at: Date.now(), models }
      return models
    } catch {
      return fallback
    }
  },

  async startSession(start: SessionStart): Promise<ProviderSession> {
    const claude = await findClaude()
    if (!claude) throw new ProviderUnavailable(`${SPEC.name} isn't installed or isn't on PATH`)
    // a .cmd we couldn't unwrap needs a shell, and the sdk's arguments don't survive one
    if (claude.launch.shell) throw new ProviderUnavailable(`Couldn't start ${SPEC.name} without a shell`)
    return new ClaudeSession(start, claude)
  }
}
