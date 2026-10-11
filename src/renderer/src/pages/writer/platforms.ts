import type { PlatformDraft, WriterPlatform } from '@shared/types'

export interface FieldSpec {
  key: string
  label: string
  limit: number
  rows: number
  placeholder: string
  // what the counter shows, defaults to plain characters
  count?: (fields: Record<string, string>) => number
  countLabel?: string
}

export interface PlatformSpec {
  id: WriterPlatform
  name: string
  fields: FieldSpec[]
  // x only: a thread of posts instead of fields
  thread?: { limit: number }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// what most sites mean by characters: emoji and accented letters count once
export function chars(s: string): number {
  let n = 0
  for (const _ of graphemes.segment(s)) n++
  return n
}

const URL_RE =
  /https?:\/\/[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|ly|app|dev|gg|tv|me|ai|xyz)(?:\/[^\s]*)?/gi
const EMOJI_RE = /\p{Extended_Pictographic}/u

// x weighs text: links are always 23, emoji and cjk count 2, latin counts 1
export function xLength(text: string): number {
  let n = 0
  const rest = text.normalize('NFC').replace(URL_RE, () => {
    n += 23
    return ''
  })
  for (const { segment } of graphemes.segment(rest)) {
    if (EMOJI_RE.test(segment)) {
      n += 2
      continue
    }
    const cp = segment.codePointAt(0) ?? 0
    const light =
      cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247)
    n += light ? 1 : 2
  }
  return n
}

export function splitTags(s: string): string[] {
  return s
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

// youtube counts the commas between tags, and quotes around tags with spaces
export function ytTagsLength(s: string): number {
  const tags = splitTags(s)
  return tags.reduce((n, t) => n + chars(t) + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1)
}

export function hashtags(s: string): string[] {
  return s.match(/#[\p{L}\p{N}_]+/gu) ?? []
}

// "fitness gym, #lift" to "#fitness #gym #lift"
export function tidyHashtags(s: string): string {
  const words = s
    .split(/[\s,]+/)
    .map((w) => w.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean)
  return [...new Set(words)].map((w) => `#${w}`).join(' ')
}

// caption and hashtags go out as one block with a blank line between
export function captionWithTags(f: Record<string, string>): string {
  return [f.caption?.trim(), f.hashtags?.trim()].filter(Boolean).join('\n\n')
}

const captionCount = (f: Record<string, string>): number => chars(captionWithTags(f))

export const PLATFORMS: PlatformSpec[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    fields: [
      { key: 'title', label: 'Title', limit: 100, rows: 2, placeholder: 'The title people see first' },
      {
        key: 'description',
        label: 'Description',
        limit: 5000,
        rows: 9,
        placeholder: 'First two lines show above the fold, put the hook there'
      },
      {
        key: 'tags',
        label: 'Tags',
        limit: 500,
        rows: 2,
        placeholder: 'comma, separated, tags',
        count: (f) => ytTagsLength(f.tags ?? ''),
        countLabel: 'YouTube counts commas, and quotes around tags with spaces'
      }
    ]
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    fields: [
      {
        key: 'caption',
        label: 'Caption',
        limit: 2200,
        rows: 6,
        placeholder: 'Caption',
        count: captionCount,
        countLabel: 'Caption and hashtags together'
      },
      { key: 'hashtags', label: 'Hashtags', limit: 2200, rows: 2, placeholder: '#tag #tag' }
    ]
  },
  {
    id: 'instagram',
    name: 'Instagram',
    fields: [
      {
        key: 'caption',
        label: 'Caption',
        limit: 2200,
        rows: 6,
        placeholder: 'Caption',
        count: captionCount,
        countLabel: 'Caption and hashtags together'
      },
      {
        key: 'hashtags',
        label: 'Hashtags',
        limit: 30,
        rows: 2,
        placeholder: '#tag #tag, 30 at most',
        count: (f) => hashtags(captionWithTags(f)).length,
        countLabel: 'Hashtags in the caption and here, Instagram allows 30'
      }
    ]
  },
  {
    id: 'x',
    name: 'X',
    fields: [],
    thread: { limit: 280 }
  },
  {
    id: 'reddit',
    name: 'Reddit',
    fields: [
      { key: 'title', label: 'Title', limit: 300, rows: 2, placeholder: 'Post title' },
      { key: 'body', label: 'Body', limit: 40000, rows: 12, placeholder: 'Text, markdown works' }
    ]
  }
]

export const SPEC: Record<WriterPlatform, PlatformSpec> = Object.fromEntries(
  PLATFORMS.map((p) => [p.id, p])
) as Record<WriterPlatform, PlatformSpec>

export function fieldCount(spec: FieldSpec, fields: Record<string, string>): number {
  return spec.count ? spec.count(fields) : chars(fields[spec.key] ?? '')
}

export type Fit = 'empty' | 'ok' | 'near' | 'over'

export function fit(n: number, limit: number): Fit {
  if (n === 0) return 'empty'
  if (n > limit) return 'over'
  return n >= limit * 0.9 ? 'near' : 'ok'
}

// worst state across a platform, for the dot on its tab
export function platformFit(spec: PlatformSpec, d: PlatformDraft): Fit {
  const counts: [number, number][] = spec.thread
    ? d.thread.map((p) => [xLength(p), spec.thread!.limit])
    : spec.fields.map((f) => [fieldCount(f, d.fields), f.limit])
  const fits = counts.map(([n, l]) => fit(n, l))
  if (fits.includes('over')) return 'over'
  if (fits.includes('near')) return 'near'
  return fits.some((f) => f !== 'empty') ? 'ok' : 'empty'
}

// the text you'd paste into the site in one go
export function fullText(spec: PlatformSpec, d: PlatformDraft): string {
  if (spec.thread) return d.thread.filter((p) => p.trim()).join('\n\n')
  if (spec.id === 'tiktok' || spec.id === 'instagram') return captionWithTags(d.fields)
  return spec.fields
    .map((f) => (d.fields[f.key] ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
}

export function hasContent(d: PlatformDraft): boolean {
  return Object.values(d.fields).some((v) => v.trim()) || d.thread.some((p) => p.trim())
}
