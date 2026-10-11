import type { ChannelShort } from '@shared/reuse'

// pulls the shorts out of a youtube channel /shorts page
// youtube puts the page data in a ytInitialData script, two shapes are seen in the wild

export function shortsUrl(channelUrl: string): string {
  const raw = channelUrl.trim()
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new Error('Use your channel link, like youtube.com/@yourname')
  }
  if (!/(^|\.)youtube\.com$/i.test(u.hostname)) throw new Error('Use a youtube.com channel link')
  const path = u.pathname.replace(/\/+$/, '').replace(/\/(shorts|videos|featured|streams)$/i, '')
  if (!/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)$/.test(path)) {
    throw new Error('Use your channel link, like youtube.com/@yourname')
  }
  return `https://www.youtube.com${path}/shorts`
}

function initialData(html: string): unknown {
  const m = /(?:var\s+ytInitialData|window\["ytInitialData"\])\s*=\s*/.exec(html)
  if (!m) return null
  // the object ends at the first ;</script> after it
  const start = m.index + m[0].length
  const end = html.indexOf(';</script>', start)
  if (end < 0) return null
  try {
    return JSON.parse(html.slice(start, end))
  } catch {
    return null
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

function text(v: unknown): string {
  if (!isObj(v)) return typeof v === 'string' ? v : ''
  if (typeof v.simpleText === 'string') return v.simpleText
  if (typeof v.content === 'string') return v.content
  if (Array.isArray(v.runs)) return v.runs.map((r) => (isObj(r) ? String(r.text ?? '') : '')).join('')
  return ''
}

export function parseShorts(html: string): ChannelShort[] {
  const data = initialData(html)
  const out = new Map<string, ChannelShort>()
  const add = (id: unknown, title: string, views: string): void => {
    if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id) || out.has(id)) return
    out.set(id, { id, title: title.trim(), url: `https://www.youtube.com/shorts/${id}`, views: views.trim() })
  }
  const visit = (v: unknown, depth: number): void => {
    if (depth > 60) return
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1)
      return
    }
    if (!isObj(v)) return
    const reel = v.reelItemRenderer
    if (isObj(reel)) add(reel.videoId, text(reel.headline), text(reel.viewCountText))
    const lockup = v.shortsLockupViewModel
    if (isObj(lockup)) {
      const meta = isObj(lockup.overlayMetadata) ? lockup.overlayMetadata : {}
      const cmd = isObj(lockup.onTap) ? lockup.onTap.innertubeCommand : null
      const watch = isObj(cmd) && isObj(cmd.reelWatchEndpoint) ? cmd.reelWatchEndpoint.videoId : null
      const fromEntity = typeof lockup.entityId === 'string' ? lockup.entityId.replace(/^shorts-shelf-item-/, '') : null
      add(watch ?? fromEntity, text(meta.primaryText), text(meta.secondaryText))
    }
    for (const x of Object.values(v)) visit(x, depth + 1)
  }
  if (data) visit(data, 0)
  // fallback when the data blob moved, links still carry the ids
  if (!out.size) {
    for (const m of html.matchAll(/\/shorts\/([\w-]{11})/g)) add(m[1], '', '')
  }
  return [...out.values()]
}
