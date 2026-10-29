import type { DraftCheck } from './cadence'
import type { SpokenWord, Transcription } from './speech'
import { isFiller, normWord, tokens } from './words'

// talk-first scripts. the creator talks the video through, the agent builds beats that quote
// their own lines word for word (marked as theirs) and fills gaps with suggestions (marked as
// the agent's). any line can be spoken again to replace it. the script is markdown in the
// project folder so it reads fine on its own and git keeps its history. pure, unit tested

export type LineOrigin = 'spoken' | 'agent' | 'typed'

export const ORIGIN_TAGS: Record<LineOrigin, string> = { spoken: 'you', agent: 'suggestion', typed: 'typed' }

export interface ScriptLine {
  id: string
  text: string
  origin: LineOrigin
  // for spoken lines: the dump it was said in and where, seconds
  dump: string | null
  at: number | null
}

export interface ScriptBeat {
  title: string
  lines: ScriptLine[]
}

export type ClaimKind = 'stat' | 'quote' | 'fact'
export type ClaimStatus = 'unchecked' | 'checking' | 'sourced' | 'wrong' | 'unverifiable'

export interface Claim {
  id: string
  lineId: string
  kind: ClaimKind
  text: string
  status: ClaimStatus
  sourceUrl: string
  note: string
}

export interface Script {
  title: string
  status: 'draft' | 'ready'
  beats: ScriptBeat[]
}

// a brain dump: what the creator said with word times, saved in the project's scripts\dumps\
export interface Dump {
  id: string
  at: number
  text: string
  words: SpokenWord[]
  duration: number
  // the recording, a wav in the project folder (scripts/dumps/<id>.wav). missing on dumps from
  // before audio was kept
  audio?: string
  // its sample rate: 48 kHz without call filters for the voiceover, 16 kHz on older dumps
  rate?: number
}

// 16-bit mono wav of float samples, for the dictation recordings
export function wavBytes(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const v = new DataView(out.buffer)
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  text(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  text(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}

let counter = 0
export function lineId(): string {
  counter = (counter + 1) % 1296
  return `${Date.now().toString(36).slice(-5)}${counter.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 5)}`
}

export function allLines(s: Script): ScriptLine[] {
  return s.beats.flatMap((b) => b.lines)
}

// ---------- markdown ----------

const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim()

export function toMarkdown(s: Script): string {
  const out = ['---', `title: ${oneLine(s.title)}`, `status: ${s.status}`, '---', '', `# ${oneLine(s.title)}`, '']
  out.push('Lines marked [you] are your own words from dictation. [suggestion] lines were written by the agent. [typed] lines you typed.', '')
  for (const b of s.beats) {
    out.push(`## ${oneLine(b.title) || 'Beat'}`, '')
    for (const l of b.lines) {
      const meta = [`id:${l.id}`]
      if (l.dump) meta.push(`dump:${l.dump}`)
      if (l.at !== null) meta.push(`at:${l.at}`)
      out.push(`- [${ORIGIN_TAGS[l.origin]}] ${oneLine(l.text)} <!-- ${meta.join(' ')} -->`)
    }
    out.push('')
  }
  return out.join('\n')
}

const TAG_ORIGIN: Record<string, LineOrigin> = { you: 'spoken', suggestion: 'agent', typed: 'typed', agent: 'agent', spoken: 'spoken' }

// reads a script back. lines someone added by hand without a tag count as typed
export function parseMarkdown(md: string): Script {
  const script: Script = { title: 'Script', status: 'draft', beats: [] }
  const text = md.replace(/\r\n/g, '\n')
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)
  let body = text
  if (front) {
    body = text.slice(front[0].length)
    for (const row of front[1].split('\n')) {
      const m = /^(\w+):\s*(.*)$/.exec(row)
      if (!m) continue
      if (m[1] === 'title' && m[2].trim()) script.title = m[2].trim()
      if (m[1] === 'status') script.status = m[2].trim() === 'ready' ? 'ready' : 'draft'
    }
  }
  let beat: ScriptBeat | null = null
  const seen = new Set<string>()
  for (const raw of body.split('\n')) {
    const row = raw.trim()
    if (!row) continue
    const h1 = /^#\s+(.+)$/.exec(row)
    if (h1) {
      if (!front) script.title = h1[1].trim()
      continue
    }
    const h2 = /^##\s+(.+)$/.exec(row)
    if (h2) {
      beat = { title: h2[1].trim(), lines: [] }
      script.beats.push(beat)
      continue
    }
    const item = /^[-*]\s+(?:\[(\w+)\]\s*)?(.*?)\s*(?:<!--\s*(.*?)\s*-->)?$/.exec(row)
    if (!item || !item[2].trim()) continue
    const meta: Record<string, string> = {}
    for (const pair of (item[3] ?? '').split(/\s+/)) {
      const i = pair.indexOf(':')
      if (i > 0) meta[pair.slice(0, i)] = pair.slice(i + 1)
    }
    let id = /^[a-z0-9]{4,24}$/i.test(meta.id ?? '') ? meta.id : lineId()
    if (seen.has(id)) id = lineId()
    seen.add(id)
    const origin = TAG_ORIGIN[(item[1] ?? '').toLowerCase()] ?? 'typed'
    const at = meta.at !== undefined && Number.isFinite(Number(meta.at)) ? Number(meta.at) : null
    if (!beat) {
      beat = { title: 'Script', lines: [] }
      script.beats.push(beat)
    }
    beat.lines.push({ id, text: item[2].trim(), origin, dump: origin === 'spoken' && meta.dump ? meta.dump : null, at: origin === 'spoken' ? at : null })
  }
  return script
}

// ---------- quoting the creator ----------

// filler words don't count against a quote, the agent may leave them out
const quoteTokens = (text: string): string[] => tokens(text).filter((t) => !isFiller(t))

function editDistance(a: string[], b: string[]): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

export interface QuoteMatch {
  dump: string
  // seconds into the dump where the quote starts, null when it has no word times
  at: number | null
  // 0 is word for word
  edits: number
}

// where in the creator's dumps a line was said. a line counts as theirs when its words appear
// in order with at most one word in ten different (capitalization, punctuation and filler words
// never count). anything looser is the agent's wording and has to be marked as a suggestion
export function findQuote(text: string, dumps: Pick<Dump, 'id' | 'text' | 'words'>[]): QuoteMatch | null {
  const want = quoteTokens(text)
  if (!want.length) return null
  const allowed = Math.floor(want.length / 10)
  let best: QuoteMatch | null = null
  for (const d of dumps) {
    // the dump's words with their times when there are some, its text otherwise
    const timed = d.words.length ? d.words.map((w) => ({ t: normWord(w.text), at: w.start })).filter((w) => w.t && !isFiller(w.t)) : quoteTokens(d.text).map((t) => ({ t, at: null as number | null }))
    const hay = timed.map((w) => w.t)
    for (let len = Math.max(1, want.length - allowed); len <= want.length + allowed; len++) {
      for (let i = 0; i + len <= hay.length; i++) {
        if (allowed === 0 && hay[i] !== want[0]) continue
        const e = editDistance(want, hay.slice(i, i + len))
        if (e <= allowed && (!best || e < best.edits)) {
          best = { dump: d.id, at: timed[i].at === null ? null : Math.round(timed[i].at! * 100) / 100, edits: e }
          if (e === 0) return best
        }
      }
    }
  }
  return best
}

// ---------- writing and changing a script ----------

export interface LineInput {
  text: string
  // what the agent says it is. spoken lines are checked against the dumps
  origin: 'spoken' | 'suggestion'
}

export interface BeatInput {
  title: string
  lines: LineInput[]
}

export interface WriteResult {
  script: Script
  // lines the agent marked spoken that aren't in the creator's words, saved as suggestions
  downgraded: string[]
}

// a whole new version from the agent. lines with the same words as before keep their id (and
// with it their claims), spoken ones are checked, and a spoken line the creator said again
// stays theirs
export function writeScript(title: string, beats: BeatInput[], dumps: Dump[], previous: Script | null): WriteResult {
  const old = previous ? allLines(previous) : []
  const used = new Set<string>()
  const downgraded: string[] = []
  const reuse = (text: string): ScriptLine | undefined => {
    const key = quoteTokens(text).join(' ')
    const hit = old.find((l) => !used.has(l.id) && quoteTokens(l.text).join(' ') === key)
    if (hit) used.add(hit.id)
    return hit
  }
  const script: Script = {
    title: oneLine(title) || previous?.title || 'Script',
    status: 'draft',
    beats: beats.map((b) => ({
      title: oneLine(b.title) || 'Beat',
      lines: b.lines
        .filter((l) => oneLine(l.text))
        .map((l): ScriptLine => {
          const text = oneLine(l.text)
          const before = reuse(text)
          const id = before?.id ?? lineId()
          // the creator's own line or typed line stays as it was marked
          if (before && (before.origin === 'spoken' || before.origin === 'typed')) return { ...before, text }
          if (l.origin === 'spoken') {
            const q = findQuote(text, dumps)
            if (q) return { id, text, origin: 'spoken', dump: q.dump, at: q.at }
            downgraded.push(text)
          }
          return { id, text, origin: 'agent', dump: null, at: null }
        })
    }))
  }
  return { script, downgraded }
}

export type LineChange =
  | { type: 'respeak'; lineId: string; text: string; dump: string | null; at: number | null }
  | { type: 'type'; lineId: string; text: string }
  | { type: 'remove'; lineId: string }

export interface ChangeResult {
  script: Script
  before: ScriptLine | null
}

// a change the creator made on the script card
export function changeLine(s: Script, c: LineChange): ChangeResult {
  let before: ScriptLine | null = null
  const beats = s.beats.map((b) => ({
    ...b,
    lines: b.lines.flatMap((l): ScriptLine[] => {
      if (l.id !== c.lineId) return [l]
      before = l
      if (c.type === 'remove') return []
      const text = oneLine(c.text)
      if (!text) return [l]
      return c.type === 'respeak' ? [{ id: l.id, text, origin: 'spoken', dump: c.dump, at: c.at }] : [{ id: l.id, text, origin: 'typed', dump: null, at: null }]
    })
  }))
  return { script: { ...s, status: 'draft', beats }, before }
}

// ---------- claims ----------

const CLAIM_KINDS: ClaimKind[] = ['stat', 'quote', 'fact']
const CLAIM_STATUSES: ClaimStatus[] = ['unchecked', 'checking', 'sourced', 'wrong', 'unverifiable']

export function cleanClaims(raw: unknown, lineIds: Set<string>): Claim[] {
  if (!Array.isArray(raw)) return []
  const out: Claim[] = []
  for (const c of raw.slice(0, 200)) {
    const x = (c ?? {}) as Partial<Claim>
    if (typeof x.id !== 'string' || typeof x.lineId !== 'string' || !lineIds.has(x.lineId) || typeof x.text !== 'string' || !x.text.trim()) continue
    out.push({
      id: x.id,
      lineId: x.lineId,
      kind: CLAIM_KINDS.includes(x.kind as ClaimKind) ? (x.kind as ClaimKind) : 'fact',
      text: oneLine(x.text).slice(0, 500),
      status: CLAIM_STATUSES.includes(x.status as ClaimStatus) ? (x.status as ClaimStatus) : 'unchecked',
      sourceUrl: typeof x.sourceUrl === 'string' && /^https?:\/\//i.test(x.sourceUrl) ? x.sourceUrl.slice(0, 1000) : '',
      note: typeof x.note === 'string' ? oneLine(x.note).slice(0, 500) : ''
    })
  }
  return out
}

// what stands between the script and recording it: stats and quotes need a source, and
// nothing may be marked wrong. plain facts that couldn't be checked only get a warning
export function readiness(s: Script, claims: Claim[]): { ready: boolean; blocking: Claim[]; warnings: Claim[] } {
  const ids = new Set(allLines(s).map((l) => l.id))
  const live = claims.filter((c) => ids.has(c.lineId))
  const blocking = live.filter((c) => c.status === 'wrong' || ((c.kind === 'stat' || c.kind === 'quote') && c.status !== 'sourced'))
  const warnings = live.filter((c) => !blocking.includes(c) && c.status !== 'sourced')
  return { ready: allLines(s).length > 0 && blocking.length === 0, blocking, warnings }
}

// the script as the agent reads it: numbered lines with ids and who wrote them
export function scriptText(s: Script, claims: Claim[] = []): string {
  const out = [`# ${s.title} (${s.status})`]
  for (const b of s.beats) {
    out.push('', `## ${b.title}`)
    for (const l of b.lines) {
      const cs = claims.filter((c) => c.lineId === l.id)
      out.push(`- ${l.id} [${ORIGIN_TAGS[l.origin]}] ${l.text}${cs.length ? `  (claims: ${cs.map((c) => `${c.id} ${c.kind} ${c.status}`).join('; ')})` : ''}`)
    }
  }
  return out.join('\n')
}

// what the script card shows
export interface ScriptView {
  file: string
  script: Script
  claims: Claim[]
  check: DraftCheck
  ready: { ready: boolean; blocking: Claim[]; warnings: Claim[] }
}

export interface ScriptsChanged {
  brandId: string
  projectId: string
  file: string
}

// window.trenddeckScripts
export interface ScriptsApi {
  get(brandId: string, projectId: string, file?: string): Promise<ScriptView | null>
  change(brandId: string, projectId: string, file: string, change: LineChange): Promise<ScriptView | null>
  setStatus(brandId: string, projectId: string, file: string, status: 'draft' | 'ready'): Promise<ScriptView | null>
  // a dictation that went to the agent, saved with its word times in the project
  // audio: the dictation as 16 kHz mono samples, saved as a wav next to it
  saveDump(brandId: string, projectId: string, t: Pick<Transcription, 'text' | 'words' | 'duration'>, audio?: Float32Array, hifi?: { rate: number; pcm: Float32Array }): Promise<{ id: string; words: number; audio: string | null }>
  // speech outside a project, only for the cadence profile
  addSpeech(brandId: string, t: Pick<Transcription, 'text' | 'words' | 'duration'>): Promise<void>
  show(brandId: string, projectId: string, threadId: string | null): Promise<string>
  onChanged(fn: (c: ScriptsChanged) => void): () => void
}

declare global {
  interface Window {
    trenddeckScripts: ScriptsApi
  }
}
