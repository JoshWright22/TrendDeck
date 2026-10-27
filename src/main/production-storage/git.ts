import { promises as fs } from 'node:fs'
import { join, dirname, parse } from 'node:path'
import { randomUUID } from 'node:crypto'
import { executable, runProcess } from './process'
import { IGNORE_POLICY, StorageError, metadataFile, metadataPath, noSymlinks, safeText } from './safety'

const MARKER = 'TrendDeck metadata repository v1\n'
const CONFIG = '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n\tlogallrefupdates = true\n\tignorecase = true\n'
const queues = new Map<string, Promise<unknown>>()

export async function serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(action, action)
  queues.set(key, next)
  try { return await next } finally { if (queues.get(key) === next) queues.delete(key) }
}

async function git(root: string, args: string[], input?: string, index?: string): Promise<string> {
  return runProcess(await executable('git'), [
    '--no-pager', '--no-optional-locks', '--literal-pathspecs',
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'core.attributesFile=/dev/null', '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0',
    '-c', 'user.name=TrendDeck', '-c', 'user.email=trenddeck@localhost', ...args
  ], root, { input, index })
}

async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function checkGitDirectory(root: string): Promise<void> {
  await noSymlinks(root)
  const directory = join(root, '.git')
  if (!await exists(directory)) throw new StorageError('No project repository yet. Ask for approval to run git_init first.')
  await noSymlinks(directory)
  if (!(await fs.stat(directory)).isDirectory()) throw new StorageError('Linked worktrees and external Git directories are not supported.')
  let count = 0
  const visit = async (folder: string): Promise<void> => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (++count > 5000) throw new StorageError('Repository exceeds the metadata safety limit.')
      const path = join(folder, entry.name)
      const stat = await fs.lstat(path)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new StorageError('Git internals must not contain links or special files.')
      if (entry.isDirectory()) await visit(path)
    }
  }
  await visit(directory)
  for (const name of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates', 'info/grafts', 'refs/replace', 'config.worktree', 'shallow']) {
    if (await exists(join(directory, name))) throw new StorageError('External or rewritten repository history is not supported.')
  }
  if (await fs.readFile(join(directory, 'trenddeck-storage'), 'utf8').catch(() => '') !== MARKER || await fs.readFile(join(directory, 'config'), 'utf8') !== CONFIG) {
    throw new StorageError('Only repositories created by these metadata tools, with unchanged isolated configuration, are supported. Existing repositories are left untouched.')
  }
}

export async function initRepository(root: string): Promise<{ initialized: boolean }> {
  await noSymlinks(root)
  if (await exists(join(root, '.git'))) { await checkGitDirectory(root); return { initialized: false } }
  for (let ancestor = dirname(root); ancestor !== parse(ancestor).root; ancestor = dirname(ancestor)) {
    if (await exists(join(ancestor, '.git'))) throw new StorageError('Project is nested inside another repository; it will not be initialized here.')
  }
  if (await exists(join(root, '.gitignore'))) {
    if ((await metadataFile(root, '.gitignore')).toString('utf8') !== IGNORE_POLICY) throw new StorageError('A custom .gitignore already exists. It is left untouched; review the metadata-only policy outside chat.')
  } else await fs.writeFile(join(root, '.gitignore'), IGNORE_POLICY, { flag: 'wx' })
  await git(root, ['init', '--template=', '--initial-branch=main', '.'])
  await fs.writeFile(join(root, '.git', 'config'), CONFIG)
  await fs.writeFile(join(root, '.git', 'trenddeck-storage'), MARKER, { flag: 'wx' })
  return { initialized: true }
}

async function trackedFiles(root: string): Promise<string[]> {
  const raw = await git(root, ['ls-files', '--stage', '-z'])
  const names: string[] = []
  for (const record of raw.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/.exec(record)
    if (!match) throw new StorageError('Symlinks, submodules and conflicted entries are not supported.')
    const name = metadataPath(match[3])
    safeText(Buffer.from(await git(root, ['cat-file', 'blob', match[2]])))
    names.push(name)
    if (names.length > 200) throw new StorageError('Only 200 tracked metadata files per project are supported.')
  }
  return names
}

export async function repositoryStatus(root: string): Promise<unknown> {
  await checkGitDirectory(root)
  const tracked = await trackedFiles(root)
  const raw = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames'])
  const changes = raw.split('\0').filter(Boolean).map((record) => ({ status: record.slice(0, 2), file: metadataPath(record.slice(3)) }))
  return { tracked, changes, note: 'Only tracked text metadata is shown. Media, credentials and untracked files are not listed. Git remote configuration and pushing are not exposed.' }
}

export async function repositoryDiff(root: string, requested: string[]): Promise<unknown> {
  await checkGitDirectory(root)
  const tracked = await trackedFiles(root)
  const files = requested.length ? requested.map(metadataPath) : tracked
  if (!files.length) return { diff: '', note: 'No tracked metadata yet.' }
  for (const file of files) {
    if (!tracked.includes(file)) throw new StorageError('Diff accepts tracked metadata only.')
    if (await exists(join(root, file))) await metadataFile(root, file)
  }
  const flags = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color']
  const working = await git(root, ['diff', ...flags, '--', ...files])
  const staged = await git(root, ['diff', '--cached', ...flags, '--', ...files])
  safeText(Buffer.from(working + staged))
  return { working, staged }
}

export async function commitMetadata(root: string, requested: string[], message: string): Promise<unknown> {
  await checkGitDirectory(root)
  await trackedFiles(root)
  safeText(Buffer.from(message))
  if (!message.trim() || message.length > 500 || /[\r\n]/.test(message)) throw new StorageError('Use a short, single-line commit message without credentials.')
  if (!requested.length || requested.length > 50) throw new StorageError('Select between 1 and 50 metadata files.')
  const files = [...new Set(['.gitignore', ...requested.map(metadataPath)])]
  const snapshots = new Map<string, Buffer>()
  for (const name of files) snapshots.set(name, await metadataFile(root, name))
  if (snapshots.get('.gitignore')!.toString('utf8') !== IGNORE_POLICY) throw new StorageError('The metadata-only ignore policy has changed; restore it before committing.')
  if ((await git(root, ['diff', '--cached', '--name-only', '-z'])).length) throw new StorageError('There are already staged changes. Review them outside chat before using this tool.')
  const index = join(root, '.git', `trenddeck-index-${randomUUID()}`)
  try {
    const hasHead = await exists(join(root, '.git', 'refs', 'heads', 'main')) || await exists(join(root, '.git', 'packed-refs'))
    await git(root, ['read-tree', hasHead ? 'HEAD' : '--empty'], undefined, index)
    let records = ''
    for (const [name, content] of snapshots) {
      const hash = (await git(root, ['hash-object', '-w', '--stdin'], content.toString('utf8'))).trim()
      if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new StorageError('Unexpected Git object identifier.')
      records += `100644 ${hash}\t${name}\0`
    }
    await git(root, ['update-index', '-z', '--index-info'], records, index)
    await git(root, ['commit', '--no-verify', '--no-gpg-sign', '--file=-'], message, index)
    await git(root, ['update-index', '-z', '--index-info'], records)
    const commit = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim()
    return { commit, files, note: 'Committed selected metadata snapshots only, with local TrendDeck author identity. Nothing was pushed.' }
  } finally {
    await fs.unlink(index).catch(() => {})
    await fs.unlink(`${index}.lock`).catch(() => {})
  }
}

// ---- the history card: checkpoints, what changed, restore ----

const COMMIT = /^[a-f0-9]{7,64}$/

export interface HistoryItem {
  commit: string
  message: string
  at: number
  files: string[]
}

export async function hasRepository(root: string): Promise<boolean> {
  return exists(join(root, '.git'))
}

export async function repositoryHistory(root: string, limit = 20): Promise<{ entries: HistoryItem[]; changed: string[] }> {
  await checkGitDirectory(root)
  const hasHead = await exists(join(root, '.git', 'refs', 'heads', 'main')) || await exists(join(root, '.git', 'packed-refs'))
  const entries: HistoryItem[] = []
  if (hasHead) {
    const raw = await git(root, ['log', `--max-count=${Math.max(1, Math.min(100, limit))}`, '--no-renames', '--name-only', '--format=%x1e%H%x1f%ct%x1f%s'])
    for (const block of raw.split('\x1e').filter((b) => b.trim())) {
      const [head, ...rest] = block.split('\n')
      const [commit, ct, message] = head.split('\x1f')
      if (!COMMIT.test(commit ?? '')) continue
      const files = rest.map((l) => l.trim()).filter(Boolean).slice(0, 50)
      entries.push({ commit, message: (message ?? '').slice(0, 200), at: Number(ct) * 1000 || 0, files })
    }
  }
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
  const changed: string[] = []
  for (const record of status.split('\0').filter(Boolean)) {
    try {
      changed.push(metadataPath(record.slice(3)))
    } catch {
      // not something the history keeps
    }
    if (changed.length >= 50) break
  }
  return { entries, changed }
}

// a checkpoint of every changed or new text file the history keeps, at most 50
export async function saveCheckpoint(root: string, message: string): Promise<unknown> {
  if (!(await exists(join(root, '.git')))) await initRepository(root)
  const { changed } = await repositoryHistory(root, 1)
  const tracked = await trackedFiles(root)
  const files = [...new Set([...changed])].filter((f) => f !== '.gitignore')
  if (!files.length && tracked.length > 1) throw new StorageError('Nothing changed since the last checkpoint.')
  if (!files.length) throw new StorageError('No scripts, captions or notes in this project yet. Text files like .md, .txt, .srt and .json are kept.')
  for (const f of files) if (!(await exists(join(root, f)))) throw new StorageError(`${f} was deleted. Deleting files from the history isn't supported yet.`)
  return commitMetadata(root, files, message)
}

export async function commitChanges(root: string, commit: string): Promise<string> {
  await checkGitDirectory(root)
  if (!COMMIT.test(commit)) throw new StorageError('That checkpoint id is not valid.')
  const out = await git(root, ['show', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--stat', '--patch', '--format=%s%n', commit, '--'])
  safeText(Buffer.from(out))
  return out.length > 40_000 ? `${out.slice(0, 40_000)}\n...` : out
}

// puts the files as they were at a checkpoint back in the folder. files added since stay,
// nothing is committed, so a restore can be looked at and saved as a new checkpoint
export async function restoreCommit(root: string, commit: string): Promise<{ restored: string[] }> {
  await checkGitDirectory(root)
  if (!COMMIT.test(commit)) throw new StorageError('That checkpoint id is not valid.')
  const raw = await git(root, ['ls-tree', '-r', '-z', commit])
  const restored: string[] = []
  for (const record of raw.split('\0').filter(Boolean)) {
    const m = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(record)
    if (!m) throw new StorageError('That checkpoint has entries that cannot be restored.')
    const name = metadataPath(m[3])
    if (name === '.gitignore') continue
    const text = safeText(Buffer.from(await git(root, ['cat-file', 'blob', m[2]])))
    const full = join(root, name)
    await fs.mkdir(dirname(full), { recursive: true })
    await noSymlinks(dirname(full))
    if (await exists(full)) await metadataFile(root, name)
    await fs.writeFile(full, text, 'utf8')
    restored.push(name)
  }
  return { restored }
}
