import { app } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { loadData, saveData } from '../store'
import { newRoot, oldRoot, setProjectsRoot } from './root'
import { inOneDrive, swapRoot } from './root-paths'

// the text files that hold paths: editor projects (and their autosaves and turn copies), lists, notes
const TEXT = /\.(fcproj|json|jsonl|md|txt|srt|vtt|csv)$/i
const MAX_TEXT = 64 * 1024 * 1024

async function rewrite(dir: string, from: string, to: string, depth = 0): Promise<number> {
  if (depth > 8) return 0
  let n = 0
  for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, d.name)
    if (d.isDirectory()) n += await rewrite(p, from, to, depth + 1)
    else if (d.isFile() && TEXT.test(d.name)) {
      const st = await fs.stat(p).catch(() => null)
      if (!st || st.size > MAX_TEXT) continue
      const text = await fs.readFile(p, 'utf8').catch(() => null)
      if (text === null) continue
      const out = swapRoot(text, from, to)
      if (out !== text) {
        await fs.writeFile(p, out, 'utf8')
        n++
      }
    }
  }
  return n
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// once, at start before anything opens a project: projects OneDrive syncs move out of it, and
// every saved path to them (editor projects, the project list, cards) follows
export async function moveProjectsOutOfOneDrive(): Promise<void> {
  if (process.env.TRENDDECK_PROJECTS_DIR) return
  const from = oldRoot()
  const to = newRoot()
  if (from === to || !inOneDrive(from) || !existsSync(from) || existsSync(to)) return
  let moved = false
  // the same drive: a rename, instant. OneDrive can hold a file for a moment, so a few tries
  for (let i = 0; i < 4 && !moved; i++) {
    try {
      await fs.rename(from, to)
      moved = true
    } catch {
      await sleep(1500)
    }
  }
  if (!moved) {
    try {
      await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false })
      moved = true
      // what OneDrive won't let go of stays there, the projects run from the copy
      await fs.rm(from, { recursive: true, force: true }).catch((err) => console.error('craft: the old project folder in OneDrive is still there', err))
    } catch (err) {
      console.error("craft: couldn't move the projects out of OneDrive, they stay there", err)
      await fs.rm(to, { recursive: true, force: true }).catch(() => {})
      return
    }
  }
  setProjectsRoot(to)
  const files = await rewrite(to, from, to)
  const data = await loadData()
  const fixed = JSON.parse(swapRoot(JSON.stringify(data), from, to)) as typeof data
  await saveData(fixed)
  await rewrite(join(app.getPath('userData'), 'cards'), from, to)
  console.log(`craft: projects moved out of OneDrive to ${to}, ${files} project files updated`)
}

