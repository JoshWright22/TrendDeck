import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentUsage, UsageWindow } from '@shared/chat'
import { CLIS } from './catalog'

// rate limits per agent. nothing here starts an agent or sends a prompt: claude's
// limits are what it reported on the last chat reply, codex's are read from its own
// session logs on disk, the rest don't expose them

interface Seen {
  windows: UsageWindow[]
  at: number
}

let seen: Record<string, Seen> | null = null

function file(): string {
  return join(app.getPath('userData'), 'agent-usage.json')
}

async function load(): Promise<Record<string, Seen>> {
  if (seen) return seen
  try {
    seen = JSON.parse(await fs.readFile(file(), 'utf8')) as Record<string, Seen>
  } catch {
    seen = {}
  }
  return seen
}

export async function recordLimits(agentId: string, windows: UsageWindow[]): Promise<void> {
  const all = await load()
  all[agentId] = { windows, at: Date.now() }
  await fs.writeFile(file(), JSON.stringify(all), 'utf8').catch(() => {})
}

// newest file under a folder, a few levels down, without reading every file
async function newest(dir: string, depth: number): Promise<string | null> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const names = entries.map((e) => e.name).sort().reverse()
  for (const name of names) {
    const e = entries.find((x) => x.name === name)!
    const path = join(dir, name)
    if (e.isDirectory() && depth > 0) {
      const hit = await newest(path, depth - 1)
      if (hit) return hit
    } else if (e.isFile() && name.endsWith('.jsonl')) {
      return path
    }
  }
  return null
}

// codex writes rate_limits into its session logs (~/.codex/sessions/yyyy/mm/dd/*.jsonl)
async function codexLimits(): Promise<Seen | null> {
  const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
  const path = await newest(root, 3)
  if (!path) return null
  try {
    const stat = await fs.stat(path)
    const lines = (await fs.readFile(path, 'utf8')).split('\n').reverse()
    for (const l of lines) {
      if (!l.includes('rate_limits')) continue
      const ev = JSON.parse(l) as { payload?: { rate_limits?: Record<string, unknown> } }
      const rl = ev.payload?.rate_limits
      if (!rl) continue
      const windows: UsageWindow[] = []
      for (const key of ['primary', 'secondary']) {
        const w = rl[key] as { used_percent?: number; window_minutes?: number; resets_at?: number; resets_in_seconds?: number } | undefined
        if (!w) continue
        const mins = w.window_minutes ?? 0
        windows.push({
          label: mins >= 10_000 ? 'Weekly limit' : mins ? `${Math.round(mins / 60)} hour limit` : key,
          used: typeof w.used_percent === 'number' ? w.used_percent / 100 : null,
          resetsAt: w.resets_at
            ? w.resets_at * 1000
            : typeof w.resets_in_seconds === 'number'
              ? stat.mtimeMs + w.resets_in_seconds * 1000
              : null
        })
      }
      if (windows.length) return { windows, at: stat.mtimeMs }
    }
  } catch {
    // unreadable log, treat as unknown
  }
  return null
}

export async function usageFor(agentIds: string[]): Promise<AgentUsage[]> {
  const all = await load()
  return Promise.all(
    agentIds.map(async (agentId): Promise<AgentUsage> => {
      const cli = CLIS.find((c) => c.id === agentId)
      const mine = all[agentId]
      if (agentId === 'codex') {
        const fromLogs = await codexLimits()
        const best = [fromLogs, mine].filter((s): s is Seen => !!s).sort((a, b) => b.at - a.at)[0]
        if (best) return { agentId, windows: best.windows, note: 'From Codex session logs', seenAt: best.at }
      }
      if (mine) return { agentId, windows: mine.windows, note: 'As of the last reply', seenAt: mine.at }
      const note = !cli
        ? "This agent doesn't report limits"
        : agentId === 'claude'
          ? 'Shows up after the first reply'
          : `${cli.name} doesn't report limits outside its own app`
      return { agentId, windows: [], note, seenAt: null }
    })
  )
}
