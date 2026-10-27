import { craftBelongsTo } from '@shared/craft'
import {
  assetUrl,
  durationText,
  PROVIDER_NAMES,
  type ToProjectResult,
  type VisualAsset,
  type VisualKind,
  type VisualResult
} from '@shared/visuals'
import { attachToChat } from '../attachments'
import { embedFor } from '../cards/embed-owner'
import type { CardActions } from '../cards/useCards'

// what the visuals' buttons do, the same for a sketch, a pasted image, an item card and an option
// in a search grid. placing things in the Craft apps goes through the agent and its craft tools

export type VisualTarget = { type: 'asset'; asset: VisualAsset } | { type: 'result'; result: VisualResult }

export const targetKind = (t: VisualTarget): VisualKind => (t.type === 'asset' ? 'image' : t.result.kind)
export const targetName = (t: VisualTarget): string => (t.type === 'asset' ? t.asset.name : t.result.title)

const api = (): Window['trenddeckVisuals'] => window.trenddeckVisuals

// ---------- events the chat listens for ----------

const SKETCH = 'trenddeck:sketch'
const NOTE = 'trenddeck:chat-note'

export interface SketchRequest {
  // data: or td-media: url of the picture to draw on, null for a blank page
  src: string | null
  name: string
  note?: string
}

// opens the sketch pad over the chat, on a picture or blank
export function openSketch(req: SketchRequest): void {
  window.dispatchEvent(new CustomEvent(SKETCH, { detail: req }))
}

export function onSketch(fn: (req: SketchRequest) => void): () => void {
  const l = (e: Event): void => fn((e as CustomEvent<SketchRequest>).detail)
  window.addEventListener(SKETCH, l)
  return () => window.removeEventListener(SKETCH, l)
}

// adds a line to the composer's draft, after what's there
export function noteToChat(text: string): void {
  if (text.trim()) window.dispatchEvent(new CustomEvent(NOTE, { detail: text.trim() }))
}

export function onChatNote(fn: (text: string) => void): () => void {
  const l = (e: Event): void => fn((e as CustomEvent<string>).detail)
  window.addEventListener(NOTE, l)
  return () => window.removeEventListener(NOTE, l)
}

// an asset as an attachment on the next message, the agent looks at it with visual_get
export function attachVisual(a: VisualAsset, note = ''): void {
  attachToChat([{ id: a.id, name: a.name.endsWith(`.${a.ext}`) ? a.name : `${a.name}.${a.ext}`, type: a.mime, size: a.bytes, visual: true }])
  noteToChat(note)
}

// ---------- describing it for the agent ----------

export function creditNote(t: VisualTarget): string {
  const r = t.type === 'result' ? t.result : t.asset.source
  if (r) {
    const credit = r.license.attribution ? 'credit needed' : 'no credit needed'
    const commercial = r.license.commercial ? '' : ', not for commercial use'
    return `"${r.title}" by ${r.author || 'unknown'} from ${PROVIDER_NAMES[r.provider]} (${r.license.name}, ${credit}${commercial})`
  }
  if (t.type === 'asset' && t.asset.origin === 'link') return `an image from ${t.asset.sourceUrl} with an unknown license`
  if (t.type === 'asset' && t.asset.origin === 'sketch') return 'my sketch'
  return 'an image I pasted'
}

export function insertText(file: string, t: VisualTarget, note: string): string {
  const kind = targetKind(t)
  const as =
    kind === 'audio'
      ? 'as a clip on an audio track'
      : kind === 'video'
        ? 'as a clip on a video track above the main footage'
        : 'as a graphic on a video track above the main footage, 5 seconds long unless I say otherwise'
  return [
    `Insert ${file} (in the project folder, ${creditNote(t)}) into the FilmCraft edit at the playhead ${as}, using the filmcraft tools.`,
    "If FilmCraft isn't open on this project, open it in the chat with craft_embed first. If the playhead, the sequence or the track isn't clear, ask me first instead of guessing. Keep the original file as it is.",
    note.trim() ? `My note: ${note.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export function photoText(file: string, t: VisualTarget, how: 'new' | 'layer', doc: string | null, note: string): string {
  const what = `${file} (in the project folder, ${creditNote(t)})`
  const steps =
    how === 'layer' && doc
      ? `Open ${doc} in PhotoCraft in the chat with craft_embed and add ${what} as a new layer on top, fitted inside the canvas. Save the document.`
      : `Open ${what} in PhotoCraft as a new document, in the chat with craft_embed. If PhotoCraft can't open it directly, make a new document the image's size, place the image as its first layer and save it next to it as a .pcraft file.`
  return [steps, "Use the photocraft tools. If something isn't clear, ask me first.", note.trim() ? `My note: ${note.trim()}` : ''].filter(Boolean).join('\n')
}

// ---------- the actions ----------

export async function toProject(a: CardActions, t: VisualTarget): Promise<ToProjectResult> {
  if (!a.project) throw new Error('Open a project to add this to its files.')
  return t.type === 'asset'
    ? api().assetToProject(a.brand.id, a.project.id, t.asset.id, a.threadId ?? null)
    : api().resultToProject(a.brand.id, a.project.id, t.result.id, a.threadId ?? null)
}

// the picture an image target shows, for drawing on it
export async function pictureOf(a: CardActions, t: VisualTarget): Promise<{ src: string; asset: VisualAsset }> {
  const asset = t.type === 'asset' ? t.asset : await api().fetchResult(a.brand.id, t.result.id)
  return { src: assetUrl(asset), asset }
}

// attached to the next message: images go as visuals, video and audio as a line in the draft
export async function sendToAgent(a: CardActions, t: VisualTarget, note = ''): Promise<string> {
  if (t.type === 'asset') {
    attachVisual(t.asset, note)
    return 'Attached to your next message.'
  }
  const r = t.result
  if (r.kind === 'image' || r.kind === 'gif') {
    const asset = await api().fetchResult(a.brand.id, r.id)
    attachVisual(asset, note)
    return 'Attached to your next message.'
  }
  const len = durationText(r.duration)
  noteToChat(`I like option ${r.id}: "${r.title}", a ${PROVIDER_NAMES[r.provider]} ${r.kind}${len ? ` of ${len}` : ''}. ${note}`.trim())
  return 'Added to your next message. Your agent can look at its preview.'
}

// FilmCraft open on this project: its window or an editor in this chat
export async function filmcraftOpen(a: CardActions): Promise<boolean> {
  if (!a.project) return false
  if (embedFor(a.project.id, 'filmcraft')) return true
  const apps = await window.trenddeckCraft.list().catch(() => [])
  const film = apps.find((s) => s.app.id === 'filmcraft')
  return !!film && craftBelongsTo(film, a.brand.id, a.project.id)
}

export async function photocraftDocs(a: CardActions): Promise<string[]> {
  if (!a.project) return []
  return (await window.trenddeckCraft.files(a.brand.id, a.project.id, 'photocraft').catch(() => [])).map((f) => f.name)
}
