import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Turn } from './turns'

// stdio for agents that can't talk http: a tiny script run by electron's own node
// that passes each line to the http server and prints the answer
const BRIDGE = `'use strict'
const url = process.env.TRENDDECK_MCP_URL
const token = process.env.TRENDDECK_MCP_TOKEN
if (!url || !token) { process.stderr.write('TRENDDECK_MCP_URL and TRENDDECK_MCP_TOKEN are needed\\n'); process.exit(1) }
let buf = ''
let chain = Promise.resolve()
const post = async (line) => {
  let id = null
  try { id = JSON.parse(line).id ?? null } catch {}
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token },
      body: line
    })
    const text = await res.text()
    if (res.status === 202 || !text) return
    if (!res.ok && id !== null) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: text || ('http ' + res.status) } }) + '\\n')
      return
    }
    process.stdout.write(text.replace(/\\n/g, ' ') + '\\n')
  } catch (err) {
    if (id !== null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'TrendDeck is not reachable: ' + err.message } }) + '\\n')
  }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line) chain = chain.then(() => post(line))
  }
})
process.stdin.on('end', () => chain.then(() => process.exit(0)))
`

export type AgentKind = 'claude' | 'codex' | 'opencode' | 'generic'

export interface Attachment {
  // extra command line args for the agent
  args: string[]
  // extra env for the agent process
  env: Record<string, string>
  // files written for this turn, removed by cleanup
  files: string[]
  cleanup: () => Promise<void>
}

function dir(): string {
  return join(app.getPath('userData'), 'mcp')
}

async function writePrivate(path: string, body: string): Promise<void> {
  await fs.mkdir(dir(), { recursive: true })
  await fs.writeFile(path, body, { encoding: 'utf8', mode: 0o600 })
}

export async function bridgePath(): Promise<string> {
  const path = join(dir(), 'bridge.cjs')
  const now = await fs.readFile(path, 'utf8').catch(() => '')
  if (now !== BRIDGE) await writePrivate(path, BRIDGE)
  return path
}

// the command that starts the stdio bridge, same for every agent
export async function stdioCommand(): Promise<{ command: string; args: string[] }> {
  return { command: process.execPath, args: [await bridgePath()] }
}

function toml(value: unknown): string {
  // json strings and arrays are valid toml here
  return JSON.stringify(value)
}

export async function attachFor(agent: AgentKind, turn: Turn, url: string): Promise<Attachment> {
  const files: string[] = []
  const cleanup = async (): Promise<void> => {
    await Promise.all(files.map((f) => fs.rm(f, { force: true })))
  }
  const stdio = await stdioCommand()
  const bridgeEnv = { ELECTRON_RUN_AS_NODE: '1', TRENDDECK_MCP_URL: url, TRENDDECK_MCP_TOKEN: turn.token }
  const base = { TRENDDECK_MCP_URL: url, TRENDDECK_MCP_TOKEN: turn.token }

  if (agent === 'claude') {
    const file = join(dir(), `claude-${turn.id}.json`)
    files.push(file)
    await writePrivate(
      file,
      JSON.stringify({
        mcpServers: { trenddeck: { type: 'http', url, headers: { Authorization: `Bearer ${turn.token}` } } }
      })
    )
    // the server checks site access itself, so its tools don't need a prompt each time
    return { args: ['--mcp-config', file, '--allowedTools', 'mcp__trenddeck'], env: base, files, cleanup }
  }

  if (agent === 'codex') {
    const key = 'mcp_servers.trenddeck'
    const args = [
      '-c', `${key}.command=${toml(stdio.command)}`,
      '-c', `${key}.args=${toml(stdio.args)}`,
      '-c', `${key}.env={ELECTRON_RUN_AS_NODE=${toml('1')},TRENDDECK_MCP_URL=${toml(url)},TRENDDECK_MCP_TOKEN=${toml(turn.token)}}`
    ]
    return { args, env: base, files, cleanup }
  }

  if (agent === 'opencode') {
    const file = join(dir(), `opencode-${turn.id}.json`)
    files.push(file)
    await writePrivate(
      file,
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        mcp: {
          trenddeck: {
            type: 'remote',
            url,
            enabled: true,
            oauth: false,
            headers: { Authorization: 'Bearer {env:TRENDDECK_MCP_TOKEN}' }
          }
        }
      })
    )
    return { args: [], env: { ...base, OPENCODE_CONFIG: file }, files, cleanup }
  }

  // anything else gets the url and token in env, plus a standard mcpServers file using stdio
  const file = join(dir(), `generic-${turn.id}.json`)
  files.push(file)
  await writePrivate(
    file,
    JSON.stringify(
      {
        mcpServers: {
          trenddeck: { command: stdio.command, args: stdio.args, env: bridgeEnv },
          'trenddeck-http': { type: 'http', url, headers: { Authorization: `Bearer ${turn.token}` } }
        }
      },
      null,
      2
    )
  )
  return {
    args: [],
    env: {
      ...base,
      TRENDDECK_MCP_CONFIG: file,
      TRENDDECK_MCP_STDIO: [stdio.command, ...stdio.args].map((p) => JSON.stringify(p)).join(' ')
    },
    files,
    cleanup
  }
}

// leftovers from a crash, the tokens in them are dead anyway
export async function sweepConfigs(): Promise<void> {
  const names = await fs.readdir(dir()).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((n) => /^(claude|opencode|generic)-.+\.json$/.test(n))
      .map((n) => fs.rm(join(dir(), n), { force: true }))
  )
}
