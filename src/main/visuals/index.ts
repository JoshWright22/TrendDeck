import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { VisualCard } from '@shared/cards'
import { creditLine, PROVIDER_NAMES, visualFileStem, type SaveImageInput, type VisualAsset, type VisualSearchInput } from '@shared/visuals'
import { ID_PATTERN } from '@shared/types'
import { registerTurnNotes } from '../agents/context'
import { addCard, newCardId } from '../cards/store'
import { findProject, projectFolder } from '../craft/paths'
import { registerTools } from '../gateway/call'
import { registerSecretSource } from '../gateway/secrets'
import { noSymlinks } from '../production-storage/safety'
import { visualsRoot } from './paths'
import { clearKey, keyFor, keyState, keyValues, loadKeys, setKey } from './keys'
import { safeFetch, setUserAgent, VisualNetError } from './net'
import { plainText } from './providers'
import { downloadResult, searchVisuals } from './search'
import {
  addPick,
  assetPath,
  decodeDataUrl,
  findResult,
  imageInfo,
  provenanceFromAsset,
  provenanceFromResult,
  readAsset,
  saveAsset,
  takePicks,
  VisualError,
  writeToProject
} from './store'
import { visualTools } from './tools'

// sketches, pasted and dropped images, and options found online. see docs/DECISIONS-visuals.md


const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'
const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v)
const RESULT_ID = /^(openverse|wikimedia|pexels|pixabay):[A-Za-z0-9._-]{1,100}$/

function bad(): never {
  throw new Error('bad visuals call')
}

// errors the user reads as they are, anything else gets a plain line
async function plain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof VisualError || err instanceof VisualNetError) throw new Error(err.message)
    throw err
  }
}

async function asset(brandId: string, id: string): Promise<VisualAsset> {
  const a = await readAsset(visualsRoot(), brandId, id)
  if (!a) throw new VisualError('That visual is gone.')
  return a
}

// a search option downloaded as an asset, so it can be attached or drawn on. images only
async function resultAsset(brandId: string, resultId: string): Promise<VisualAsset> {
  const r = await findResult(visualsRoot(), brandId, resultId)
  if (!r) throw new VisualError('That option is from an older search. Search again.')
  if (r.kind !== 'image' && r.kind !== 'gif') throw new VisualError('Only images can be attached or drawn on. Add it to the video files instead.')
  const { bytes } = await downloadResult(r)
  return saveAsset(visualsRoot(), brandId, bytes, { origin: 'search', name: r.title, note: '', sourceUrl: r.pageUrl, source: r })
}

// an image link or a page with an og:image, dropped from a browser
async function linkAsset(brandId: string, url: string): Promise<VisualAsset> {
  const first = await safeFetch(url, { maxBytes: 25_000_000, timeoutMs: 30_000, accept: (m) => m.startsWith('image/') || m === 'text/html' || m === 'application/xhtml+xml' || m === '' })
  if (imageInfo(first.bytes)) {
    const name = decodeURIComponent(new URL(first.url).pathname.split('/').pop() ?? '') || 'image'
    return saveAsset(visualsRoot(), brandId, first.bytes, { origin: 'link', name, note: '', sourceUrl: url, source: null })
  }
  const html = first.bytes.toString('utf8', 0, Math.min(first.bytes.length, 600_000))
  const meta = (prop: string): string => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i')
    const tag = re.exec(html)?.[0] ?? ''
    return plainText(/content=["']([^"']+)["']/i.exec(tag)?.[1] ?? '')
  }
  const img = meta('og:image') || meta('og:image:url') || meta('twitter:image')
  if (!img) throw new VisualError("That page has no image TrendDeck can find. Drag the image itself, or save it and paste it.")
  const imgUrl = new URL(img, first.url).href
  const got = await safeFetch(imgUrl, { maxBytes: 25_000_000, timeoutMs: 30_000, accept: (m) => m.startsWith('image/') || m === 'application/octet-stream' || m === '' })
  const title = meta('og:title') || plainText(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '') || new URL(url).hostname
  return saveAsset(visualsRoot(), brandId, got.bytes, { origin: 'link', name: title, note: '', sourceUrl: first.url, source: null })
}

// a search option or an asset into <project>/media/visuals with its .credit.json
async function toProject(brandId: string, projectId: string, id: string, threadId: string | null, byAgent: boolean): Promise<{ file: string; credit: string; note: string }> {
  findProject(brandId, projectId)
  const root = await noSymlinks(await projectFolder(brandId, projectId))
  let out
  let what: string
  if (RESULT_ID.test(id)) {
    const r = await findResult(visualsRoot(), brandId, id)
    if (!r) throw new VisualError('That option is from an older search. Search again.')
    const { bytes } = await downloadResult(r)
    const ext = r.ext && /^[a-z0-9]{2,5}$/.test(r.ext) ? r.ext : (imageInfo(bytes)?.ext ?? 'bin')
    out = await writeToProject(root, { bytes, ext, stem: r.title, provenance: provenanceFromResult(r) })
    what = `"${r.title}" from ${PROVIDER_NAMES[r.provider]} (${r.license.name})`
  } else if (isId(id)) {
    const a = await asset(brandId, id)
    const bytes = await fs.readFile(assetPath(visualsRoot(), a))
    const p = provenanceFromAsset(a)
    const stem = a.origin === 'sketch' ? `sketch-${new Date(a.createdAt).toISOString().slice(0, 16).replace(/[-:T]/g, '')}` : a.source?.title || a.name
    out = await writeToProject(root, { bytes, ext: a.ext, stem: visualFileStem(stem, a.origin), provenance: p })
    what = a.origin === 'sketch' ? 'a sketch' : `"${a.name}"`
  } else throw new VisualError('That visual id is not valid.')
  const credit = creditLine(out.provenance)
  const note = out.existed ? `Already in the video files as ${out.file}.` : `Added to the video files as ${out.file}.`
  if (threadId && !byAgent) void addPick(visualsRoot(), brandId, threadId, `The user added ${what} to the video files as ${out.file}.`).catch(() => {})
  return { file: out.file, credit, note }
}

// what the user did with visuals since the agent's last reply
async function visualTurnNotes(brandId: string, threadId: string): Promise<string> {
  const picks = await takePicks(visualsRoot(), brandId, threadId)
  if (!picks.length) return ''
  return ['## Visuals the user picked or made since your last reply', ...picks.map((p) => `- ${p}`), 'Build on these picks; ask before swapping them for something else.'].join('\n')
}

export function setupVisuals(): void {
  setUserAgent(app.getVersion())
  void loadKeys()
  registerSecretSource(keyValues)
  registerTools(visualTools({ root: visualsRoot, toProject }))
  registerTurnNotes(visualTurnNotes)

  ipcMain.handle('visuals:search', (e, brandId: unknown, _threadId: unknown, input: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !input || typeof input !== 'object') bad()
    return plain(() => searchVisuals(visualsRoot(), brandId, input as VisualSearchInput, keyFor))
  })
  ipcMain.handle('visuals:asset', (e, brandId: unknown, id: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isId(id)) bad()
    return readAsset(visualsRoot(), brandId, id)
  })
  ipcMain.handle('visuals:save-image', (e, raw: unknown) => {
    const r = (raw ?? {}) as Partial<SaveImageInput>
    if (!fromApp(e) || !isId(r.brandId) || typeof r.dataUrl !== 'string' || !['sketch', 'paste', 'frame'].includes(String(r.origin))) bad()
    const brandId = r.brandId
    return plain(async () => {
      const a = await saveAsset(visualsRoot(), brandId, decodeDataUrl(r.dataUrl!), {
        origin: r.origin as SaveImageInput['origin'],
        name: typeof r.name === 'string' ? r.name : r.origin === 'sketch' ? 'Sketch' : 'Pasted image',
        note: typeof r.note === 'string' ? r.note : '',
        sourceUrl: '',
        source: null
      })
      return a
    })
  })
  ipcMain.handle('visuals:fetch-result', (e, brandId: unknown, resultId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || typeof resultId !== 'string' || !RESULT_ID.test(resultId)) bad()
    return plain(() => resultAsset(brandId, resultId))
  })
  ipcMain.handle('visuals:fetch-link', (e, brandId: unknown, url: unknown) => {
    if (!fromApp(e) || !isId(brandId) || typeof url !== 'string' || url.length > 2000) bad()
    return plain(() => linkAsset(brandId, url))
  })
  ipcMain.handle('visuals:result-to-project', (e, brandId: unknown, projectId: unknown, resultId: unknown, threadId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isId(projectId) || typeof resultId !== 'string' || !RESULT_ID.test(resultId)) bad()
    return plain(() => toProject(brandId, projectId, resultId, typeof threadId === 'string' ? threadId : null, false))
  })
  ipcMain.handle('visuals:asset-to-project', (e, brandId: unknown, projectId: unknown, assetId: unknown, threadId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isId(projectId) || !isId(assetId)) bad()
    return plain(() => toProject(brandId, projectId, assetId, typeof threadId === 'string' ? threadId : null, false))
  })
  ipcMain.handle('visuals:show-card', async (e, brandId: unknown, threadId: unknown, assetId: unknown) => {
    if (!fromApp(e) || !isId(brandId) || typeof threadId !== 'string' || !threadId || !isId(assetId)) bad()
    const a = await plain(() => asset(brandId, assetId))
    const now = Date.now()
    const card: VisualCard = { id: newCardId(), brandId, threadId, messageId: null, at: now, updatedAt: now, type: 'visual', asset: a }
    await addCard(card)
    return card.id
  })
  ipcMain.handle('visuals:keys', (e) => {
    if (!fromApp(e)) bad()
    return keyState()
  })
  ipcMain.handle('visuals:set-key', (e, name: unknown, key: unknown) => {
    if (!fromApp(e)) bad()
    return setKey(name, key)
  })
  ipcMain.handle('visuals:clear-key', (e, name: unknown) => {
    if (!fromApp(e)) bad()
    return clearKey(name)
  })
}

// a deleted brand takes its sketches, pastes, thumbnails and picks with it. files already added to
// a project folder stay there
export async function dropVisualsBrand(brandId: string): Promise<void> {
  if (!ID_PATTERN.test(brandId)) return
  await fs.rm(join(visualsRoot(), brandId), { recursive: true, force: true })
}
