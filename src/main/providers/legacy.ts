import type { ModelOption } from '@shared/chat'
import { baseAgentId } from '@shared/agents'
import type { ApprovalDecision, PermissionMode, ProviderCapabilities } from '@shared/providers'
import { cliFor } from '../agents/catalog'
import { getCustom } from '../agents/config'
import { which } from '../agents/detect'
import { runApi, runCli, runCommand, type RunHooks } from '../agents/run'
import { sinkFor } from './common'
import type { ProviderAdapter, ProviderEvent, ProviderHealth, ProviderSession, SessionStart, TurnInput } from './types'

// the one-shot spawn path for clis without a session protocol (cursor, grok, opencode, agy,
// qwen, kimi), custom command agents and custom openai compatible api agents. a turn is one
// process or one request: no approvals mid turn, no steering, stop kills the process tree.
// claude and codex land here too when their own adapter can't run on this machine

const DEFAULT_MODEL: ModelOption[] = [{ id: '', label: 'Model' }]
const NATIVE = new Set(['claude', 'codex'])

const caps: ProviderCapabilities = {
  steer: false,
  approvals: false,
  userInput: false,
  resume: false,
  interrupt: true,
  liveModels: false,
  permissionModes: false
}

class LegacySession implements ProviderSession {
  private session: string | undefined
  private ctl = new AbortController()

  constructor(
    readonly agentId: string,
    private start: SessionStart
  ) {
    this.session = start.resume
    start.signal.addEventListener('abort', () => this.ctl.abort(), { once: true })
  }

  private emit(e: ProviderEvent): void {
    if (e.type === 'session') this.session = e.id
    this.start.emit(e)
  }

  async sendTurn(input: TurnInput): Promise<void> {
    const hooks: RunHooks = { ...sinkFor((e) => this.emit(e)), signal: this.ctl.signal }
    const mcp = this.start.mcp?.attach
    const attach = { args: mcp?.args ?? [], env: { ...(mcp?.env ?? {}), ...(this.start.env ?? {}) } }
    const cli = cliFor(this.agentId)
    if (cli) {
      const opts = { model: this.start.model, effort: this.start.effort, session: cli.resume ? this.session : undefined }
      await runCli(cli, input.text, opts, hooks, attach)
      return
    }
    const custom = await getCustom(this.agentId)
    if (!custom) throw new Error('That agent was removed. Pick another one.')
    if (custom.kind === 'command') {
      await runCommand(custom.command, input.text, hooks, attach)
      return
    }
    // an api agent is one plain request with no process and no tool calls
    await runApi(
      { baseUrl: custom.baseUrl, apiKey: custom.apiKey, model: this.start.model || custom.model },
      [
        { role: 'system', content: input.system ?? '' },
        ...(input.history ?? []).map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: m.text })),
        { role: 'user', content: input.message ?? input.text }
      ],
      hooks
    )
  }

  async steer(): Promise<boolean> {
    return false
  }

  async interrupt(): Promise<void> {
    this.ctl.abort()
  }

  respondToApproval(_requestId: string, _decision: ApprovalDecision): boolean {
    return false
  }

  respondToUserInput(): boolean {
    return false
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {}

  sessionId(): string | undefined {
    return this.session
  }

  async close(): Promise<void> {
    this.ctl.abort()
  }
}

async function findCli(agentId: string): Promise<string | null> {
  const cli = cliFor(agentId)
  if (!cli) return null
  for (const bin of cli.bins) {
    const path = await which(bin)
    if (path) return path
  }
  return null
}

export const legacyAdapter: ProviderAdapter = {
  kind: 'legacy-cli',
  capabilities: caps,
  // claude and codex have their own adapters, this one only runs them as a fallback
  handles: (agentId) => !NATIVE.has(baseAgentId(agentId)),

  async health(agentId): Promise<ProviderHealth> {
    const cli = cliFor(agentId)
    if (cli) {
      const path = await findCli(agentId)
      return { installed: path !== null, detail: path ?? '', signedIn: null, note: path ? undefined : `Sign in with: ${cli.setup}` }
    }
    const custom = await getCustom(agentId)
    if (!custom) return { installed: false, detail: '', signedIn: null }
    if (custom.kind === 'command') return { installed: true, detail: custom.command, signedIn: null }
    let host = custom.baseUrl
    try {
      host = new URL(custom.baseUrl).host
    } catch {
      // keep the raw url
    }
    return { installed: true, detail: host, signedIn: custom.hasKey ? true : null }
  },

  async listModels(agentId): Promise<ModelOption[]> {
    const cli = cliFor(agentId)
    if (cli) return cli.modelFlag ? (cli.models ?? DEFAULT_MODEL) : DEFAULT_MODEL
    return apiModels(agentId)
  },

  async startSession(start: SessionStart): Promise<ProviderSession> {
    return new LegacySession(start.agentId, start)
  }
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

export const legacyKind = async (agentId: string): Promise<'legacy-cli' | 'legacy-command' | 'legacy-api'> => {
  if (cliFor(agentId)) return 'legacy-cli'
  const custom = await getCustom(agentId)
  return custom?.kind === 'api' ? 'legacy-api' : 'legacy-command'
}
