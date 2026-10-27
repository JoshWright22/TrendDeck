// the first thing that runs. it picks which copy of the app code to start: the one that came with
// the installer, or a newer one the updater downloaded (userData/app-updates/<version>.asar).
// most releases only change the app code, so updating is a download and a restart, no installer.
// a release that changes electron or the files kept outside the archive (ffmpeg and such) still
// goes through the installer, see updater.ts and scripts/after-pack.cjs.
// keep this file small and stable, a downloaded update can't change it
import { app } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
// electron's fs looks inside .asar archives, original-fs sees them as plain files
import { existsSync } from 'node:fs'
import fs from 'original-fs'

import { MAX_TRIES, newer, readState, writeState, type BootInfo } from './boot-state'

// what a downloaded update has to match to run on this install. written at build time
function shellKey(): string {
  if (!app.isPackaged) return 'dev'
  try {
    const raw = JSON.parse(fs.readFileSync(join(process.resourcesPath, 'shell.json'), 'utf8')) as { key?: unknown }
    return typeof raw.key === 'string' ? raw.key : ''
  } catch {
    return ''
  }
}

function start(): void {
  const bundledVersion = app.getVersion()
  const shell = shellKey()
  const saved = app.isPackaged ? readState() : null
  const hot =
    saved &&
    shell !== '' &&
    saved.shell === shell &&
    saved.tries < MAX_TRIES &&
    newer(saved.version, bundledVersion) &&
    existsSync(join(saved.file, 'out', 'main', 'index.js'))
      ? saved
      : null

  // counts as a failed launch until the window opens and the app calls markGood
  if (saved && !hot) writeState(null)
  if (hot) writeState({ ...hot, tries: hot.tries + 1 })

  const info: BootInfo = {
    bundledVersion,
    version: hot ? hot.version : bundledVersion,
    hot: hot !== null,
    shell,
    markGood: () => {
      const now = readState()
      if (hot && now && now.version === hot.version && now.tries !== 0) writeState({ ...now, tries: 0 })
    }
  }
  ;(globalThis as { __trenddeckBoot?: BootInfo }).__trenddeckBoot = info

  const load = createRequire(__filename)
  if (hot) {
    try {
      // the rest of the app, electron-updater included, sees the version that's running
      app.getVersion = () => hot.version
      load(join(hot.file, 'out', 'main', 'index.js'))
      return
    } catch (err) {
      console.error('downloaded update failed to start, using the installed one', err)
      writeState(null)
      app.getVersion = () => bundledVersion
      info.version = bundledVersion
      info.hot = false
    }
  }
  load('./index.js')
}

start()
