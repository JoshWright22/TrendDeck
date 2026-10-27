import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  creditLine,
  visualFileStem,
  type VisualAsset,
  type VisualProvenance,
  type VisualResult
} from '@shared/visuals'

// files for visuals. no electron here, the folders come in as arguments so tests and scripts can
// point them at a temp folder:
// - <root>/<brand>/items/<id>.<ext> + <id>.json   sketches, pastes, drops and downloaded options
// - <root>/<brand>/thumbs/<hash>.<ext>            cached thumbnails of search results
// - <root>/<brand>/results.json                   recent search results, so card actions still work after a restart
// - <root>/<brand>/picks.json                     what the user did with visuals, for the agent's next turn
// - <project>/media/visuals/<name>.<ext> + <name>.<ext>.credit.json   files added to the video

export const ID = /^[a-zA-Z0-9-]{1,64}$/
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
export const PROJECT_DIR = 'media/visuals'
export const CREDIT_SUFFIX = '.credit.json'

export class VisualError extends Error {}

// ---------- image headers ----------

export interface ImageInfo {
  mime: string
  ext: string
  width: number
  height: number
}

// what an image file is and how big, from its first bytes. png, jpeg, gif and webp
export function imageInfo(b: Buffer): ImageInfo | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') {
    return { mime: 'image/png', ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  }
  if (b.length >= 10 && b.toString('ascii', 0, 4) === 'GIF8') {
    return { mime: 'image/gif', ext: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  }
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16)
    if (chunk === 'VP8X') return { mime: 'image/webp', ext: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
    if (chunk === 'VP8 ') return { mime: 'image/webp', ext: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return { mime: 'image/webp', ext: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const len = b.readUInt16BE(i + 2)
      // start of frame markers carry the size, except DHT, JPG and DAC
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', ext: 'jpg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
      }
      i += 2 + len
    }
    return { mime: 'image/jpeg', ext: 'jpg', width: 0, height: 0 }
  }
  return null
}

export function decodeDataUrl(dataUrl: string): Buffer {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl)
  if (!m) throw new VisualError('That should be a png, jpeg, webp or gif image.')
  const b = Buffer.from(m[2], 'base64')
  if (b.length > MAX_IMAGE_BYTES) throw new VisualError('That image is over 25 MB.')
  return b
}

// ---------- assets ----------

const brandDir = (root: string, brandId: string): string => {
  if (!ID.test(brandId)) throw new VisualError('bad brand id')
  return join(root, brandId)
}
const itemsDir = (root: string, brandId: string): string => join(brandDir(root, brandId), 'items')

export async function saveAsset(
  root: string,
  brandId: string,
  bytes: Buffer,
  meta: Pick<VisualAsset, 'origin' | 'name' | 'note' | 'sourceUrl' | 'source'>
): Promise<VisualAsset> {
  const info = imageInfo(bytes)
  if (!info) throw new VisualError("That isn't an image TrendDeck can use (png, jpeg, webp or gif).")
  if (bytes.length > MAX_IMAGE_BYTES) throw new VisualError('That image is over 25 MB.')
  const id = randomUUID()
  const dir = itemsDir(root, brandId)
  await fs.mkdir(dir, { recursive: true })
  const asset: VisualAsset = {
    id,
    brandId,
    origin: meta.origin,
    name: (meta.name || `${meta.origin}`).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 120) || 'visual',
    mime: info.mime,
    ext: info.ext,
    bytes: bytes.length,
    width: info.width,
    height: info.height,
    createdAt: Date.now(),
    source: meta.source,
    sourceUrl: meta.sourceUrl,
    note: meta.note.slice(0, 2000)
  }
  await fs.writeFile(join(dir, `${id}.${info.ext}`), bytes)
  await fs.writeFile(join(dir, `${id}.json`), JSON.stringify(asset), 'utf8')
  return asset
}

export async function readAsset(root: string, brandId: string, id: string): Promise<VisualAsset | null> {
  if (!ID.test(id)) return null
  try {
    const a = JSON.parse(await fs.readFile(join(itemsDir(root, brandId), `${id}.json`), 'utf8')) as VisualAsset
    return a && a.id === id && a.brandId === brandId ? a : null
  } catch {
    return null
  }
}

export function assetPath(root: string, a: Pick<VisualAsset, 'brandId' | 'id' | 'ext'>): string {
  return join(itemsDir(root, a.brandId), `${a.id}.${a.ext}`)
}

// the file behind td-media://visual/<brand>/<name>: an item or a cached thumbnail, nothing else
export function servedVisual(root: string, brandId: string, name: string): { path: string; ext: string } | null {
  if (!ID.test(brandId)) return null
  const item = /^items\/([a-zA-Z0-9-]{1,64})\.(png|jpg|gif|webp)$/.exec(name)
  if (item) return { path: join(itemsDir(root, brandId), `${item[1]}.${item[2]}`), ext: item[2] }
  const thumb = /^thumbs\/([a-f0-9]{40})\.(png|jpg|gif|webp)$/.exec(name)
  if (thumb) return { path: join(brandDir(root, brandId), 'thumbs', `${thumb[1]}.${thumb[2]}`), ext: thumb[2] }
  return null
}

export const thumbKey = (url: string): string => createHash('sha1').update(url).digest('hex')

export async function cachedThumb(root: string, brandId: string, url: string): Promise<string | null> {
  const key = thumbKey(url)
  const dir = join(brandDir(root, brandId), 'thumbs')
  for (const ext of ['jpg', 'png', 'gif', 'webp']) {
    try {
      await fs.access(join(dir, `${key}.${ext}`))
      return `thumbs/${key}.${ext}`
    } catch {
      // next
    }
  }
  return null
}

export async function saveThumb(root: string, brandId: string, url: string, bytes: Buffer): Promise<string> {
  const info = imageInfo(bytes)
  if (!info) throw new VisualError('not an image')
  const dir = join(brandDir(root, brandId), 'thumbs')
  await fs.mkdir(dir, { recursive: true })
  const name = `${thumbKey(url)}.${info.ext}`
  await fs.writeFile(join(dir, name), bytes)
  return `thumbs/${name}`
}

// ---------- recent results ----------

const MAX_RESULTS = 600

export async function rememberResults(root: string, brandId: string, results: VisualResult[]): Promise<void> {
  const file = join(brandDir(root, brandId), 'results.json')
  const have = await loadResults(root, brandId)
  const map = new Map(have.map((r) => [r.id, r]))
  for (const r of results) {
    map.delete(r.id)
    map.set(r.id, r)
  }
  const list = [...map.values()].slice(-MAX_RESULTS)
  await fs.mkdir(brandDir(root, brandId), { recursive: true })
  await fs.writeFile(`${file}.tmp`, JSON.stringify(list), 'utf8')
  await fs.rename(`${file}.tmp`, file)
}

export async function loadResults(root: string, brandId: string): Promise<VisualResult[]> {
  try {
    const raw = JSON.parse(await fs.readFile(join(brandDir(root, brandId), 'results.json'), 'utf8')) as unknown
    return Array.isArray(raw) ? (raw as VisualResult[]).filter((r) => r && typeof r.id === 'string' && typeof r.fileUrl === 'string') : []
  } catch {
    return []
  }
}

export async function findResult(root: string, brandId: string, id: string): Promise<VisualResult | null> {
  return (await loadResults(root, brandId)).find((r) => r.id === id) ?? null
}

// ---------- picks for the agent's next turn ----------

interface PickNote {
  at: number
  text: string
}

export async function addPick(root: string, brandId: string, threadId: string, text: string): Promise<void> {
  const file = join(brandDir(root, brandId), 'picks.json')
  let all: Record<string, PickNote[]> = {}
  try {
    all = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, PickNote[]>
  } catch {
    // none yet
  }
  const list = (all[threadId] ?? []).concat({ at: Date.now(), text: text.replace(/\s+/g, ' ').slice(0, 400) }).slice(-30)
  all[threadId] = list
  await fs.mkdir(brandDir(root, brandId), { recursive: true })
  await fs.writeFile(file, JSON.stringify(all), 'utf8')
}

// what happened since the last reply, cleared once told
export async function takePicks(root: string, brandId: string, threadId: string): Promise<string[]> {
  const file = join(brandDir(root, brandId), 'picks.json')
  let all: Record<string, PickNote[]>
  try {
    all = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, PickNote[]>
  } catch {
    return []
  }
  const list = all[threadId] ?? []
  if (!list.length) return []
  delete all[threadId]
  await fs.writeFile(file, JSON.stringify(all), 'utf8')
  return list.map((p) => p.text)
}

// ---------- the project folder ----------

const rel = (root: string, full: string): string => relative(root, full).split(sep).join('/')

async function uniqueTarget(dir: string, stem: string, ext: string): Promise<string> {
  const taken = new Set((await fs.readdir(dir).catch(() => [] as string[])).map((n) => n.toLowerCase()))
  let name = `${stem}.${ext}`
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${stem}-${i}.${ext}`
  return join(dir, name)
}

// the same source already in the folder, so adding it twice stays one file
async function existingFor(dir: string, sourceKey: string): Promise<string | null> {
  if (!sourceKey) return null
  for (const n of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!n.endsWith(CREDIT_SUFFIX)) continue
    try {
      const p = JSON.parse(await fs.readFile(join(dir, n), 'utf8')) as VisualProvenance
      const key = p.fileUrl || p.sourceUrl
      const file = join(dir, n.slice(0, -CREDIT_SUFFIX.length))
      if (key && key === sourceKey && (await fs.stat(file).catch(() => null))?.isFile()) return file
    } catch {
      // a broken sidecar doesn't match anything
    }
  }
  return null
}

export interface ProjectWrite {
  bytes: Buffer
  ext: string
  stem: string
  provenance: Omit<VisualProvenance, 'version' | 'file' | 'retrievedAt'> & { retrievedAt?: string }
}

// writes the file and its sidecar into <project>/media/visuals/. returns paths relative to the project
export async function writeToProject(projectRoot: string, w: ProjectWrite): Promise<{ file: string; sidecar: string; existed: boolean; provenance: VisualProvenance }> {
  const dir = join(projectRoot, ...PROJECT_DIR.split('/'))
  await fs.mkdir(dir, { recursive: true })
  const key = w.provenance.fileUrl || w.provenance.sourceUrl
  const have = w.provenance.origin === 'search' || w.provenance.origin === 'link' ? await existingFor(dir, key) : null
  if (have) {
    const provenance = JSON.parse(await fs.readFile(`${have}${CREDIT_SUFFIX}`, 'utf8')) as VisualProvenance
    return { file: rel(projectRoot, have), sidecar: rel(projectRoot, `${have}${CREDIT_SUFFIX}`), existed: true, provenance }
  }
  const ext = /^[a-z0-9]{2,5}$/.test(w.ext) ? w.ext : 'bin'
  const target = await uniqueTarget(dir, visualFileStem(w.stem), ext)
  await fs.writeFile(target, w.bytes, { flag: 'wx' })
  const provenance: VisualProvenance = {
    version: 1,
    file: rel(projectRoot, target),
    ...w.provenance,
    retrievedAt: w.provenance.retrievedAt ?? new Date().toISOString()
  }
  await fs.writeFile(`${target}${CREDIT_SUFFIX}`, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
  return { file: provenance.file, sidecar: rel(projectRoot, `${target}${CREDIT_SUFFIX}`), existed: false, provenance }
}

export function provenanceFromResult(r: VisualResult, note = ''): ProjectWrite['provenance'] {
  return {
    origin: 'search',
    provider: r.provider,
    title: r.title,
    author: r.author,
    authorUrl: r.authorUrl,
    sourceUrl: r.pageUrl,
    fileUrl: r.fileUrl,
    license: r.license,
    attribution: r.attribution,
    note
  }
}

export function provenanceFromAsset(a: VisualAsset): ProjectWrite['provenance'] {
  if (a.source) return { ...provenanceFromResult(a.source, a.note), retrievedAt: new Date(a.createdAt).toISOString() }
  return {
    origin: a.origin === 'search' ? 'link' : a.origin,
    provider: null,
    title: a.name,
    author: a.origin === 'sketch' ? 'you, drawn in TrendDeck' : '',
    authorUrl: '',
    sourceUrl: a.sourceUrl,
    fileUrl: a.sourceUrl,
    license: null,
    attribution: '',
    note: a.note,
    retrievedAt: new Date(a.createdAt).toISOString()
  }
}

// every sidecar in the project, newest first. looks in media/visuals and two levels anywhere else
export async function readCredits(projectRoot: string): Promise<VisualProvenance[]> {
  const out: { p: VisualProvenance; at: number }[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory() && depth < 3 && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(full, depth + 1)
      else if (e.isFile() && e.name.endsWith(CREDIT_SUFFIX)) {
        try {
          const p = JSON.parse(await fs.readFile(full, 'utf8')) as VisualProvenance
          if (p && p.version === 1 && typeof p.file === 'string') out.push({ p, at: Date.parse(p.retrievedAt) || 0 })
        } catch {
          // skip a broken one
        }
      }
    }
  }
  await walk(projectRoot, 0)
  return out.sort((a, b) => b.at - a.at).map((x) => x.p)
}

// the credits block for a video description: one line per file that needs or deserves credit
export function creditsText(list: VisualProvenance[]): string {
  const lines = [...new Set(list.map((p) => creditLine(p)).filter(Boolean))]
  return lines.length ? ['Credits:', ...lines.map((l) => `- ${l}`)].join('\n') : ''
}
