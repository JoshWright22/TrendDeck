import { app, net } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import yauzl from 'yauzl'
import { loadData } from '../store'
import { webSpec } from '@shared/craft-web'
import { APPS, spec } from './catalog'
import { newer, parseSums, pickAsset, versionFromTag, webAssetName, zipTarget } from './rules'
import { liveOf, setLive } from './state'

// each app is the portable zip from its GitHub release, unpacked into
// %LOCALAPPDATA%\TrendDeck\craft\<id>\<version>\ and picked by <id>\current.json.
// a download is checked against the release's SHA256SUMS.txt before anything is unpacked

const SIX_HOURS = 6 * 60 * 60 * 1000
// a zip of a craft app is around 100 MB, nothing near this
const MAX_ZIP = 1024 * 1024 * 1024
const MAX_UNPACKED = 4 * 1024 * 1024 * 1024

export function craftRoot(): string {
  if (process.env.TRENDDECK_CRAFT_DIR) return process.env.TRENDDECK_CRAFT_DIR
  const local = process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local')
  return join(local, 'TrendDeck', 'craft')
}

const appDir = (id: string): string => join(craftRoot(), id)

interface Current {
  version: string
  previous: string | null
}

interface Release {
  version: string
  asset: string
  url: string
  size: number
  sumsUrl: string
  publishedAt: string
  // the release's web build, <id>-web-<version>.zip. undefined in caches from before it was read
  web?: { asset: string; url: string; size: number } | null
}

interface ReleaseCache {
  checkedAt: number
  apps: Record<string, { etag: string | null; release: Release | null }>
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2))
  await fs.rename(tmp, file)
}

export async function current(id: string): Promise<Current | null> {
  const c = await readJson<Current>(join(appDir(id), 'current.json'))
  if (!c || typeof c.version !== 'string' || !versionFromTag(c.version)) return null
  return { version: c.version, previous: typeof c.previous === 'string' ? c.previous : null }
}

// the installed app's folder, its exe and cli. null when it isn't installed
export async function installed(id: string): Promise<{ version: string; dir: string; exe: string; cli: string } | null> {
  const c = await current(id)
  if (!c) return null
  const dir = join(appDir(id), c.version)
  const exe = join(dir, `${id}.exe`)
  try {
    await fs.access(exe)
  } catch {
    return null
  }
  return { version: c.version, dir, exe, cli: join(dir, `${id}-cli.exe`) }
}

export function versionDir(id: string, version: string): string {
  return join(appDir(id), version)
}

// ---- releases ----

const cacheFile = (): string => join(craftRoot(), 'releases.json')
let cache: ReleaseCache | null = null

async function loadCache(): Promise<ReleaseCache> {
  if (!cache) {
    const c = await readJson<ReleaseCache>(cacheFile())
    cache = c && typeof c.checkedAt === 'number' && c.apps ? c : { checkedAt: 0, apps: {} }
  }
  return cache
}

interface GhRelease {
  tag_name: string
  draft: boolean
  published_at: string
  assets: { name: string; size: number; browser_download_url: string }[]
}

// the app's latest release, asked with the last etag so an unchanged answer is free
async function fetchRelease(id: string): Promise<Release | null> {
  const c = await loadCache()
  const prev = c.apps[id]
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (prev?.etag) headers['If-None-Match'] = prev.etag
  const res = await net.fetch(`https://api.github.com/repos/${spec(id).repo}/releases/latest`, { headers, cache: 'no-store' })
  if (res.status === 304 && prev) return prev.release
  if (!res.ok) throw new Error(`GitHub said ${res.status} for ${spec(id).name}`)
  const r = (await res.json()) as GhRelease
  const version = versionFromTag(r.tag_name)
  const names = r.assets.map((a) => a.name)
  const asset = version ? pickAsset(names, id, version, process.arch) : null
  const zip = r.assets.find((a) => a.name === asset)
  const sums = r.assets.find((a) => a.name === 'SHA256SUMS.txt')
  const web = version ? r.assets.find((a) => a.name === webAssetName(id, version)) : undefined
  const release: Release | null =
    version && zip && sums && !r.draft
      ? {
          version, asset: zip.name, url: zip.browser_download_url, size: zip.size, sumsUrl: sums.browser_download_url, publishedAt: r.published_at,
          web: web ? { asset: web.name, url: web.browser_download_url, size: web.size } : null
        }
      : null
  c.apps[id] = { etag: res.headers.get('etag'), release }
  return release
}

// every app's latest release, from GitHub when the cache is older than maxAge
export async function refreshReleases(maxAge = SIX_HOURS): Promise<void> {
  const c = await loadCache()
  if (Date.now() - c.checkedAt < maxAge) {
    for (const a of APPS) setLive(a.id, { latest: c.apps[a.id]?.release?.version ?? null }, false)
    return
  }
  const results = await Promise.allSettled(APPS.map((a) => fetchRelease(a.id)))
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`craft release check failed for ${APPS[i].id}`, r.reason)
  })
  if (results.some((r) => r.status === 'fulfilled')) c.checkedAt = Date.now()
  await writeJson(cacheFile(), c).catch(() => {})
  for (const a of APPS) setLive(a.id, { latest: c.apps[a.id]?.release?.version ?? null })
}

async function releaseFor(id: string): Promise<Release> {
  const c = await loadCache()
  let r = c.apps[id]?.release ?? null
  if (!r || (r.web === undefined && webSpec(id)) || Date.now() - c.checkedAt > 10 * 60_000) {
    r = await fetchRelease(id)
    await writeJson(cacheFile(), c).catch(() => {})
  }
  if (!r) throw new Error(`${spec(id).name} has no Windows build on its latest release yet`)
  setLive(id, { latest: r.version }, false)
  return r
}

// ---- download and unpack ----

// progress only shows for a first install, an update downloads quietly behind the installed app
async function download(id: string, r: Pick<Release, 'asset' | 'url' | 'size' | 'sumsUrl' | 'version'>, file: string, progress: boolean): Promise<void> {
  const sumsRes = await net.fetch(r.sumsUrl, { cache: 'no-store' })
  if (!sumsRes.ok) throw new Error(`couldn't get the checksums: ${sumsRes.status}`)
  const want = parseSums(await sumsRes.text()).get(r.asset)
  if (!want) throw new Error(`the release's SHA256SUMS.txt doesn't list ${r.asset}`)

  const res = await net.fetch(r.url)
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`)
  const total = Number(res.headers.get('content-length')) || r.size
  if (total > MAX_ZIP) throw new Error('the download is too big')
  const hash = createHash('sha256')
  const out = createWriteStream(file)
  let received = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_ZIP) throw new Error('the download is too big')
      hash.update(value)
      if (!out.write(value)) await new Promise<void>((ok) => out.once('drain', () => ok()))
      if (progress) setLive(id, { install: { kind: 'installing', version: r.version, received, total } })
    }
    await new Promise<void>((ok, fail) => out.end((err?: Error | null) => (err ? fail(err) : ok())))
  } catch (err) {
    out.destroy()
    throw err
  }
  if (hash.digest('hex') !== want) throw new Error('the download failed its SHA-256 check, nothing was installed')
}

function unzip(file: string, dest: string, top: string): Promise<void> {
  return new Promise((ok, fail) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (err, zip) => {
      if (err || !zip) return fail(err ?? new Error('bad zip'))
      let total = 0
      const done = (e?: unknown): void => {
        zip.close()
        if (e) fail(e)
        else ok()
      }
      zip.on('error', done)
      zip.on('end', () => done())
      zip.on('entry', (entry: yauzl.Entry) => {
        let target: string | null
        try {
          target = zipTarget(dest, entry.fileName, top)
        } catch (e) {
          return done(e)
        }
        // symlinks and other odd entries are skipped, only plain files and folders come out
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000
        if (!target || mode === 0o120000) return zip.readEntry()
        if (entry.fileName.endsWith('/')) {
          fs.mkdir(target, { recursive: true }).then(() => zip.readEntry(), done)
          return
        }
        total += entry.uncompressedSize
        if (total > MAX_UNPACKED) return done(new Error('the zip unpacks to too much'))
        const to = target
        fs.mkdir(dirname(to), { recursive: true }).then(() => {
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return done(e ?? new Error('bad zip entry'))
            const out = createWriteStream(to)
            stream.on('error', done)
            out.on('error', done)
            out.on('finish', () => zip.readEntry())
            stream.pipe(out)
          })
        }, done)
      })
      zip.readEntry()
    })
  })
}

// downloads, checks and unpacks a version into its own folder. the folder only gets its real name
// once everything is in it, so a half unpacked app is never picked
async function fetchVersion(id: string, r: Release, progress: boolean): Promise<void> {
  const final = versionDir(id, r.version)
  try {
    await fs.access(join(final, `${id}.exe`))
    return
  } catch {
    // not there yet
  }
  const tmpDir = join(appDir(id), '.download')
  await fs.mkdir(tmpDir, { recursive: true })
  const zip = join(tmpDir, `${r.asset}.part`)
  const partial = join(tmpDir, r.version)
  if (progress) setLive(id, { install: { kind: 'installing', version: r.version, received: 0, total: r.size } })
  try {
    await download(id, r, zip, progress)
    await fs.rm(partial, { recursive: true, force: true })
    await unzip(zip, partial, r.asset.replace(/\.zip$/, ''))
    await fs.access(join(partial, `${id}.exe`)).catch(() => {
      throw new Error(`the zip has no ${id}.exe`)
    })
    await fs.rm(final, { recursive: true, force: true })
    await fs.rename(partial, final)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
  // the web build goes in with the app it belongs to. the desktop app works without it
  if (webSpec(id)) await fetchWeb(id, r).catch((err) => console.error(`craft: no web build for ${id} ${r.version}`, err))
}

// ---- the web build, <craft>\<id>\<version>\web\ (index.html and its files) ----

export const webDirOf = (id: string, version: string): string => join(versionDir(id, version), 'web')

async function hasWeb(dir: string): Promise<boolean> {
  return fs.access(join(dir, 'index.html')).then(() => true, () => false)
}

// the release of exactly this version, so the web build always matches the installed app
async function releaseOf(id: string, version: string): Promise<Release> {
  const latest = await releaseFor(id).catch(() => null)
  if (latest?.version === version) return latest
  const res = await net.fetch(`https://api.github.com/repos/${spec(id).repo}/releases/tags/v${version}`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })
  if (!res.ok) throw new Error(`GitHub said ${res.status} for ${spec(id).name} ${version}`)
  const g = (await res.json()) as GhRelease
  const sums = g.assets.find((a) => a.name === 'SHA256SUMS.txt')
  const web = g.assets.find((a) => a.name === webAssetName(id, version))
  if (!sums) throw new Error(`${spec(id).name} ${version} has no SHA256SUMS.txt`)
  return {
    version, asset: '', url: '', size: 0, sumsUrl: sums.browser_download_url, publishedAt: g.published_at,
    web: web ? { asset: web.name, url: web.browser_download_url, size: web.size } : null
  }
}

// downloads the web zip, checks it against the release's SHA256SUMS.txt, unpacks it next to the app
async function fetchWeb(id: string, r: Release): Promise<string> {
  const final = webDirOf(id, r.version)
  if (await hasWeb(final)) return final
  const rel = r.web === undefined ? await releaseOf(id, r.version) : r
  if (!rel.web) throw new Error(`${spec(id).name} ${r.version} has no web build`)
  const tmpDir = join(appDir(id), '.download-web')
  await fs.mkdir(tmpDir, { recursive: true })
  const zip = join(tmpDir, `${rel.web.asset}.part`)
  const partial = join(tmpDir, 'web')
  try {
    await download(id, { ...rel.web, sumsUrl: rel.sumsUrl, version: r.version }, zip, false)
    await fs.rm(partial, { recursive: true, force: true })
    await unzip(zip, partial, rel.web.asset.replace(/\.zip$/, ''))
    if (!(await hasWeb(partial))) throw new Error('the web zip has no index.html')
    await fs.rm(final, { recursive: true, force: true })
    await fs.rename(partial, final)
    return final
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

const webBusy = new Map<string, Promise<string>>()

// the installed version's web build, downloaded when it isn't there yet (an app installed before
// TrendDeck knew about web builds)
export function ensureWeb(id: string): Promise<string> {
  const running = webBusy.get(id)
  if (running) return running
  const job = (async () => {
    const have = await installed(id)
    if (!have) throw new Error(`${spec(id).name} isn't installed`)
    const dir = webDirOf(id, have.version)
    if (await hasWeb(dir)) return dir
    return fetchWeb(id, await releaseOf(id, have.version))
  })().finally(() => webBusy.delete(id))
  webBusy.set(id, job)
  return job
}

// the installed web build's folder, null when there's none yet
export async function installedWeb(id: string): Promise<string | null> {
  const have = await installed(id)
  if (!have) return null
  const dir = webDirOf(id, have.version)
  return (await hasWeb(dir)) ? dir : null
}

// files the app wrote next to its exe in portable mode (settings, presets, crash recovery)
// go along to the new version. anything the new zip has itself stays as shipped
async function carryOver(id: string, from: string, to: string): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(from)
  } catch {
    return
  }
  const shipped = new Set((await fs.readdir(to)).map((n) => n.toLowerCase()))
  for (const name of names) {
    // the web build belongs to its version, the new one has its own
    if (shipped.has(name.toLowerCase()) || name.toLowerCase() === 'web') continue
    await fs.cp(join(from, name), join(to, name), { recursive: true, errorOnExist: false, force: false }).catch((err) =>
      console.error(`craft: couldn't carry ${name} over for ${id}`, err)
    )
  }
}

// makes a downloaded version the one that runs, keeps the one before it and drops older ones
async function swapTo(id: string, version: string): Promise<void> {
  const cur = await current(id)
  if (cur?.version === version) return
  if (cur) await carryOver(id, versionDir(id, cur.version), versionDir(id, version))
  await writeJson(join(appDir(id), 'current.json'), { version, previous: cur?.version ?? null } satisfies Current)
  const keep = new Set([version, cur?.version].filter(Boolean))
  for (const name of await fs.readdir(appDir(id))) {
    if (versionFromTag(name) && !keep.has(name)) await fs.rm(join(appDir(id), name), { recursive: true, force: true }).catch(() => {})
  }
  await fs.rm(join(appDir(id), 'staged.json'), { force: true })
}

// set by launch.ts, an update never replaces an app that's open
let isRunning: (id: string) => boolean = () => false
export function setRunningCheck(fn: (id: string) => boolean): void {
  isRunning = fn
}

const busy = new Map<string, Promise<void>>()

// installs the latest version, or updates to it. an open app gets it staged and swapped when it closes
export function installLatest(id: string): Promise<void> {
  const running = busy.get(id)
  if (running) return running
  const job = (async () => {
    try {
      const r = await releaseFor(id)
      const have = await installed(id)
      if (have && !newer(r.version, have.version)) {
        setLive(id, { install: { kind: 'installed', version: have.version } })
        return
      }
      await fetchVersion(id, r, !have)
      if (have && isRunning(id)) {
        await writeJson(join(appDir(id), 'staged.json'), { version: r.version })
        setLive(id, { install: { kind: 'installed', version: have.version }, updateReady: r.version })
        return
      }
      await swapTo(id, r.version)
      setLive(id, { install: { kind: 'installed', version: r.version }, updateReady: null })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`craft install failed for ${id}`, err)
      const have = await installed(id).catch(() => null)
      // a failed update leaves the installed version working
      setLive(id, { install: have ? { kind: 'installed', version: have.version } : { kind: 'failed', error: msg } })
      throw err
    }
  })().finally(() => busy.delete(id))
  busy.set(id, job)
  return job
}

// launch.ts calls this when an app's window closes
export async function applyStaged(id: string): Promise<void> {
  const staged = await readJson<{ version: string }>(join(appDir(id), 'staged.json'))
  if (!staged?.version || !versionFromTag(staged.version)) return
  try {
    await fs.access(join(versionDir(id, staged.version), `${id}.exe`))
    await swapTo(id, staged.version)
    setLive(id, { install: { kind: 'installed', version: staged.version }, updateReady: null })
  } catch (err) {
    console.error(`craft: couldn't apply the ${id} update`, err)
  }
}

export async function uninstall(id: string): Promise<void> {
  if (isRunning(id)) throw new Error(`close ${spec(id).name} first`)
  await busy.get(id)?.catch(() => {})
  await fs.rm(appDir(id), { recursive: true, force: true })
  setLive(id, { install: { kind: 'not-installed' }, updateReady: null })
}

// what's on disk, at startup
export async function loadInstalled(): Promise<void> {
  for (const a of APPS) {
    const have = await installed(a.id)
    const staged = await readJson<{ version: string }>(join(appDir(a.id), 'staged.json'))
    if (have && staged?.version && !isRunning(a.id)) await applyStaged(a.id)
    const now = await installed(a.id)
    setLive(a.id, { install: now ? { kind: 'installed', version: now.version } : { kind: 'not-installed' } }, false)
  }
  await refreshReleases(Infinity).catch(() => {})
}

async function autoUpdateOn(): Promise<boolean> {
  try {
    const data = await loadData()
    return (data.settings as { autoUpdate?: boolean }).autoUpdate !== false
  } catch {
    return true
  }
}

// asks GitHub for every app's latest release and updates the installed ones, unless updates are off
export async function checkUpdates(force: boolean): Promise<void> {
  await refreshReleases(force ? 0 : SIX_HOURS)
  if (!(await autoUpdateOn())) return
  for (const a of APPS) {
    const l = liveOf(a.id)
    if (l.install.kind !== 'installed' || !l.latest || !newer(l.latest, l.install.version)) continue
    if (l.updateReady === l.latest) continue
    void installLatest(a.id).catch(() => {})
  }
}

let timer: NodeJS.Timeout | null = null

export function startUpdateChecks(): void {
  if (timer) return
  setTimeout(() => void checkUpdates(false).catch((err) => console.error('craft update check failed', err)), 20_000)
  timer = setInterval(() => void checkUpdates(true).catch((err) => console.error('craft update check failed', err)), SIX_HOURS)
}
