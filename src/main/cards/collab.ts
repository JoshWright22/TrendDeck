import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { CraftEmbedCard } from '@shared/cards'
import { describeChanges, diffSnapshots, fcSequenceFrom, type FcSnapshot, type ProjectSnapshot } from '@shared/craft-embed'
import { cachedTools } from '../craft/agent'
import { spec } from '../craft/catalog'
import { runningApp } from '../craft/launch'
import { knownFolder } from '../craft/paths'
import { appCall, resultJson } from '../craft/tools'
import { webEdited, webStill } from '../craft/web'
import { decodeDataUrl, saveAsset } from '../visuals/store'
import { visualsRoot } from '../visuals/paths'
import { onTurnClosed } from '../mcp/turns'
import { currentFile, liveOn, onCommentMarkers, setOnEmbedded } from './embed'
import { cardsDir, listCards } from './store'

// the user and the agent take turns on the same Craft projects. when a reply ends, TrendDeck takes
// a look at every project embedded in that chat. when the next message goes out, it looks again
// and tells the agent what the user changed in between, in plain words, next to their message

interface Look {
  at: number
  snapshot: ProjectSnapshot | null
  file: string | null
  mtime: number | null
  // markers that came from the user's comments, the agent already got those as comments
  skipMarkers: number[]
}

const looks = new Map<string, Look>()
const loaded = new Set<string>()
const key = (brandId: string, threadId: string, appId: string, projectId: string): string => `${brandId}|${threadId}|${appId}|${projectId}`
const lookFile = (brandId: string): string => join(cardsDir(), 'looks', `${brandId}.json`)
const MAX_SEQUENCES = 8

async function load(brandId: string): Promise<void> {
  if (loaded.has(brandId)) return
  loaded.add(brandId)
  try {
    const raw = JSON.parse(await fs.readFile(lookFile(brandId), 'utf8')) as Record<string, Look>
    for (const [k, v] of Object.entries(raw)) if (k.startsWith(`${brandId}|`) && !looks.has(k)) looks.set(k, v)
  } catch {
    // none yet
  }
}

const saving = new Map<string, NodeJS.Timeout>()
function persist(brandId: string): void {
  clearTimeout(saving.get(brandId))
  saving.set(
    brandId,
    setTimeout(() => {
      saving.delete(brandId)
      const mine = Object.fromEntries([...looks].filter(([k]) => k.startsWith(`${brandId}|`)))
      void fs
        .mkdir(join(cardsDir(), 'looks'), { recursive: true })
        .then(() => fs.writeFile(lookFile(brandId), JSON.stringify(mine), 'utf8'))
        .catch(() => {})
    }, 500)
  )
}

const json = async (brandId: string, projectId: string, appId: string, tool: string, args: Record<string, unknown> = {}): Promise<unknown> =>
  resultJson(await appCall(brandId, projectId, appId, tool, args, { timeoutMs: 20_000 }))

async function inspectFilmcraft(brandId: string, projectId: string): Promise<FcSnapshot> {
  const p = (await json(brandId, projectId, 'filmcraft', 'project_inspect')) as { root?: unknown; activeSequence?: unknown } | null
  const names: Record<string, string> = {}
  const walk = (n: unknown, depth: number): void => {
    if (!n || typeof n !== 'object' || depth > 8) return
    const o = n as Record<string, unknown>
    if (o.type === 'Sequence' && typeof o.item === 'number') names[String(o.item)] = typeof o.name === 'string' ? o.name : `sequence ${o.item}`
    if (Array.isArray(o.children)) for (const c of o.children) walk(c, depth + 1)
  }
  walk(p?.root, 0)
  const active = typeof p?.activeSequence === 'number' ? p.activeSequence : null
  const sequences = []
  for (const id of Object.keys(names).map(Number).slice(0, MAX_SEQUENCES)) {
    try {
      const seq = await json(brandId, projectId, 'filmcraft', 'command_run', { id: 'sequence.inspect', params: { item: id } })
      // captions.list only reads the open sequence
      const caps = id === active ? await json(brandId, projectId, 'filmcraft', 'command_run', { id: 'captions.list', params: {} }).catch(() => null) : null
      const s = fcSequenceFrom(seq, caps)
      if (s) sequences.push(s)
    } catch {
      // a sequence that can't be read is left out of both looks
    }
  }
  return { kind: 'filmcraft', sequences, names }
}

async function inspect(brandId: string, projectId: string, appId: string): Promise<ProjectSnapshot | null> {
  if (appId === 'filmcraft') return inspectFilmcraft(brandId, projectId)
  const tool = ['doc_inspect', 'project_inspect'].find((t) => cachedTools(appId).some((c) => c.tool.name === t))
  if (!tool) return null
  return { kind: 'generic', tree: await json(brandId, projectId, appId, tool) }
}

async function mtimeOf(file: string | null): Promise<number | null> {
  if (!file) return null
  return (await fs.stat(file).catch(() => null))?.mtimeMs ?? null
}

// a look at the project now. the app is asked when it has the project open, or when the file
// changed on disk since the last look (then a headless engine opens it). otherwise nothing changed
async function lookNow(brandId: string, projectId: string, appId: string, prev: Look | null): Promise<Look> {
  const file = await currentFile(appId, brandId, projectId).catch(() => null)
  const mtime = await mtimeOf(file)
  const live = liveOn(appId, brandId, projectId)
  const run = runningApp(appId)
  const busyElsewhere = !!run && (run.brandId !== brandId || run.projectId !== projectId)
  const unchanged = !live && prev && prev.file === file && prev.mtime === mtime
  if (unchanged) return { ...prev, at: Date.now() }
  if (busyElsewhere || !spec(appId).agent || !file) return { at: Date.now(), snapshot: null, file, mtime, skipMarkers: prev?.skipMarkers ?? [] }
  const snapshot = await inspect(brandId, projectId, appId).catch(() => null)
  return { at: Date.now(), snapshot, file, mtime, skipMarkers: prev?.skipMarkers ?? [] }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

// the app projects embedded in a chat, newest embed first
async function embedded(brandId: string, threadId: string): Promise<CraftEmbedCard[]> {
  const seen = new Set<string>()
  const out: CraftEmbedCard[] = []
  for (const c of (await listCards(brandId, threadId)).slice().reverse()) {
    if (c.type !== 'craft' || !knownFolder(brandId, c.projectId)) continue
    const k = `${c.appId}|${c.projectId}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(c)
  }
  return out.slice(0, 4)
}

async function editedPicture(brandId: string, c: CraftEmbedCard, since: number): Promise<string | null> {
  const edit = webEdited(c.appId, brandId, c.projectId)
  if (!edit || edit.editedAt <= since) return null
  const still = await webStill(edit.cardId).catch(() => null)
  if (!still) return null
  const asset = await saveAsset(visualsRoot(), brandId, decodeDataUrl(still), {
    origin: 'frame',
    name: `${c.appName} after the user's edits`,
    note: `How the ${c.appName} editor in the chat looked when the user sent this message, their edits included.`,
    sourceUrl: '',
    source: null
  }).catch(() => null)
  return asset
    ? `the user edited it in the editor here, maybe not saved to the file yet. A picture of how it looks now is visual ${asset.id}: open it with visual_get only if you need to see their changes`
    : null
}

export async function takeLook(brandId: string, threadId: string, appId: string, projectId: string): Promise<void> {
  await load(brandId)
  const k = key(brandId, threadId, appId, projectId)
  const look = await withTimeout(lookNow(brandId, projectId, appId, looks.get(k) ?? null), 30_000)
  if (!look) return
  // a fresh look starts a fresh list, those markers are in it now
  looks.set(k, { ...look, skipMarkers: [] })
  persist(brandId)
}

// what the user changed in the chat's embedded projects since the agent's last reply, for the
// start of the agent's next turn. empty when nothing changed
export async function turnNotes(brandId: string, threadId: string): Promise<string> {
  await load(brandId)
  const parts: string[] = []
  for (const c of await embedded(brandId, threadId)) {
    const k = key(brandId, threadId, c.appId, c.projectId)
    const prev = looks.get(k)
    if (!prev) continue
    const now = await withTimeout(lookNow(brandId, c.projectId, c.appId, prev), 12_000)
    if (!now) continue
    let lines: string[] = []
    if (prev.snapshot && now.snapshot) lines = diffSnapshots(prev.snapshot, now.snapshot, new Set(prev.skipMarkers))
    else if (prev.mtime !== now.mtime || prev.file !== now.file) lines = [`the file ${now.file ? basename(now.file) : ''} changed, look at it with the ${c.appId} tools`.replace('  ', ' ')]
    // an image the user changed in the editor here: a picture of it the agent can open if it needs
    // to. none when they didn't touch it, so nothing is spent on looking
    const shot = c.appId === 'filmcraft' ? null : await editedPicture(brandId, c, prev.at)
    if (shot) lines.push(shot)
    // what was told now is the starting point for next time
    looks.set(k, { ...now, skipMarkers: [] })
    const text = describeChanges(c.appName, now.file ? basename(now.file) : c.file, lines)
    if (text) parts.push(`- ${text}`)
  }
  persist(brandId)
  if (!parts.length) return ''
  return [
    '## What the user changed in the editors since your last reply',
    ...parts,
    "These are the user's own edits in the Craft apps in this chat. Keep them and build on them. Don't undo, redo or move them unless the user asks; if you think one should change, say so and ask."
  ].join('\n')
}

export function setupCollab(): void {
  // the first look at a project once it's in a chat
  setOnEmbedded(async (brandId, threadId, appId, projectId) => {
    if (!threadId) return
    await load(brandId)
    if (!looks.has(key(brandId, threadId, appId, projectId))) await takeLook(brandId, threadId, appId, projectId)
  })
  // a reply ended: what the projects look like now is the agent's last state
  onTurnClosed((turn) => {
    if (!turn.threadId) return
    const threadId = turn.threadId
    // after the edit groups saved their files
    setTimeout(() => {
      void (async () => {
        for (const c of await embedded(turn.brandId, threadId)) await takeLook(turn.brandId, threadId, c.appId, c.projectId)
      })().catch((err) => console.error('cards: looking at the embedded projects failed', err))
    }, 1500)
  })
  onCommentMarkers((brandId, threadId, appId, projectId, markers) => {
    if (!threadId || !markers.length) return
    const k = key(brandId, threadId, appId, projectId)
    const l = looks.get(k)
    if (l) {
      l.skipMarkers = [...new Set([...l.skipMarkers, ...markers])].slice(-500)
      persist(brandId)
    }
  })
}
