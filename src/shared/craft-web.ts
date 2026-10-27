// the Craft apps' web builds, embedded in the chat as real page elements (a <webview> per card)
// instead of a native window laid over the page. main serves each build from craft-web://<app>/,
// the agent drives FilmCraft's through window.filmcraft, and heavy work (exports, proxies,
// inspects, frame renders) goes to the native cli on a saved copy. see docs/DECISIONS-craft-web.md.
// the parts here are pure and unit tested

export const CRAFT_WEB_SCHEME = 'craft-web'
export const CRAFT_WEB_PARTITION = 'persist:craft-web'

// api: the build has a page api TrendDeck drives (window.<app>), the agent works in the embed.
// files: no page api, files come in by a drop and saves come out as downloads TrendDeck catches
export type CraftWebKind = 'api' | 'files'

export interface CraftWebSpec {
  kind: CraftWebKind
  // query flags for index.html. FilmCraft's own crash recovery and demo are off, TrendDeck opens
  // the project and keeps the recovery copies in the project folder
  query: string
}

// checked by hand in the built app (docs/DECISIONS-craft-web.md). apps not here open in the full app
export const WEB_APPS: Record<string, CraftWebSpec> = {
  filmcraft: { kind: 'api', query: '?empty&norecover&fresh' },
  photocraft: { kind: 'files', query: '' }
}

export const webSpec = (appId: string): CraftWebSpec | null => WEB_APPS[appId] ?? null

// main -> window on 'craft-web:state': how a card's editor is doing
export interface WebEmbedState {
  cardId: string
  state: 'loading' | 'ready' | 'failed' | 'closed'
  // what to tell you: autosave, files outside the folder, why it failed
  note: string
  savedAt: number | null
}

// at most this many web editors run at once, the rest show a still with Open here
export const MAX_LIVE = 2

// ---- the craft-web protocol ----

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  wasm: 'application/wasm',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  css: 'text/css; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

export function mimeOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot >= 0 && TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream'
}

// cross-origin isolated (FilmCraft reports it in info() and a threaded build would need it) and
// nothing from elsewhere: the page may only load its own files
export const ISOLATION_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self' blob: data:; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: data:; worker-src 'self' blob:; img-src 'self' blob: data:; media-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
}

export type ParsedRange = { start: number; end: number } | 'unsatisfiable' | null

// one byte range of a file of this size. null when there's no usable header (the whole file)
export function parseRange(header: string | null, size: number): ParsedRange {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!m || (!m[1] && !m[2])) return null
  if (size <= 0) return 'unsatisfiable'
  let start: number
  let end: number
  if (!m[1]) {
    // the last n bytes
    const n = Number(m[2])
    if (n <= 0) return 'unsatisfiable'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'unsatisfiable'
  return { start, end }
}

// the file a craft-web url asks for, relative to the app's build or a project's folder.
// null when the url is outside what may be served
export type WebTarget = { kind: 'app'; appId: string; rel: string } | { kind: 'project'; appId: string; token: string; rel: string }

export function webTarget(url: string): WebTarget | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== `${CRAFT_WEB_SCHEME}:` || !/^[a-z][a-z0-9-]{0,40}$/.test(u.hostname)) return null
  let path: string
  try {
    path = decodeURIComponent(u.pathname)
  } catch {
    return null
  }
  if (path.includes('\0') || path.includes('\\')) return null
  const parts = path.split('/').filter(Boolean)
  if (parts.some((p) => p === '..' || p === '.' || /^[a-z]:/i.test(p))) return null
  // project files: /_project/<token>/<file in the folder>
  if (parts[0] === '_project') {
    const [, token, ...rest] = parts
    if (!token || !/^[a-f0-9]{32}$/.test(token) || !rest.length) return null
    return { kind: 'project', appId: u.hostname, token, rel: rest.join('/') }
  }
  return { kind: 'app', appId: u.hostname, rel: parts.length ? parts.join('/') : 'index.html' }
}

// ---- FilmCraft's project files on disk and in the web build ----

// keys whose string values are file paths in a .fcproj: media, proxies, full res, luts
const PATH_KEY = /(^|_)path$|Path$/

// every path value in the project passed through map, the rest of the document untouched.
// map returns null to leave a path as it is
export function mapProjectPaths(doc: unknown, map: (p: string) => string | null, key = ''): unknown {
  if (typeof doc === 'string') return PATH_KEY.test(key) ? (map(doc) ?? doc) : doc
  if (Array.isArray(doc)) return doc.map((v) => mapProjectPaths(v, map, key))
  if (doc && typeof doc === 'object') {
    return Object.fromEntries(Object.entries(doc as Record<string, unknown>).map(([k, v]) => [k, mapProjectPaths(v, map, k)]))
  }
  return doc
}

// the path values of a project, for finding the files it needs
export function projectPaths(doc: unknown): string[] {
  const out = new Set<string>()
  mapProjectPaths(doc, (p) => {
    if (p) out.add(p)
    return null
  })
  return [...out]
}

const winKey = (p: string): string => p.replace(/\//g, '\\').toLowerCase()

// disk paths and the web build's virtual ones, both ways. windows paths compare case-insensitively
export class PathTable {
  private toWebMap = new Map<string, string>()
  private toDiskMap = new Map<string, string>()

  add(disk: string, web: string): void {
    this.toWebMap.set(winKey(disk), web)
    this.toDiskMap.set(web, disk)
  }

  web(disk: string): string | null {
    return this.toWebMap.get(winKey(disk)) ?? null
  }

  disk(web: string): string | null {
    return this.toDiskMap.get(web) ?? null
  }

  has(disk: string): boolean {
    return this.toWebMap.has(winKey(disk))
  }

  // virtual paths the project refers to that no disk file is known for
  unknownIn(doc: unknown): string[] {
    return projectPaths(doc).filter((p) => p.startsWith('/') && !this.toDiskMap.has(p))
  }
}

// ---- the agent's FilmCraft tools against the web build ----

export const FILMCRAFT_EXPORT_IDS = new Set(['file.exportMedia', 'export.queue.add', 'export.queue.start', 'export.queue.render'])
const SAVE_IDS = new Set(['file.save', 'file.saveAs', 'file.saveCopy', 'file.saveAll'])
const RELOAD_IDS = new Set(['file.revert', 'file.open'])
// web builds report these as errors (threads), the native engine does them
const NATIVE_IDS = new Set(['media.createProxies', 'file.projectManager'])

export type WebStep =
  | { kind: 'execute'; command: string; params: Record<string, unknown> }
  | { kind: 'batch'; steps: { id: string; params: Record<string, unknown> }[]; stopOnError: boolean }
  | { kind: 'request'; method: string; params: Record<string, unknown> }
  | { kind: 'commands'; filter: string | null }
  | { kind: 'import'; paths: string[] }
  | { kind: 'screenshot'; params: Record<string, unknown> }
  // a read the native engine answers from a saved copy of the web session
  | { kind: 'snapshot'; tool: string; args: Record<string, unknown> }
  // runs in the native engine on the saved project: exports and the rest of NATIVE_IDS
  | { kind: 'native'; command: string; params: Record<string, unknown> }
  | { kind: 'save'; command: string; path: string | null }
  | { kind: 'reload'; path: string | null }
  | { kind: 'unsupported'; why: string }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

function commandStep(id: string, params: Record<string, unknown>): WebStep {
  if (FILMCRAFT_EXPORT_IDS.has(id) || NATIVE_IDS.has(id)) return { kind: 'native', command: id, params }
  if (SAVE_IDS.has(id)) return { kind: 'save', command: id, path: typeof params.path === 'string' ? params.path : null }
  if (RELOAD_IDS.has(id)) return { kind: 'reload', path: typeof params.path === 'string' ? params.path : null }
  return { kind: 'execute', command: id, params }
}

const UI_METHODS: Record<string, string> = {
  ui_inspect: 'ui.inspect',
  ui_elements: 'ui.elements',
  ui_click: 'ui.click',
  ui_drag: 'ui.drag',
  ui_key: 'ui.key',
  ui_type: 'ui.type'
}

// what one of FilmCraft's MCP tools is in the web build. paths in args are absolute disk paths
// already checked to be in the project folder
export function filmcraftWebStep(tool: string, args: Record<string, unknown>): WebStep {
  switch (tool) {
    case 'command_list':
      return { kind: 'commands', filter: typeof args.filter === 'string' ? args.filter : null }
    case 'command_run':
      return typeof args.id === 'string' ? commandStep(args.id, obj(args.params)) : { kind: 'unsupported', why: 'command_run needs an id' }
    case 'command_batch': {
      const steps = Array.isArray(args.steps) ? args.steps.map((s) => ({ id: String(obj(s).id ?? ''), params: obj(obj(s).params) })) : []
      if (!steps.length || steps.some((s) => !s.id)) return { kind: 'unsupported', why: 'command_batch needs steps with ids' }
      return { kind: 'batch', steps, stopOnError: args.stop_on_error !== false }
    }
    case 'sequence_inspect':
      return { kind: 'execute', command: 'sequence.inspect', params: typeof args.item === 'number' ? { item: args.item } : {} }
    case 'project_inspect':
    case 'doc_inspect':
    case 'render_frame':
    case 'render_preview':
      return { kind: 'snapshot', tool, args }
    case 'media_import': {
      const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === 'string') : []
      return paths.length ? { kind: 'import', paths } : { kind: 'unsupported', why: 'media_import needs paths' }
    }
    case 'ui_screenshot':
      return { kind: 'screenshot', params: args }
    case 'ui_control':
      return typeof args.method === 'string' ? { kind: 'request', method: args.method, params: obj(args.params) } : { kind: 'unsupported', why: 'ui_control needs a method' }
  }
  const method = UI_METHODS[tool]
  if (method) return { kind: 'request', method, params: args }
  return { kind: 'unsupported', why: `${tool} isn't available while FilmCraft is open in the chat. Use command_run, or open it in the full app.` }
}

// the export settings a native export gets: hardware encoding where the machine has it, unless asked otherwise
export function nativeExportParams(params: Record<string, unknown>): Record<string, unknown> {
  const settings = obj(params.settings)
  return { ...params, settings: { hardwareEncoding: 'auto', ...settings }, wait: true }
}

// ---- which embeds run live ----

export interface LiveCandidate {
  id: string
  // app and project: one live editor per document
  key: string
  visible: boolean
  // newest first wins: max(created, pinned)
  rank: number
}

// the embeds that get a running web editor: the newest you can see (or are about to), at most max,
// one per document. one that's live keeps running after it scrolls away while there's room, so
// scrolling back to it never reloads it
export function pickLive(cands: LiveCandidate[], current: ReadonlySet<string>, max = MAX_LIVE): Set<string> {
  const out = new Set<string>()
  const keys = new Set<string>()
  const visible = cands.filter((c) => c.visible).sort((a, b) => b.rank - a.rank)
  const pinnedTop = visible[0]
  const take = (c: LiveCandidate): void => {
    if (out.size >= max || keys.has(c.key) || out.has(c.id)) return
    out.add(c.id)
    keys.add(c.key)
  }
  // the one you asked for last goes first, then the ones already running, then the newest
  if (pinnedTop) take(pinnedTop)
  for (const c of visible) if (current.has(c.id)) take(c)
  for (const c of visible) take(c)
  // out of view but running: kept while no editor you can see needs the room
  for (const c of [...cands].sort((a, b) => b.rank - a.rank)) if (!c.visible && current.has(c.id)) take(c)
  return out
}

// ---- proxies ----

export interface ProbeInfo {
  width: number
  height: number
  bitRate: number
  codec: string
}

// footage worth a proxy in the web editor: bigger than 1080p, or a heavy bit rate or codec
export function wantsProxy(p: ProbeInfo): boolean {
  if (!p.width || !p.height) return false
  if (p.width * p.height > 1920 * 1080) return true
  if (p.bitRate > 25_000_000) return true
  return /prores|dnx|hevc|h265/i.test(p.codec)
}

// ffmpeg arguments for a proxy FilmCraft accepts: same frame rate and length, quarter size, short GOP
export function proxyArgs(input: string, output: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-vf', 'scale=-2:540', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-threads', '0', '-progress', 'pipe:1', '-nostats', output]
}
