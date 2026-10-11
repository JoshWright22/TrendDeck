import { promises as fs, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, join } from 'node:path'

const isWin = process.platform === 'win32'

// how to start a program without going through a shell
export interface Launch {
  file: string
  // goes before our own args, e.g. the script path when we run node directly
  prefix: string[]
  // only for .cmd files we couldn't unwrap. never used when the prompt is an arg
  shell: boolean
}

// apps started from the dock or start menu don't always get the shell's PATH
function extraDirs(): string[] {
  const home = homedir()
  if (isWin) {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [join(appData, 'npm'), join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(local, 'Programs')]
  }
  return [
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.opencode', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
}

export function searchDirs(): string[] {
  const fromEnv = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
  return [...new Set([...fromEnv, ...extraDirs()])]
}

async function isFile(path: string): Promise<boolean> {
  try {
    const st = await fs.stat(path)
    if (!st.isFile()) return false
    if (!isWin) await fs.access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// first match for a bare command name, real executables before .cmd wrappers
export async function which(name: string): Promise<string | null> {
  if (/[\\/]/.test(name)) return (await isFile(name)) ? name : null
  const exts = isWin ? ['.exe', '.com', '.cmd', '.bat'] : ['']
  for (const ext of exts) {
    for (const dir of searchDirs()) {
      const path = join(dir, name + ext)
      if (await isFile(path)) return path
    }
  }
  return null
}

// npm on windows makes .cmd wrappers like "%dp0%\node_modules\x\cli.js" %*
// node refuses to start .cmd files without a shell, so run what's inside instead
async function unwrapCmd(path: string): Promise<Launch | null> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
  const hits = [...text.matchAll(/"%~?dp0%?\\?([^"%]+)"\s+%\*/g)]
  const target = hits.at(-1)?.[1]
  if (!target) return null
  const full = join(dirname(path), target)
  if (!(await isFile(full))) return null
  const ext = extname(full).toLowerCase()
  if (ext === '.exe' || ext === '.com') return { file: full, prefix: [], shell: false }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const local = join(dirname(path), 'node.exe')
    const node = (await isFile(local)) ? local : await which('node')
    if (!node) return null
    return { file: node, prefix: [full], shell: false }
  }
  return null
}

export async function resolveLaunch(path: string): Promise<Launch> {
  const ext = extname(path).toLowerCase()
  if (isWin && (ext === '.cmd' || ext === '.bat')) {
    const inner = await unwrapCmd(path)
    if (inner) return inner
    return { file: path, prefix: [], shell: true }
  }
  return { file: path, prefix: [], shell: false }
}

// splits a command line on spaces, keeping "quoted parts" together
export function splitCommand(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let started = false
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur)
      cur = ''
      started = false
    } else {
      cur += ch
    }
  }
  if (started || cur) out.push(cur)
  return out
}
