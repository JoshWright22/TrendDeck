import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  cleanDomain,
  DEFAULT_SITES,
  hostOf,
  ID_PATTERN,
  isHttpUrl,
  type AppData,
  type Brand,
  type ChatMessage,
  type ChatThread,
  type Idea,
  type Site,
  TAB_CAP_DEFAULT,
  TAB_CAP_MAX,
  TREND_SOURCES
} from '@shared/types'
import { cleanIdeaBoard, cleanSchedule } from './planner/clean'
import { cleanChatProjects, cleanPipeline, cleanProjects } from './workspace/clean'

const FILE_NAME = 'trenddeck.json'

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function defaultData(): AppData {
  const brand: Brand = {
    id: randomUUID(),
    name: 'My Brand',
    keywords: [],
    subreddits: [],
    adblock: true,
    adblockAllow: [],
    sites: DEFAULT_SITES.map((s) => ({ ...s, id: randomUUID() })),
    threads: [],
    ideas: [],
    projects: [],
    pipeline: []
  }
  brand.pipeline = cleanPipeline(undefined)
  brand.projects = cleanProjects(undefined, brand.pipeline, Date.now())
  brand.chatProjects = {}
  return {
    version: 1,
    activeBrandId: brand.id,
    chatOpen: false,
    onboarded: false,
    settings: { youtubeApiKey: '', tabCap: TAB_CAP_DEFAULT, autoUpdate: true },
    brands: [brand]
  }
}

function cleanSite(raw: unknown): Site | null {
  const s = raw as Partial<Site> | null
  if (!s || typeof s.id !== 'string' || !ID_PATTERN.test(s.id)) return null
  if (typeof s.name !== 'string' || typeof s.url !== 'string' || !isHttpUrl(s.url)) return null
  return { id: s.id, name: s.name.slice(0, 60), url: s.url }
}

function cleanMessage(raw: unknown): ChatMessage | null {
  const m = raw as Partial<ChatMessage> | null
  if (!m || typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) return null
  if (m.role !== 'user' && m.role !== 'agent') return null
  if (typeof m.text !== 'string') return null
  return { id: m.id, role: m.role, text: m.text.slice(0, 20000), at: Number(m.at) || 0 }
}

function cleanThread(raw: unknown): ChatThread | null {
  const t = raw as Partial<ChatThread> | null
  if (!t || typeof t.id !== 'string' || !ID_PATTERN.test(t.id)) return null
  const messages = Array.isArray(t.messages)
    ? t.messages.map(cleanMessage).filter((m): m is ChatMessage => m !== null)
    : []
  const title = typeof t.title === 'string' ? t.title.slice(0, 80) : 'New chat'
  return { id: t.id, title, updatedAt: Number(t.updatedAt) || 0, messages }
}

function cleanIdea(raw: unknown): Idea | null {
  const i = raw as Partial<Idea> | null
  if (!i || typeof i.id !== 'string' || !ID_PATTERN.test(i.id)) return null
  if (typeof i.title !== 'string' || typeof i.url !== 'string') return null
  if (i.url && !isHttpUrl(i.url)) return null
  const source = (TREND_SOURCES as readonly string[]).includes(i.source as string)
    ? (i.source as Idea['source'])
    : 'manual'
  return {
    id: i.id,
    title: i.title.slice(0, 300),
    url: i.url,
    source,
    savedAt: Number(i.savedAt) || 0,
    ...cleanIdeaBoard(i)
  }
}

function strings(raw: unknown, max: number): string[] {
  return Array.isArray(raw)
    ? raw.filter((k): k is string => typeof k === 'string').map((k) => k.slice(0, max))
    : []
}

function cleanBrand(raw: unknown): Brand | null {
  const b = raw as Partial<Brand> | null
  if (!b || typeof b.id !== 'string' || !ID_PATTERN.test(b.id)) return null
  if (typeof b.name !== 'string') return null
  const keywords = strings(b.keywords, 80)
  // subreddit names go into urls, so only the characters reddit allows
  const subreddits = strings(b.subreddits, 21).filter((r) => /^[A-Za-z0-9_]{2,21}$/.test(r))
  const sites = Array.isArray(b.sites)
    ? b.sites.map(cleanSite).filter((s): s is Site => s !== null)
    : []
  // sites used to have their own ad blocker switch, an off one moves to the allowlist
  const oldOff = Array.isArray(b.sites)
    ? (b.sites as Partial<{ url: string; adblock: boolean }>[])
        .filter((s) => s && s.adblock === false && typeof s.url === 'string')
        .map((s) => hostOf(s.url as string))
    : []
  const adblockAllow = [...new Set([...strings(b.adblockAllow, 253).map(cleanDomain), ...oldOff])].filter(Boolean)
  const threads = Array.isArray(b.threads)
    ? b.threads.map(cleanThread).filter((t): t is ChatThread => t !== null)
    : []
  const ideas = Array.isArray(b.ideas)
    ? b.ideas.map(cleanIdea).filter((i): i is Idea => i !== null)
    : []
  const pipeline = cleanPipeline(b.pipeline)
  return {
    id: b.id,
    name: b.name.slice(0, 60),
    keywords,
    subreddits,
    adblock: b.adblock !== false,
    adblockAllow,
    sites,
    threads,
    ideas,
    schedule: cleanSchedule(b.schedule),
    pipeline,
    // brands from before projects get General. links from before chats could have several
    // projects come from each project's threadIds
    ...cleanChatProjects(b.chatProjects, cleanProjects(b.projects, pipeline, Date.now()))
  }
}

// never trust the file or the renderer, rebuild the shape by hand
export function sanitize(raw: unknown): AppData {
  const d = raw as Partial<AppData> | null
  if (!d || !Array.isArray(d.brands)) throw new Error('bad data shape')
  const brands = d.brands.map(cleanBrand).filter((b): b is Brand => b !== null)
  const active = brands.some((b) => b.id === d.activeBrandId)
    ? (d.activeBrandId as string)
    : (brands[0]?.id ?? null)
  const s = (d.settings ?? {}) as Partial<AppData['settings']>
  const key = s.youtubeApiKey
  const cap = Math.round(Number(s.tabCap))
  const settings = {
    youtubeApiKey: typeof key === 'string' ? key.trim().slice(0, 200) : '',
    tabCap: cap >= 1 && cap <= TAB_CAP_MAX ? cap : TAB_CAP_DEFAULT,
    autoUpdate: s.autoUpdate !== false
  }
  // files from before setup existed count as done
  const onboarded = d.onboarded !== false
  return { version: 1, activeBrandId: active, chatOpen: d.chatOpen === true, onboarded, settings, brands }
}

let current: AppData | null = null

// the last data loaded or saved, for the main process to read
export function getData(): AppData | null {
  return current
}

export async function loadData(): Promise<AppData> {
  const file = filePath()
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    const data = defaultData()
    await saveData(data)
    return data
  }
  try {
    current = sanitize(JSON.parse(text))
    return current
  } catch {
    // keep the broken file around instead of silently wiping it
    await fs.rename(file, `${file}.broken-${Date.now()}`).catch(() => {})
    const data = defaultData()
    await saveData(data)
    return data
  }
}

let queue: Promise<void> = Promise.resolve()

// writes go through a temp file and a queue so a crash mid-save can't leave half a file
export function saveData(data: AppData): Promise<void> {
  const clean = sanitize(data)
  current = clean
  const run = async (): Promise<void> => {
    const file = filePath()
    const tmp = `${file}.tmp`
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(clean, null, 2), 'utf8')
    await fs.rename(tmp, file)
  }
  queue = queue.then(run, run)
  return queue
}
