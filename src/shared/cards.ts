import type { EmbedAlternatives, EmbedFocus, EmbedTurn } from './craft-embed'
import type { Transcription } from './speech'
import type { TakeDiff, TakeFeedback } from './take'
import type { BrandFileName, ProposedRule } from './brand-memory'
import type { MappedDip, SnapshotLabel } from './content-map'
import type { VisualAsset, VisualSearch } from './visuals'

// cards in the chat timeline that the agent's tools put there: a video to review, a suggestion,
// a cloud copy, a project's history. main keeps them per brand, the chat shows the ones of the
// open thread under the reply that made them. shared by main, preload and the ui

export const SUGGESTION_KINDS = ['edit', 'shot', 'title', 'thumbnail', 'caption', 'other'] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]

export const SUGGESTION_NAMES: Record<SuggestionKind, string> = {
  edit: 'Edit',
  shot: 'Shot',
  title: 'Title',
  thumbnail: 'Thumbnail',
  caption: 'Caption',
  other: 'Suggestion'
}

// a file in a project folder the card can show, already checked to be inside it
export interface ProjectFileRef {
  projectId: string
  // relative to the project folder, forward slashes
  file: string
  kind: 'video' | 'image' | 'audio'
}

interface CardBase {
  id: string
  brandId: string
  threadId: string | null
  // the reply that made it, null when it came from outside a reply
  messageId: string | null
  at: number
  updatedAt: number
}

export interface VideoCard extends CardBase {
  type: 'video'
  title: string
  media: ProjectFileRef
  // the part the agent wants you to look at, seconds
  from: number | null
  to: number | null
  note: string
  // made by a FilmCraft render or export, not by show_video
  auto: boolean
}

// what happened to an edit suggestion, set by the agent through card_update
export type EditState = 'proposed' | 'previewing' | 'applied' | 'failed' | 'undone'

export interface SuggestionAnswer {
  // accept, later, a custom action label, or reply
  choice: string
  text: string
  at: number
}

export interface SuggestionCard extends CardBase {
  type: 'suggestion'
  kind: SuggestionKind
  title: string
  body: string
  preview: (ProjectFileRef & { from: number | null; to: number | null }) | null
  actions: string[]
  answer: SuggestionAnswer | null
  // edits only
  edit: { state: EditState; note: string; checkpoint: string | null } | null
}

export interface StorageCard extends CardBase {
  type: 'storage'
  destination: string
  total: number
  copied: number
  verified: number
  archived: number
  status: 'running' | 'done' | 'failed'
  note: string
}

export interface HistoryEntry {
  commit: string
  message: string
  at: number
  files: string[]
}

export interface HistoryCard extends CardBase {
  type: 'history'
  projectId: string
  entries: HistoryEntry[]
  // tracked files with changes since the last checkpoint
  changed: string[]
  note: string
}

// a live Craft editor in the chat, see ./craft-embed. one per reply and app project: the agent
// posts it with craft_embed, and its edits in a reply show and update it on their own
export interface CraftEmbedCard extends CardBase {
  type: 'craft'
  appId: string
  appName: string
  projectId: string
  // the app's file, a name in the project folder. null for the newest of its type
  file: string | null
  focus: EmbedFocus | null
  note: string
  // this reply's edits in the app, null when it made none
  turn: EmbedTurn | null
  alternatives: EmbedAlternatives | null
  // shown because the agent edited, not because it called craft_embed
  auto: boolean
}

// heavy work for a Craft editor in the chat, done by the app's native engine in the background:
// an export of what the editor shows, or proxies for big footage so the editor plays it smoothly
export interface CraftJobCard extends CardBase {
  type: 'craft-job'
  appId: string
  appName: string
  projectId: string
  kind: 'export' | 'proxy'
  label: string
  // 0 to 1, null while it doesn't know yet
  progress: number | null
  state: 'running' | 'done' | 'failed'
  output: ProjectFileRef | null
  note: string
}

// a recording of the creator: from the composer's recorder or an OBS recording that stopped.
// main transcribes it (through the window's Whisper) and fills in cadence and the script diff
export interface TakeCard extends CardBase {
  type: 'take'
  projectId: string
  media: ProjectFileRef
  source: 'obs' | 'composer'
  title: string
  state: 'transcribing' | 'ready' | 'failed'
  error: string
  transcript: Transcription | null
  feedback: TakeFeedback | null
  // against the project's script, null when it has none
  diff: TakeDiff | null
}

// a script in the project folder, the card reads it live from the file
export interface ScriptCard extends CardBase {
  type: 'script'
  projectId: string
  // relative to the project folder, e.g. scripts/script.md
  file: string
  title: string
}

// a rule the agent proposes from the session's friction log: keep, edit or drop
export interface RuleCard extends CardBase {
  type: 'rule'
  rule: ProposedRule
  state: 'proposed' | 'kept' | 'dropped'
  // what got saved, can differ from the proposal when you edited it
  kept: string
}

// a brand file the agent drafted, e.g. voice.md from the intake: keep, edit or drop
export interface BrandFileCard extends CardBase {
  type: 'brand-file'
  file: BrandFileName
  content: string
  note: string
  state: 'proposed' | 'kept' | 'dropped'
}

// OBS in the chat: connection, preview, scenes, record and stop, recent takes
export interface ObsCard extends CardBase {
  type: 'obs'
  projectId: string | null
}

// the brand's content map in the chat: pillars, baselines and every past video against them.
// the card loads the map live, focus opens one video's retention curve
export interface ContentMapCard extends CardBase {
  type: 'content-map'
  note: string
  focus: string | null
}

export interface Learning {
  id: string
  text: string
  state: 'proposed' | 'kept' | 'dropped'
}

// after +48h and +7d: how a new video did against the baseline at the same age, where people
// left and what was said there. kept learnings go into brand/learnings.md
export interface PostMortemCard extends CardBase {
  type: 'post-mortem'
  videoId: string
  title: string
  stage: Extract<SnapshotLabel, '48h' | '7d'>
  // views at this age over the median of earlier videos at the same age
  ratio: number | null
  views: number | null
  at30: number | null
  dips: MappedDip[]
  summary: string
  learnings: Learning[]
}

// options found online, from the agent's find_visuals: a grid to pick from
export interface VisualsCard extends CardBase {
  type: 'visuals'
  search: VisualSearch
  note: string
}

// one image in the chat: pasted, dropped from a browser, or a sketch. the file stays in TrendDeck's
// visuals folder until it's added to the video files
export interface VisualCard extends CardBase {
  type: 'visual'
  asset: VisualAsset
}

export type ChatCard =
  | VisualsCard
  | VisualCard
  | VideoCard
  | SuggestionCard
  | StorageCard
  | HistoryCard
  | CraftEmbedCard
  | TakeCard
  | ScriptCard
  | RuleCard
  | BrandFileCard
  | ObsCard
  | ContentMapCard
  | PostMortemCard
  | CraftJobCard

export interface CardsChanged {
  brandId: string
  card: ChatCard
}

// the frame you drew on, kept in main so the agent can look at it with review_frame_get
export interface ReviewFrameInput {
  // data:image/png;base64,...
  dataUrl: string
  timeSeconds: number
  width: number
  height: number
  box: ReviewBox | null
}

export interface ReviewBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ReviewComment {
  from: number
  // equal to from for a single frame
  to: number
  text: string
  // set once the frame is saved in main
  frameId?: string
  box?: ReviewBox | null
  frameWidth?: number
  frameHeight?: number
}

export interface ReviewFeedback {
  cardId: string
  projectId: string
  file: string
  comments: ReviewComment[]
}

export interface CardsApi {
  list(brandId: string, threadId: string): Promise<ChatCard[]>
  // the user's pick on a suggestion card, the chat sends it on to the agent
  answer(brandId: string, cardId: string, answer: { choice: string; text: string }): Promise<ChatCard | null>
  saveFrame(brandId: string, cardId: string, frame: ReviewFrameInput): Promise<string>
  // copies the project's editor files aside before an edit is applied, returns the checkpoint id
  checkpoint(brandId: string, cardId: string): Promise<string | null>
  restoreCheckpoint(brandId: string, cardId: string): Promise<{ ok: boolean; note: string }>
  // a media library file copied into the project folder, returns its project relative path
  addToProject(brandId: string, projectId: string, mediaId: string): Promise<string>
  // td-media://project/... for a file in a project folder
  projectFileUrl(brandId: string, ref: ProjectFileRef): string
  history(brandId: string, projectId: string): Promise<HistoryCard | null>
  saveCheckpoint(brandId: string, projectId: string, message: string): Promise<HistoryCard | null>
  commitDiff(brandId: string, projectId: string, commit: string): Promise<string>
  restoreCommit(brandId: string, projectId: string, commit: string): Promise<HistoryCard | null>
  onChanged(fn: (c: CardsChanged) => void): () => void
}

declare global {
  interface Window {
    trenddeckCards: CardsApi
  }
}

// ---- the review feedback the chat sends to the agent. pure, unit tested ----

export const REVIEW_LANG = 'trenddeck-review'

export function reviewTime(seconds: number): string {
  const ms = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor(ms / 60_000) % 60
  const s = Math.floor(ms / 1000) % 60
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000

function cleanBox(b: unknown, w?: number, h?: number): ReviewBox | null {
  const r = b as Partial<ReviewBox> | null
  if (!r) return null
  const vals = [r.x, r.y, r.width, r.height]
  if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  const box = { x: Math.max(0, Math.round(r.x!)), y: Math.max(0, Math.round(r.y!)), width: Math.round(r.width!), height: Math.round(r.height!) }
  if (box.width < 1 || box.height < 1) return null
  if (w && box.x + box.width > w) box.width = Math.max(1, w - box.x)
  if (h && box.y + box.height > h) box.height = Math.max(1, h - box.y)
  return box
}

// drops broken comments, orders the ends, clamps to the video's length
export function cleanComments(raw: unknown, duration = Infinity): ReviewComment[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewComment[] = []
  for (const c of raw.slice(0, 50)) {
    const r = c as Partial<ReviewComment> | null
    if (!r || typeof r.text !== 'string' || !r.text.trim()) continue
    if (typeof r.from !== 'number' || !Number.isFinite(r.from)) continue
    const to = typeof r.to === 'number' && Number.isFinite(r.to) ? r.to : r.from
    const max = Number.isFinite(duration) && duration > 0 ? duration : Infinity
    const a = Math.min(max, Math.max(0, Math.min(r.from, to)))
    const b = Math.min(max, Math.max(0, Math.max(r.from, to)))
    const item: ReviewComment = { from: round3(a), to: round3(b), text: r.text.trim().slice(0, 2000) }
    if (typeof r.frameId === 'string' && /^[a-z0-9-]{1,64}$/i.test(r.frameId)) item.frameId = r.frameId
    const w = typeof r.frameWidth === 'number' && r.frameWidth > 0 ? Math.round(r.frameWidth) : undefined
    const h = typeof r.frameHeight === 'number' && r.frameHeight > 0 ? Math.round(r.frameHeight) : undefined
    const box = cleanBox(r.box, w, h)
    if (box) item.box = box
    if (w && h) {
      item.frameWidth = w
      item.frameHeight = h
    }
    out.push(item)
  }
  return out.sort((x, y) => x.from - y.from || x.to - y.to)
}

const span = (c: ReviewComment): string => (c.to > c.from ? `${reviewTime(c.from)} to ${reviewTime(c.to)}` : `at ${reviewTime(c.from)}`)

// a readable list for the agent and the chat, then the same thing as json so it can't be misread
export function formatReview(f: ReviewFeedback, projectName = ''): string {
  const comments = cleanComments(f.comments)
  if (!comments.length) throw new Error('Add a comment first.')
  const lines = [`Review of ${f.file}${projectName ? ` in ${projectName}` : ''}`, '']
  comments.forEach((c, i) => {
    const extra: string[] = []
    if (c.frameId) extra.push(`frame ${c.frameId}`)
    if (c.box) extra.push(`box x ${c.box.x}, y ${c.box.y}, ${c.box.width} by ${c.box.height}${c.frameWidth ? ` of ${c.frameWidth} by ${c.frameHeight}` : ''}`)
    lines.push(`${i + 1}. ${span(c)}: ${c.text.replace(/\s+/g, ' ')}${extra.length ? ` (${extra.join(', ')})` : ''}`)
  })
  if (comments.some((c) => c.frameId)) lines.push('', 'To see a frame, call review_frame_get with its id.')
  const data = { card: f.cardId, projectId: f.projectId, file: f.file, comments }
  lines.push('', '```' + REVIEW_LANG, JSON.stringify(data), '```')
  return lines.join('\n')
}

// reads the json part back, null when the text has none or it's broken
export function parseReview(text: string): ReviewFeedback | null {
  const m = new RegExp('```' + REVIEW_LANG + '\\n([\\s\\S]*?)\\n```').exec(text)
  if (!m) return null
  try {
    const j = JSON.parse(m[1]) as Record<string, unknown>
    if (typeof j.card !== 'string' || typeof j.file !== 'string' || typeof j.projectId !== 'string') return null
    const comments = cleanComments(j.comments)
    return comments.length ? { cardId: j.card, projectId: j.projectId, file: j.file, comments } : null
  } catch {
    return null
  }
}

// what a suggestion card's answer says to the agent
export function formatAnswer(card: Pick<SuggestionCard, 'id' | 'title' | 'kind'>, answer: { choice: string; text: string }): string {
  const what = `your ${SUGGESTION_NAMES[card.kind].toLowerCase()} suggestion "${card.title}" (card ${card.id})`
  const note = answer.text.trim() ? `\n\n${answer.text.trim()}` : ''
  switch (answer.choice) {
    case 'accept':
      return `Yes to ${what}. Go ahead.${note}`
    case 'later':
      return `Not now for ${what}. Keep going without it.${note}`
    case 'reply':
      return `About ${what}:${note || ' (no text)'}`
    case 'preview':
      return `Show me a preview of ${what} before changing anything. Render it and show it with show_video, then update the card with card_update state previewing.${note}`
    case 'apply':
      return `Apply ${what}. TrendDeck saved a checkpoint of the project's editor files first. When it's done, call card_update with state applied, or failed with what went wrong.${note}`
    case 'undo':
      return `Undo ${what}. Use the editor's own undo if it can, otherwise tell me and I'll restore the checkpoint from the card. Then call card_update with state undone.${note}`
    default:
      return `For ${what} I picked "${answer.choice}".${note}`
  }
}
