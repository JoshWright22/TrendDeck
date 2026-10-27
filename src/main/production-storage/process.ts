import { spawn } from 'node:child_process'
import { promises as fs, constants } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { StorageError } from './safety'

export async function executable(name: 'git' | 'rclone'): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory) || resolve(directory) === process.cwd()) continue
    const candidate = join(directory, process.platform === 'win32' ? `${name}.exe` : name)
    try {
      await fs.access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate)
    } catch {}
  }
  throw new StorageError(name === 'rclone'
    ? 'Setup needed: install rclone, configure a Drive, S3, B2 or OneDrive remote using rclone config outside chat, then retry. Native OAuth is not implemented. Never paste credentials here.'
    : 'Setup needed: install Git and add it to PATH, then retry.')
}

export async function runProcess(binary: string, args: string[], cwd: string, options: { input?: string; timeout?: number; limit?: number; index?: string } = {}): Promise<string> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key) || (/^RCLONE_/i.test(key) && !/^RCLONE_CONFIG(?:_PASS)?$/i.test(key))) delete env[key]
  }
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' })
  if (options.index) env.GIT_INDEX_FILE = options.index
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let total = 0
    let failure: StorageError | null = null
    const stop = (message: string): void => {
      failure ??= new StorageError(message)
      child.kill()
    }
    const timer = setTimeout(() => stop('Operation timed out. Some work may have completed; inspect before retrying.'), options.timeout ?? 30_000)
    child.stdout.on('data', (bytes: Buffer) => {
      total += bytes.length
      if (total > (options.limit ?? 256 * 1024)) stop('Output exceeded the safety limit. Narrow the operation before retrying.')
      else chunks.push(bytes)
    })
    child.stderr.on('data', (bytes: Buffer) => {
      total += bytes.length
      if (total > (options.limit ?? 256 * 1024)) stop('Diagnostic output exceeded the safety limit.')
    })
    child.stdin.on('error', () => {})
    child.on('error', () => { clearTimeout(timer); reject(new StorageError('Could not start the executable. Check its installation outside chat.')) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (code !== 0) reject(new StorageError('Operation failed. Check local Git/rclone configuration outside chat. Diagnostics are withheld to protect credentials. Some work may have completed.'))
      else resolveResult(Buffer.concat(chunks).toString('utf8'))
    })
    child.stdin.end(options.input)
  })
}
