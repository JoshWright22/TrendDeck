import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { CraftJobCard } from '@shared/cards'
import { nativeExportParams, proxyArgs, wantsProxy } from '@shared/craft-web'
import { addCard, changeCard, newCardId } from '../cards/store'
import { checkProjectFile, relativeIn } from '../cards/files'
import { ffmpegPaths, probe } from '../qc/ffmpeg'
import { fill, spec } from './catalog'
import { installed } from './install'
import { cleanEnv } from './launch'
import { McpClient, type McpCallResult } from './mcp'
import { safeName, uniqueName } from './rules'

// the heavy half of a web editor in the chat: the web builds run on one thread, so exports and
// proxies run in the app's native engine (all cores, hardware encoding) or the bundled ffmpeg,
// in the background, each with a card in the chat that shows how far it got

export interface JobWhere {
  brandId: string
  threadId: string | null
  messageId: string | null
}

interface JobTarget {
  appId: string
  brandId: string
  projectId: string
  folder: string
}

async function startCard(w: JobWhere, t: JobTarget, kind: CraftJobCard['kind'], label: string): Promise<string> {
  const now = Date.now()
  const card: CraftJobCard = {
    id: newCardId(), brandId: w.brandId, threadId: w.threadId, messageId: w.messageId, at: now, updatedAt: now,
    type: 'craft-job', appId: t.appId, appName: spec(t.appId).name, projectId: t.projectId, kind, label, progress: null, state: 'running', output: null, note: ''
  }
  await addCard(card)
  return card.id
}

// progress changes come fast, the card gets one every half second
function progressTo(brandId: string, cardId: string): (p: number | null) => void {
  let last = 0
  let pending: number | null = null
  let timer: NodeJS.Timeout | null = null
  const flush = (): void => {
    timer = null
    last = Date.now()
    const p = pending
    void changeCard(brandId, cardId, (c) => {
      if (c.type === 'craft-job' && c.state === 'running') c.progress = p
    }).catch(() => {})
  }
  return (p) => {
    pending = p === null ? null : Math.max(0, Math.min(1, p))
    if (timer) return
    timer = setTimeout(flush, Math.max(0, 500 - (Date.now() - last)))
  }
}

async function finishCard(brandId: string, cardId: string, patch: Partial<CraftJobCard>): Promise<void> {
  await changeCard(brandId, cardId, (c) => {
    if (c.type === 'craft-job') Object.assign(c, patch)
  }).catch(() => {})
}

async function outputRef(t: JobTarget, path: unknown): Promise<CraftJobCard['output']> {
  if (typeof path !== 'string' || !path) return null
  try {
    return (await checkProjectFile(t.brandId, t.projectId, relativeIn(t.folder, path))).ref
  } catch {
    return null
  }
}

const textOf = (r: McpCallResult): string => r.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join(' ').trim()

// one command (an export) in the native engine on the saved project file, with a card. resolves
// with the engine's answer, which goes back to the agent as it is
export async function nativeCommand(o: JobTarget & { file: string; command: string; params: Record<string, unknown>; where: JobWhere; signal?: AbortSignal }): Promise<McpCallResult> {
  const have = await installed(o.appId)
  if (!have) throw new Error(`${spec(o.appId).name} isn't installed`)
  const sp = spec(o.appId)
  const isExport = /export|render|queue/i.test(o.command)
  const params = isExport && o.appId === 'filmcraft' && o.command === 'file.exportMedia' ? nativeExportParams(o.params) : { ...o.params, wait: true }
  const out = typeof params.path === 'string' ? params.path : null
  const label = isExport ? `Exporting ${out ? basename(out) : 'the sequence'}` : `${sp.name}: ${o.command}`
  const cardId = await startCard(o.where, o, 'export', label)
  const progress = progressTo(o.brandId, cardId)
  const started = Date.now()
  const client = new McpClient({ command: have.cli, args: ['mcp', ...sp.headlessArgs(o.file, o.folder)], env: cleanEnv({}) as Record<string, string>, cwd: o.folder, timeoutMs: 10 * 60_000 })
  try {
    await client.start()
    if (sp.openTool) {
      const opened = fill(sp.openTool, o.file)
      const r = await client.callTool(opened.name, opened.args, { timeoutMs: 60_000 })
      if (r.isError) throw new Error(textOf(r) || `couldn't open ${basename(o.file)}`)
    }
    const r = await client.callTool('command_run', { id: o.command, params }, {
      signal: o.signal,
      timeoutMs: 10 * 60_000,
      onProgress: (p) => progress(p.total ? p.progress / p.total : null)
    })
    let result: Record<string, unknown> | null = null
    try {
      result = JSON.parse(textOf(r)) as Record<string, unknown>
    } catch {
      // not json, the text goes back as it is
    }
    const written = (result?.result as { path?: unknown } | undefined)?.path ?? result?.path ?? out
    const secs = Math.round((Date.now() - started) / 100) / 10
    await finishCard(o.brandId, cardId, r.isError
      ? { state: 'failed', note: textOf(r).slice(0, 300) || 'The export failed.', progress: null }
      : { state: 'done', progress: 1, output: await outputRef(o, written), note: `Done in ${secs} s on this computer's ${spec(o.appId).name}.` })
    return r
  } catch (err) {
    await finishCard(o.brandId, cardId, { state: 'failed', progress: null, note: (err instanceof Error ? err.message : String(err)).slice(0, 300) })
    throw err
  } finally {
    client.close()
  }
}

// ---- proxies ----

let proxyQueue: Promise<unknown> = Promise.resolve()

function ffmpeg(args: string[], duration: number, onProgress: (p: number | null) => void): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(ffmpegPaths().ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) {
        const m = /^out_time_us=(\d+)/.exec(l.trim())
        if (m && duration > 0) onProgress(Number(m[1]) / 1e6 / duration)
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString('utf8')).slice(-2000)
    })
    child.once('error', fail)
    child.once('close', (code) => (code === 0 ? ok() : fail(new Error(err.trim().split('\n').pop() || `ffmpeg stopped with ${code}`))))
  })
}

// a proxy for footage that's heavy for the web editor: quarter size H.264 with a short GOP, same
// frame rate and length so FilmCraft takes it as a proxy. made one at a time with every core.
// null when the footage doesn't need one. an up to date proxy from before is used again
export function makeProxy(o: JobTarget & { source: string; where: JobWhere }): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    const info = await probe(o.source).catch(() => null)
    if (!info || !info.width || !info.duration) return null
    const st = await fs.stat(o.source)
    if (!wantsProxy({ width: info.width, height: info.height, codec: info.videoCodec, bitRate: (st.size * 8) / info.duration })) return null
    const dir = join(o.folder, 'proxies')
    await fs.mkdir(dir, { recursive: true })
    const stem = safeName(basename(o.source, extname(o.source)), 'clip')
    const want = join(dir, `${stem}_proxy.mp4`)
    const there = await fs.stat(want).catch(() => null)
    if (there && there.mtimeMs >= st.mtimeMs && there.size > 0) return want
    const out = there ? join(dir, `${uniqueName(`${stem}_proxy`, (await fs.readdir(dir)).map((n) => basename(n, extname(n))))}.mp4`) : want
    const cardId = await startCard(o.where, o, 'proxy', `Making a smooth playback copy of ${basename(o.source)}`)
    const started = Date.now()
    try {
      await ffmpeg(proxyArgs(o.source, out), info.duration, progressTo(o.brandId, cardId))
      const secs = Math.round((Date.now() - started) / 100) / 10
      await finishCard(o.brandId, cardId, { state: 'done', progress: 1, output: await outputRef(o, out), note: `Done in ${secs} s. The editor plays this copy, exports use the original.` })
      return out
    } catch (err) {
      await fs.rm(out, { force: true }).catch(() => {})
      await finishCard(o.brandId, cardId, { state: 'failed', progress: null, note: `${(err instanceof Error ? err.message : String(err)).slice(0, 240)} The editor plays the original.` })
      throw err
    }
  }
  const next = proxyQueue.then(run, run)
  proxyQueue = next.catch(() => {})
  return next
}
