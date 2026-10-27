import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import { APPS } from '../craft/catalog'
import { status } from '../craft/state'

// before an edit suggestion is applied, the project's editor files (.fcproj and the other craft
// apps' files at the top of the folder) are copied to .trenddeck/checkpoints/<card>/. restoring
// copies them back, only while no editor has the project open, so nothing writes over it

const EDITOR_EXTS = new Set(APPS.flatMap((a) => a.exts.map((e) => e.toLowerCase())))
const MAX_BYTES = 512 * 1024 * 1024

const dirFor = (root: string, id: string): string => join(root, '.trenddeck', 'checkpoints', id)

async function editorFiles(root: string): Promise<string[]> {
  const names = await fs.readdir(root).catch(() => [] as string[])
  const out: string[] = []
  for (const n of names) {
    if (!EDITOR_EXTS.has(extname(n).toLowerCase())) continue
    const st = await fs.lstat(join(root, n)).catch(() => null)
    if (st?.isFile() && !st.isSymbolicLink()) out.push(n)
  }
  return out
}

// the checkpoint id, null when the project has no editor files yet
export async function makeCheckpoint(root: string, id: string): Promise<string | null> {
  if (!/^[a-z0-9-]{1,64}$/i.test(id)) throw new Error('bad checkpoint id')
  const files = await editorFiles(root)
  if (!files.length) return null
  let total = 0
  for (const f of files) total += (await fs.stat(join(root, f))).size
  if (total > MAX_BYTES) throw new Error('the editor files are too big to copy aside')
  const dir = dirFor(root, id)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  for (const f of files) await fs.copyFile(join(root, f), join(dir, f))
  await fs.writeFile(join(dir, 'checkpoint.json'), JSON.stringify({ at: Date.now(), files }), 'utf8')
  return id
}

// which editor has this project open, by name
export function openEditor(brandId: string, projectId: string): string | null {
  for (const a of APPS) {
    const s = status(a.id)
    if ((s.running || s.agent !== 'off') && s.brandId === brandId && s.projectId === projectId) return a.name
  }
  return null
}

export async function restoreCheckpoint(root: string, id: string, brandId: string, projectId: string): Promise<{ ok: boolean; note: string }> {
  if (!/^[a-z0-9-]{1,64}$/i.test(id)) return { ok: false, note: 'That checkpoint id is not valid.' }
  const dir = dirFor(root, id)
  let meta: { files?: unknown }
  try {
    meta = JSON.parse(await fs.readFile(join(dir, 'checkpoint.json'), 'utf8')) as { files?: unknown }
  } catch {
    return { ok: false, note: 'That checkpoint is gone.' }
  }
  const editor = openEditor(brandId, projectId)
  if (editor) return { ok: false, note: `${editor} has this project open. Use its undo, or close it and restore again.` }
  const files = Array.isArray(meta.files) ? meta.files.filter((f): f is string => typeof f === 'string' && EDITOR_EXTS.has(extname(f).toLowerCase()) && !/[\\/]/.test(f)) : []
  for (const f of files) {
    const cur = join(root, f)
    // the current file goes aside too, so a restore can be taken back by hand
    await fs.copyFile(cur, join(dir, `${f}.before-restore`)).catch(() => {})
    await fs.copyFile(join(dir, f), cur)
  }
  return { ok: true, note: `Restored ${files.length} editor file${files.length === 1 ? '' : 's'} from before the edit.` }
}
