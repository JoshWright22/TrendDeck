// a downloaded update (app-updates/<version>.asar, see boot.ts) needs the native files kept outside
// the archive: ffmpeg, ffprobe and koffi. electron looks for them in <archive>.asar.unpacked next to
// whichever archive is running, so a downloaded archive gets a link to the installed app's
// app.asar.unpacked. that's safe because an update only runs when its shell key matches the
// install, and the shell key covers every unpacked file (scripts/after-pack.cjs).
// imported first in index.ts, before anything loads a native file
import { join } from 'node:path'
import fs from 'original-fs'

// windows junctions need no admin rights, unlike symlinks
export function linkUnpacked(archive: string): void {
  if (!process.resourcesPath || process.platform !== 'win32') return
  const target = join(process.resourcesPath, 'app.asar.unpacked')
  const link = `${archive}.unpacked`
  if (archive === join(process.resourcesPath, 'app.asar') || !fs.existsSync(target)) return
  try {
    if (fs.lstatSync(link).isSymbolicLink() || fs.existsSync(link)) return
  } catch {
    // not there yet
  }
  try {
    fs.symlinkSync(target, link, 'junction')
  } catch (err) {
    console.error('could not link the native files for the downloaded update', err)
  }
}

// removes a link without touching what it points to. never use a recursive rm on a link: on
// windows it follows a junction and deletes the target's files
export function unlinkUnpacked(link: string): void {
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.rmdirSync(link)
  } catch {
    // already gone
  }
}

// the archive this code runs from, when it's a downloaded one
function runningArchive(): string | null {
  const m = /^(.*?\.asar)[\/]/.exec(__dirname)
  return m ? m[1] : null
}

const archive = runningArchive()
if (archive) linkUnpacked(archive)
