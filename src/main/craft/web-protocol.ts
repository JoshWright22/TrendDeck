import { createReadStream, promises as fs } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { ISOLATION_HEADERS, mimeOf, parseRange, webTarget } from '@shared/craft-web'

// craft-web://<app>/<file>: the app's web build, read only, with the headers that make the page
// cross-origin isolated. craft-web://<app>/_project/<token>/<file>: a file of the project an open
// embed is on, read only, with byte ranges so footage streams in pieces. the token is made by main
// for one embed and dropped when it closes, so the page can't name another project or folder.
// no electron here, index.ts hooks it to the embeds' session

export interface WebProtocolDeps {
  // the installed web build of an app, null when there's none
  appRoot(appId: string): Promise<string | null>
  // the project folder an embed's token stands for, null for an unknown token or another app
  projectRoot(appId: string, token: string): string | null
}

const empty = (status: number, headers: Record<string, string> = {}): Response => new Response(null, { status, headers: { ...ISOLATION_HEADERS, ...headers } })

// the real file under root, or null when it's not a regular file inside it (links out of it too)
async function contained(root: string, rel: string): Promise<{ path: string; size: number } | null> {
  const want = resolve(root, ...rel.split('/'))
  const r = relative(resolve(root), want)
  if (!r || r.startsWith('..') || r.includes(`..${sep}`) || resolve(root, r) !== want) return null
  try {
    const [realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(want)])
    const rr = relative(realRoot, real)
    if (!rr || rr.startsWith('..') || resolve(realRoot, rr) !== real) return null
    const st = await fs.stat(real)
    return st.isFile() ? { path: real, size: st.size } : null
  } catch {
    return null
  }
}

function fileResponse(file: { path: string; size: number }, name: string, range: string | null, extra: Record<string, string>): Response {
  const headers: Record<string, string> = { ...ISOLATION_HEADERS, 'Content-Type': mimeOf(name), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', ...extra }
  const r = parseRange(range, file.size)
  if (r === 'unsatisfiable') return empty(416, { ...headers, 'Content-Range': `bytes */${file.size}` })
  if (r) {
    const body = Readable.toWeb(createReadStream(file.path, { start: r.start, end: r.end })) as ReadableStream
    return new Response(body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${r.start}-${r.end}/${file.size}`, 'Content-Length': String(r.end - r.start + 1) } })
  }
  const body = file.size ? (Readable.toWeb(createReadStream(file.path)) as ReadableStream) : null
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(file.size) } })
}

export async function craftWebResponse(url: string, method: string, range: string | null, deps: WebProtocolDeps): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') return empty(405)
  const t = webTarget(url)
  if (!t) return empty(404)
  let root: string | null
  if (t.kind === 'app') root = await deps.appRoot(t.appId)
  else root = deps.projectRoot(t.appId, t.token)
  if (!root) return empty(404)
  const file = await contained(root, t.rel)
  if (!file) return empty(404)
  const res = fileResponse(file, t.rel, range, t.kind === 'project' ? { 'Cache-Control': 'no-store' } : {})
  return method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res
}

export const projectUrl = (appId: string, token: string, rel: string): string =>
  `craft-web://${appId}/_project/${token}/${rel.split(/[\\/]/).map(encodeURIComponent).join('/')}`

export const appUrl = (appId: string, query: string): string => `craft-web://${appId}/index.html${query}`
