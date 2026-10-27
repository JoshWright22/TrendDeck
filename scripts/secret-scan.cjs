const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const localScanner = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'TrendDeck', 'tools', 'gitleaks', 'gitleaks.exe')
const scanner = process.env.GITLEAKS_BIN || (localScanner && fs.existsSync(localScanner) ? localScanner : 'gitleaks')
const common = ['--redact', '--no-banner', '--no-color', '--verbose', '--timeout=120', '--ignore-gitleaks-allow']
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error('Could not inspect Git state for the secret scan.')
  return result.stdout
}
function scan(args) {
  const result = spawnSync(scanner, [...args, ...common], { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw new Error('Gitleaks is required before pushing. Install it or set GITLEAKS_BIN to its executable.')
  if (result.status !== 0) throw new Error('Secret scan failed. Resolve findings before pushing; do not bypass the hook.')
}
let snapshot
try {
  snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'trenddeck-secret-scan-'))
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean)
  for (const filename of new Set(files)) {
    const source = path.resolve(root, filename)
    const destination = path.resolve(snapshot, filename)
    if (!source.startsWith(root + path.sep) || !destination.startsWith(snapshot + path.sep)) throw new Error('Unsafe scan path.')
    if (!fs.existsSync(source)) continue
    const stat = fs.lstatSync(source)
    if (stat.isSymbolicLink()) throw new Error('Review symbolic links before publishing this repository.')
    if (!stat.isFile()) continue
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
  }
  scan(['dir', snapshot])
  if (process.argv.includes('--pre-push')) {
    const updates = fs.readFileSync(0, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    for (const update of updates) {
      const [, localSha, , remoteSha] = update.split(/\s+/)
      if (!/^[a-f0-9]{40,64}$/.test(localSha || '') || !/^[a-f0-9]{40,64}$/.test(remoteSha || '')) throw new Error('Invalid push refs.')
      if (/^0+$/.test(localSha)) continue
      const range = /^0+$/.test(remoteSha) ? `${localSha} --not --remotes` : `${remoteSha}..${localSha}`
      scan(['git', root, `--log-opts=${range}`])
    }
  } else {
    const remote = spawnSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: root, stdio: 'ignore', windowsHide: true })
    scan(['git', root, `--log-opts=${remote.status === 0 ? 'origin/main..HEAD' : '--all'}`])
  }
  console.log('Secret scan passed: working files and outgoing commits.')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  if (snapshot) fs.rmSync(snapshot, { recursive: true, force: true })
}
