import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { CraftEmbedCard, ProjectFileRef } from '@shared/cards'
import {
  markerParams,
  timecode,
  toSeconds,
  toTicks,
  type EmbedAlternative,
  type EmbedCommentInput,
  type EmbedFocus,
  type EmbedSequence,
  type PlacedMarker
} from '@shared/craft-embed'
import { ID_PATTERN } from '@shared/types'
import { openApp } from '../craft'
import { webSpec } from '@shared/craft-web'
import { cachedTools, pickFile, sessionOf, stopSession, waitForBridge } from '../craft/agent'
import { APPS, fill, isAppId, spec } from '../craft/catalog'
import { runningApp } from '../craft/launch'
import { attachWeb, cardForGuest, prepareWeb, releaseWeb, reloadWeb, webLiveOn, webReady, webState, webStill, webUnsaved } from '../craft/web'
import { appFiles, findProject, knownFolder, projectFolder } from '../craft/paths'
import { isInside, PathError, resolveInProject, safeName, uniqueName } from '../craft/rules'
import { liveOf, status } from '../craft/state'
import { appCall, resultJson } from '../craft/tools'
import { onToolCalled } from '../gateway/call'
import { brandOf } from '../gateway/tools/common'
import { ToolError, type GatewayTool, type Turn } from '../gateway/types'
import { int, list, num, obj, oneOf, str } from '../gateway/validate'
import { checkProjectFile, newVideosSince, relativeIn } from './files'
import { recordFriction } from './friction'
import { addCard, changeCard, getCard, listCards, newCardId } from './store'
import { projectOf } from './tools'

// a live Craft editor in the chat: the agent posts one with craft_embed (or its edits in a reply
// make one), the card hosts the app's web build (craft/web.ts). see @shared/craft-embed,
// @shared/craft-web and docs/DECISIONS-craft-web.md

export interface Where {
  brandId: string
  threadId: string | null
  messageId: string | null
}

export const whereOf = (turn: Turn): Where => ({ brandId: turn.brandId, threadId: turn.threadId, messageId: turn.messageId ?? null })

// ---- which file and connection ----

// the app's file for the project right now: the open window's, the headless engine's, else the newest
export async function currentFile(appId: string, brandId: string, projectId: string): Promise<string | null> {
  const folder = await projectFolder(brandId, projectId)
  const run = runningApp(appId)
  if (run && run.brandId === brandId && run.projectId === projectId && run.file) return run.file
  const s = sessionOf(appId)
  if (s && s.brandId === brandId && s.projectId === projectId && s.file) return s.file
  const files = await appFiles(folder, appId)
  return files.length ? join(folder, files[0].name) : null
}

// the app has this project open: in the chat (its web build), its own window, or headless
export function liveOn(appId: string, brandId: string, projectId: string): 'web' | 'window' | 'headless' | null {
  if (webLiveOn(appId, brandId, projectId)) return 'web'
  const run = runningApp(appId)
  if (run && run.brandId === brandId && run.projectId === projectId) return 'window'
  const s = sessionOf(appId)
  if (s && s.mode === 'headless' && s.brandId === brandId && s.projectId === projectId) return 'headless'
  return null
}

const hasTool = (appId: string, name: string): boolean => cachedTools(appId).some((t) => t.tool.name === name)

async function command(brandId: string, projectId: string, appId: string, id: string, params: Record<string, unknown> = {}, edits = false): Promise<unknown> {
  return resultJson(await appCall(brandId, projectId, appId, 'command_run', { id, params }, { edits }))
}

// ---- the card ----

const upserts = new Map<string, Promise<unknown>>()

// the embed of this reply for the app and project, made when there's none yet
export function upsertEmbed(w: Where, appId: string, projectId: string, change: (c: CraftEmbedCard) => void, init: Partial<CraftEmbedCard> = {}): Promise<CraftEmbedCard> {
  const run = async (): Promise<CraftEmbedCard> => {
    const have = w.threadId
      ? (await listCards(w.brandId, w.threadId)).find(
          (c): c is CraftEmbedCard => c.type === 'craft' && c.messageId === w.messageId && c.appId === appId && c.projectId === projectId
        )
      : undefined
    if (have) return (await changeCard(w.brandId, have.id, (c) => (c.type === 'craft' ? change(c) : undefined))) as CraftEmbedCard
    const file = await currentFile(appId, w.brandId, projectId).catch(() => null)
    const now = Date.now()
    const card: CraftEmbedCard = {
      id: newCardId(),
      brandId: w.brandId,
      threadId: w.threadId,
      messageId: w.messageId,
      at: now,
      updatedAt: now,
      type: 'craft',
      appId,
      appName: spec(appId).name,
      projectId,
      file: file ? basename(file) : null,
      focus: null,
      note: '',
      turn: null,
      alternatives: null,
      auto: false,
      ...init
    }
    change(card)
    return (await addCard(card)) as CraftEmbedCard
  }
  const key = w.brandId
  const next = (upserts.get(key) ?? Promise.resolve()).then(run, run)
  upserts.set(key, next.catch(() => {}))
  return next
}

async function embedCard(brandId: string, cardId: string): Promise<CraftEmbedCard> {
  const c = await getCard(brandId, cardId)
  if (!c || c.type !== 'craft') throw new Error('That editor is gone from the chat.')
  findProject(brandId, c.projectId)
  return c
}

// ---- checkpoints: a copy of the app's file aside, put back to undo ----

export async function checkpointFile(brandId: string, projectId: string, appId: string, id: string): Promise<{ rel: string; file: string } | null> {
  if (!/^[a-z0-9-]{1,80}$/i.test(id)) throw new Error('bad checkpoint id')
  const folder = await projectFolder(brandId, projectId)
  const file = await currentFile(appId, brandId, projectId)
  if (!file) return null
  const dir = join(folder, '.trenddeck', 'turns', id)
  await fs.mkdir(dir, { recursive: true })
  const target = join(dir, basename(file))
  await fs.rm(target, { force: true })
  const live = liveOn(appId, brandId, projectId)
  if (live && appId === 'filmcraft') {
    // the open project as it is now, the user's unsaved changes too, without moving the window to the copy
    await command(brandId, projectId, appId, 'file.saveCopy', { path: target })
  } else if (live && spec(appId).save) {
    // other apps have no save a copy: save the file itself, then copy it
    const st = fill(spec(appId).save!, file)
    resultJson(await appCall(brandId, projectId, appId, st.name, st.args))
    await fs.copyFile(file, target)
  } else await fs.copyFile(file, target)
  await fs.access(target)
  await fs.writeFile(join(dir, 'checkpoint.json'), JSON.stringify({ appId, file: basename(file), at: Date.now() }), 'utf8')
  return { rel: relativeIn(folder, target), file }
}

export async function restoreFile(brandId: string, projectId: string, appId: string, rel: string): Promise<{ ok: boolean; note: string }> {
  const folder = await projectFolder(brandId, projectId)
  let copy: string
  try {
    copy = resolveInProject(folder, rel)
  } catch {
    return { ok: false, note: 'That copy is not in the project folder.' }
  }
  const dir = join(copy, '..')
  let meta: { file?: unknown; appId?: unknown }
  try {
    meta = JSON.parse(await fs.readFile(join(dir, 'checkpoint.json'), 'utf8')) as typeof meta
  } catch {
    return { ok: false, note: 'The copy from before is gone.' }
  }
  if (typeof meta.file !== 'string' || /[\\/]/.test(meta.file) || meta.appId !== appId) return { ok: false, note: 'The copy from before is not for this app.' }
  const target = join(folder, meta.file)
  const name = spec(appId).name
  const live = liveOn(appId, brandId, projectId)
  const run = runningApp(appId)
  if (live === 'web') {
    await fs.copyFile(target, `${copy}.before-undo`).catch(() => {})
    await fs.copyFile(copy, target)
    try {
      await reloadWeb(appId, brandId, projectId)
    } catch {
      return { ok: false, note: `The file is back on disk, but ${name} in the chat didn't show it. Open it here again.` }
    }
    return { ok: true, note: '' }
  }
  if (live === 'window' && run?.file && run.file.toLowerCase() !== target.toLowerCase()) return { ok: false, note: `${name} has another file of this project open.` }
  if (live === 'window' && appId !== 'filmcraft') return { ok: false, note: `Close ${name}, then undo again. It can't reload the file while it's open.` }
  // what's there now goes aside, so an undo can be taken back by hand
  await fs.copyFile(target, `${copy}.before-undo`).catch(() => {})
  if (live === 'headless') await stopSession(appId, false)
  await fs.copyFile(copy, target)
  if (live === 'window') {
    try {
      await command(brandId, projectId, appId, 'file.revert')
    } catch {
      try {
        await command(brandId, projectId, appId, 'file.open', { path: target })
      } catch {
        return { ok: false, note: `The file is back on disk, but ${name} didn't reload it. Use File, Revert in ${name}.` }
      }
    }
  }
  return { ok: true, note: '' }
}

// ---- FilmCraft's open sequence and stills ----

export async function activeSequence(brandId: string, projectId: string): Promise<EmbedSequence | null> {
  let s: Record<string, unknown> | null
  try {
    s = (await command(brandId, projectId, 'filmcraft', 'sequence.inspect')) as Record<string, unknown> | null
  } catch (err) {
    if (/no active sequence/i.test(message(err))) return null
    throw err
  }
  if (!s || typeof s.id !== 'number') return null
  const fr = ((s.settings as Record<string, unknown> | undefined)?.frame_rate ?? {}) as { num?: number; den?: number }
  const fps = { num: fr.num || 30, den: fr.den || 1 }
  const ph = s.playhead
  const playhead = typeof ph === 'number' ? toSeconds(ph) : ph && typeof ph === 'object' && typeof (ph as { time?: unknown }).time === 'number' ? toSeconds((ph as { time: number }).time) : null
  return { id: s.id, name: typeof s.name === 'string' ? s.name : `sequence ${s.id}`, fps, durationSeconds: toSeconds(Number(s.duration) || 0), playheadSeconds: playhead }
}

const imageOf = (r: { isError?: boolean; content: { type: string; data?: string; mimeType?: string }[] }): string | null => {
  const img = r.isError ? null : r.content.find((c) => c.type === 'image' && typeof c.data === 'string')
  return img ? `data:${img.mimeType ?? 'image/png'};base64,${img.data}` : null
}

// a still of the embed. seconds null: what the app looks like now, for under and instead of the
// live window. seconds given: that frame of the FilmCraft sequence, for a comment
async function still(card: CraftEmbedCard, seconds: number | null): Promise<string | null> {
  const run = runningApp(card.appId)
  // the app is busy with another project, nothing to show without taking it away
  if (run && (run.brandId !== card.brandId || run.projectId !== card.projectId)) return null
  // the editor in this card as it looks now
  if (seconds === null) {
    const shot = await webStill(card.id).catch(() => null)
    if (shot) return shot
  }
  const window = liveOn(card.appId, card.brandId, card.projectId) === 'window'
  // the full app's window as it looks now
  if (seconds === null && window && hasTool(card.appId, 'ui_screenshot')) {
    const shot = await appCall(card.brandId, card.projectId, card.appId, 'ui_screenshot', { max_side: 1600 }, { needsWindow: true, timeoutMs: 15_000 })
      .then(imageOf)
      .catch(() => null)
    if (shot) return shot
  }
  // FilmCraft's window answers render_frame with a picture of its monitor panel, file.exportFrame
  // renders the real frame
  if (card.appId === 'filmcraft' && window) {
    const t = seconds ?? card.focus?.time ?? null
    const dir = join(await projectFolder(card.brandId, card.projectId), '.trenddeck', 'frames')
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, `${randomUUID()}.png`)
    try {
      await command(card.brandId, card.projectId, 'filmcraft', 'file.exportFrame', { path: file, format: 'png', target: 'program', ...(t !== null ? { time: toTicks(t) } : {}) })
      return `data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`
    } catch {
      // the render below
    } finally {
      await fs.rm(file, { force: true }).catch(() => {})
    }
  }
  const tool = card.appId === 'filmcraft' ? 'render_frame' : hasTool(card.appId, 'render_preview') ? 'render_preview' : null
  if (!tool) return null
  const args: Record<string, unknown> = { max_side: 960 }
  const t = seconds ?? card.focus?.time ?? null
  if (t !== null && card.appId === 'filmcraft') args.seconds = Math.max(0, t)
  return imageOf(await appCall(card.brandId, card.projectId, card.appId, tool, args, { timeoutMs: 20_000 }))
}

// ---- what the agent's tool does ----

async function applyFocus(brandId: string, projectId: string, appId: string, focus: EmbedFocus | null): Promise<string[]> {
  const notes: string[] = []
  if (!focus || appId !== 'filmcraft') return notes
  if (focus.sequence !== null) {
    try {
      await command(brandId, projectId, appId, 'sequence.open', { item: focus.sequence })
    } catch (err) {
      notes.push(`couldn't open sequence ${focus.sequence}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (focus.time !== null) {
    try {
      await command(brandId, projectId, appId, 'playhead.set', { seconds: focus.time })
    } catch (err) {
      notes.push(`couldn't move the playhead: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return notes
}

async function sequenceNames(brandId: string, projectId: string): Promise<Map<number, string>> {
  const p = (await resultJson(await appCall(brandId, projectId, 'filmcraft', 'project_inspect', {}))) as { root?: unknown } | null
  const out = new Map<number, string>()
  const walk = (n: unknown, depth: number): void => {
    if (!n || typeof n !== 'object' || depth > 8) return
    const o = n as Record<string, unknown>
    if (o.type === 'Sequence' && typeof o.item === 'number') out.set(o.item, typeof o.name === 'string' ? o.name : `sequence ${o.item}`)
    if (Array.isArray(o.children)) for (const c of o.children) walk(c, depth + 1)
  }
  walk(p?.root, 0)
  return out
}

// baseline hook, collab.ts takes the first look at a project once it's in the chat
let onEmbedded: (brandId: string, threadId: string | null, appId: string, projectId: string) => Promise<void> = async () => {}
export function setOnEmbedded(fn: typeof onEmbedded): void {
  onEmbedded = fn
}

const APP_ARG = oneOf('the craft app, by id', APPS.map((a) => a.id))

export function embedTools(): GatewayTool[] {
  return [
    {
      name: 'craft_embed',
      title: 'Show a Craft editor in the chat',
      description:
        "Posts a live Craft editor (FilmCraft for the video, PhotoCraft for thumbnails, SoundCraft, EffectCraft or any app in craft_list) into the chat at this point of the conversation, on the project's file. It's the real app: the user edits in it directly while you work in the same app with its <app>_* tools, and what they changed reaches you at the start of their next message. Your edits in one reply are one undo group the user can undo or keep. focus points it at a FilmCraft sequence (project item id) and a time in seconds, or a layer. alternatives lists versions you made as separate sequences in the same project: the user switches between them in the embed and keeps one. Installs the app first if needed (asks).",
      inputSchema: obj(
        {
          app: APP_ARG,
          projectId: str("the TrendDeck project (one video), by id. leave it out for this chat's project", 100),
          file: str('a file of the app in the project folder, the newest when left out', 260),
          focus: obj({
            sequence: int('FilmCraft sequence to show, its project item id', 0),
            time: num('seconds on that sequence to put the playhead at', 0),
            layer: str('a layer name to point at, for the image apps', 120)
          }),
          note: str('one line on what to look at', 300),
          alternatives: list(
            'FilmCraft only: versions of the cut you made as separate sequences, 2 to 4',
            obj({ label: str('short, like "Faster open"', 40, 1), sequence: int('the sequence project item id', 0) }, ['label', 'sequence']),
            4
          )
        },
        ['app']
      ),
      risk: 'read',
      mustAsk: async (_turn, args) =>
        liveOf(String(args.app)).install.kind === 'installed' ? null : `${spec(String(args.app)).name} isn't installed, this downloads it from GitHub (about 100 MB)`,
      summarize: (turn, args) => `Show ${spec(String(args.app)).name} in the chat for ${projectOf(turn, args.projectId).name}`,
      run: async (turn, args) => {
        const appId = String(args.app)
        if (!isAppId(appId)) throw new ToolError('no craft app with that id')
        brandOf(turn)
        const project = projectOf(turn, args.projectId)
        const file = typeof args.file === 'string' && args.file.trim() ? args.file.trim() : null
        const f = (args.focus ?? null) as { sequence?: number; time?: number; layer?: string } | null
        const focus: EmbedFocus | null = f ? { sequence: f.sequence ?? null, time: f.time ?? null, layer: f.layer?.trim() || null } : null
        try {
          await openApp({ appId, brandId: turn.brandId, projectId: project.id, file })
        } catch (err) {
          throw new ToolError(err instanceof Error ? err.message : String(err))
        }
        if (spec(appId).agent && spec(appId).bridgeArgs && !webSpec(appId)) await waitForBridge(appId)
        // an editor in the chat takes the focus when it has loaded, see embed:web-attach
        const notes = liveOn(appId, turn.brandId, project.id) ? await applyFocus(turn.brandId, project.id, appId, focus) : []
        let alternatives: CraftEmbedCard['alternatives'] = null
        const alts = (args.alternatives as EmbedAlternative[] | undefined) ?? []
        if (alts.length) {
          if (appId !== 'filmcraft') throw new ToolError('alternatives are FilmCraft sequences, use them with app filmcraft')
          if (alts.length < 2) throw new ToolError('give at least 2 alternatives')
          const names = await sequenceNames(turn.brandId, project.id).catch(() => new Map<number, string>())
          const missing = alts.filter((a) => !names.has(a.sequence))
          if (missing.length) throw new ToolError(`no sequence ${missing.map((m) => m.sequence).join(', ')} in the project. sequences: ${[...names].map(([id, n]) => `${id} (${n})`).join(', ') || 'none'}`)
          alternatives = { items: alts.map((a) => ({ label: a.label.trim(), sequence: a.sequence })), showing: alts[0].sequence, kept: null, checkpoint: null, note: '' }
          if (focus?.sequence === undefined || focus?.sequence === null) await command(turn.brandId, project.id, appId, 'sequence.open', { item: alts[0].sequence }).catch(() => {})
        }
        const s = status(appId)
        const card = await upsertEmbed(
          whereOf(turn),
          appId,
          project.id,
          (c) => {
            c.auto = false
            c.focus = focus
            c.note = typeof args.note === 'string' ? args.note.trim() : c.note
            if (s.file) c.file = basename(s.file)
            if (alternatives) c.alternatives = alternatives
          }
        )
        await onEmbedded(turn.brandId, turn.threadId, appId, project.id).catch(() => {})
        return `${spec(appId).name} is in the chat as embed ${card.id} on ${card.file ?? 'a new file'}${notes.length ? ` (${notes.join('; ')})` : ''}. the user can edit in it, what they change reaches you with their next message. keep working in it with the ${appId}_* tools`
      }
    }
  ]
}

// ---- the window's side ----

const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'
const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v)
const isCardId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,64}$/i.test(v)

function bad(): never {
  throw new Error('bad embed call')
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error: /, '')

const markerSkips: ((brandId: string, threadId: string | null, appId: string, projectId: string, markers: number[]) => void)[] = []
export function onCommentMarkers(fn: (typeof markerSkips)[number]): void {
  markerSkips.push(fn)
}

async function importPaths(card: CraftEmbedCard, paths: string[]): Promise<{ imported: string[]; note: string }> {
  const folder = await projectFolder(card.brandId, card.projectId)
  const media = join(folder, 'media')
  const placed: string[] = []
  for (const p of paths.slice(0, 20)) {
    if (typeof p !== 'string' || !isAbsolute(p)) continue
    const st = await fs.stat(p).catch(() => null)
    if (!st?.isFile()) continue
    if (isInside(folder, p)) {
      placed.push(p)
      continue
    }
    await fs.mkdir(media, { recursive: true })
    const clean = safeName(basename(p), 'media')
    const ext = extname(clean)
    const stem = clean.slice(0, clean.length - ext.length)
    const taken = await fs.readdir(media).catch(() => [] as string[])
    let name = clean
    if (taken.includes(name)) {
      const there = await fs.stat(join(media, name)).catch(() => null)
      if (!there || there.size !== st.size) name = `${uniqueName(stem, taken.map((t) => t.slice(0, t.length - extname(t).length)))}${ext}`
    }
    if (!taken.includes(name)) await fs.copyFile(p, join(media, name))
    placed.push(join(media, name))
  }
  if (!placed.length) return { imported: [], note: 'Nothing to add, drop files from your computer.' }
  const rel = placed.map((p) => relativeIn(folder, p))
  const tool = card.appId === 'filmcraft' || hasTool(card.appId, 'media_import') ? 'media_import' : null
  if (!tool) return { imported: rel, note: `Copied into the project's media folder. ${card.appName} has no import the app can call, add them from there.` }
  resultJson(await appCall(card.brandId, card.projectId, card.appId, tool, { paths: placed }, { edits: true }))
  return { imported: rel, note: `Added to the ${card.appName} project.` }
}

export function setupEmbeds(deps: { addToProject: (brandId: string, projectId: string, mediaId: string) => Promise<string> }): void {
  // an app the agent opened with craft_open shows in the chat too, there's nowhere else for it
  onToolCalled((turn, name, args) => {
    if (name !== 'craft_open' || !isAppId(args.app)) return
    void (async () => {
      const project = projectOf(turn, args.projectId)
      await upsertEmbed(whereOf(turn), String(args.app), project.id, () => {})
      await onEmbedded(turn.brandId, turn.threadId, String(args.app), project.id)
    })().catch((err) => console.error('cards: showing the opened app failed', err))
  })
  ipcMain.handle('embed:create', async (e, brandId: unknown, threadId: unknown, projectId: unknown, appId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || typeof threadId !== 'string' || !isId(projectId) || !isAppId(appId)) bad()
    findProject(brandId, projectId)
    const card = await upsertEmbed({ brandId, threadId, messageId: null }, appId, projectId, (c) => {
      // opened again, it's the newest now
      c.at = Date.now()
    })
    await onEmbedded(brandId, threadId, appId, projectId).catch(() => {})
    return card.id
  })
  ipcMain.handle('embed:open', async (e, brandId: unknown, cardId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId)) bad()
    const card = await embedCard(brandId, cardId)
    const s = await openApp({ appId: card.appId, brandId, projectId: card.projectId, file: card.file })
    if (!webSpec(card.appId) && spec(card.appId).agent && spec(card.appId).bridgeArgs) {
      void waitForBridge(card.appId).then((ok) => (ok ? applyFocus(brandId, card.projectId, card.appId, card.focus) : null)).catch(() => {})
    }
    return s
  })
  // the card shows the app's web build: the page and session to load, then the guest it made
  ipcMain.handle('embed:web-open', async (e, brandId: unknown, cardId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId)) bad()
    const card = await embedCard(brandId, cardId)
    if (!webSpec(card.appId)) throw new Error(`${card.appName} opens in the full app`)
    await openApp({ appId: card.appId, brandId, projectId: card.projectId, file: card.file })
    const folder = await projectFolder(brandId, card.projectId)
    const { project } = findProject(brandId, card.projectId)
    const file = await pickFile(card.appId, folder, project.name, card.file)
    if (file && !card.file) await changeCard(brandId, card.id, (c) => { if (c.type === 'craft') c.file = basename(file) })
    return prepareWeb({ cardId, appId: card.appId, brandId, projectId: card.projectId, folder, file, where: { brandId, threadId: card.threadId, messageId: card.messageId } })
  })
  ipcMain.handle('embed:web-attach', async (e, brandId: unknown, cardId: unknown, guestId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId) || typeof guestId !== 'number') bad()
    const card = await embedCard(brandId, cardId)
    attachWeb(cardId, guestId, e.sender)
    void webReady(cardId).then(() => applyFocus(brandId, card.projectId, card.appId, card.focus)).catch(() => {})
    return webState(cardId)
  })
  ipcMain.handle('embed:web-release', async (e, brandId: unknown, cardId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId)) bad()
    // false: it stays running, its changes aren't in a file yet
    if (webUnsaved(cardId)) return false
    await releaseWeb(cardId)
    return true
  })
  ipcMain.handle('embed:web-state', (e, cardId: unknown) => {
    if (!fromApp(e) || !isCardId(cardId)) bad()
    return webState(cardId)
  })
  ipcMain.handle('embed:open-full', async (e, brandId: unknown, cardId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId)) bad()
    const card = await embedCard(brandId, cardId)
    return openApp({ appId: card.appId, brandId, projectId: card.projectId, file: card.file, full: true })
  })
  // files dropped on FilmCraft in a card (its preload sends them) go into the project like a drop on the card
  ipcMain.on('craft-web:drop', (e, paths: unknown) => {
    const at = cardForGuest(e.sender.id)
    if (!at || !Array.isArray(paths)) return
    void getCard(at.brandId, at.cardId)
      .then((c) => (c && c.type === 'craft' ? importPaths(c, paths.filter((p): p is string => typeof p === 'string')) : null))
      .catch((err) => console.error('craft: dropped files were not added', err))
  })
  ipcMain.handle('embed:still', async (e, brandId: unknown, cardId: unknown, seconds: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId)) bad()
    try {
      return await still(await embedCard(brandId, cardId), typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null)
    } catch {
      return null
    }
  })
  ipcMain.handle('embed:sequence', async (e, brandId: unknown, cardId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId)) bad()
    const card = await embedCard(brandId, cardId)
    if (card.appId !== 'filmcraft') return null
    return activeSequence(brandId, card.projectId)
  })
  ipcMain.handle('embed:add-markers', async (e, brandId: unknown, cardId: unknown, raw: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId) || !Array.isArray(raw)) bad()
    const card = await embedCard(brandId, cardId)
    if (card.appId !== 'filmcraft') throw new Error('Comments become markers in FilmCraft only.')
    const seq = await activeSequence(brandId, card.projectId)
    if (!seq) throw new Error('FilmCraft has no sequence open. Open one, then comment.')
    const out: PlacedMarker[] = []
    for (const r of raw.slice(0, 50) as Partial<EmbedCommentInput>[]) {
      if (!r || typeof r.text !== 'string' || !r.text.trim() || typeof r.from !== 'number' || !Number.isFinite(r.from)) continue
      const to = typeof r.to === 'number' && Number.isFinite(r.to) ? r.to : r.from
      const c = { from: Math.max(0, Math.min(r.from, to)), to: Math.max(0, r.from, to), text: r.text.trim().slice(0, 2000) }
      const placed: PlacedMarker = { marker: null, sequence: seq.id, sequenceName: seq.name, from: c.from, to: c.to, inTimecode: timecode(c.from, seq.fps), outTimecode: timecode(c.to, seq.fps), text: c.text }
      try {
        const res = (await command(brandId, card.projectId, 'filmcraft', 'markers.add', markerParams(c, seq.fps), true)) as { marker?: unknown } | null
        placed.marker = typeof res?.marker === 'number' ? res.marker : null
      } catch (err) {
        placed.error = message(err).slice(0, 200)
      }
      out.push(placed)
    }
    const ids = out.map((p) => p.marker).filter((m): m is number => m !== null)
    for (const fn of markerSkips) fn(brandId, card.threadId, card.appId, card.projectId, ids)
    return out
  })
  ipcMain.handle('embed:undo-turn', async (e, brandId: unknown, cardId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId)) bad()
    const card = await embedCard(brandId, cardId)
    if (!card.turn?.checkpoint) return { ok: false, note: `There is no copy from before this reply. Use undo in ${card.appName}.` }
    if (card.turn.state === 'working') return { ok: false, note: 'Your agent is still editing. Stop the reply first.' }
    const out = await restoreFile(brandId, card.projectId, card.appId, card.turn.checkpoint)
    if (!out.ok) return out
    await changeCard(brandId, card.id, (c) => {
      if (c.type === 'craft' && c.turn) Object.assign(c.turn, { state: 'undone', note: '' })
    })
    void recordFriction({ brandId, threadId: card.threadId, projectId: card.projectId, appId: card.appId, kind: 'undo-turn', edits: card.turn.edits })
    // the card itself says it
    return { ok: true, note: '' }
  })
  ipcMain.handle('embed:keep-turn', async (e, brandId: unknown, cardId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId)) bad()
    const card = await embedCard(brandId, cardId)
    if (!card.turn) return { ok: false, note: 'Nothing to keep.' }
    if (card.appId === 'filmcraft' && liveOn(card.appId, brandId, card.projectId)) {
      await command(brandId, card.projectId, card.appId, 'file.save').catch(() => {})
    }
    await changeCard(brandId, card.id, (c) => {
      if (c.type === 'craft' && c.turn) c.turn.state = 'kept'
    })
    void recordFriction({ brandId, threadId: card.threadId, projectId: card.projectId, appId: card.appId, kind: 'keep-turn', edits: card.turn.edits })
    return { ok: true, note: '' }
  })
  ipcMain.handle('embed:show-alternative', async (e, brandId: unknown, cardId: unknown, sequence: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId) || typeof sequence !== 'number') bad()
    const card = await embedCard(brandId, cardId)
    if (!card.alternatives?.items.some((a) => a.sequence === sequence)) bad()
    await command(brandId, card.projectId, 'filmcraft', 'sequence.open', { item: sequence })
    await changeCard(brandId, card.id, (c) => {
      if (c.type === 'craft' && c.alternatives) c.alternatives.showing = sequence
    })
  })
  ipcMain.handle('embed:keep-alternative', async (e, brandId: unknown, cardId: unknown, sequence: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId) || typeof sequence !== 'number') bad()
    const card = await embedCard(brandId, cardId)
    const alts = card.alternatives
    if (!alts?.items.some((a) => a.sequence === sequence)) bad()
    const ck = await checkpointFile(brandId, card.projectId, card.appId, `alt-${card.id}-${randomUUID().slice(0, 8)}`)
    if (!ck) return { ok: false, note: 'The project has no file to keep a copy of.' }
    const others = alts.items.filter((a) => a.sequence !== sequence).map((a) => a.sequence)
    try {
      await command(brandId, card.projectId, 'filmcraft', 'sequence.open', { item: sequence })
      await command(brandId, card.projectId, 'filmcraft', 'project.delete', { items: others }, true)
      const live = liveOn(card.appId, brandId, card.projectId)
      if (live === 'window' || live === 'web') await command(brandId, card.projectId, 'filmcraft', 'file.save').catch(() => {})
    } catch (err) {
      return { ok: false, note: `FilmCraft didn't remove the other versions: ${message(err)}` }
    }
    await changeCard(brandId, card.id, (c) => {
      if (c.type === 'craft' && c.alternatives) Object.assign(c.alternatives, { kept: sequence, showing: sequence, checkpoint: ck.rel, note: '' })
    })
    const label = alts.items.find((a) => a.sequence === sequence)?.label ?? String(sequence)
    void recordFriction({ brandId, threadId: card.threadId, projectId: card.projectId, appId: card.appId, kind: 'keep-alternative', detail: label })
    return { ok: true, note: '' }
  })
  ipcMain.handle('embed:undo-alternative', async (e, brandId: unknown, cardId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId)) bad()
    const card = await embedCard(brandId, cardId)
    if (!card.alternatives?.checkpoint) return { ok: false, note: 'There is nothing to undo.' }
    const out = await restoreFile(brandId, card.projectId, card.appId, card.alternatives.checkpoint)
    if (!out.ok) return out
    await changeCard(brandId, card.id, (c) => {
      if (c.type === 'craft' && c.alternatives) Object.assign(c.alternatives, { kept: null, checkpoint: null })
    })
    void recordFriction({ brandId, threadId: card.threadId, projectId: card.projectId, appId: card.appId, kind: 'undo-alternative' })
    return { ok: true, note: 'All versions are back.' }
  })
  ipcMain.handle('embed:import-files', async (e, brandId: unknown, cardId: unknown, paths: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId) || !Array.isArray(paths)) bad()
    return importPaths(await embedCard(brandId, cardId), paths as string[])
  })
  ipcMain.handle('embed:import-media', async (e, brandId: unknown, cardId: unknown, mediaId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId) || !isId(mediaId)) bad()
    const card = await embedCard(brandId, cardId)
    const rel = await deps.addToProject(brandId, card.projectId, mediaId)
    const folder = await projectFolder(brandId, card.projectId)
    return importPaths(card, [join(folder, rel)])
  })
  ipcMain.handle('embed:latest-render', async (e, brandId: unknown, cardId: unknown): Promise<ProjectFileRef | null> => {
    if (!fromApp(e) || !isId(brandId) || !isCardId(cardId)) bad()
    const card = await embedCard(brandId, cardId)
    const root = knownFolder(brandId, card.projectId)
    if (!root) return null
    for (const p of await newVideosSince(root, 0)) {
      try {
        return (await checkProjectFile(brandId, card.projectId, relativeIn(root, p))).ref
      } catch (err) {
        if (!(err instanceof PathError)) continue
      }
    }
    return null
  })
}
