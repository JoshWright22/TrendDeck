import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { CliSpec } from './catalog'
import { resolveLaunch, splitCommand, which } from './detect'
import { claudeParser, codexParser, cursorParser, type Parser, type Sink } from './parse'

export interface RunHooks extends Sink {
  signal: AbortSignal
}

export interface CliOptions {
  model?: string
  session?: string
}

// what the app's agent server hands back for one turn: extra args and env for the process
export interface TurnAttach {
  args: string[]
  env: Record<string, string>
}

const NO_ATTACH: TurnAttach = { args: [], env: {} }

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

// the agent gets the user's normal environment, minus electron's own switches, plus the turn's
function agentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return { ...env, ...extra }
}

// a flag given twice only keeps one value, so the turn's allowed tools join the ones already there
function mergeArgs(base: string[], extra: string[]): { base: string[]; extra: string[] } {
  const out = [...base]
  const rest: string[] = []
  for (let i = 0; i < extra.length; i++) {
    const flag = extra[i]
    const at = flag === '--allowedTools' ? out.indexOf(flag) : -1
    if (at >= 0 && at + 1 < out.length && i + 1 < extra.length) {
      out[at + 1] = `${out[at + 1]},${extra[i + 1]}`
      i++
    } else rest.push(flag)
  }
  return { base: out, extra: rest }
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

interface SpawnPlan {
  file: string
  args: string[]
  shell: boolean
  stdin: string | null
  output: CliSpec['output']
  env: Record<string, string>
}

async function planCli(spec: CliSpec, prompt: string, opts: CliOptions, turn: TurnAttach): Promise<SpawnPlan> {
  let path: string | null = null
  for (const bin of spec.bins) {
    path = await which(bin)
    if (path) break
  }
  if (!path) throw new Error(`${spec.name} isn't installed or isn't on PATH`)
  const launch = await resolveLaunch(path)
  const merged = mergeArgs(spec.args, turn.args)
  const extra: string[] = [...merged.extra]
  if (opts.session && spec.resume) extra.push(...spec.resume(opts.session))
  if (opts.model && spec.modelFlag) extra.push(spec.modelFlag, opts.model)
  const base = merged.base.map((a) => (a === '{prompt}' ? prompt : a))
  // codex reads `-` as the prompt marker, so the extra flags go before the last arg there
  const args = spec.id === 'codex' ? [...base.slice(0, -1), ...extra, ...base.slice(-1)] : [...extra, ...base]
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
    output: spec.output,
    env: turn.env
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

async function planCommand(command: string, prompt: string, turn: TurnAttach): Promise<SpawnPlan> {
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
    args: [...launch.prefix, ...args, ...turn.args],
    shell: launch.shell,
    stdin: usesArg ? null : prompt,
    output: 'text',
    env: turn.env
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
      env: agentEnv(plan.env),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    let gotText = false
    let pending = ''
    const sink: Sink = { ...hooks, text: (t) => emit(t) }
    const parser: Parser | null =
      plan.output === 'claude-json'
        ? claudeParser(sink)
        : plan.output === 'codex-json'
          ? codexParser(sink)
          : plan.output === 'cursor-json'
            ? cursorParser(sink)
            : null

    function emit(text: string): void {
      if (!text) return
      gotText = true
      hooks.text(text)
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

export async function runCli(
  spec: CliSpec,
  prompt: string,
  opts: CliOptions,
  hooks: RunHooks,
  turn: TurnAttach = NO_ATTACH
): Promise<void> {
  await runPlan(await planCli(spec, prompt, opts, turn), hooks)
}

export async function runCommand(
  command: string,
  prompt: string,
  hooks: RunHooks,
  turn: TurnAttach = NO_ATTACH
): Promise<void> {
  await runPlan(await planCommand(command, prompt, turn), hooks)
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
      body: JSON.stringify({ model: target.model, messages, stream: true, stream_options: { include_usage: true } }),
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
          const j = JSON.parse(data) as {
            choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string } }[]
            usage?: { total_tokens?: number }
            error?: { message?: string }
          }
          if (j.error) throw new Error(j.error.message ?? 'The API returned an error')
          const delta = j.choices?.[0]?.delta
          // deepseek, glm and openrouter send their thinking next to the answer
          const thought = delta?.reasoning_content ?? delta?.reasoning
          if (thought) hooks.thinking(thought)
          if (delta?.content) hooks.text(delta.content)
          if (j.usage?.total_tokens) hooks.contextTokens(j.usage.total_tokens)
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
