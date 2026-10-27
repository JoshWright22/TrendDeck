import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  BRAND_FILES,
  BRAND_FILE_TITLES,
  RULE_KINDS,
  RULE_TEXT_MAX,
  type BrandMemoryState,
  type FrictionEvent,
  type FrictionKind
} from '@shared/brand-memory'
import type { BrandFileCard, RuleCard } from '@shared/cards'
import { addSample, analyzeWords, profileText, summarize, type CadenceProfile } from '@shared/cadence'
import type { SpokenWord } from '@shared/speech'
import { ID_PATTERN } from '@shared/types'
import { addCard, changeCard, getCard, newCardId } from '../cards/store'
import { addRule } from '../context/rules'
import { changeContext, changed as contextChanged } from '../context/store'
import { projectsRoot } from '../craft/paths'
import { safeName } from '../craft/rules'
import { brandOf } from '../gateway/tools/common'
import { ToolError, type GatewayTool, type Turn } from '../gateway/types'
import { broadcast } from '../gateway/wait'
import { list, obj, oneOf, str } from '../gateway/validate'
import { initRepository, saveCheckpoint, serialize } from '../production-storage/git'
import { getData } from '../store'
import { isBrandFile, memoryBlock, readBrandFile, readCadence, writeBrandFile, writeCadence, writeKeptRule, appendLearningLine, MAX_BRAND_FILE } from './files'
import { cleanProposal, frictionText, newEvent, parseFriction, rulesLeft, wrapUpPrompt } from './rules'

// brand memory that grows with the brand: every undo, turned down suggestion, re-spoken line
// and edit to an agent's line goes in a friction log (JSONL per brand). at the end of a work
// session the agent reads it and proposes at most three rules as cards; kept rules go into the
// style memory (main/context) and into git-versioned files in Documents\TrendDeck\<brand>\brand\

interface MemoryState {
  lastWrapUpAt: number | null
  // rule cards made since the last wrap-up started
  proposed: number
  lastDigestAt: number | null
  intakeDone: boolean
}

const userDir = (brandId: string): string => join(app.getPath('userData'), 'brand-memory', checkId(brandId))

function checkId(brandId: string): string {
  if (!ID_PATTERN.test(brandId)) throw new Error('bad brand id')
  return brandId
}

function brandName(brandId: string): string {
  const b = getData()?.brands.find((x) => x.id === brandId)
  if (!b) throw new Error('no brand with that id')
  return b.name
}

// Documents\TrendDeck\<brand>\brand
export function brandFolder(brandId: string): string {
  return join(projectsRoot(), safeName(brandName(brandId), 'Brand'), 'brand')
}

// one change at a time per brand
const queues = new Map<string, Promise<unknown>>()
function serial<T>(brandId: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(brandId) ?? Promise.resolve()).then(fn, fn)
  queues.set(brandId, next.catch(() => {}))
  return next
}

async function loadState(brandId: string): Promise<MemoryState> {
  try {
    const raw = JSON.parse(await fs.readFile(join(userDir(brandId), 'state.json'), 'utf8')) as Partial<MemoryState>
    const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    return { lastWrapUpAt: n(raw.lastWrapUpAt), proposed: n(raw.proposed) ?? 0, lastDigestAt: n(raw.lastDigestAt), intakeDone: raw.intakeDone === true }
  } catch {
    return { lastWrapUpAt: null, proposed: 0, lastDigestAt: null, intakeDone: false }
  }
}

async function saveState(brandId: string, s: MemoryState): Promise<void> {
  const dir = userDir(brandId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'state.json.tmp'), JSON.stringify(s), 'utf8')
  await fs.rename(join(dir, 'state.json.tmp'), join(dir, 'state.json'))
}

const changeState = (brandId: string, fn: (s: MemoryState) => void): Promise<MemoryState> =>
  serial(brandId, async () => {
    const s = await loadState(brandId)
    fn(s)
    await saveState(brandId, s)
    return s
  })

// ---------- friction log ----------

export function logFriction(
  brandId: string,
  e: { kind: FrictionKind; projectId?: string | null; before?: string; after?: string; ref?: string; note?: string }
): Promise<FrictionEvent | null> {
  if (!ID_PATTERN.test(brandId)) return Promise.resolve(null)
  return serial(brandId, async () => {
    const event = newEvent({ kind: e.kind, projectId: e.projectId ?? null, before: e.before ?? '', after: e.after ?? '', ref: e.ref ?? '', note: e.note ?? '' })
    const dir = userDir(brandId)
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(join(dir, 'friction.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
    broadcast('brand-memory:changed', brandId)
    return event
  }).catch((err) => {
    console.error('brand memory: logging failed', err)
    return null
  })
}

export async function frictionSince(brandId: string, since: number | null): Promise<FrictionEvent[]> {
  let text = ''
  try {
    text = await fs.readFile(join(userDir(brandId), 'friction.jsonl'), 'utf8')
  } catch {
    return []
  }
  return parseFriction(text).filter((e) => since === null || e.at > since)
}

// ---------- brand files and git ----------

// commits the brand folder's text files, a missing git only costs the history
async function commitBrand(brandId: string, message: string): Promise<void> {
  const dir = brandFolder(brandId)
  try {
    await serialize(dir, async () => {
      await initRepository(dir)
      await saveCheckpoint(dir, message.slice(0, 200))
    })
  } catch (err) {
    console.error('brand memory: commit failed', err instanceof Error ? err.message : err)
  }
}

export async function readCadenceProfile(brandId: string): Promise<CadenceProfile> {
  return readCadence(brandFolder(brandId))
}

// every dictation and take with word times teaches the brand's cadence profile
export function addSpeech(brandId: string, words: SpokenWord[]): Promise<void> {
  if (words.length < 3) return Promise.resolve()
  return serial(brandId, async () => {
    const dir = brandFolder(brandId)
    await writeCadence(dir, addSample(await readCadence(dir), analyzeWords(words)))
  }).catch((err) => console.error('brand memory: cadence failed', err))
}

// what goes into every turn after the style rules: positioning, the voice guide and how the
// creator talks, capped
export async function brandMemoryContext(brandId: string, maxChars = 3000): Promise<string> {
  try {
    const dir = brandFolder(brandId)
    const [positioning, voice, cadence] = await Promise.all([readBrandFile(dir, 'positioning.md'), readBrandFile(dir, 'voice.md'), readCadence(dir)])
    return memoryBlock({ 'positioning.md': positioning, 'voice.md': voice }, profileText(cadence), maxChars)
  } catch {
    return ''
  }
}

export async function memoryState(brandId: string): Promise<BrandMemoryState> {
  const dir = brandFolder(brandId)
  const s = await loadState(brandId)
  const files: BrandMemoryState['files'] = []
  for (const f of BRAND_FILES) {
    const st = await fs.stat(join(dir, f)).catch(() => null)
    if (st?.isFile()) files.push({ file: f, chars: st.size, modified: st.mtimeMs })
  }
  const cadence = await readCadence(dir)
  return {
    pending: (await frictionSince(brandId, s.lastWrapUpAt)).length,
    lastWrapUpAt: s.lastWrapUpAt,
    files,
    folder: dir,
    hasCadence: cadence.words >= 60,
    intakeDone: s.intakeDone || files.some((f) => f.file === 'voice.md')
  }
}

// a learning the creator confirmed elsewhere, e.g. from a post-mortem card: one dated line in
// brand/learnings.md, committed to the brand folder's history
export async function addLearning(brandId: string, text: string): Promise<void> {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('The learning is empty.')
  await serial(brandId, () => appendLearningLine(brandFolder(brandId), brandName(brandId), Date.now(), clean.slice(0, 600)))
  await commitBrand(brandId, `learning: ${clean}`)
  broadcast('brand-memory:changed', brandId)
}

// ---------- weekly digest hook ----------

// a weekly brand digest card (open videos, stalled stages, the guide's changes) isn't built yet.
// this checks once a day and tells whoever registered that one is due, with the week's data
export interface DigestData {
  brandId: string
  since: number
  friction: FrictionEvent[]
  keptRules: number
}
const digestHandlers: ((d: DigestData) => void | Promise<void>)[] = []
export function onDigestDue(fn: (d: DigestData) => void | Promise<void>): void {
  digestHandlers.push(fn)
}
const WEEK = 7 * 24 * 3600_000
async function checkDigests(): Promise<void> {
  if (!digestHandlers.length) return
  for (const b of getData()?.brands ?? []) {
    const s = await loadState(b.id)
    const since = s.lastDigestAt ?? Date.now() - WEEK
    if (s.lastDigestAt !== null && Date.now() - s.lastDigestAt < WEEK) continue
    const friction = await frictionSince(b.id, since)
    const data: DigestData = { brandId: b.id, since, friction, keptRules: friction.filter((e) => e.kind === 'edited-rule').length }
    await changeState(b.id, (x) => void (x.lastDigestAt = Date.now()))
    for (const fn of digestHandlers) await Promise.resolve(fn(data)).catch(() => {})
  }
}

// ---------- cards ----------

const base = (turn: Turn) => {
  const now = Date.now()
  return { id: newCardId(), brandId: turn.brandId, threadId: turn.threadId, messageId: turn.messageId ?? null, at: now, updatedAt: now }
}

async function keepRule(brandId: string, cardId: string, text: string): Promise<RuleCard> {
  const card = await getCard(brandId, cardId)
  if (!card || card.type !== 'rule') throw new Error('That rule card is gone.')
  if (card.state !== 'proposed') throw new Error('This rule was already decided.')
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean || clean.length > RULE_TEXT_MAX) throw new Error(`Keep a rule between 1 and ${RULE_TEXT_MAX} characters.`)
  const edited = clean !== card.rule.text
  // the existing style memory first, so it reaches the agent every turn
  const why = `Kept from a wrap-up. ${card.rule.why}`.trim()
  const saved = await changeContext<string | null>(brandId, (f) => {
    const r = addRule(f.rules, clean, 'agent', { why })
    return r.ok ? { file: { ...f, rules: r.rules }, out: null } : { file: f, out: r.error }
  })
  if (saved && !/already saved/.test(saved)) throw new Error(saved)
  contextChanged(brandId)
  const at = Date.now()
  await writeKeptRule(brandFolder(brandId), brandName(brandId), clean, card.rule.kind, { at, cardId, evidence: card.rule.evidence, examples: card.rule.examples, edited })
  if (edited) await logFriction(brandId, { kind: 'edited-rule', before: card.rule.text, after: clean, ref: cardId })
  await commitBrand(brandId, `kept rule: ${clean}`)
  const out = await changeCard(brandId, cardId, (c) => {
    if (c.type !== 'rule') return
    c.state = 'kept'
    c.kept = clean
  })
  return out as RuleCard
}

async function dropRule(brandId: string, cardId: string): Promise<RuleCard> {
  const card = await getCard(brandId, cardId)
  if (!card || card.type !== 'rule') throw new Error('That rule card is gone.')
  if (card.state !== 'proposed') return card
  await logFriction(brandId, { kind: 'dropped-rule', before: card.rule.text, ref: cardId })
  return (await changeCard(brandId, cardId, (c) => {
    if (c.type === 'rule') c.state = 'dropped'
  })) as RuleCard
}

async function keepFile(brandId: string, cardId: string, content: string): Promise<BrandFileCard> {
  const card = await getCard(brandId, cardId)
  if (!card || card.type !== 'brand-file') throw new Error('That card is gone.')
  if (card.state !== 'proposed') throw new Error('This file was already decided.')
  const dir = brandFolder(brandId)
  const had = !!(await readBrandFile(dir, card.file))
  await writeBrandFile(dir, card.file, content)
  await appendLearningLine(dir, brandName(brandId), Date.now(), `${had ? 'Updated' : 'Started'} ${card.file}${content.trim() !== card.content.trim() ? ' (edited by you before keeping)' : ''}.`)
  await commitBrand(brandId, `${had ? 'update' : 'start'} ${card.file}`)
  if (card.file === 'voice.md' || card.file === 'positioning.md') await changeState(brandId, (s) => void (s.intakeDone = true))
  return (await changeCard(brandId, cardId, (c) => {
    if (c.type !== 'brand-file') return
    c.state = 'kept'
    c.content = content
  })) as BrandFileCard
}

async function dropFile(brandId: string, cardId: string): Promise<BrandFileCard> {
  return (await changeCard(brandId, cardId, (c) => {
    if (c.type === 'brand-file' && c.state === 'proposed') c.state = 'dropped'
  })) as BrandFileCard
}

// the wrap-up message for the agent, and a fresh session for the rule cap
async function wrapUp(brandId: string): Promise<string> {
  const s = await loadState(brandId)
  const events = await frictionSince(brandId, s.lastWrapUpAt)
  await changeState(brandId, (x) => {
    x.lastWrapUpAt = Date.now()
    x.proposed = 0
  })
  broadcast('brand-memory:changed', brandId)
  return wrapUpPrompt(events, rulesLeft(0))
}

// the brand intake: what the creator should talk about, the agent turns it into the files
export const INTAKE_PROMPT = [
  "I'm setting up this brand by talking it through. Below is what I said. Turn it into the brand files with brand_file_propose, one card each, in my own words as much as you can (quote me, don't polish):",
  '- positioning.md: who it is for, the promise, what makes it different, the content pillars.',
  '- voice.md: three to five words for the voice, how I talk, what we are not (a "we are not" list), words and phrases I use, and examples of lines that sound like me.',
  "If something important is missing, ask me in one short message instead of making it up. I'll keep, edit or drop each card."
].join('\n')

// ---------- agent tools ----------

const FILE_ARG = oneOf('which brand file', BRAND_FILES)

export const BRAND_MEMORY_TOOLS: GatewayTool[] = [
  {
    name: 'brand_files_read',
    title: 'Read the brand files',
    risk: 'read',
    description:
      "Read the brand's own files from its brand folder: positioning.md (audience, promise, pillars), voice.md (the voice guide), rules.md (rules the creator kept) and learnings.md (the running log). Leave file out to get all of them.",
    inputSchema: obj({ file: FILE_ARG }),
    run: async (turn, args) => {
      brandOf(turn)
      const dir = brandFolder(turn.brandId)
      const names = isBrandFile(args.file) ? [args.file] : [...BRAND_FILES]
      const out: Record<string, string> = {}
      for (const f of names) out[f] = (await readBrandFile(dir, f)) || '(not written yet)'
      return out
    }
  },
  {
    name: 'brand_file_propose',
    title: 'Propose a brand file',
    risk: 'read',
    description:
      "Shows a card in the chat with a draft of one brand file (positioning.md or voice.md, or rules.md and learnings.md when asked) for the creator to keep, edit or drop. Nothing is written until they keep it, then it's saved to the brand folder and committed to its history. Use the creator's own words. Use it for the brand intake and when they ask to update the voice guide.",
    inputSchema: obj(
      {
        file: FILE_ARG,
        content: str('the whole file as markdown, starting with a # title', MAX_BRAND_FILE, 20),
        note: str('one line on what changed or what you are unsure about', 300)
      },
      ['file', 'content']
    ),
    run: async (turn, args) => {
      brandOf(turn)
      if (!isBrandFile(args.file)) throw new ToolError('unknown brand file')
      const card: BrandFileCard = {
        ...base(turn),
        type: 'brand-file',
        file: args.file,
        content: String(args.content).replace(/\r\n/g, '\n'),
        note: typeof args.note === 'string' ? args.note.trim() : '',
        state: 'proposed'
      }
      await addCard(card)
      return `shown as card ${card.id}. ${BRAND_FILE_TITLES[args.file]} is saved only if the creator keeps it, their answer comes back as a message`
    }
  },
  {
    name: 'friction_log',
    title: 'Read what the creator changed',
    risk: 'read',
    description:
      "The friction log since the last wrap-up: every undo, turned down suggestion, re-spoken script line, rewrite or removal of a line you wrote, and line said differently on camera, with ids. Use it to propose rules with rule_propose at a wrap-up.",
    inputSchema: obj(),
    run: async (turn) => {
      brandOf(turn)
      const s = await loadState(turn.brandId)
      const events = await frictionSince(turn.brandId, s.lastWrapUpAt)
      return { since: s.lastWrapUpAt ? new Date(s.lastWrapUpAt).toISOString() : 'the start', count: events.length, rulesLeftThisSession: rulesLeft(s.proposed), events: frictionText(events, 80) }
    }
  },
  {
    name: 'rule_propose',
    title: 'Propose a brand rule',
    risk: 'read',
    description:
      'At a wrap-up, propose one rule learned from the friction log as a card with Keep, Edit and Drop. At most 3 per session, so pick the patterns that repeat. evidence is the ids of the friction events it comes from. Kept rules go into the style rules you see every turn and into the brand files with where they came from.',
    inputSchema: obj(
      {
        text: str('the rule, one short plain sentence, e.g. "Cut \'Moreover\'"', RULE_TEXT_MAX, 3),
        kind: oneOf('what it is about', RULE_KINDS),
        why: str('one line on the pattern you saw', 300),
        evidence: list('friction event ids from friction_log', str('id', 40, 1), 10, 1),
        examples: list('up to 3 short before and after quotes', str('example', 200, 1), 3)
      },
      ['text', 'kind', 'evidence']
    ),
    run: async (turn, args) => {
      brandOf(turn)
      const s = await loadState(turn.brandId)
      if (rulesLeft(s.proposed) <= 0) throw new ToolError('You already proposed 3 rules this session. Stop here; the creator decides on those first.')
      const known = new Set((await frictionSince(turn.brandId, null)).map((e) => e.id))
      const rule = cleanProposal(args, known)
      if (typeof rule === 'string') throw new ToolError(rule)
      await changeState(turn.brandId, (x) => void (x.proposed += 1))
      const card: RuleCard = { ...base(turn), type: 'rule', rule, state: 'proposed', kept: '' }
      await addCard(card)
      return `shown as rule card ${card.id}, ${rulesLeft(s.proposed + 1)} left this session. the creator keeps, edits or drops it`
    }
  },
  {
    name: 'cadence_profile',
    title: 'How the creator talks',
    risk: 'read',
    description:
      "The brand's cadence profile from the creator's dictations and takes: words per minute, sentence length, pauses, filler words, contractions, how often they say you, and their favorite phrases. Write lines that fit it.",
    inputSchema: obj(),
    run: async (turn) => {
      brandOf(turn)
      const p = await readCadenceProfile(turn.brandId)
      if (p.words < 60) return `Not enough speech yet (${p.words} words). It fills in as the creator dictates and records takes.`
      return { ...summarize(p), samples: p.samples }
    }
  }
]

// ---------- ipc ----------

const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'
function brandArg(e: IpcMainInvokeEvent, v: unknown): string {
  if (!fromApp(e) || typeof v !== 'string' || !ID_PATTERN.test(v)) throw new Error('bad brand memory call')
  return v
}
const idArg = (v: unknown): string => {
  if (typeof v !== 'string' || !v || v.length > 100) throw new Error('bad card id')
  return v
}

export function setupBrandMemory(): void {
  ipcMain.handle('brand-memory:state', (e, b: unknown) => memoryState(brandArg(e, b)))
  ipcMain.handle('brand-memory:wrap-up', (e, b: unknown) => wrapUp(brandArg(e, b)))
  ipcMain.handle('brand-memory:keep-rule', (e, b: unknown, id: unknown, text: unknown) => keepRule(brandArg(e, b), idArg(id), typeof text === 'string' ? text : ''))
  ipcMain.handle('brand-memory:drop-rule', (e, b: unknown, id: unknown) => dropRule(brandArg(e, b), idArg(id)))
  ipcMain.handle('brand-memory:keep-file', (e, b: unknown, id: unknown, content: unknown) => {
    if (typeof content !== 'string' || !content.trim()) throw new Error('The file is empty.')
    return keepFile(brandArg(e, b), idArg(id), content)
  })
  ipcMain.handle('brand-memory:drop-file', (e, b: unknown, id: unknown) => dropFile(brandArg(e, b), idArg(id)))
  ipcMain.handle('brand-memory:read-file', (e, b: unknown, file: unknown) => {
    const id = brandArg(e, b)
    if (!isBrandFile(file)) throw new Error('unknown brand file')
    return readBrandFile(brandFolder(id), file)
  })
  ipcMain.handle('brand-memory:intake-prompt', (e) => {
    if (!fromApp(e)) throw new Error('bad brand memory call')
    return INTAKE_PROMPT
  })
  ipcMain.handle('brand-memory:log', (e, b: unknown, kind: unknown, payload: unknown) => {
    const id = brandArg(e, b)
    // only the kinds the window itself sees happen
    if (kind !== 'undo' && kind !== 'rejected-suggestion') throw new Error('bad friction kind')
    const p = (payload ?? {}) as Record<string, unknown>
    const s = (v: unknown): string => (typeof v === 'string' ? v : '')
    return logFriction(id, { kind, projectId: s(p.projectId) || null, before: s(p.before), after: s(p.after), ref: s(p.ref), note: s(p.note) })
  })
  setInterval(() => void checkDigests().catch(() => {}), 24 * 3600_000).unref?.()
}

export async function dropBrandMemory(brandId: string): Promise<void> {
  if (!ID_PATTERN.test(brandId)) return
  await serial(brandId, () => fs.rm(userDir(brandId), { recursive: true, force: true }))
}
