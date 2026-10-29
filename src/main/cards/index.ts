import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { ProjectFileRef, ReviewFrameInput, VideoCard } from '@shared/cards'
import { ID_PATTERN } from '@shared/types'
import { findProject, knownFolder, projectFolder } from '../craft/paths'
import { commandIds, safeName, uniqueName } from '../craft/rules'
import { onToolCalled, registerTools } from '../gateway/call'
import { resolveForUpload } from '../media/upload'
import { onTurnClosed } from '../mcp/turns'
import { historyCard } from '../production-storage'
import { commitChanges, restoreCommit, saveCheckpoint, serialize } from '../production-storage/git'
import { noSymlinks, StorageError } from '../production-storage/safety'
import { logFriction } from '../brand-memory'
import { makeCheckpoint, restoreCheckpoint } from './checkpoint'
import { checkProjectFile, newVideosSince, projectFileUrl, relativeIn } from './files'
import { addCard, cardsDir, changeCard, dropCards, getCard, listCards, newCardId } from './store'
import { cardTools, projectOf } from './tools'
import { registerTurnNotes } from '../agents/context'
import { movedNote } from '../craft/move-root'
import { setupCollab, turnNotes } from './collab'
import { embedTools, setupEmbeds } from './embed'
import { setupTurnEdits } from './turn-edits'

export { servedPath } from './files'
export { dropCards } from './store'
export { recordFriction, type FrictionEvent } from './friction'

// cards in the chat from the agent's tools, see @shared/cards. the window lists them per thread,
// answers suggestion cards, saves review frames and checkpoints, and reads project history

const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'
const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v)
const MAX_FRAME_BYTES = 12 * 1024 * 1024

function bad(): never {
  throw new Error('bad cards call')
}

async function saveFrame(brandId: string, cardId: string, f: ReviewFrameInput): Promise<string> {
  const card = await getCard(brandId, cardId)
  if (!card) throw new Error('that card is gone')
  const m = typeof f?.dataUrl === 'string' ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(f.dataUrl) : null
  if (!m) throw new Error('the frame should be a png')
  const png = Buffer.from(m[1], 'base64')
  if (png.length > MAX_FRAME_BYTES || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('the frame should be a png under 12 MB')
  const id = randomUUID()
  const dir = join(cardsDir(), 'frames', brandId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, `${id}.png`), png)
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0)
  const box = f.box && [f.box.x, f.box.y, f.box.width, f.box.height].every((v) => typeof v === 'number' && Number.isFinite(v))
    ? { x: Math.round(f.box.x), y: Math.round(f.box.y), width: Math.round(f.box.width), height: Math.round(f.box.height) }
    : null
  await fs.writeFile(join(dir, `${id}.json`), JSON.stringify({ cardId, timeSeconds: n(f.timeSeconds), width: Math.round(n(f.width)), height: Math.round(n(f.height)), box }), 'utf8')
  return id
}

// a media library file into the project's media folder, so the editors and the agent can use it
async function addToProject(brandId: string, projectId: string, mediaId: string): Promise<string> {
  findProject(brandId, projectId)
  const src = await resolveForUpload(mediaId, { brandId, forAgent: false })
  const root = await projectFolder(brandId, projectId)
  const dir = join(root, 'media')
  await fs.mkdir(dir, { recursive: true })
  await noSymlinks(dir)
  const name = safeName(src.fileName, 'media')
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  const taken = new Set(await fs.readdir(dir).catch(() => [] as string[]))
  let target = `${stem}${ext}`
  if (taken.has(target)) {
    // the same file added twice stays one file
    const st = await fs.stat(join(dir, target)).catch(() => null)
    if (st && st.size === src.size) return relativeIn(root, join(dir, target))
    target = `${uniqueName(stem, [...taken].map((t) => t.replace(/\.[^.]+$/, '')))}${ext}`
  }
  await fs.copyFile(src.path, join(dir, target))
  return relativeIn(root, join(dir, target))
}

async function projectRoot(brandId: string, projectId: string): Promise<string> {
  findProject(brandId, projectId)
  return noSymlinks(await projectFolder(brandId, projectId))
}

const storageMessage = (err: unknown): string => (err instanceof StorageError ? err.message : 'That did not work. Check that Git is installed.')

// a FilmCraft render or export puts what it made in the chat, once per file per turn
const autoShown = new Map<string, Set<string>>()

function watchRenders(): void {
  onTurnClosed((turn) => autoShown.delete(turn.id))
  onToolCalled((turn, name, args, startedAt) => {
    if (!name.startsWith('filmcraft_')) return
    const ids = commandIds(args)
    if (!/render|export|preview/i.test(name) && !ids.some((id) => /render|export/i.test(id))) return
    void (async () => {
      const project = projectOf(turn, args.projectId)
      const root = knownFolder(turn.brandId, project.id)
      if (!root) return
      const seen = autoShown.get(turn.id) ?? new Set<string>()
      autoShown.set(turn.id, seen)
      const fresh = (await newVideosSince(root, startedAt)).filter((p) => !seen.has(p.toLowerCase()))
      const path = fresh[0]
      if (!path) return
      seen.add(path.toLowerCase())
      const { ref } = await checkProjectFile(turn.brandId, project.id, relativeIn(root, path))
      const now = Date.now()
      const card: VideoCard = {
        id: newCardId(), brandId: turn.brandId, threadId: turn.threadId, messageId: turn.messageId ?? null, at: now, updatedAt: now,
        type: 'video', title: basename(path), media: ref, from: null, to: null, note: 'Made by FilmCraft just now.', auto: true
      }
      await addCard(card)
    })().catch((err) => console.error('cards: showing a render failed', err))
  })
}

export function setupCards(): void {
  registerTools(cardTools())
  watchRenders()
  // the Craft apps live in the chat: craft_embed, a reply's edits as one undo group, and what the
  // user changed in them between replies
  registerTools(embedTools())
  setupEmbeds({ addToProject })
  setupTurnEdits()
  setupCollab()
  registerTurnNotes(turnNotes)
  registerTurnNotes(() => movedNote())

  ipcMain.handle('cards:list', (e, brandId: unknown, threadId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || typeof threadId !== 'string') return []
    return listCards(brandId, threadId)
  })
  ipcMain.handle('cards:answer', (e, brandId: unknown, cardId: unknown, raw: unknown) => {
    if (!fromApp(e) || !isId(brandId) || typeof cardId !== 'string') bad()
    const a = (raw ?? {}) as { choice?: unknown; text?: unknown }
    const choice = typeof a.choice === 'string' ? a.choice.slice(0, 40) : ''
    if (!choice) bad()
    const text = typeof a.text === 'string' ? a.text.slice(0, 4000) : ''
    // turned down and undone suggestions go in the brand's friction log for the wrap-up
    void getCard(brandId, cardId).then((c) => {
      if (c?.type !== 'suggestion') return
      if (choice === 'later') return logFriction(brandId, { kind: 'rejected-suggestion', projectId: c.preview?.projectId ?? null, before: `${c.title}: ${c.body}`, after: text, ref: c.id })
      if (choice === 'undo') return logFriction(brandId, { kind: 'undo', projectId: c.preview?.projectId ?? null, before: `${c.title}: ${c.body}`, after: text, ref: c.id })
    })
    return changeCard(brandId, cardId, (c) => {
      if (c.type !== 'suggestion') return
      if (choice !== 'preview' && choice !== 'apply' && choice !== 'undo') c.answer = { choice, text, at: Date.now() }
      if (c.edit && choice === 'apply') c.edit.state = 'proposed'
    })
  })
  ipcMain.handle('cards:save-frame', (e, brandId: unknown, cardId: unknown, frame: unknown) => {
    if (!fromApp(e) || !isId(brandId) || typeof cardId !== 'string' || !frame || typeof frame !== 'object') bad()
    return saveFrame(brandId, cardId, frame as ReviewFrameInput)
  })
  ipcMain.handle('cards:checkpoint', async (e, brandId: unknown, cardId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || typeof cardId !== 'string') bad()
    const card = await getCard(brandId, cardId)
    if (!card || card.type !== 'suggestion' || !card.edit) bad()
    const projectId = card.preview?.projectId ?? projectOfThread(brandId, card.threadId)
    if (!projectId) return null
    const root = await projectRoot(brandId, projectId)
    const id = await makeCheckpoint(root, card.id)
    await changeCard(brandId, card.id, (c) => {
      if (c.type === 'suggestion' && c.edit) c.edit.checkpoint = id
    })
    return id
  })
  ipcMain.handle('cards:restore-checkpoint', async (e, brandId: unknown, cardId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || typeof cardId !== 'string') bad()
    const card = await getCard(brandId, cardId)
    if (!card || card.type !== 'suggestion' || !card.edit?.checkpoint) return { ok: false, note: 'There is no checkpoint for this edit.' }
    const projectId = card.preview?.projectId ?? projectOfThread(brandId, card.threadId)
    if (!projectId) return { ok: false, note: 'This chat has no project.' }
    const out = await restoreCheckpoint(await projectRoot(brandId, projectId), card.edit.checkpoint, brandId, projectId)
    if (out.ok) {
      await changeCard(brandId, card.id, (c) => {
        if (c.type === 'suggestion' && c.edit) Object.assign(c.edit, { state: 'undone', note: out.note })
      })
    }
    return out
  })
  ipcMain.handle('cards:add-to-project', (e, brandId: unknown, projectId: unknown, mediaId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isId(projectId) || !isId(mediaId)) bad()
    return addToProject(brandId, projectId, mediaId)
  })
  ipcMain.handle('cards:history', async (e, brandId: unknown, projectId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isId(projectId)) bad()
    const root = await projectRoot(brandId, projectId)
    try {
      return await serialize(root, () => historyCard({ brandId, threadId: null, messageId: null }, projectId, root))
    } catch (err) {
      throw new Error(storageMessage(err))
    }
  })
  ipcMain.handle('cards:save-checkpoint', async (e, brandId: unknown, projectId: unknown, message: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isId(projectId)) bad()
    const text = typeof message === 'string' && message.trim() ? message.trim().replace(/\s+/g, ' ').slice(0, 200) : 'Checkpoint'
    const root = await projectRoot(brandId, projectId)
    try {
      return await serialize(root, async () => {
        await saveCheckpoint(root, text)
        return historyCard({ brandId, threadId: null, messageId: null }, projectId, root)
      })
    } catch (err) {
      throw new Error(storageMessage(err))
    }
  })
  ipcMain.handle('cards:commit-diff', async (e, brandId: unknown, projectId: unknown, commit: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isId(projectId) || typeof commit !== 'string') bad()
    const root = await projectRoot(brandId, projectId)
    try {
      return await serialize(root, () => commitChanges(root, commit))
    } catch (err) {
      throw new Error(storageMessage(err))
    }
  })
  ipcMain.handle('cards:restore-commit', async (e, brandId: unknown, projectId: unknown, commit: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isId(projectId) || typeof commit !== 'string') bad()
    const root = await projectRoot(brandId, projectId)
    try {
      return await serialize(root, async () => {
        await restoreCommit(root, commit)
        return historyCard({ brandId, threadId: null, messageId: null }, projectId, root)
      })
    } catch (err) {
      throw new Error(storageMessage(err))
    }
  })
}

// the project a chat belongs to, null for none
function projectOfThread(brandId: string, threadId: string | null): string | null {
  if (!threadId) return null
  try {
    return projectOf({ brandId, threadId } as Parameters<typeof projectOf>[0], undefined).id
  } catch {
    return null
  }
}

export function fileUrl(brandId: string, ref: ProjectFileRef): string {
  return projectFileUrl(brandId, ref)
}

export async function dropCardsBrand(brandId: string): Promise<void> {
  await dropCards(brandId)
}
