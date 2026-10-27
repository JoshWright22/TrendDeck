import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { checkDraft } from '@shared/cadence'
import type { ScriptCard } from '@shared/cards'
import {
  allLines,
  changeLine,
  cleanClaims,
  parseMarkdown,
  readiness,
  scriptText,
  toMarkdown,
  writeScript,
  type BeatInput,
  type Claim,
  type Dump,
  type LineChange,
  type Script,
  type ScriptView
} from '@shared/script'
import type { SpokenWord, Transcription } from '@shared/speech'
import { ID_PATTERN } from '@shared/types'
import { addSpeech, logFriction, readCadenceProfile } from '../brand-memory'
import { addCard, changeCard, listCards, newCardId } from '../cards/store'
import { projectOf } from '../cards/tools'
import { findProject, projectFolder } from '../craft/paths'
import { PathError, resolveInProject } from '../craft/rules'
import { ToolError, type GatewayTool, type Turn } from '../gateway/types'
import { broadcast } from '../gateway/wait'
import { list, obj, oneOf, str } from '../gateway/validate'

// talk-first scripts in the project folder: scripts\script.md (markdown, git keeps its history),
// scripts\script.claims.json for the claim check, and scripts\dumps\<id>.json for every
// dictation with its word times. the agent quotes the dumps, main checks each quote

export const DEFAULT_SCRIPT = 'scripts/script.md'
const MAX_DUMPS = 200

async function root(brandId: string, projectId: string): Promise<string> {
  findProject(brandId, projectId)
  return projectFolder(brandId, projectId)
}

function scriptPath(dir: string, file: string): string {
  if (!/^scripts\/[a-z0-9 _-]{1,60}\.md$/i.test(file)) throw new ToolError('a script file is scripts/<name>.md')
  try {
    return resolveInProject(dir, file)
  } catch (err) {
    throw new ToolError(err instanceof PathError ? err.message : 'that path is not in the project folder')
  }
}

const claimsPath = (path: string): string => path.replace(/\.md$/i, '.claims.json')

// one change at a time per script file
const queues = new Map<string, Promise<unknown>>()
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn)
  queues.set(key, next.catch(() => {}))
  return next
}

async function readScript(path: string): Promise<{ script: Script; claims: Claim[] } | null> {
  let md: string
  try {
    md = await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
  const script = parseMarkdown(md)
  let raw: unknown = []
  try {
    raw = JSON.parse(await fs.readFile(claimsPath(path), 'utf8'))
  } catch {
    // no claims yet
  }
  return { script, claims: cleanClaims(raw, new Set(allLines(script).map((l) => l.id))) }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(`${path}.tmp`, text, 'utf8')
  await fs.rename(`${path}.tmp`, path)
}

async function saveScript(path: string, script: Script, claims: Claim[]): Promise<void> {
  await writeAtomic(path, toMarkdown(script))
  const ids = new Set(allLines(script).map((l) => l.id))
  await writeAtomic(claimsPath(path), `${JSON.stringify(claims.filter((c) => ids.has(c.lineId)), null, 1)}\n`)
}

function changed(brandId: string, projectId: string, file: string): void {
  broadcast('scripts:changed', { brandId, projectId, file })
}

export async function scriptView(brandId: string, projectId: string, file = DEFAULT_SCRIPT): Promise<ScriptView | null> {
  const dir = await root(brandId, projectId)
  const got = await readScript(scriptPath(dir, file))
  if (!got) return null
  const lines = allLines(got.script)
  const profile = await readCadenceProfile(brandId).catch(() => null)
  return {
    file,
    script: got.script,
    claims: got.claims,
    check: checkDraft(
      lines.map((l) => ({ id: l.id, text: l.text, spoken: l.origin === 'spoken' })),
      profile
    ),
    ready: readiness(got.script, got.claims)
  }
}

// the script lines a take is compared with, null when the project has none
export async function scriptLines(brandId: string, projectId: string): Promise<{ file: string; lines: ReturnType<typeof allLines> } | null> {
  try {
    const dir = await root(brandId, projectId)
    const got = await readScript(scriptPath(dir, DEFAULT_SCRIPT))
    return got ? { file: DEFAULT_SCRIPT, lines: allLines(got.script) } : null
  } catch {
    return null
  }
}

// ---------- dumps ----------

const dumpsDir = (dir: string): string => join(dir, 'scripts', 'dumps')

export async function saveDump(brandId: string, projectId: string, t: Pick<Transcription, 'text' | 'words' | 'duration'>): Promise<Dump> {
  const dir = await root(brandId, projectId)
  const at = Date.now()
  const id = `${new Date(at).toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomUUID().slice(0, 4)}`
  const words: SpokenWord[] = t.words
    .slice(0, 20000)
    .filter((w) => typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({ text: w.text.slice(0, 60), start: Math.round(w.start * 100) / 100, end: Math.round(w.end * 100) / 100 }))
  const dump: Dump = { id, at, text: t.text.slice(0, 200_000), words, duration: Number.isFinite(t.duration) ? t.duration : 0 }
  await writeAtomic(join(dumpsDir(dir), `${id}.json`), JSON.stringify(dump))
  void addSpeech(brandId, words)
  return dump
}

async function loadDumps(dir: string): Promise<Dump[]> {
  let names: string[] = []
  try {
    names = (await fs.readdir(dumpsDir(dir))).filter((n) => /^[\w-]{1,40}\.json$/.test(n))
  } catch {
    return []
  }
  const out: Dump[] = []
  for (const n of names.sort().slice(-MAX_DUMPS)) {
    try {
      const d = JSON.parse(await fs.readFile(join(dumpsDir(dir), n), 'utf8')) as Dump
      if (typeof d.id === 'string' && typeof d.text === 'string' && Array.isArray(d.words)) out.push(d)
    } catch {
      // half written, skip
    }
  }
  return out
}

// the dump as the agent reads it: sentences with the time they start
function dumpText(d: Dump): string {
  if (!d.words.length) return d.text
  const out: string[] = []
  let cur: string[] = []
  let start = d.words[0].start
  for (const w of d.words) {
    if (!cur.length) start = w.start
    cur.push(w.text.trim())
    if (/[.!?]$/.test(w.text.trim()) || cur.length >= 40) {
      out.push(`[${start.toFixed(1)}s] ${cur.join(' ')}`)
      cur = []
    }
  }
  if (cur.length) out.push(`[${start.toFixed(1)}s] ${cur.join(' ')}`)
  return out.join('\n')
}

// ---------- cards ----------

async function showCard(turn: Turn | { brandId: string; threadId: string | null; messageId?: string | null }, projectId: string, file: string, title: string): Promise<string> {
  if (turn.threadId) {
    const existing = (await listCards(turn.brandId, turn.threadId)).find((c) => c.type === 'script' && c.projectId === projectId && c.file === file)
    if (existing) {
      await changeCard(turn.brandId, existing.id, (c) => {
        if (c.type === 'script') c.title = title
      })
      return existing.id
    }
  }
  const now = Date.now()
  const card: ScriptCard = { id: newCardId(), brandId: turn.brandId, threadId: turn.threadId, messageId: turn.messageId ?? null, at: now, updatedAt: now, type: 'script', projectId, file, title }
  await addCard(card)
  return card.id
}

// ---------- the creator's changes from the card ----------

export async function changeScript(brandId: string, projectId: string, file: string, change: LineChange): Promise<ScriptView | null> {
  const dir = await root(brandId, projectId)
  const path = scriptPath(dir, file)
  await serial(path, async () => {
    const got = await readScript(path)
    if (!got) throw new Error('That script is gone.')
    const { script, before } = changeLine(got.script, change)
    if (!before) throw new Error('That line is gone. Reload the script.')
    // a claim on a line that changed has to be checked again
    const claims = change.type === 'remove' ? got.claims : got.claims.map((c) => (c.lineId === change.lineId && before.text !== script.beats.flatMap((b) => b.lines).find((l) => l.id === change.lineId)?.text ? { ...c, status: 'unchecked' as const, sourceUrl: '', note: 'The line changed, check again.' } : c))
    await saveScript(path, script, claims)
    const after = change.type === 'remove' ? '' : change.text
    if (change.type === 'respeak') await logFriction(brandId, { kind: 'respoken-line', projectId, before: before.text, after, ref: before.id, note: before.origin === 'agent' ? 'the line was the agent' : '' })
    else if (before.origin === 'agent') await logFriction(brandId, { kind: change.type === 'remove' ? 'removed-agent-line' : 'edited-agent-line', projectId, before: before.text, after, ref: before.id })
  })
  changed(brandId, projectId, file)
  return scriptView(brandId, projectId, file)
}

export async function setScriptStatus(brandId: string, projectId: string, file: string, status: 'draft' | 'ready'): Promise<ScriptView | null> {
  const dir = await root(brandId, projectId)
  const path = scriptPath(dir, file)
  await serial(path, async () => {
    const got = await readScript(path)
    if (!got) throw new Error('That script is gone.')
    if (status === 'ready') {
      const r = readiness(got.script, got.claims)
      if (!r.ready) throw new Error(r.blocking.length ? `${r.blocking.length} claim${r.blocking.length === 1 ? ' needs' : 's need'} a source first.` : 'The script is empty.')
    }
    await saveScript(path, { ...got.script, status }, got.claims)
  })
  changed(brandId, projectId, file)
  return scriptView(brandId, projectId, file)
}

// ---------- agent tools ----------

const PROJECT_ARG = str("the TrendDeck project (one video), by id. leave it out for this chat's project", 100)
const FILE_ARG = str(`the script file in the project folder, ${DEFAULT_SCRIPT} when left out`, 80)
const fileOf = (args: Record<string, unknown>): string => (typeof args.file === 'string' && args.file.trim() ? args.file.trim().replace(/\\/g, '/') : DEFAULT_SCRIPT)

const lineSchema = obj(
  {
    text: str('the line, one or two sentences as it will be said', 600, 1),
    origin: oneOf('spoken: quoted word for word from a dump. suggestion: your own wording', ['spoken', 'suggestion'])
  },
  ['text', 'origin']
)

export const SCRIPT_TOOLS: GatewayTool[] = [
  {
    name: 'dumps_list',
    title: 'List brain dumps',
    risk: 'read',
    description: "The creator's dictations for this project (brain dumps, re-spoken lines), newest last, with ids. Read one with dump_read.",
    inputSchema: obj({ projectId: PROJECT_ARG }),
    run: async (turn, args) => {
      const p = projectOf(turn, args.projectId)
      const dumps = await loadDumps(await root(turn.brandId, p.id))
      if (!dumps.length) return 'No dictation saved for this project yet. Ask the creator to talk the video through with the mic in the composer.'
      return dumps.map((d) => ({ id: d.id, at: new Date(d.at).toISOString(), words: d.words.length || d.text.split(/\s+/).length, start: d.text.slice(0, 160) }))
    }
  },
  {
    name: 'dump_read',
    title: 'Read a brain dump',
    risk: 'read',
    description: "The full text of one dictation, in sentences with the second each one starts. Quote these sentences word for word in script_write as spoken lines.",
    inputSchema: obj({ projectId: PROJECT_ARG, id: str('the dump id from dumps_list', 60, 1) }, ['id']),
    run: async (turn, args) => {
      const p = projectOf(turn, args.projectId)
      const d = (await loadDumps(await root(turn.brandId, p.id))).find((x) => x.id === args.id)
      if (!d) throw new ToolError(`no dump ${String(args.id)} in this project`)
      return { id: d.id, at: new Date(d.at).toISOString(), text: dumpText(d) }
    }
  },
  {
    name: 'script_get',
    title: 'Read the script',
    risk: 'read',
    description:
      "The project's script with line ids, who each line is from ([you] the creator's own words, [suggestion] yours, [typed] typed by the creator), its claims, the cadence check (lines that read written, not spoken) and whether it's ready to record.",
    inputSchema: obj({ projectId: PROJECT_ARG, file: FILE_ARG }),
    run: async (turn, args) => {
      const p = projectOf(turn, args.projectId)
      const v = await scriptView(turn.brandId, p.id, fileOf(args))
      if (!v) return `No script at ${fileOf(args)} yet. Write one with script_write from the creator's dumps.`
      return {
        script: scriptText(v.script, v.claims),
        cadence: { readSeconds: v.check.seconds, wpm: v.check.wpm, flags: v.check.flags },
        readyToRecord: v.ready.ready,
        blocking: v.ready.blocking.map((c) => `${c.id} on ${c.lineId}: ${c.text} (${c.status})`)
      }
    }
  },
  {
    name: 'script_write',
    title: 'Write the script',
    risk: 'edit',
    description:
      "Write or rewrite the project's script from the creator's own words. Build beats from their sentences quoted word for word from their dumps (origin spoken; fillers like um may be left out, nothing else changed) and add only short connecting lines of your own (origin suggestion). TrendDeck checks every spoken line against the dumps; a line that isn't really theirs is saved as a suggestion and listed back to you. Lines with the same words as before keep their id, the creator's own and typed lines stay theirs. Make minimal edits, don't polish their lines. The script card in the chat updates.",
    inputSchema: obj(
      {
        projectId: PROJECT_ARG,
        file: FILE_ARG,
        title: str('the video title or working title', 120, 1),
        beats: list('the beats in order', obj({ title: str('short beat name, e.g. Hook', 80, 1), lines: list('the lines', lineSchema, 40, 1) }, ['title', 'lines']), 30, 1)
      },
      ['title', 'beats']
    ),
    summarize: (_turn, args) => `Write the script "${String(args.title)}"`,
    run: async (turn, args) => {
      const p = projectOf(turn, args.projectId)
      const file = fileOf(args)
      const dir = await root(turn.brandId, p.id)
      const path = scriptPath(dir, file)
      const result = await serial(path, async () => {
        const prev = await readScript(path)
        const r = writeScript(String(args.title), args.beats as BeatInput[], await loadDumps(dir), prev?.script ?? null)
        await saveScript(path, r.script, prev?.claims ?? [])
        return r
      })
      changed(turn.brandId, p.id, file)
      const cardId = await showCard(turn, p.id, file, result.script.title)
      const lines = allLines(result.script)
      const spoken = lines.filter((l) => l.origin === 'spoken').length
      const v = await scriptView(turn.brandId, p.id, file)
      return {
        saved: file,
        card: cardId,
        lines: lines.length,
        creatorLines: spoken,
        ...(result.downgraded.length ? { savedAsSuggestions: result.downgraded, why: "these aren't in the creator's dumps word for word, so they're marked as your suggestions" } : {}),
        cadenceFlags: v?.check.flags.length ?? 0,
        next: 'Tell the creator in one line what you built. They can re-speak or edit any line on the card.'
      }
    }
  },
  {
    name: 'script_show',
    title: 'Show the script in the chat',
    risk: 'read',
    description: 'Puts the script card in the chat: every line with who it is from, cadence flags, claim checks and per-line actions (say it again, edit, remove).',
    inputSchema: obj({ projectId: PROJECT_ARG, file: FILE_ARG }),
    run: async (turn, args) => {
      const p = projectOf(turn, args.projectId)
      const v = await scriptView(turn.brandId, p.id, fileOf(args))
      if (!v) throw new ToolError(`no script at ${fileOf(args)} yet`)
      return `showing it as card ${await showCard(turn, p.id, v.file, v.script.title)}`
    }
  },
  {
    name: 'script_claims_set',
    title: 'List the claims in the script',
    risk: 'read',
    description:
      "The claim check before recording, step one: list every factual claim in the script (stats, quotes, facts that could be wrong), each tied to its line id. This replaces the previous list; claims on unchanged lines keep their status when the text is the same. Then verify each with your web tools and report each with script_claim_update. Stats and quotes block recording until they have a source. Check the creator's own lines too.",
    inputSchema: obj(
      {
        projectId: PROJECT_ARG,
        file: FILE_ARG,
        claims: list('the claims', obj({ lineId: str('the line id', 40, 1), kind: oneOf('stat, quote or fact', ['stat', 'quote', 'fact']), text: str('the claim in a few words', 300, 1) }, ['lineId', 'kind', 'text']), 60)
      },
      ['claims']
    ),
    run: async (turn, args) => {
      const p = projectOf(turn, args.projectId)
      const file = fileOf(args)
      const path = scriptPath(await root(turn.brandId, p.id), file)
      const out = await serial(path, async () => {
        const got = await readScript(path)
        if (!got) throw new ToolError(`no script at ${file} yet`)
        const ids = new Set(allLines(got.script).map((l) => l.id))
        const bad = (args.claims as { lineId: string }[]).filter((c) => !ids.has(c.lineId)).map((c) => c.lineId)
        if (bad.length) throw new ToolError(`no lines ${[...new Set(bad)].join(', ')} in the script, use the ids from script_get`)
        const claims = (args.claims as { lineId: string; kind: Claim['kind']; text: string }[]).map((c): Claim => {
          const same = got.claims.find((o) => o.lineId === c.lineId && o.text.toLowerCase() === c.text.trim().toLowerCase())
          return same ?? { id: `c${randomUUID().slice(0, 6)}`, lineId: c.lineId, kind: c.kind, text: c.text.trim(), status: 'checking', sourceUrl: '', note: '' }
        })
        await saveScript(path, got.script, claims)
        return claims
      })
      changed(turn.brandId, p.id, file)
      return { claims: out.map((c) => ({ id: c.id, lineId: c.lineId, kind: c.kind, text: c.text, status: c.status })), next: 'verify each one with your web tools, then call script_claim_update for each' }
    }
  },
  {
    name: 'script_claim_update',
    title: 'Report a claim check',
    risk: 'read',
    description: 'Say what you found for one claim: sourced (give the source url), wrong (say what is right in note) or unverifiable. Only say sourced when a page you actually read supports it.',
    inputSchema: obj(
      {
        projectId: PROJECT_ARG,
        file: FILE_ARG,
        claimId: str('the claim id', 40, 1),
        status: oneOf('what you found', ['sourced', 'wrong', 'unverifiable']),
        sourceUrl: str('the page that supports it', 1000),
        note: str('one line for the creator', 400)
      },
      ['claimId', 'status']
    ),
    run: async (turn, args) => {
      const p = projectOf(turn, args.projectId)
      const file = fileOf(args)
      if (args.status === 'sourced' && !(typeof args.sourceUrl === 'string' && /^https?:\/\//i.test(args.sourceUrl))) throw new ToolError('a sourced claim needs the source url')
      const path = scriptPath(await root(turn.brandId, p.id), file)
      await serial(path, async () => {
        const got = await readScript(path)
        if (!got) throw new ToolError(`no script at ${file} yet`)
        const c = got.claims.find((x) => x.id === args.claimId)
        if (!c) throw new ToolError(`no claim ${String(args.claimId)}, list them with script_claims_set first`)
        c.status = args.status as Claim['status']
        c.sourceUrl = typeof args.sourceUrl === 'string' ? args.sourceUrl.trim() : ''
        c.note = typeof args.note === 'string' ? args.note.trim() : ''
        await saveScript(path, got.script, got.claims)
      })
      changed(turn.brandId, p.id, file)
      const v = await scriptView(turn.brandId, p.id, file)
      return { claim: args.claimId, status: args.status, readyToRecord: v?.ready.ready ?? false, stillBlocking: v?.ready.blocking.length ?? 0 }
    }
  }
]

// ---------- ipc ----------

const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'
function ids(e: IpcMainInvokeEvent, b: unknown, p: unknown): [string, string] {
  if (!fromApp(e) || typeof b !== 'string' || !ID_PATTERN.test(b) || typeof p !== 'string' || !ID_PATTERN.test(p)) throw new Error('bad script call')
  return [b, p]
}
const fileArg = (f: unknown): string => (typeof f === 'string' && f ? f : DEFAULT_SCRIPT)

function cleanChange(raw: unknown): LineChange {
  const c = (raw ?? {}) as Record<string, unknown>
  const lineId = typeof c.lineId === 'string' ? c.lineId : ''
  const text = typeof c.text === 'string' ? c.text.slice(0, 2000) : ''
  if (!lineId) throw new Error('bad line')
  if (c.type === 'remove') return { type: 'remove', lineId }
  if (!text.trim()) throw new Error('The line is empty.')
  if (c.type === 'respeak') return { type: 'respeak', lineId, text, dump: typeof c.dump === 'string' ? c.dump.slice(0, 60) : null, at: typeof c.at === 'number' ? c.at : null }
  return { type: 'type', lineId, text }
}

function cleanTranscription(raw: unknown): Pick<Transcription, 'text' | 'words' | 'duration'> {
  const t = (raw ?? {}) as Partial<Transcription>
  if (typeof t.text !== 'string' || !t.text.trim()) throw new Error('nothing was said')
  const words = Array.isArray(t.words) ? t.words.filter((w) => w && typeof w.text === 'string' && typeof w.start === 'number' && typeof w.end === 'number') : []
  return { text: t.text, words, duration: typeof t.duration === 'number' ? t.duration : 0 }
}

export function setupScripts(): void {
  ipcMain.handle('scripts:get', (e, b: unknown, p: unknown, f: unknown) => scriptView(...ids(e, b, p), fileArg(f)))
  ipcMain.handle('scripts:change', (e, b: unknown, p: unknown, f: unknown, c: unknown) => changeScript(...ids(e, b, p), fileArg(f), cleanChange(c)))
  ipcMain.handle('scripts:status', (e, b: unknown, p: unknown, f: unknown, s: unknown) => setScriptStatus(...ids(e, b, p), fileArg(f), s === 'ready' ? 'ready' : 'draft'))
  // every dictation that goes to the agent, kept with its word times
  ipcMain.handle('scripts:save-dump', async (e, b: unknown, p: unknown, t: unknown) => {
    const d = await saveDump(...ids(e, b, p), cleanTranscription(t))
    return { id: d.id, words: d.words.length }
  })
  // speech that isn't for a project still teaches the cadence profile
  ipcMain.handle('scripts:speech', (e, b: unknown, t: unknown) => {
    if (!fromApp(e) || typeof b !== 'string' || !ID_PATTERN.test(b)) throw new Error('bad script call')
    return addSpeech(b, cleanTranscription(t).words)
  })
  ipcMain.handle('scripts:show', (e, b: unknown, p: unknown, thread: unknown) => {
    const [brandId, projectId] = ids(e, b, p)
    return showCard({ brandId, threadId: typeof thread === 'string' ? thread : null }, projectId, DEFAULT_SCRIPT, 'Script')
  })
}

