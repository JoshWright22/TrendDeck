import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, promises as fs, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  CUSTOM_ID, LOCAL_DTYPES, LOCAL_MODELS, ONNX_SUFFIX, customRepoId, localModel, variantFiles,
  type LocalDtype, type LocalModelInfo, type LocalModelProgress, type LocalModelsState, type LocalVariant, type OnnxDtype
} from '../../shared/dictation'

// local speech models: downloaded once from Hugging Face into userData/stt/models/<id>/<dtype>/,
// served to the dictation worker as td-media://stt/<id>/<dtype>/<file>. a manifest written last
// marks a finished download. nothing is fetched at run time

const MANIFEST = 'manifest.json'
const HF = 'https://huggingface.co'

export function sttRoot(): string {
  return join(app.getPath('userData'), 'stt')
}

export function modelsRoot(): string {
  return join(sttRoot(), 'models')
}

export function variantDir(id: string, dtype: LocalDtype): string {
  return join(modelsRoot(), id, dtype)
}

export function fileUrl(info: LocalModelInfo, path: string): string {
  return `${HF}/${info.repo}/resolve/main/${path}`
}

// ---------- custom models ----------

let customCache: LocalModelInfo[] | null = null

function customPath(): string {
  return join(sttRoot(), 'custom.json')
}

export function customModels(): LocalModelInfo[] {
  if (customCache) return customCache
  try {
    const raw = JSON.parse(readFileSync(customPath(), 'utf8')) as unknown
    customCache = Array.isArray(raw) ? (raw as LocalModelInfo[]).filter((m) => CUSTOM_ID.test(m?.id) && customRepoId(m.repo) === m.id) : []
  } catch {
    customCache = []
  }
  return customCache
}

async function saveCustom(list: LocalModelInfo[]): Promise<void> {
  await fs.mkdir(sttRoot(), { recursive: true })
  await fs.writeFile(`${customPath()}.tmp`, JSON.stringify(list, null, 2))
  await fs.rename(`${customPath()}.tmp`, customPath())
  customCache = list
}

export function findModel(id: unknown): LocalModelInfo | undefined {
  return localModel(id, customModels())
}

interface TreeEntry { size: number; oid: string; lfsOid?: string }

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, redirect: 'follow' })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(res.status === 401 || res.status === 404 ? 'That model is not on Hugging Face.' : `Hugging Face returned HTTP ${res.status}.`)
  }
  return res.json()
}

// path -> size and hashes, for the repo root and its onnx folder
async function listRepo(repo: string, signal?: AbortSignal): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>()
  for (const dir of ['', '/onnx']) {
    const list = (await getJson(`${HF}/api/models/${repo}/tree/main${dir}`, signal)) as { type?: string; path?: string; size?: number; oid?: string; lfs?: { oid?: string } }[]
    if (!Array.isArray(list)) throw new Error('Hugging Face returned an unexpected file list.')
    for (const f of list) {
      if (f.type !== 'file' || typeof f.path !== 'string' || typeof f.size !== 'number' || typeof f.oid !== 'string') continue
      out.set(f.path, { size: f.size, oid: f.oid, lfsOid: f.lfs?.oid })
    }
  }
  return out
}

// an onnx-community repo typed in Settings: speech models transformers.js can run, files that
// fit without external data. word times are exact only for the _timestamped exports
export async function addCustomModel(repo: unknown): Promise<LocalModelInfo> {
  if (typeof repo !== 'string') throw new Error('Enter a model id like onnx-community/whisper-large-v3.')
  const id = customRepoId(repo.trim())
  if (!id) throw new Error('Enter an onnx-community model id, like onnx-community/whisper-large-v3.')
  const name = repo.trim().slice('onnx-community/'.length)
  if (LOCAL_MODELS.some((m) => m.repo === repo.trim())) throw new Error('That model is already in the list.')
  const config = (await getJson(`${HF}/${repo.trim()}/resolve/main/config.json`)) as { model_type?: unknown }
  const family = config?.model_type === 'whisper' || config?.model_type === 'lite-whisper' ? 'whisper' : config?.model_type === 'moonshine' ? 'moonshine' : null
  if (!family) throw new Error('Only Whisper and Moonshine speech models can run here.')
  const files = await listRepo(repo.trim())
  for (const f of ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json']) {
    if (!files.has(f)) throw new Error(`The repo is missing ${f}.`)
  }
  const part = (file: string, d: OnnxDtype): number | null => {
    const path = `onnx/${file}${ONNX_SUFFIX[d]}.onnx`
    // a model over 2 GB comes with external data, which the worker doesn't load
    if (!files.has(path) || files.has(`${path}_data`)) return null
    return files.get(path)!.size
  }
  const variants: Partial<Record<LocalDtype, LocalVariant>> = {}
  for (const d of LOCAL_DTYPES) {
    const enc = part('encoder_model', d)
    const dec = part('decoder_model_merged', d)
    if (enc !== null && dec !== null) variants[d] = { encoder: d, decoder: d, bytes: enc + dec + 2_770_000 }
  }
  const available = Object.keys(variants) as LocalDtype[]
  if (!available.length) throw new Error('The repo has no encoder and decoder files this app can load.')
  const info: LocalModelInfo = {
    id, label: name, repo: repo.trim(), family,
    englishOnly: /\.en($|[_-])/.test(name) || family === 'moonshine',
    wordTimes: family === 'whisper' && /_timestamped$/.test(name) ? 'exact' : 'approximate',
    speed: 'Depends on size', note: 'Added from Hugging Face.',
    variants, defaultDtype: (['q8', 'q4', 'fp16', 'fp32'] as LocalDtype[]).find((d) => variants[d]) ?? available[0],
    custom: true
  }
  await saveCustom([...customModels().filter((m) => m.id !== id), info])
  return info
}

export async function removeCustomModel(id: unknown): Promise<void> {
  const info = customModels().find((m) => m.id === id)
  if (!info) throw new Error('Unknown model.')
  await deleteModel(info.id)
  await saveCustom(customModels().filter((m) => m.id !== info.id))
}

// ---------- installed state ----------

interface Manifest {
  repo: string
  dtype: LocalDtype
  files: { path: string; size: number; sha256?: string; gitSha1?: string; etag?: string }[]
  downloadedAt: number
}

function readManifest(id: string, dtype: LocalDtype): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(variantDir(id, dtype), MANIFEST), 'utf8')) as Manifest
  } catch {
    return null
  }
}

export function isInstalled(id: string, dtype: LocalDtype): boolean {
  const info = findModel(id)
  if (!info?.variants[dtype]) return false
  const manifest = readManifest(info.id, dtype)
  if (!manifest) return false
  const dir = variantDir(info.id, dtype)
  return variantFiles(info, dtype).every((path) => {
    const want = manifest.files.find((f) => f.path === path)
    try {
      return !!want && statSync(join(dir, ...path.split('/'))).size === want.size
    } catch {
      return false
    }
  })
}

export function installedDtypes(id: string): LocalDtype[] {
  return LOCAL_DTYPES.filter((d) => isInstalled(id, d))
}

// a request for td-media://stt/<id>/<dtype>/<path>: only the files that variant lists, of a
// finished download, so nothing else under userData (or anywhere) can be read through it
export function servedModelFile(pathname: string): string | null {
  let parts: string[]
  try {
    parts = pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
  } catch {
    return null
  }
  const [id, dtype, ...rest] = parts
  const info = findModel(id)
  if (!info || !rest.length || !LOCAL_DTYPES.includes(dtype as LocalDtype)) return null
  const path = rest.join('/')
  if (!variantFiles(info, dtype as LocalDtype).includes(path)) return null
  if (!readManifest(info.id, dtype as LocalDtype)) return null
  const dir = variantDir(info.id, dtype as LocalDtype)
  const full = join(dir, ...rest)
  if (!full.startsWith(dir + sep)) return null
  return existsSync(full) ? full : null
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += await folderBytes(p)
    else if (e.isFile()) total += (await fs.stat(p).catch(() => ({ size: 0 }))).size
  }
  return total
}

interface Active {
  controller: AbortController
  received: number
  total: number
  done: Promise<void>
}

const active = new Map<string, Active>()
const key = (id: string, dtype: LocalDtype): string => `${id}/${dtype}`

export async function modelsState(): Promise<LocalModelsState> {
  const all = [...LOCAL_MODELS, ...customModels()]
  return {
    models: all.map((m) => ({
      id: m.id,
      installed: installedDtypes(m.id),
      downloading: (Object.keys(m.variants) as LocalDtype[]).flatMap((dtype) => {
        const a = active.get(key(m.id, dtype))
        return a ? [{ dtype, received: a.received, total: a.total }] : []
      })
    })),
    diskBytes: await folderBytes(modelsRoot())
  }
}

// ---------- downloads ----------

function gitBlobSha1(): { update(b: Buffer): void; start(size: number): void; digest(): string } {
  const h = createHash('sha1')
  return { start: (size) => h.update(`blob ${size}\0`), update: (b) => h.update(b), digest: () => h.digest('hex') }
}

async function fetchFile(
  url: string, dest: string, want: TreeEntry, signal: AbortSignal, onBytes: (n: number) => void
): Promise<{ size: number; sha256?: string; gitSha1?: string; etag?: string }> {
  const response = await fetch(url, { signal, redirect: 'follow' })
  const name = url.split('/').pop()
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`Hugging Face returned HTTP ${response.status} for ${name}.`)
  }
  const etag = response.headers.get('x-linked-etag') ?? response.headers.get('etag') ?? undefined
  const part = `${dest}.part`
  let written = 0
  const sha256 = createHash('sha256')
  const sha1 = gitBlobSha1()
  sha1.start(want.size)
  const counted = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
  counted.on('data', (chunk: Buffer) => {
    written += chunk.length
    if (want.lfsOid) sha256.update(chunk)
    else sha1.update(chunk)
    onBytes(chunk.length)
  })
  try {
    await pipeline(counted, createWriteStream(part), { signal })
    if (written !== want.size) throw new Error(`${name} downloaded incompletely (${written} of ${want.size} bytes).`)
    const out: { size: number; sha256?: string; gitSha1?: string; etag?: string } = { size: written, etag }
    if (want.lfsOid) {
      out.sha256 = sha256.digest('hex')
      if (out.sha256 !== want.lfsOid) throw new Error(`${name} did not match its checksum.`)
    } else {
      out.gitSha1 = sha1.digest()
      if (out.gitSha1 !== want.oid) throw new Error(`${name} did not match its checksum.`)
    }
    await fs.rename(part, dest)
    return out
  } catch (err) {
    await fs.rm(part, { force: true }).catch(() => {})
    throw err
  }
}

// several downloads can run at once, one per model and dtype. files that already finished
// (an earlier cancelled try) are kept when their size matches
export async function downloadModel(id: string, dtype: LocalDtype, progress: (p: LocalModelProgress) => void): Promise<void> {
  const info = findModel(id)
  if (!info) throw new Error('Unknown model.')
  if (!info.variants[dtype]) throw new Error(`${info.label} has no ${dtype} download.`)
  const k = key(info.id, dtype)
  const running = active.get(k)
  if (running) return running.done
  const controller = new AbortController()
  const dir = variantDir(info.id, dtype)
  const state: Active = { controller, received: 0, total: info.variants[dtype]!.bytes, done: Promise.resolve() }
  let last = 0
  const report = (force = false): void => {
    const now = Date.now()
    if (!force && now - last < 200) return
    last = now
    progress({ id: info.id, dtype, state: 'downloading', received: state.received, total: state.total })
  }
  state.done = (async () => {
    await fs.mkdir(join(dir, 'onnx'), { recursive: true })
    await fs.rm(join(dir, MANIFEST), { force: true })
    report(true)
    const listing = await listRepo(info.repo, controller.signal)
    const paths = variantFiles(info, dtype)
    const missing = paths.filter((p) => !listing.has(p))
    if (missing.length) throw new Error(`Hugging Face no longer has ${missing.join(', ')} for ${info.label}.`)
    state.total = paths.reduce((s, p) => s + listing.get(p)!.size, 0)
    const files: Manifest['files'] = []
    for (const path of paths) {
      const want = listing.get(path)!
      const dest = join(dir, ...path.split('/'))
      const have = existsSync(dest) ? statSync(dest).size : -1
      if (have === want.size) {
        state.received += have
        files.push({ path, size: have, ...(want.lfsOid ? { sha256: want.lfsOid } : { gitSha1: want.oid }) })
        report()
        continue
      }
      const got = await fetchFile(fileUrl(info, path), dest, want, controller.signal, (n) => {
        state.received += n
        report()
      })
      files.push({ path, ...got })
    }
    const manifest: Manifest = { repo: info.repo, dtype, files, downloadedAt: Date.now() }
    await fs.writeFile(join(dir, MANIFEST), JSON.stringify(manifest, null, 2))
  })()
  active.set(k, state)
  try {
    await state.done
    progress({ id: info.id, dtype, state: 'done', received: state.total, total: state.total })
  } catch (err) {
    if (controller.signal.aborted) {
      progress({ id: info.id, dtype, state: 'cancelled', received: state.received, total: state.total })
      throw new Error('Download cancelled.')
    }
    const message = err instanceof Error ? err.message : 'Download failed.'
    const plain = /^(Hugging Face|That model)|incompletely|checksum/.test(message) ? message : 'Download failed. Check your connection and try again.'
    progress({ id: info.id, dtype, state: 'error', received: state.received, total: state.total, error: plain })
    throw new Error(plain)
  } finally {
    active.delete(k)
  }
}

export function cancelDownload(id: string, dtype: LocalDtype): void {
  active.get(key(id, dtype))?.controller.abort()
}

export async function deleteModel(id: string, dtype?: LocalDtype): Promise<void> {
  const info = findModel(id)
  if (!info) throw new Error('Unknown model.')
  const dtypes = dtype ? [dtype] : LOCAL_DTYPES
  for (const d of dtypes) {
    const a = active.get(key(info.id, d))
    if (a) {
      a.controller.abort()
      await a.done.catch(() => {})
    }
    await fs.rm(variantDir(info.id, d), { recursive: true, force: true })
  }
  if (!dtype) await fs.rm(join(modelsRoot(), info.id), { recursive: true, force: true })
}
