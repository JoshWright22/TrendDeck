// a live Craft editor posted into the chat (see CraftEmbedCard in ./cards): the real app's window
// docks over the embed while it's the newest one you can see, older ones show a still. the agent's
// edits in one reply form one undo group, your comments become markers at their sequence time,
// and what you change in the editor between replies goes to the agent as a short summary.
// the parts here are pure and unit tested, main and the window share them

import type { CraftAppStatus } from './craft'
import type { ProjectFileRef, ReviewBox } from './cards'

export type EmbedSize = 'inline' | 'large' | 'fill'

export const MIN_STAGE_HEIGHT = 420

export function stageHeight(size: EmbedSize, width: number, room: number): number {
  const available = Number.isFinite(room) ? Math.max(1, Math.floor(room)) : MIN_STAGE_HEIGHT
  const preferred = Math.max(MIN_STAGE_HEIGHT, Math.round((Math.max(0, Number.isFinite(width) ? width : 0) * 2) / 3))
  if (size === 'fill') return available
  if (size === 'large') return Math.min(available, Math.max(preferred, Math.round(available * 0.9)))
  return Math.min(preferred, available)
}


// where the agent wants you to look: a FilmCraft sequence (project item id) and a time in seconds,
// or a layer by name in the image apps
export interface EmbedFocus {
  sequence: number | null
  time: number | null
  layer: string | null
}

// what happened to one reply's edits in the app
export type EmbedTurnState = 'working' | 'review' | 'kept' | 'undone' | 'failed'

export interface EmbedTurn {
  turnId: string
  edits: number
  state: EmbedTurnState
  // a copy of the project file from before the first edit of the reply, relative to the project
  checkpoint: string | null
  note: string
}

// versions of a cut as separate sequences in the same project
export interface EmbedAlternative {
  label: string
  sequence: number
}

export interface EmbedAlternatives {
  items: EmbedAlternative[]
  showing: number | null
  kept: number | null
  checkpoint: string | null
  note: string
}

// ---- the window's side: window.trenddeckEmbed ----

export interface EmbedSequence {
  id: number
  name: string
  fps: { num: number; den: number }
  durationSeconds: number
  playheadSeconds: number | null
}

// a comment on the timeline, about to become a marker
export interface EmbedCommentInput {
  from: number
  to: number
  text: string
}

export interface PlacedMarker {
  marker: number | null
  sequence: number
  sequenceName: string
  from: number
  to: number
  inTimecode: string
  outTimecode: string
  text: string
  error?: string
}

export interface EmbedApi {
  // an embed of the app at the end of the chat, for opening an editor by hand. returns its card id
  create(brandId: string, threadId: string, projectId: string, appId: string): Promise<string>
  // opens the app on the embed's project and file (installs first when it has to)
  open(brandId: string, cardId: string): Promise<CraftAppStatus>
  // a still of the embed for when it isn't the live one, a png data url or null
  still(brandId: string, cardId: string, seconds?: number | null): Promise<string | null>
  sequence(brandId: string, cardId: string): Promise<EmbedSequence | null>
  addMarkers(brandId: string, cardId: string, comments: EmbedCommentInput[]): Promise<PlacedMarker[]>
  undoTurn(brandId: string, cardId: string): Promise<{ ok: boolean; note: string }>
  keepTurn(brandId: string, cardId: string): Promise<{ ok: boolean; note: string }>
  showAlternative(brandId: string, cardId: string, sequence: number): Promise<void>
  keepAlternative(brandId: string, cardId: string, sequence: number): Promise<{ ok: boolean; note: string }>
  undoAlternative(brandId: string, cardId: string): Promise<{ ok: boolean; note: string }>
  // files dropped on the embed go into the app's project media
  importFiles(brandId: string, cardId: string, paths: string[]): Promise<{ imported: string[]; note: string }>
  importMedia(brandId: string, cardId: string, mediaId: string): Promise<{ imported: string[]; note: string }>
  // the newest video in the project folder, for the preview when the app can't run
  latestRender(brandId: string, cardId: string): Promise<ProjectFileRef | null>
  pathForFile(file: File): string
}

declare global {
  interface Window {
    trenddeckEmbed?: EmbedApi
  }
}

// ---- time: FilmCraft counts ticks, 254 016 000 000 a second ----

export const TICKS_PER_SECOND = 254_016_000_000

export const toTicks = (seconds: number): number => Math.round(Math.max(0, seconds) * TICKS_PER_SECOND)
export const toSeconds = (ticks: number): number => ticks / TICKS_PER_SECOND

export interface Fps {
  num: number
  den: number
}

const fpsOf = (fps: Fps | null | undefined): number => (fps && fps.num > 0 && fps.den > 0 ? fps.num / fps.den : 30)

// the frame a time falls on, the way the timeline counts it
export function frameAt(seconds: number, fps?: Fps | null): number {
  return Math.floor(Math.max(0, seconds) * fpsOf(fps) + 1e-6)
}

// HH:MM:SS:FF, non drop frame
export function timecode(seconds: number, fps?: Fps | null): string {
  const rate = Math.max(1, Math.round(fpsOf(fps)))
  const frames = Math.floor(Math.max(0, seconds) * fpsOf(fps) + 1e-6)
  const ff = frames % rate
  const total = Math.floor(frames / rate)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(Math.floor(total / 3600))}:${p(Math.floor(total / 60) % 60)}:${p(total % 60)}:${p(ff)}`
}

// the start of the frame a time falls on, in ticks
export function snapTicks(seconds: number, fps?: Fps | null): number {
  return toTicks(frameAt(seconds, fps) / fpsOf(fps))
}

// a short marker name from the comment: its first words
export function markerName(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  let out = ''
  for (const w of words) {
    if ((out ? out.length + 1 : 0) + w.length > 40) break
    out = out ? `${out} ${w}` : w
  }
  return out || text.trim().slice(0, 40)
}

// a comment as FilmCraft's markers.add params: on the program timeline at the frame the comment
// starts on, a range when it covers more than one frame
export function markerParams(c: EmbedCommentInput, fps?: Fps | null): Record<string, unknown> {
  const from = Math.max(0, Math.min(c.from, c.to))
  const to = Math.max(c.from, c.to)
  const startFrame = frameAt(from, fps)
  const frames = frameAt(to, fps) - startFrame
  const params: Record<string, unknown> = { target: 'program', time: snapTicks(from, fps), name: markerName(c.text), comment: c.text.trim().slice(0, 2000) }
  if (frames >= 1) params.durationFrames = frames
  return params
}

// ---- the comments as one message to the agent ----

export const CRAFT_REVIEW_LANG = 'trenddeck-craft-review'

export interface CraftReviewItem extends PlacedMarker {
  frameId?: string
  box?: ReviewBox | null
  frameWidth?: number
  frameHeight?: number
}

export function formatCraftReview(info: { cardId: string; projectId: string; projectName: string; appName: string; file: string | null }, items: CraftReviewItem[]): string {
  if (!items.length) throw new Error('Add a comment first.')
  const seq = items[0]
  const lines = [
    `Comments on the ${info.appName} timeline of ${info.projectName || 'this project'}${info.file ? ` (${info.file})` : ''}, sequence "${seq.sequenceName}" (id ${seq.sequence}). Each one is a marker in the project now.`,
    ''
  ]
  items.forEach((c, i) => {
    const at = c.to > c.from ? `${c.inTimecode} to ${c.outTimecode}` : `at ${c.inTimecode}`
    const extra: string[] = []
    if (c.marker !== null) extra.push(`marker ${c.marker}`)
    else if (c.error) extra.push(`no marker: ${c.error}`)
    if (c.frameId) extra.push(`frame ${c.frameId}`)
    if (c.box) extra.push(`box x ${c.box.x}, y ${c.box.y}, ${c.box.width} by ${c.box.height}${c.frameWidth ? ` of ${c.frameWidth} by ${c.frameHeight}` : ''}`)
    lines.push(`${i + 1}. ${at}: ${c.text.replace(/\s+/g, ' ')}${extra.length ? ` (${extra.join(', ')})` : ''}`)
  })
  if (items.some((c) => c.frameId)) lines.push('', 'To see a frame, call review_frame_get with its id.')
  const data = {
    card: info.cardId,
    projectId: info.projectId,
    file: info.file,
    sequence: seq.sequence,
    comments: items.map((c) => ({
      marker: c.marker,
      in: c.inTimecode,
      out: c.outTimecode,
      fromSeconds: Math.round(c.from * 1000) / 1000,
      toSeconds: Math.round(c.to * 1000) / 1000,
      text: c.text,
      ...(c.frameId ? { frameId: c.frameId } : {}),
      ...(c.box ? { box: c.box } : {})
    }))
  }
  lines.push('', '```' + CRAFT_REVIEW_LANG, JSON.stringify(data), '```')
  return lines.join('\n')
}

// ---- what changed in a project between two looks at it ----

export interface FcClip {
  id: number
  track: string
  name: string
  start: number
  end: number
  sourceIn: number
  sourceOut: number
  speed: number
  enabled: boolean
  link: number | null
  effects: string[]
}

export interface FcMarker {
  id: number
  name: string
  comment: string
  start: number
  duration: number
}

export interface FcCaption {
  id: number
  text: string
  start: number
  end: number
}

export interface FcSequence {
  id: number
  name: string
  fps: Fps
  clips: FcClip[]
  markers: FcMarker[]
  // null when they weren't looked at (captions.list only covers the open sequence)
  captions: FcCaption[] | null
}

export interface FcSnapshot {
  kind: 'filmcraft'
  sequences: FcSequence[]
  // every sequence in the project by id, with its name, even the ones not looked into
  names: Record<string, string>
}

export interface GenericSnapshot {
  kind: 'generic'
  tree: unknown
}

export type ProjectSnapshot = FcSnapshot | GenericSnapshot

// the effects every clip has, not worth a line
const DEFAULT_EFFECTS = new Set(['volume', 'channel_volume', 'panner', 'motion', 'opacity', 'time_remapping', 'audio_levels'])

const asNum = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')

// sequence.inspect (and captions.list) as a snapshot sequence
export function fcSequenceFrom(seq: unknown, captions?: unknown): FcSequence | null {
  const s = seq as Record<string, unknown> | null
  if (!s || typeof s !== 'object' || typeof s.id !== 'number') return null
  const settings = (s.settings ?? {}) as Record<string, unknown>
  const fr = (settings.frame_rate ?? {}) as Record<string, unknown>
  const fps = { num: asNum(fr.num, 30) || 30, den: asNum(fr.den, 1) || 1 }
  const clips: FcClip[] = []
  for (const [kind, list] of [
    ['V', s.video],
    ['A', s.audio]
  ] as const) {
    if (!Array.isArray(list)) continue
    list.forEach((t, i) => {
      const items = (t as { items?: unknown }).items
      if (!Array.isArray(items)) return
      for (const raw of items) {
        const c = raw as Record<string, unknown>
        if (typeof c.clip !== 'number') continue
        const effects = Array.isArray(c.effects)
          ? c.effects.map((e) => asStr((e as { effect?: unknown }).effect)).filter((e) => e && !DEFAULT_EFFECTS.has(e))
          : []
        clips.push({
          id: c.clip,
          track: `${kind}${i + 1}`,
          name: asStr(c.name) || `clip ${c.clip}`,
          start: asNum(c.start),
          end: asNum(c.end),
          sourceIn: asNum(c.sourceIn),
          sourceOut: asNum(c.sourceOut),
          speed: asNum(c.speed, 1),
          enabled: c.enabled !== false,
          link: typeof c.link === 'number' ? c.link : null,
          effects
        })
      }
    })
  }
  const markers: FcMarker[] = Array.isArray(s.markers)
    ? s.markers
        .filter((m): m is Record<string, unknown> => !!m && typeof (m as { id?: unknown }).id === 'number')
        .map((m) => ({ id: m.id as number, name: asStr(m.name), comment: asStr(m.comment), start: asNum(m.start), duration: asNum(m.duration) }))
    : []
  let caps: FcCaption[] | null = null
  const tracks = (captions as { tracks?: unknown } | null)?.tracks
  if (Array.isArray(tracks)) {
    caps = []
    for (const t of tracks) {
      const list = (t as { captions?: unknown }).captions
      if (!Array.isArray(list)) continue
      for (const raw of list) {
        const c = raw as Record<string, unknown>
        if (typeof c.id === 'number') caps!.push({ id: c.id, text: asStr(c.text), start: asNum(c.start), end: asNum(c.end) })
      }
    }
  }
  return { id: s.id, name: asStr(s.name) || `sequence ${s.id}`, fps, clips, markers, captions: caps }
}

const secs = (ticks: number): string => {
  const s = Math.abs(toSeconds(ticks))
  return `${s < 10 ? Math.round(s * 10) / 10 : Math.round(s)} s`
}

const quote = (s: string, max = 60): string => `"${s.replace(/\s+/g, ' ').trim().slice(0, max)}${s.trim().length > max ? '...' : ''}"`

// the clips worth naming: picture clips, and sound clips that aren't the sound of a picture clip
function ownClips(seq: FcSequence): FcClip[] {
  const pictureLinks = new Set(seq.clips.filter((c) => c.track.startsWith('V') && c.link !== null).map((c) => c.link))
  return seq.clips.filter((c) => c.track.startsWith('V') || c.link === null || !pictureLinks.has(c.link))
}

function diffSequence(a: FcSequence, b: FcSequence, skipMarkers: ReadonlySet<number>): string[] {
  const out: string[] = []
  const tc = (ticks: number): string => timecode(toSeconds(ticks), b.fps)
  const before = new Map(ownClips(a).map((c) => [c.id, c]))
  const after = new Map(ownClips(b).map((c) => [c.id, c]))
  for (const [id, c] of after) {
    const o = before.get(id)
    if (!o) {
      out.push(`added clip ${id} ${quote(c.name, 40)} on ${c.track} at ${tc(c.start)} (${secs(c.end - c.start)})`)
      continue
    }
    const lenA = o.end - o.start
    const lenB = c.end - c.start
    const what = `clip ${id} ${quote(c.name, 40)}`
    if (o.track !== c.track) out.push(`moved ${what} from ${o.track} to ${c.track}`)
    if (lenA !== lenB) {
      const edge = o.start !== c.start || o.sourceIn !== c.sourceIn ? 'start' : 'end'
      out.push(`${lenB < lenA ? 'shortened' : 'lengthened'} ${what} by ${secs(lenB - lenA)} at its ${edge}, now ${tc(c.start)} to ${tc(c.end)}`)
    } else if (o.start !== c.start) out.push(`moved ${what} from ${tc(o.start)} to ${tc(c.start)}`)
    else if (o.sourceIn !== c.sourceIn) out.push(`slipped ${what} by ${secs(c.sourceIn - o.sourceIn)}`)
    if (o.speed !== c.speed) out.push(`changed the speed of ${what} to ${Math.round(c.speed * 100)}%`)
    if (o.enabled !== c.enabled) out.push(`${c.enabled ? 'enabled' : 'disabled'} ${what}`)
    for (const e of c.effects) if (!o.effects.includes(e)) out.push(`added effect ${e} to ${what}`)
    for (const e of o.effects) if (!c.effects.includes(e)) out.push(`removed effect ${e} from ${what}`)
  }
  for (const [id, o] of before) {
    if (!after.has(id)) out.push(`deleted clip ${id} ${quote(o.name, 40)} from ${o.track}, it was at ${tc(o.start)} (${secs(o.end - o.start)})`)
  }
  const mBefore = new Map(a.markers.map((m) => [m.id, m]))
  const mAfter = new Map(b.markers.map((m) => [m.id, m]))
  const markerWords = (m: FcMarker): string => `${quote(m.name || 'marker', 40)}${m.comment && m.comment !== m.name ? ` (${quote(m.comment)})` : ''}`
  for (const [id, m] of mAfter) {
    if (skipMarkers.has(id)) continue
    const o = mBefore.get(id)
    if (!o) out.push(`added marker ${id} ${markerWords(m)} at ${tc(m.start)}${m.duration > 0 ? ` to ${tc(m.start + m.duration)}` : ''}`)
    else if (o.name !== m.name || o.comment !== m.comment) out.push(`changed marker ${id} at ${tc(m.start)} to ${markerWords(m)}`)
    else if (o.start !== m.start || o.duration !== m.duration) out.push(`moved marker ${id} ${quote(m.name || 'marker', 40)} to ${tc(m.start)}`)
  }
  for (const [id, o] of mBefore) if (!mAfter.has(id) && !skipMarkers.has(id)) out.push(`removed marker ${id} ${quote(o.name || 'marker', 40)} at ${tc(o.start)}`)
  if (!a.captions || !b.captions) return out
  const cBefore = new Map(a.captions.map((c) => [c.id, c]))
  const cAfter = new Map(b.captions.map((c) => [c.id, c]))
  for (const [id, c] of cAfter) {
    const o = cBefore.get(id)
    if (!o) out.push(`added caption ${quote(c.text)} at ${tc(c.start)}`)
    else {
      if (o.text !== c.text) out.push(`changed the caption at ${tc(c.start)} from ${quote(o.text)} to ${quote(c.text)}`)
      if (o.start !== c.start || o.end !== c.end) out.push(`retimed the caption ${quote(c.text, 30)} to ${tc(c.start)} to ${tc(c.end)}`)
    }
  }
  for (const [id, o] of cBefore) if (!cAfter.has(id)) out.push(`deleted the caption ${quote(o.text)} at ${tc(o.start)}`)
  return out
}

export function diffFilmcraft(a: FcSnapshot, b: FcSnapshot, skipMarkers: ReadonlySet<number> = new Set()): string[] {
  const out: string[] = []
  for (const [id, name] of Object.entries(b.names)) {
    if (!(id in a.names)) out.push(`added sequence ${quote(name, 40)} (id ${id})`)
    else if (a.names[id] !== name) out.push(`renamed sequence ${quote(a.names[id], 40)} to ${quote(name, 40)}`)
  }
  for (const [id, name] of Object.entries(a.names)) if (!(id in b.names)) out.push(`deleted sequence ${quote(name, 40)} (id ${id})`)
  const before = new Map(a.sequences.map((s) => [s.id, s]))
  for (const s of b.sequences) {
    const o = before.get(s.id)
    if (!o) continue
    const lines = diffSequence(o, s, skipMarkers)
    if (lines.length) out.push(...lines.map((l) => (b.sequences.length > 1 ? `in ${quote(s.name, 40)}: ${l}` : l)))
  }
  return out
}

// ---- any other app: its doc_inspect tree, objects with ids matched up ----

const IGNORED_KEYS = new Set(['revision', 'dirty', 'at', 'modified', 'selection', 'selected', 'playhead', 'zoom', 'scroll', 'pan', 'cursor', 'focused', 'hover', 'viewport'])

interface Node {
  path: string
  label: string
  value: Record<string, unknown>
}

function labelOf(o: Record<string, unknown>, kind: string): string {
  const name = ['name', 'title', 'label', 'text'].map((k) => o[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined
  return `${kind} ${name ? quote(name, 40) : String(o.id)}`
}

function collect(v: unknown, kind: string, out: Map<string, Node>, depth = 0): void {
  if (depth > 12 || !v || typeof v !== 'object') return
  if (Array.isArray(v)) {
    for (const x of v) collect(x, kind, out, depth + 1)
    return
  }
  const o = v as Record<string, unknown>
  if (typeof o.id === 'number' || typeof o.id === 'string') {
    const k = `${kind}:${String(o.id)}`
    if (!out.has(k)) out.set(k, { path: k, label: labelOf(o, kind.replace(/s$/, '')), value: o })
  }
  for (const [key, x] of Object.entries(o)) if (!IGNORED_KEYS.has(key) && x && typeof x === 'object') collect(x, Array.isArray(x) ? key : kind, out, depth + 1)
}

const scalar = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v)

export function diffGeneric(a: GenericSnapshot, b: GenericSnapshot): string[] {
  const before = new Map<string, Node>()
  const after = new Map<string, Node>()
  collect(a.tree, 'item', before)
  collect(b.tree, 'item', after)
  const out: string[] = []
  for (const [k, n] of after) {
    const o = before.get(k)
    if (!o) {
      out.push(`added ${n.label}`)
      continue
    }
    const changed: string[] = []
    for (const key of new Set([...Object.keys(o.value), ...Object.keys(n.value)])) {
      if (IGNORED_KEYS.has(key)) continue
      const x = o.value[key]
      const y = n.value[key]
      if ((scalar(x) || scalar(y)) && x !== y) changed.push(typeof y === 'string' && typeof x === 'string' && key === 'text' ? `text to ${quote(y)}` : key)
    }
    if (changed.length) out.push(`changed ${changed.slice(0, 4).join(', ')} of ${n.label}`)
  }
  for (const [k, o] of before) if (!after.has(k)) out.push(`removed ${o.label}`)
  return out
}

export function diffSnapshots(a: ProjectSnapshot, b: ProjectSnapshot, skipMarkers?: ReadonlySet<number>): string[] {
  if (a.kind === 'filmcraft' && b.kind === 'filmcraft') return diffFilmcraft(a, b, skipMarkers)
  if (a.kind === 'generic' && b.kind === 'generic') return diffGeneric(a, b)
  return []
}

const MAX_LINES = 25

// one paragraph per app and file for the agent's next turn
export function describeChanges(appName: string, file: string | null, lines: string[]): string {
  if (!lines.length) return ''
  const shown = lines.slice(0, MAX_LINES)
  const more = lines.length - shown.length
  return `${appName}${file ? `, ${file}` : ''}: ${shown.join('; ')}${more > 0 ? `; and ${more} more change${more === 1 ? '' : 's'}` : ''}.`
}

// ---- one reply's edits are one undo group ----

// the first edit of a reply in an app's project makes the checkpoint, every edit after it in the
// same reply joins that group. two first edits at once share the one checkpoint
export class TurnGroups<T> {
  private groups = new Map<string, { value: Promise<T>; edits: number; turnId: string }>()

  static key(turnId: string, appId: string, projectId: string): string {
    return `${turnId}|${appId}|${projectId}`
  }

  // the group for this reply and app, made with start() the first time
  open(turnId: string, appId: string, projectId: string, start: () => Promise<T>): { value: Promise<T>; first: boolean } {
    const k = TurnGroups.key(turnId, appId, projectId)
    const have = this.groups.get(k)
    if (have) return { value: have.value, first: false }
    const value = start()
    this.groups.set(k, { value, edits: 0, turnId })
    // a failed start doesn't stick, the next edit tries again
    value.catch(() => {
      if (this.groups.get(k)?.value === value) this.groups.delete(k)
    })
    return { value, first: true }
  }

  get(turnId: string, appId: string, projectId: string): Promise<T> | null {
    return this.groups.get(TurnGroups.key(turnId, appId, projectId))?.value ?? null
  }

  edited(turnId: string, appId: string, projectId: string): number {
    const g = this.groups.get(TurnGroups.key(turnId, appId, projectId))
    if (!g) return 0
    g.edits += 1
    return g.edits
  }

  edits(turnId: string, appId: string, projectId: string): number {
    return this.groups.get(TurnGroups.key(turnId, appId, projectId))?.edits ?? 0
  }

  // the reply ended: its groups, gone from here
  close(turnId: string): { key: string; value: Promise<T>; edits: number }[] {
    const out: { key: string; value: Promise<T>; edits: number }[] = []
    for (const [k, g] of this.groups) {
      if (g.turnId !== turnId) continue
      out.push({ key: k, value: g.value, edits: g.edits })
      this.groups.delete(k)
    }
    return out
  }
}

// which of an app's edit risk tools change the project. exports, saves, renders, moving the
// playhead and looking things up don't, so they neither start an undo group nor count in it
const NOT_EDITS = /^(file\.(export|save|saveAll|saveCopy)|export\.|markers\.(exportCsv|go|filter|show)|captions\.(export|list|goTo|next|previous|show|hide|select)|playhead\.|sequence\.(open|inspect|close|goTo|render)|history\.list|project\.items|graphics\.(list|fonts|template\.list|template\.thumbnail)|jobs\.|media\.(status|findMissing)|perf\.|window\.|ui\.|tool\.)/

export function countsAsEdit(tool: string, args: Record<string, unknown>): boolean {
  if (/^(render|ui_(inspect|elements|screenshot)|.*_(inspect|list|get|export|save|preview)$)/.test(tool)) return false
  if (tool === 'command_run' || tool === 'command_batch') {
    const ids: string[] = []
    if (typeof args.id === 'string') ids.push(args.id)
    if (Array.isArray(args.steps)) for (const s of args.steps) if (s && typeof (s as { id?: unknown }).id === 'string') ids.push((s as { id: string }).id)
    return ids.some((id) => !NOT_EDITS.test(id))
  }
  return true
}
