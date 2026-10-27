// electron-builder afterPack hook. runs on the packed app before the installer is made.
// 1. writes resources/shell.json, a fingerprint of everything a downloaded app code update can't
//    replace: electron, the launcher (out/main/boot.js) and every file outside app.asar
// 2. copies app.asar next to the installer as TrendDeck-app-<version>.asar with app-update.json,
//    which the updater uses to update by download and restart instead of running the installer
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full, base, out)
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

const sha = (algo, data) => createHash(algo).update(data).digest('hex')

exports.default = async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources')
  const appAsar = path.join(resources, 'app.asar')
  const version = context.packager.appInfo.version
  const electron = context.packager.config.electronVersion || require('electron/package.json').version
  const boot = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'boot-state.ts'), 'utf8')
  const protocol = (boot.match(/BOOT_PROTOCOL = (\d+)/) || [])[1] || '0'

  const h = createHash('sha256')
  h.update(`electron ${electron}\nboot ${protocol}\n`)
  // the launcher as packed, a change to it needs the installer
  h.update(`boot.js ${sha('sha256', fs.readFileSync(path.join(context.packager.projectDir, 'out', 'main', 'boot.js')))}\n`)
  // the electron binaries and dlls next to the exe
  for (const rel of walk(context.appOutDir)) {
    if (rel === 'resources/app.asar' || rel === 'resources/shell.json') continue
    // the installer stamps the version into the exe, everything else in it is electron's
    if (rel === `${context.packager.appInfo.productFilename}.exe`) continue
    h.update(`${rel} ${sha('sha256', fs.readFileSync(path.join(context.appOutDir, rel)))}\n`)
  }
  const key = h.digest('hex')
  fs.writeFileSync(path.join(resources, 'shell.json'), JSON.stringify({ key, version, electron }))

  const outDir = context.outDir
  const file = `TrendDeck-app-${version}.asar`
  const data = fs.readFileSync(appAsar)
  fs.writeFileSync(path.join(outDir, file), data)
  const manifest = {
    version,
    file,
    sha512: createHash('sha512').update(data).digest('base64'),
    size: data.length,
    shell: key
  }
  fs.writeFileSync(path.join(outDir, 'app-update.json'), JSON.stringify(manifest, null, 2))
  console.log(`  • app code update ${file} (${(data.length / 1e6).toFixed(1)} MB), shell ${key.slice(0, 12)}`)
}
