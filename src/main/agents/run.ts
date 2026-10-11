import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { CliSpec } from './catalog'
import { resolveLaunch, splitCommand, which } from './detect'

export interface RunHooks {
  onText: (text: string) => void
  signal: AbortSignal
}

const isWin = process.platform === 'win32'
// a reply that takes longer than this is stuck
const MAX_RUN_MS = 10 * 60_000

// strips colors and cursor moves some clis print even when piped
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

// agents run in an empty folder so they don't go reading your files
async function workDir(): Promise<string> {
  const path = join(app.getPath('userData'), 'agent-room')
  await fs.mkdir(path, { recursive: true })
  return path
}

// the agent gets the user's normal environment, minus electron's own switches
function agentEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return env
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return
  if (isWin) {
    // child.kill only gets the top process on windows, the agent's own children keep going
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
  } else {
    child.kill('SIGTERM')
  }
}

// claude's stream-json: partial text arrives as content_block_delta events
function claudeParser(onText: (t: string) => void): { line: (l: string) => void; error: () => string } {
  let sawDelta = false
  let error = ''
  return {
    line(l) {
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(l)
      } catch {
        return
      }
      if (ev.type === 'stream_event') {
        const e = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          sawDelta = true
          onText(e.delta.text)
        }
      } else if (ev.type === 'assistant' && !sawDelta) {
        // older versions without partial messages send whole messages
        const content = (ev.message as { content?: { type: string; text?: string }[] } | undefined)?.content ?? []
        for (const c of content) if (c.type === 'text' && c.text) onText(c.text)
      } else if (ev.type === 'result' && ev.is_error) {
        error = typeof ev.result === 'string' ? ev.result : 'The agent returned an error'
      }
    },
    error: () => error
  }
}

interface SpawnPlan {
  file: string
  args: string[]
  shell: boolean
  stdin: string | null
  output: CliSpec['output']
}

async function planCli(spec: CliSpec, prompt: string): Promise<SpawnPlan> {
  let path: string | null = null
  for (const bin of spec.bins) {
    path = await which(bin)
    if (path) break
  }
  if (!path) throw new Error(`${spec.name} isn't installed or isn't on PATH`)
  const launch = await resolveLaunch(path)
  const args = spec.args.map((a) => (a === '{prompt}' ? prompt : a))
  if (launch.shell && spec.prompt === 'arg') {
    throw new Error(`Couldn't start ${spec.name} without a shell. Add it as a custom command agent instead.`)
  }
  // cmd.exe mangles an empty "" arg, drop the flag pair instead
  const safeArgs = launch.shell ? dropEmptyFlags(args) : args
  return {
    file: launch.file,
    args: [...launch.prefix, ...safeArgs],
    shell: launch.shell,
    stdin: spec.prompt === 'stdin' ? prompt : null,
    output: spec.output
  }
}

function dropEmptyFlags(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i + 1] === '' && args[i].startsWith('-')) {
      i++
      continue
    }
    if (args[i] !== '') out.push(args[i])
  }
  return out
}

async function planCommand(command: string, prompt: string): Promise<SpawnPlan> {
  const parts = splitCommand(command)
  if (parts.length === 0) throw new Error('This agent has no command set')
  const path = await which(parts[0])
  if (!path) throw new Error(`Couldn't find ${parts[0]} on PATH`)
  const launch = await resolveLaunch(path)
  const usesArg = parts.slice(1).some((p) => p.includes('{prompt}'))
  if (launch.shell && usesArg) {
    throw new Error(`Couldn't start ${parts[0]} without a shell, so {prompt} can't be used. Drop it and the prompt goes in on stdin.`)
  }
  const args = parts.slice(1).map((p) => p.split('{prompt}').join(prompt))
  return {
    file: launch.file,
    args: [...launch.prefix, ...args],
    shell: launch.shell,
    stdin: usesArg ? null : prompt,
    output: 'text'
  }
}

async function runPlan(plan: SpawnPlan, hooks: RunHooks): Promise<void> {
  const cwd = await workDir()
  return new Promise((resolve, reject) => {
    if (hooks.signal.aborted) return resolve()
    // with a shell node joins everything with spaces, so a path with spaces needs quotes
    const file = plan.shell ? `"${plan.file}"` : plan.file
    const child = spawn(file, plan.args, {
      cwd,
      shell: plan.shell,
      windowsHide: true,
      env: agentEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    let gotText = false
    let pending = ''
    const parser = plan.output === 'claude-json' ? claudeParser((t) => emit(t)) : null

    function emit(text: string): void {
      if (!text) return
      gotText = true
      hooks.onText(text)
    }

    const stop = (): void => killTree(child)
    hooks.signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, MAX_RUN_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (parser) {
        pending += chunk
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const l of lines) parser.line(l)
      } else {
        emit(chunk.replace(ANSI, '').replace(/\r\n/g, '\n'))
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      hooks.signal.removeEventListener('abort', stop)
      if (parser && pending) parser.line(pending)
      if (hooks.signal.aborted) return resolve()
      const parsedError = parser?.error()
      if (parsedError) return reject(new Error(parsedError))
      if (code !== 0 && !gotText) {
        const why = stderr.replace(ANSI, '').trim().split('\n').slice(-6).join('\n')
        return reject(new Error(why || `The agent quit with code ${code}`))
      }
      resolve()
    })

    child.stdin.on('error', () => {})
    if (plan.stdin !== null) child.stdin.end(plan.stdin)
    else child.stdin.end()
  })
}

export async function runCli(spec: CliSpec, prompt: string, hooks: RunHooks): Promise<void> {
  await runPlan(await planCli(spec, prompt), hooks)
}

export async function runCommand(command: string, prompt: string, hooks: RunHooks): Promise<void> {
  await runPlan(await planCommand(command, prompt), hooks)
}

export interface ApiTarget {
  baseUrl: string
  apiKey: string
  model: string
}

// any openai compatible /chat/completions endpoint, streamed over sse
export async function runApi(
  target: ApiTarget,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  hooks: RunHooks
): Promise<void> {
  const timeout = AbortSignal.timeout(MAX_RUN_MS)
  const signal = AbortSignal.any([hooks.signal, timeout])
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' }
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`
  let res: Response
  try {
    res = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: target.model, messages, stream: true }),
      signal
    })
  } catch (err) {
    if (hooks.signal.aborted) return
    throw new Error(`Couldn't reach ${new URL(target.baseUrl).host}: ${err instanceof Error ? err.message : err}`)
  }
  if (!res.ok || !res.body) {
    const body = (await res.text().catch(() => '')).slice(0, 600)
    let why = body
    try {
      const j = JSON.parse(body) as { error?: { message?: string } | string }
      why = typeof j.error === 'string' ? j.error : (j.error?.message ?? body)
    } catch {
      // not json, keep the text
    }
    throw new Error(`${res.status} ${res.statusText}${why ? `: ${why}` : ''}`)
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += value
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        try {
          const j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; error?: { message?: string } }
          if (j.error) throw new Error(j.error.message ?? 'The API returned an error')
          const text = j.choices?.[0]?.delta?.content
          if (text) hooks.onText(text)
        } catch (err) {
          if (err instanceof SyntaxError) continue
          throw err
        }
      }
    }
  } catch (err) {
    if (hooks.signal.aborted) return
    throw err
  }
}
