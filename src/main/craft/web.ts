import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { session as electronSession, webContents, type WebContents } from 'electron'
import { CRAFT_WEB_PARTITION, CRAFT_WEB_SCHEME, filmcraftWebStep, mapProjectPaths, PathTable, projectPaths, webSpec, type WebEmbedState, type WebStep } from '@shared/craft-web'
import { dockOpenClose, dockSizes, prefsToRestore, stepZoom, type DockAction } from '@shared/craft-web-view'
import { broadcast } from '../gateway/wait'
import { setWebHooks, sessionOf, stopSession, type Session } from './agent'
import { fill, spec } from './catalog'
import { ensureWeb, installed, installedWeb } from './install'
import { makeProxy, nativeCommand, type JobWhere } from './jobs'
import { cleanEnv, runningApp } from './launch'
import { McpClient, type McpCallResult, type McpContent } from './mcp'
import { projectOperation, snapshotFile } from './recovery'
import { previewSpeedNow } from '../preview-speed'
import { isInside, safeName } from './rules'
import { appUrl, craftWebResponse, projectUrl } from './web-protocol'
import { setView, viewOf } from './web-view'

// the Craft apps' web builds in the chat: each card hosts the app as a <webview> on
// craft-web://<app>/. main finds its guest page, loads the project into it, keeps the project
// file in the folder up to date (with recovery copies) and lets the agent drive it. see
// @shared/craft-web and docs/DECISIONS-craft-web.md

interface Embed {
  cardId: string
  appId: string
  brandId: string
  projectId: string
  folder: string
  // the project's document on disk, null when the app opened empty
  file: string | null
  where: JobWhere
  token: string
  guest: WebContents | null
  state: WebEmbedState['state']
  note: string
  savedAt: number | null
  ready: Promise<void>
  settle: (err?: Error) => void
  table: PathTable
  // the document's path in the web build (/projects/<name>)
  doc: string | null
  // the project as last written to disk, to tell whether anything changed
  saved: string | null
  // input since the last save, for builds whose saves TrendDeck can't make itself
  touched: boolean
  // your last input in the editor, the agent hears about edits since its last reply
  editedAt: number
  loadedAt: number
  session: Session
  timers: NodeJS.Timeout[]
  inputSave: NodeJS.Timeout | null
  seenJobs: Set<number>
  debugger: boolean
  // the saved layout is going back in, what the page shows until then isn't yours
  restoring: boolean
  // the page froze and is starting again on purpose, its renderer going away isn't a failure
  restarting: boolean
}

const embeds = new Map<string, Embed>()
const AUTOSAVE_MS = 30_000
// a pause after you stop typing or dragging, then the project saves
const INPUT_SAVE_MS = 4_000

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error: /, '').replace(/^Error invoking remote method '[^']+': /, '')

function emit(e: Embed): void {
  broadcast('craft-web:state', { cardId: e.cardId, state: e.state, note: e.note, savedAt: e.savedAt } satisfies WebEmbedState)
}

export function webState(cardId: string): WebEmbedState | null {
  const e = embeds.get(cardId)
  return e ? { cardId, state: e.state, note: e.note, savedAt: e.savedAt } : null
}

// the ready api embed on a project, the one the agent works in
function liveFor(appId: string, brandId: string, projectId: string): Embed | null {
  for (const e of embeds.values()) {
    if (e.appId === appId && e.brandId === brandId && e.projectId === projectId && e.state !== 'closed' && e.state !== 'failed') return e
  }
  return null
}

export function webLiveOn(appId: string, brandId: string, projectId: string): boolean {
  const e = liveFor(appId, brandId, projectId)
  return !!e && webSpec(appId)?.kind === 'api'
}

// an editor whose changes only live in the page (PhotoCraft saves as a download TrendDeck can't
// make for you): it keeps running when it scrolls out of view, letting go would lose them
export function webUnsaved(cardId: string): boolean {
  const e = embeds.get(cardId)
  return !!e && e.touched && e.state === 'ready' && webSpec(e.appId)?.kind === 'files' && !!e.guest && !e.guest.isDestroyed()
}

// an editor you're working in right now (a change in the last two minutes) or one holding work
// TrendDeck can't save for you: a restart for an update waits for it
export function webInUse(now = Date.now()): boolean {
  return [...embeds.values()].some((e) => (e.editedAt && now - e.editedAt < 120_000) || webUnsaved(e.cardId))
}

// the running editor on a project and when you last changed something in it
export function webEdited(appId: string, brandId: string, projectId: string): { cardId: string; editedAt: number } | null {
  const e = liveFor(appId, brandId, projectId)
  return e && e.editedAt ? { cardId: e.cardId, editedAt: e.editedAt } : null
}

export function webEmbedOn(appId: string, brandId: string, projectId: string): string | null {
  return liveFor(appId, brandId, projectId)?.cardId ?? null
}

// ---- the guest page ----

function guest(e: Embed): WebContents {
  if (!e.guest || e.guest.isDestroyed()) throw new Error(`${spec(e.appId).name} in the chat is gone. Open it here again.`)
  return e.guest
}

// the longest anything in the page may take (bringing in a big file). a call into a page that
// closed, crashed or hung never comes back on its own, and it would hold the project's lock with
// everything after it waiting, so it fails instead
const PAGE_MS = 5 * 60_000

function js(e: Embed, code: string): Promise<unknown> {
  const g = guest(e)
  return new Promise((ok, no) => {
    const end = (fn: () => void): void => {
      clearTimeout(timer)
      g.removeListener('destroyed', gone)
      g.removeListener('render-process-gone', gone)
      fn()
    }
    const gone = (): void => end(() => no(new Error(`${spec(e.appId).name} in the chat closed before it answered`)))
    const timer = setTimeout(() => end(() => no(new Error(`${spec(e.appId).name} in the chat didn't answer`))), PAGE_MS)
    g.once('destroyed', gone)
    g.once('render-process-gone', gone)
    g.executeJavaScript(code).then(
      (r: unknown) => end(() => ok(r)),
      (err: unknown) => end(() => no(err))
    )
  })
}

const call = (e: Embed, fn: string, ...args: unknown[]): Promise<unknown> =>
  js(e, `Promise.resolve(window.${e.appId}.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})).then((r) => r === undefined ? null : JSON.parse(JSON.stringify(r)))`)

const execute = (e: Embed, command: string, params: Record<string, unknown> = {}): Promise<unknown> => call(e, 'execute', command, params)

async function cdp(e: Embed, method: string, params: Record<string, unknown>): Promise<unknown> {
  const g = guest(e)
  if (!g.debugger.isAttached()) {
    g.debugger.attach('1.3')
    e.debugger = true
  }
  return g.debugger.sendCommand(method, params)
}

// files on disk as real File objects in the page: a hidden input the devtools protocol fills.
// the page reads them in pieces straight from disk, nothing is copied
async function pickFiles(e: Embed, paths: string[]): Promise<void> {
  await js(e, `(() => { let i = document.getElementById('td-pick'); if (!i) { i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 'td-pick'; i.hidden = true; document.body.appendChild(i) } return true })()`)
  const { root } = (await cdp(e, 'DOM.getDocument', { depth: 1 })) as { root: { nodeId: number } }
  const { nodeId } = (await cdp(e, 'DOM.querySelector', { nodeId: root.nodeId, selector: '#td-pick' })) as { nodeId: number }
  await cdp(e, 'DOM.setFileInputFiles', { nodeId, files: paths })
}

async function readWebFile(e: Embed, path: string): Promise<Buffer> {
  const b64 = (await js(e, `window.${e.appId}.readFile(${JSON.stringify(path)}).then((b) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s) })`)) as string
  return Buffer.from(b64, 'base64')
}

async function waitReady(e: Embed): Promise<void> {
  const g = guest(e)
  if (g.isLoading()) await new Promise<void>((ok) => g.once('did-stop-loading', () => ok()))
  const until = Date.now() + 90_000
  const check = webSpec(e.appId)?.kind === 'api'
    ? `(() => { const l = window.filmcraftLoad; if (l && l.error) throw new Error(String(l.error)); return !!(l && l.readyMs && window.${e.appId}) })()`
    : `(() => { const c = document.querySelector('canvas'); const l = document.querySelector('[id$="_loading"], #loading'); return !!c && c.width > 0 && !(l && l.isConnected && getComputedStyle(l).display !== 'none') })()`
  while (Date.now() < until) {
    if (await js(e, check)) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`${spec(e.appId).name} didn't start in the chat`)
}

// ---- FilmCraft: the project in and out ----

async function importInto(e: Embed, paths: string[]): Promise<{ items: number[]; paths: string[]; errors: unknown[] }> {
  if (!paths.length) return { items: [], paths: [], errors: [] }
  await pickFiles(e, paths)
  const r = (await js(e, `window.${e.appId}.importFiles(document.getElementById('td-pick').files).then((x) => JSON.parse(JSON.stringify(x)))`)) as { items?: number[]; paths?: string[]; errors?: unknown[] }
  const items = r.items ?? []
  const virtual = r.paths ?? []
  virtual.forEach((v, i) => {
    if (paths[i]) e.table.add(paths[i], v)
  })
  return { items, paths: virtual, errors: r.errors ?? [] }
}

const isFile = async (p: string): Promise<boolean> => (await fs.stat(p).catch(() => null))?.isFile() ?? false

async function openDocument(e: Embed): Promise<void> {
  if (!e.file) return
  const doc = JSON.parse(await fs.readFile(e.file, 'utf8')) as Record<string, unknown>
  if (doc.format !== 'filmcraft.project') throw new Error(`${basename(e.file)} isn't a FilmCraft project`)
  // the project's media and proxies in the folder, as files the page can read
  const need: string[] = []
  for (const p of projectPaths(doc)) {
    if (!isAbsolute(p) || e.table.has(p) || !isInside(e.folder, p) || !(await isFile(p))) continue
    if (!need.some((n) => n.toLowerCase() === p.toLowerCase())) need.push(p)
  }
  // the File handles are registered by name; importing makes items the opened project replaces
  await importInto(e, need)
  const mapped = mapProjectPaths(doc, (p) => e.table.web(p))
  const dir = join(e.folder, '.trenddeck', 'web')
  await fs.mkdir(dir, { recursive: true })
  const copy = join(dir, `${e.token}.fcproj`)
  await fs.writeFile(copy, JSON.stringify(mapped))
  try {
    const opened = (await call(e, 'openProject', projectUrl(e.appId, e.token, `.trenddeck/web/${e.token}.fcproj`))) as { path?: string; missingMedia?: number } | null
    e.doc = opened?.path ?? null
    // FilmCraft names the opened document after the url, it's saved under the project's own name
    const own = `/projects/${basename(e.file)}`
    if (e.doc !== own) {
      await execute(e, 'file.saveAs', { path: own })
      e.doc = own
    }
    const offline = projectPaths(doc).filter((p) => isAbsolute(p) && !e.table.has(p)).length
    e.note = offline ? `${offline} media file${offline === 1 ? ' is' : 's are'} outside the project folder and show as offline here.` : ''
  } finally {
    await fs.rm(copy, { force: true }).catch(() => {})
  }
  e.saved = JSON.stringify((doc as { project?: unknown }).project ?? null)
  e.loadedAt = Date.now()
  // proxies attached in the project play in the editor
  if (projectPaths(doc).some((p) => /_proxy\./i.test(p) && e.table.has(p))) await execute(e, 'media.toggleProxies', { enabled: true }).catch(() => {})
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}

// the web session's project, as it would be on disk
async function currentProject(e: Embed): Promise<Record<string, unknown>> {
  if (!e.doc) throw new Error('FilmCraft in the chat has no project open')
  await execute(e, 'file.save', {}).catch(() => execute(e, 'file.saveAs', { path: e.doc }))
  const text = (await readWebFile(e, e.doc)).toString('utf8')
  const doc = JSON.parse(text) as Record<string, unknown>
  if (doc.format !== 'filmcraft.project') throw new Error('FilmCraft saved something that is not a project')
  return mapProjectPaths(doc, (p) => e.table.disk(p)) as Record<string, unknown>
}

// writes the web session to the project file (or a copy) when it changed. recovery copies go in
// .trenddeck/autosaves before and after. the caller holds the folder's projectOperation
async function saveWeb(e: Embed, reason: string, to?: string): Promise<boolean> {
  await e.ready
  if (webSpec(e.appId)?.kind !== 'api') return false
  const doc = await currentProject(e)
  const project = JSON.stringify(doc.project ?? null)
  if (to) {
    if (!isInside(e.folder, to)) throw new Error('that copy would be outside the project folder')
    await writeAtomic(to, JSON.stringify(doc))
    return true
  }
  if (!e.file) return false
  const unknown = e.table.unknownIn(doc)
  if (project === e.saved && reason === 'autosave') return false
  if (await isFile(e.file)) await snapshotFile(e.folder, e.file, e.appId, `before-${reason}`)
  await writeAtomic(e.file, JSON.stringify(doc))
  await snapshotFile(e.folder, e.file, e.appId, reason)
  e.saved = project
  e.savedAt = Date.now()
  e.note = unknown.length
    ? `Saved. ${unknown.length} file${unknown.length === 1 ? ' was' : 's were'} added inside the editor and ${unknown.length === 1 ? "isn't" : "aren't"} in the project folder; drop files on this card instead so the project can find them.`
    : ''
  emit(e)
  return true
}

function saveSoon(e: Embed, reason: string): Promise<boolean> {
  return projectOperation(e.folder, () => saveWeb(e, reason))
}

// ---- the agent's calls ----

const text = (v: unknown): McpCallResult => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v ?? null) }] })
const failed = (why: string): McpCallResult => ({ isError: true, content: [{ type: 'text', text: why }] })

function cli(args: string[], cwd: string, cliPath: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((ok) => {
    execFile(cliPath, args, { cwd, env: cleanEnv({}), windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) =>
      ok({ code: err ? 1 : 0, out: String(stdout), err: String(stderr) })
    )
  })
}

// a read the native engine answers from a copy of what the web editor has now: the project tree
// and frames are exactly what the desktop app would say and render
async function snapshotCall(e: Embed, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
  const have = await installed(e.appId)
  if (!have) return failed(`${spec(e.appId).name} isn't installed`)
  const dir = join(e.folder, '.trenddeck', 'web')
  await fs.mkdir(dir, { recursive: true })
  const copy = join(dir, `${e.token}-${randomUUID().slice(0, 8)}.fcproj`)
  const png = `${copy}.png`
  try {
    await saveWeb(e, 'inspect', copy)
    const show = (s: string): string => (e.file ? s.split(copy.replace(/\\/g, '\\\\')).join(e.file.replace(/\\/g, '\\\\')).split(copy).join(e.file) : s)
    if (tool === 'project_inspect' || tool === 'doc_inspect') {
      const r = await cli(['--project', copy, '--compact', 'inspect', ...(tool === 'project_inspect' ? ['project'] : [])], e.folder, have.cli)
      return r.code ? failed(r.err.trim() || 'inspect failed') : text(show(r.out.trim()))
    }
    const seconds = typeof args.seconds === 'number' && Number.isFinite(args.seconds) ? Math.max(0, args.seconds) : null
    let at = seconds
    if (at === null) {
      const seq = (await execute(e, 'sequence.inspect').catch(() => null)) as { playhead?: unknown } | null
      const ph = seq?.playhead
      const ticks = typeof ph === 'number' ? ph : ph && typeof ph === 'object' && typeof (ph as { time?: unknown }).time === 'number' ? (ph as { time: number }).time : 0
      at = ticks / 254_016_000_000
    }
    const maxSide = typeof args.max_side === 'number' ? args.max_side : 0
    const scale = maxSide > 0 && maxSide < 1920 ? Math.max(0.1, Math.min(1, maxSide / 1920)) : 1
    const r = await cli(['--project', copy, 'render', '--seconds', String(at), '--out', png, '--allow-offline', ...(scale < 1 ? ['--scale', scale.toFixed(3)] : [])], e.folder, have.cli)
    if (r.code) return failed(r.err.trim() || 'render failed')
    return { content: [{ type: 'image', data: (await fs.readFile(png)).toString('base64'), mimeType: 'image/png' } as McpContent] }
  } finally {
    await fs.rm(copy, { force: true }).catch(() => {})
    await fs.rm(png, { force: true }).catch(() => {})
  }
}

// disk paths in a command's params: files the page has become their web paths, anything else
// is an output (an exported frame, a csv) the page writes to /exports/ and TrendDeck copies back
function webParams(e: Embed, params: Record<string, unknown>): { params: Record<string, unknown>; outputs: Map<string, string> } {
  const outputs = new Map<string, string>()
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'string' && isAbsolute(v) && /^[a-z]:[\\/]/i.test(v) && /path|file|output|destination|folder/i.test(key)) {
      const known = e.table.web(v)
      if (known) return known
      const out = `/exports/${randomUUID().slice(0, 8)}-${basename(v)}`
      outputs.set(out, v)
      return out
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]))
    return v
  }
  return { params: walk(params, '') as Record<string, unknown>, outputs }
}

async function copyOutputs(e: Embed, outputs: Map<string, string>): Promise<void> {
  if (!outputs.size) return
  const files = ((await call(e, 'files').catch(() => [])) as { path: string }[]) ?? []
  for (const [web, disk] of outputs) {
    if (!files.some((f) => f.path === web) || !isInside(e.folder, disk)) continue
    await writeAtomic(disk, await readWebFile(e, web))
  }
}

async function importForAgent(e: Embed, paths: string[]): Promise<McpCallResult> {
  const inside = paths.filter((p) => isInside(e.folder, p))
  const r = await importInto(e, inside)
  for (const p of inside) void proxyFor(e, p)
  return text({ items: r.items, errors: r.errors, paths: inside.map((p) => p.slice(e.folder.length + 1)) })
}

async function runStep(e: Embed, step: WebStep, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
  switch (step.kind) {
    case 'execute': {
      const { params, outputs } = webParams(e, step.params)
      const r = await answered(e, execute(e, step.command, params), step.command)
      await copyOutputs(e, outputs)
      return text(r)
    }
    case 'batch': {
      const results: unknown[] = []
      let completed = 0
      let failedAt: number | null = null
      for (const [i, s] of step.steps.entries()) {
        const one = await runStep(e, filmcraftWebStep('command_run', { id: s.id, params: s.params }), 'command_run', { id: s.id, params: s.params }).catch((err) => failed(message(err)))
        const body = one.content.map((c) => c.text ?? '').join('')
        results.push(one.isError ? { error: body } : (() => { try { return JSON.parse(body) } catch { return body } })())
        if (one.isError) {
          failedAt = i
          if (step.stopOnError) break
        } else completed += 1
      }
      return text({ completed, failed: failedAt, results })
    }
    case 'request':
      return text(await answered(e, call(e, 'request', step.method, step.params), step.method))
    case 'commands': {
      const list = ((await call(e, 'commands')) as { id: string; label?: string }[]) ?? []
      const f = step.filter?.toLowerCase()
      return text(f ? list.filter((c) => c.id.toLowerCase().includes(f) || (c.label ?? '').toLowerCase().includes(f)) : list)
    }
    case 'import':
      return importForAgent(e, step.paths)
    case 'screenshot': {
      const shot = (await call(e, 'screenshot', step.params)) as { pngBase64?: string } | null
      return shot?.pngBase64 ? { content: [{ type: 'image', data: shot.pngBase64, mimeType: 'image/png' } as McpContent] } : failed('no screenshot')
    }
    case 'snapshot':
      return snapshotCall(e, step.tool, step.args)
    case 'native': {
      if (step.command === 'media.createProxies') {
        const media = [...new Set(projectPaths(await currentProject(e)).filter((p) => isAbsolute(p) && isInside(e.folder, p) && !/_proxy\./i.test(p)))]
        for (const p of media) void proxyFor(e, p)
        return text({ started: media.length, note: 'Proxies are made in the background with ffmpeg and attached in the editor when each one is ready.' })
      }
      await saveWeb(e, 'before-export')
      if (!e.file) return failed('Save the project in the project folder first.')
      return nativeCommand({ appId: e.appId, brandId: e.brandId, projectId: e.projectId, folder: e.folder, file: e.file, command: step.command, params: step.params, where: e.where })
    }
    case 'nativeEdit':
      return nativeEdit(e, step.command, step.params)
    case 'save':
      if (step.path && e.file && step.path.toLowerCase() !== e.file.toLowerCase()) {
        await saveWeb(e, 'copy', step.path)
        return text({ path: step.path })
      }
      await saveWeb(e, 'save')
      return text({ path: e.file })
    case 'reload':
      await reload(e)
      return text({ path: e.file, reloaded: true })
    case 'unsupported':
      return failed(step.why)
  }
  void tool
  void args
}

// ---- heavy edits and a frozen editor ----

// an edit the page should answer well within this. one that takes longer has the page stuck
export const WEB_ANSWER_MS = 90_000
let answerMs = WEB_ANSWER_MS
export function setWebAnswerMs(ms: number): void {
  answerMs = ms
}

class Frozen extends Error {}

// the page's answer, or, when it doesn't come, the editor started again from the last save (made
// just before this edit) so the next call has a working editor instead of waiting behind this one
async function answered<T>(e: Embed, p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_ok, no) => {
    timer = setTimeout(() => no(new Frozen(what)), answerMs)
  })
  try {
    return await Promise.race([p, late])
  } catch (err) {
    if (!(err instanceof Frozen)) throw err
    p.catch(() => {})
    void unfreeze(e, what)
    throw new Error(`${spec(e.appId).name} in the chat stopped answering during ${what}, so TrendDeck is starting it again from the save made just before it. That edit didn't happen. Wait for the editor to open again, then try it once more or another way.`)
  } finally {
    clearTimeout(timer)
  }
}

async function unfreeze(e: Embed, what: string): Promise<void> {
  const g = e.guest
  if (e.restarting || !g || g.isDestroyed() || e.state === 'closed') return
  e.restarting = true
  let settle!: (err?: Error) => void
  e.ready = new Promise<void>((ok, no) => {
    settle = (err) => (err ? no(err) : ok())
  })
  e.ready.catch(() => {})
  e.settle = settle
  e.session.ready = e.ready
  e.state = 'loading'
  e.note = `${spec(e.appId).name} got stuck on ${what} and is starting again from your last save.`
  emit(e)
  try {
    // a page busy in a loop doesn't take a reload, its renderer goes and a new one loads
    g.forcefullyCrashRenderer()
    g.reload()
    e.table = new PathTable()
    e.doc = null
    await waitReady(e)
    await restoreView(e).catch(() => {})
    await openDocument(e)
    e.state = 'ready'
    e.note = ''
    e.settle()
    emit(e)
  } catch (err) {
    fail(e, err, true)
  } finally {
    e.restarting = false
  }
}

// a heavy edit in the native engine: the editor's project is saved, the engine opens it, makes
// the edit and saves, and the editor opens the result. the caller holds the folder's projectOperation
async function nativeEdit(e: Embed, command: string, params: Record<string, unknown>): Promise<McpCallResult> {
  await saveWeb(e, `before-${command}`)
  if (!e.file) return failed('Save the project in the project folder first.')
  const have = await installed(e.appId)
  const sp = spec(e.appId)
  if (!have || !sp.save) return failed(`${sp.name} isn't installed`)
  const run = { ...params }
  // files it writes go next to the project unless the call says where, never the engine's own folder
  if (command === 'clip.extractAudio') {
    if (typeof run.dir !== 'string' || !run.dir) run.dir = dirname(e.file)
    await fs.mkdir(run.dir as string, { recursive: true })
  }
  const client = new McpClient({ command: have.cli, args: ['mcp', ...sp.headlessArgs(e.file, e.folder)], env: cleanEnv({}) as Record<string, string>, cwd: e.folder, timeoutMs: 30 * 60_000 })
  let r: McpCallResult
  try {
    await client.start()
    if (sp.openTool) {
      const opened = fill(sp.openTool, e.file)
      const o = await client.callTool(opened.name, opened.args, { timeoutMs: 60_000 })
      if (o.isError) return o
    }
    r = await client.callTool('command_run', { id: command, params: run }, { timeoutMs: 30 * 60_000 })
    if (r.isError) return r
    const save = fill(sp.save, e.file)
    const saved = await client.callTool(save.name, save.args, { timeoutMs: 60_000 })
    if (saved.isError) return saved
  } finally {
    client.close()
  }
  await snapshotFile(e.folder, e.file, e.appId, command)
  e.loadedAt = Date.now()
  await reload(e)
  e.savedAt = Date.now()
  emit(e)
  return r
}

async function webCall(e: Embed, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
  if (webSpec(e.appId)?.kind !== 'api') return failed(`${spec(e.appId).name} in the chat can't be driven. Ask the user to save it there first.`)
  await e.ready
  try {
    return await runStep(e, filmcraftWebStep(tool, args), tool, args)
  } catch (err) {
    return failed(message(err))
  }
}

// ---- proxies for heavy footage ----

const proxied = new Set<string>()

async function proxyFor(e: Embed, source: string): Promise<void> {
  const key = `${e.cardId}|${source.toLowerCase()}`
  if (proxied.has(key) || /_proxy\./i.test(source)) return
  proxied.add(key)
  try {
    const proxy = await makeProxy({ appId: e.appId, brandId: e.brandId, projectId: e.projectId, folder: e.folder, source, where: e.where })
    if (!proxy || embeds.get(e.cardId) !== e || e.state !== 'ready') return
    const item = await itemFor(e, source)
    if (item === null) return
    await pickFiles(e, [proxy])
    const reg = (await js(e, `window.${e.appId}.importFiles(document.getElementById('td-pick').files).then((x) => JSON.parse(JSON.stringify(x)))`)) as { paths?: string[]; items?: number[] }
    const web = reg.paths?.[0]
    if (!web) return
    e.table.add(proxy, web)
    await execute(e, 'media.attachProxies', { item, path: web })
    // the proxy's own project item isn't wanted, the attachment is what plays
    if (reg.items?.length) await execute(e, 'project.delete', { items: reg.items }).catch(() => {})
    await execute(e, 'media.toggleProxies', { enabled: true })
    await saveSoon(e, 'proxy')
  } catch (err) {
    console.error(`craft: no proxy for ${basename(source)}`, err)
  }
}

// the project item that plays this file
async function itemFor(e: Embed, source: string): Promise<number | null> {
  const doc = await currentProject(e)
  const items = ((doc.project as { items?: Record<string, unknown> } | undefined)?.items ?? {}) as Record<string, unknown>
  for (const [id, item] of Object.entries(items)) {
    const path = (item as { kind?: { Media?: { media?: { File?: { path?: unknown } } } } }).kind?.Media?.media?.File?.path
    if (typeof path === 'string' && path.toLowerCase() === source.toLowerCase()) return Number(id)
  }
  return null
}

// ---- user exports from the editor's own menu go to the native engine ----

async function watchExports(e: Embed): Promise<void> {
  if (e.state !== 'ready') return
  const jobs = (await execute(e, 'jobs.list').catch(() => null)) as { id: number; label?: string; finished?: boolean }[] | { jobs?: unknown } | null
  const list = (Array.isArray(jobs) ? jobs : ((jobs as { jobs?: unknown })?.jobs as { id: number; label?: string; finished?: boolean }[]) ?? []) || []
  for (const j of list) {
    if (e.seenJobs.has(j.id)) continue
    e.seenJobs.add(j.id)
    if (j.finished || !/^Export /.test(j.label ?? '')) continue
    const ui = (await call(e, 'request', 'ui.inspect', {}).catch(() => null)) as { export?: Record<string, unknown> } | null
    const ex = ui?.export ?? {}
    await execute(e, 'jobs.cancel', { job: j.id }).catch(() => {})
    const name = safeName(typeof ex.fileName === 'string' && ex.fileName ? ex.fileName : (j.label ?? 'Export export.mp4').replace(/^Export /, ''), 'export.mp4')
    const params: Record<string, unknown> = { path: join(e.folder, 'exports', extname(name) ? name : `${name}.mp4`) }
    if (typeof ex.preset === 'string' && ex.preset) params.preset = ex.preset
    if (ex.settings && typeof ex.settings === 'object') params.settings = ex.settings
    if (typeof ex.range === 'string') params.range = ex.range
    await fs.mkdir(join(e.folder, 'exports'), { recursive: true })
    void projectOperation(e.folder, async () => {
      await saveWeb(e, 'before-export')
      if (!e.file) return
      await nativeCommand({ appId: e.appId, brandId: e.brandId, projectId: e.projectId, folder: e.folder, file: e.file, command: 'file.exportMedia', params, where: e.where })
    }).catch((err) => console.error('craft: the export failed', err))
  }
}

// ---- files kind: saves come out of the page as downloads ----

function onDownload(item: Electron.DownloadItem, wc: WebContents | undefined): void {
  const e = [...embeds.values()].find((x) => x.guest && wc && x.guest.id === wc.id)
  if (!e) return item.cancel()
  // FilmCraft's own save and export downloads: TrendDeck saves the project and exports natively
  if (webSpec(e.appId)?.kind === 'api') return item.cancel()
  const name = safeName(item.getFilename(), 'download')
  const ext = extname(name).toLowerCase()
  const target = spec(e.appId).exts.includes(ext) ? join(e.folder, name) : join(e.folder, 'exports', name)
  const tmp = join(e.folder, '.trenddeck', 'web', `incoming-${randomUUID()}${ext}`)
  item.setSavePath(tmp)
  item.once('done', (_ev, state) => {
    if (state !== 'completed') {
      void fs.rm(tmp, { force: true }).catch(() => {})
      return
    }
    void projectOperation(e.folder, async () => {
      await fs.mkdir(join(target, '..'), { recursive: true })
      if (await isFile(target)) await snapshotFile(e.folder, target, e.appId, 'before-web-save')
      await fs.rename(tmp, target)
      if (spec(e.appId).exts.includes(ext)) await snapshotFile(e.folder, target, e.appId, 'web-save')
      e.touched = false
      e.loadedAt = Date.now()
      e.savedAt = Date.now()
      e.note = ''
      emit(e)
    }).catch((err) => {
      e.note = `Couldn't put ${name} in the project folder: ${message(err)}`
      emit(e)
    })
  })
}

async function dropFile(e: Embed, file: string): Promise<void> {
  const [w, h] = (await js(e, '[innerWidth, innerHeight]')) as [number, number]
  const data = { items: [], files: [file], dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp(e, 'Input.dispatchDragEvent', { type, x: Math.round(w / 2), y: Math.round(h / 2), data })
}

// ---- how it looks: its size, FilmCraft's settings and panels (see @shared/craft-web-view) ----

async function applyZoom(wc: WebContents, appId: string): Promise<void> {
  const { zoom } = await viewOf(appId)
  if (!wc.isDestroyed()) wc.setZoomFactor(zoom)
}

// a size up or down for every editor of the app in the chat, and the next time it embeds
export async function setWebZoom(appId: string, step: -1 | 0 | 1): Promise<number> {
  const now = (await viewOf(appId)).zoom
  if (!step) return now
  const { zoom } = await setView(appId, { zoom: stepZoom(now, step) })
  for (const e of embeds.values()) if (e.appId === appId && e.guest && !e.guest.isDestroyed()) e.guest.setZoomFactor(zoom)
  return zoom
}

// newer FilmCraft has ui.docking, older (0.13) keeps the frame tree in ui.inspect's ui.dock
async function dockLayout(e: Embed): Promise<unknown> {
  const docking = (await call(e, 'request', 'ui.docking', {}).catch(() => null)) as { layout?: unknown } | null
  if (docking?.layout) return docking.layout
  return ((await call(e, 'inspect').catch(() => null)) as { ui?: { dock?: unknown } } | null)?.ui?.dock ?? null
}
const prefsNow = async (e: Embed): Promise<unknown> => ((await execute(e, 'prefs.get', {})) as { values?: unknown } | null)?.values ?? null

// what you set up in FilmCraft here, kept for the next embed
async function captureView(e: Embed): Promise<void> {
  if (webSpec(e.appId)?.kind !== 'api' || e.state !== 'ready' || e.restoring || !e.guest || e.guest.isDestroyed()) return
  const [dock, prefs] = await Promise.all([dockLayout(e), prefsNow(e)])
  if (dock || prefs) await setView(e.appId, { ...(dock ? { dock } : {}), ...(prefs ? { prefs } : {}) })
}

// the settings and panels as you left them last time. each step on its own: one FilmCraft
// doesn't take (a panel a newer version renamed) leaves the rest as they come back
async function restoreView(e: Embed): Promise<void> {
  if (webSpec(e.appId)?.kind !== 'api') return
  const saved = await viewOf(e.appId)
  if (!saved.prefs && !saved.dock) return
  e.restoring = true
  try {
    if (saved.prefs) {
      for (const [key, value] of Object.entries(prefsToRestore(await prefsNow(e), saved.prefs))) {
        await execute(e, 'prefs.set', { key, value }).catch(() => {})
      }
    }
    if (saved.dock) {
      const act = (action: DockAction): Promise<unknown> => execute(e, 'window.dockAction', { action }).catch(() => {})
      for (const a of dockOpenClose(await dockLayout(e), saved.dock)) await act(a)
      for (const a of dockSizes(await dockLayout(e), saved.dock)) await act(a)
    }
  } finally {
    e.restoring = false
  }
}

// ---- lifecycle ----

// FilmCraft plays at 1x every time play starts. each start goes to your preview speed (2x unless
// changed), a speed you pick while it plays (J, K, L) stays until it stops. only watching:
// clips and renders keep their own speed
const SPEED_POLL_MS = 400
function watchSpeed(e: Embed): void {
  let was = false
  let busy = false
  e.timers.push(
    setInterval(() => {
      if (busy || e.state !== 'ready' || e.restarting) return
      busy = true
      void (async () => {
        const p = (await call(e, 'request', 'ui.playback', {})) as { playing?: unknown } | null
        const now = p?.playing === true
        const speed = previewSpeedNow()
        if (now && !was && speed !== 1) await call(e, 'request', 'ui.playback', { action: 'play', speed })
        was = now
      })()
        .catch(() => {})
        .finally(() => {
          busy = false
        })
    }, SPEED_POLL_MS)
  )
}

async function load(e: Embed): Promise<void> {
  try {
    await waitReady(e)
    if (webSpec(e.appId)?.kind === 'api') {
      await restoreView(e).catch((err) => console.warn(`craft: ${e.appId}'s layout didn't come back`, err))
      await openDocument(e)
      e.timers.push(setInterval(() => void saveSoon(e, 'autosave').catch((err) => fail(e, err, false)), AUTOSAVE_MS))
      e.timers.push(setInterval(() => void watchExports(e).catch(() => {}), 2_000))
      watchSpeed(e)
    } else if (e.file) {
      await dropFile(e, e.file)
      // the agent changed the file on disk: show it again, unless you have changes here
      e.timers.push(setInterval(() => void refreshFromDisk(e), 3_000))
    }
    e.state = 'ready'
    e.settle()
    emit(e)
  } catch (err) {
    fail(e, err, true)
  }
}

function fail(e: Embed, err: unknown, fatal: boolean): void {
  console.error(`craft: ${e.appId} in the chat`, err)
  e.note = fatal ? `${spec(e.appId).name} couldn't open here: ${message(err)}` : `Autosave failed: ${message(err)}. Your changes are still in the editor.`
  if (fatal) {
    e.state = 'failed'
    e.settle(err instanceof Error ? err : new Error(String(err)))
  }
  emit(e)
}

async function refreshFromDisk(e: Embed): Promise<void> {
  if (e.state !== 'ready' || !e.file || e.touched) return
  const st = await fs.stat(e.file).catch(() => null)
  if (!st || st.mtimeMs <= e.loadedAt) return
  e.loadedAt = Date.now()
  await reload(e)
}

// the project file on disk shown again (after Undo this turn, or the agent's edits headless)
async function reload(e: Embed): Promise<void> {
  if (webSpec(e.appId)?.kind === 'api') {
    await openDocument(e)
    return
  }
  const g = guest(e)
  g.reload()
  await waitReady(e)
  if (e.file) await dropFile(e, e.file)
}

const tokens = new Map<string, { appId: string; folder: string }>()

export interface PrepareInput {
  cardId: string
  appId: string
  brandId: string
  projectId: string
  folder: string
  file: string | null
  where: JobWhere
}

// a card is about to show the app: the page to load and the session it runs in
export async function prepareWeb(p: PrepareInput): Promise<{ src: string; partition: string }> {
  const ws = webSpec(p.appId)
  if (!ws) throw new Error(`${spec(p.appId).name} opens in the full app`)
  const run = runningApp(p.appId)
  if (run && run.brandId === p.brandId && run.projectId === p.projectId) throw new Error(`${spec(p.appId).name} is open in the full app on this project. Close it there to edit here.`)
  await ensureWeb(p.appId)
  // one live editor per document: another card on it saves and lets go
  for (const other of [...embeds.values()]) {
    if (other.cardId !== p.cardId && other.appId === p.appId && other.brandId === p.brandId && other.projectId === p.projectId) await releaseWeb(other.cardId)
  }
  // a headless engine on this project saves and stops, the editor here takes over
  const s = sessionOf(p.appId)
  if (s && s.brandId === p.brandId && s.projectId === p.projectId) await stopSession(p.appId)
  const have = embeds.get(p.cardId)
  if (have && have.state !== 'closed' && have.state !== 'failed' && have.guest && !have.guest.isDestroyed()) return { src: appUrl(p.appId, ws.query), partition: CRAFT_WEB_PARTITION }
  if (have) await releaseWeb(p.cardId, false)
  const token = randomBytes(16).toString('hex')
  let settle!: (err?: Error) => void
  const ready = new Promise<void>((ok, no) => {
    settle = (err) => (err ? no(err) : ok())
  })
  ready.catch(() => {})
  const e: Embed = {
    ...p, token, guest: null, state: 'loading', note: '', savedAt: null, ready, settle, table: new PathTable(), doc: null, saved: null,
    touched: false, editedAt: 0, loadedAt: Date.now(), timers: [], inputSave: null, seenJobs: new Set(), debugger: false, restoring: false, restarting: false,
    session: null as unknown as Session
  }
  e.session = {
    appId: p.appId, mode: 'web', file: p.file, folder: p.folder, brandId: p.brandId, projectId: p.projectId,
    client: { callTool: (name: string, args: Record<string, unknown>) => webCall(e, name, args), close: () => {} } as unknown as Session['client'],
    ready, dirty: false, idle: null, cancelAutosave: () => {}
  }
  embeds.set(p.cardId, e)
  tokens.set(token, { appId: p.appId, folder: p.folder })
  emit(e)
  return { src: appUrl(p.appId, ws.query), partition: CRAFT_WEB_PARTITION }
}

// the card's <webview> is on the page: its guest, checked to be ours
export function attachWeb(cardId: string, guestId: number, host: WebContents): void {
  const e = embeds.get(cardId)
  if (!e) throw new Error('that editor is gone')
  const wc = webContents.fromId(guestId)
  if (!wc || wc.getType() !== 'webview' || wc.hostWebContents?.id !== host.id || wc.session !== electronSession.fromPartition(CRAFT_WEB_PARTITION)) throw new Error('bad craft web guest')
  const origin = (() => {
    try {
      return new URL(wc.getURL()).host
    } catch {
      return ''
    }
  })()
  if (origin && origin !== e.appId) throw new Error('bad craft web guest')
  if (e.guest === wc) return
  e.guest = wc
  // the size you picked for this app, again after every load of the page
  void applyZoom(wc, e.appId)
  wc.on('dom-ready', () => void applyZoom(wc, e.appId))
  wc.once('destroyed', () => {
    if (embeds.get(cardId) === e && e.guest === wc) void releaseWeb(cardId, false)
  })
  wc.on('render-process-gone', (_ev, d) => {
    if (e.guest === wc && !e.restarting) fail(e, new Error(`the editor stopped (${d.reason}). Your last save is in the project folder`), true)
  })
  // what you do in the editor saves a few seconds after you stop
  const touch = (): void => {
    e.touched = true
    e.editedAt = Date.now()
    if (webSpec(e.appId)?.kind !== 'api' || e.state !== 'ready') return
    if (e.inputSave) clearTimeout(e.inputSave)
    e.inputSave = setTimeout(() => {
      void saveSoon(e, 'autosave').catch((err) => fail(e, err, false))
      // a panel moved or a setting changed is input too
      void captureView(e).catch(() => {})
    }, INPUT_SAVE_MS)
  }
  wc.on('before-input-event', (_ev, input) => {
    if (input.type === 'keyUp') touch()
  })
  wc.on('before-mouse-event', (_ev, mouse) => {
    if (mouse.type === 'mouseUp') touch()
  })
  void load(e)
}

// the card stops showing the app: saved first, then let go. false save: it's already gone
export async function releaseWeb(cardId: string, save = true): Promise<void> {
  const e = embeds.get(cardId)
  if (!e) return
  if (save) await captureView(e).catch(() => {})
  if (save && e.state === 'ready' && webSpec(e.appId)?.kind === 'api' && e.guest && !e.guest.isDestroyed()) {
    await saveSoon(e, 'close').catch((err) => {
      fail(e, err, false)
      throw new Error(`${spec(e.appId).name} couldn't save, so it stays open here: ${message(err)}`)
    })
  }
  embeds.delete(cardId)
  tokens.delete(e.token)
  for (const t of e.timers) clearInterval(t)
  if (e.inputSave) clearTimeout(e.inputSave)
  try {
    if (e.debugger && e.guest && !e.guest.isDestroyed() && e.guest.debugger.isAttached()) e.guest.debugger.detach()
  } catch {
    // gone
  }
  e.state = 'closed'
  e.settle(new Error('closed'))
  emit(e)
  // the page's own copies of imported footage (FilmCraft keeps one in its storage) aren't needed:
  // the project folder has the files
  if (![...embeds.values()].some((x) => x.appId === e.appId)) {
    void electronSession.fromPartition(CRAFT_WEB_PARTITION).clearStorageData({ origin: `${CRAFT_WEB_SCHEME}://${e.appId}`, storages: ['filesystem', 'indexdb'] }).catch(() => {})
  }
}

export const hasWebEmbeds = (): boolean => embeds.size > 0

// quitting: every editor in the chat saves first. one that can't stops the quit
export async function releaseAllWeb(): Promise<void> {
  const results = await Promise.allSettled([...embeds.keys()].map((id) => releaseWeb(id)))
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) throw failed.reason
}

export function webReady(cardId: string): Promise<void> {
  return embeds.get(cardId)?.ready ?? Promise.reject(new Error('that editor is gone'))
}

// the card a guest page belongs to, for its preload's messages
export function cardForGuest(guestId: number): { cardId: string; brandId: string } | null {
  for (const e of embeds.values()) if (e.guest && !e.guest.isDestroyed() && e.guest.id === guestId) return { cardId: e.cardId, brandId: e.brandId }
  return null
}

// what the editor shows now, for the still under other cards and for circle and comment
export async function webStill(cardId: string): Promise<string | null> {
  const e = embeds.get(cardId)
  if (!e?.guest || e.guest.isDestroyed() || e.state !== 'ready') return null
  const img = await e.guest.capturePage()
  return img.isEmpty() ? null : img.toDataURL()
}

// files dropped on the card (or a picked library file) go into the open editor
export async function importToWeb(cardId: string, paths: string[]): Promise<boolean> {
  const e = embeds.get(cardId)
  if (!e || webSpec(e.appId)?.kind !== 'api' || e.state !== 'ready') return false
  await e.ready
  await importInto(e, paths.filter((p) => isInside(e.folder, p)))
  for (const p of paths) void proxyFor(e, p)
  await saveSoon(e, 'import')
  return true
}

export async function reloadWeb(appId: string, brandId: string, projectId: string): Promise<boolean> {
  const e = liveFor(appId, brandId, projectId)
  if (!e || e.state !== 'ready') return false
  e.loadedAt = Date.now()
  await reload(e)
  return true
}

// the editors' session: the build and project files from craft-web://, the page's downloads,
// nothing else (no camera, mic, notifications)
export function setupWebSession(): void {
  const ses = electronSession.fromPartition(CRAFT_WEB_PARTITION)
  ses.protocol.handle(CRAFT_WEB_SCHEME, (req) =>
    craftWebResponse(req.url, req.method, req.headers.get('range'), {
      appRoot: (appId) => (webSpec(appId) ? installedWeb(appId) : Promise.resolve(null)),
      projectRoot: (appId, token) => {
        const t = tokens.get(token)
        return t && t.appId === appId ? t.folder : null
      }
    })
  )
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'))
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write')
  ses.on('will-download', (_ev, item, wc) => onDownload(item, wc))
  // anything that isn't the app's own files stays off: no web, no other schemes
  ses.webRequest.onBeforeRequest((details, cb) => {
    const ok = details.url.startsWith(`${CRAFT_WEB_SCHEME}://`) || details.url.startsWith('blob:') || details.url.startsWith('data:') || details.url.startsWith('devtools:')
    cb({ cancel: !ok })
  })
  setWebHooks({
    session: (appId, brandId, projectId) => {
      const e = liveFor(appId, brandId, projectId)
      if (!e) return null
      if (webSpec(appId)?.kind === 'api') return e.session
      // a build TrendDeck can't drive: the agent works on the file on disk, which the card shows
      // again afterwards. not while you have changes there it doesn't know about
      if (e.touched) throw new Error(`${spec(appId).name} in the chat may have changes that aren't saved. Ask the user to save there (File, Save) first.`)
      return null
    },
    alive: (s) => [...embeds.values()].some((e) => e.session === s && e.state !== 'closed' && e.state !== 'failed'),
    save: async (s, reason) => {
      const e = [...embeds.values()].find((x) => x.session === s)
      if (e) await saveWeb(e, reason)
    }
  })
}
