import { protocol } from 'electron'
import { createReadStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { MEDIA_SCHEME } from '@shared/media'
import { getLib, thumbPath, validId } from './library'
import { servedPath } from '../cards/files'

// has to run before the app is ready
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
    }
  ])
}

const TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  weba: 'audio/webm',
  mkv: 'video/x-matroska',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac'
}

// the canvas that grabs poster frames needs cors or it can't read the pixels
const CORS = { 'Access-Control-Allow-Origin': '*' }

function notFound(): Response {
  return new Response(null, { status: 404, headers: CORS })
}

async function serveFile(path: string, type: string, range: string | null): Promise<Response> {
  const size = (await fs.stat(path)).size
  const headers: Record<string, string> = {
    ...CORS,
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache'
  }
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
  if (m && size > 0) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2])
    let end = m[1] && m[2] ? Number(m[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(end, size - 1)
    if (start > end) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    }
    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
    })
  }
  const body = Readable.toWeb(createReadStream(path)) as ReadableStream
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
}

// only the app window's own session gets this, site tabs live in brand partitions and never see it.
// it serves files that are already in the library by id, never a path
export function handleMediaScheme(): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    try {
      const url = new URL(req.url)
      // a file in a project folder for a chat card, td-media://project/<brand>/<project>/<file>
      if (url.hostname === 'project') {
        const [b, p, ...rest] = url.pathname.split('/').filter(Boolean)
        const path = rest.length ? await servedPath(b, p, decodeURIComponent(rest.join('/'))) : null
        if (!path) return notFound()
        const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
        return await serveFile(path, TYPES[ext] ?? 'application/octet-stream', req.headers.get('range'))
      }
      const [brandId, id] = url.pathname.split('/').filter(Boolean)
      if (!validId(brandId) || !validId(id)) return notFound()
      const lib = await getLib(brandId)
      const item = lib.items.find((i) => i.id === id)
      if (!item) return notFound()
      if (url.hostname === 'thumb') {
        if (!item.hasThumb) return notFound()
        return await serveFile(thumbPath(brandId, id), 'image/jpeg', null)
      }
      if (url.hostname !== 'file') return notFound()
      return await serveFile(item.path, TYPES[item.ext] ?? 'application/octet-stream', req.headers.get('range'))
    } catch {
      return notFound()
    }
  })
}
