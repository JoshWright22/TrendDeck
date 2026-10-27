import type { CraftApi, CraftAppStatus, CraftChanged, CraftDock } from '@shared/craft'
import { CRAFT_NAMES } from './apps'

// a stand in for main's craft side, only in dev builds or a build made with VITE_CRAFT_MOCK=1,
// so the workspace and settings can be seen and screenshotted without the real apps.
// installs take two seconds, opening shows a gray box where the window would dock

const BLURBS: Record<string, string> = {
  filmcraft: 'Cut video on a timeline, captions and exports for every site',
  photocraft: 'Edit photos and make thumbnails in layers',
  soundcraft: 'Record, clean up and mix voice and music',
  effectcraft: 'Motion graphics, titles and animated text',
  designcraft: 'Layouts for posts, banners and covers',
  vectorcraft: 'Logos, icons and vector art',
  lightcraft: 'Color grading and looks for photos and video',
  pdfcraft: 'Read, mark up and fill in PDFs',
  wordcraft: 'Long documents, scripts and show notes',
  deckcraft: 'Slide decks and pitch decks',
  gridcraft: 'Spreadsheets for plans and numbers',
  cadcraft: '2D and 3D drawings',
  figcraft: 'Interface mockups and prototypes'
}

const START: Record<string, Partial<CraftAppStatus>> = {
  filmcraft: { install: { kind: 'installed', version: '1.4.2' }, latest: '1.4.2' },
  photocraft: { install: { kind: 'not-installed' }, latest: '2.0.1' },
  soundcraft: { install: { kind: 'installed', version: '0.9.0' }, latest: '0.9.3', updateReady: '0.9.3' },
  effectcraft: { install: { kind: 'failed', error: "SHA256SUMS.txt didn't match the download, nothing was installed" }, latest: '1.1.0' },
  designcraft: { install: { kind: 'installed', version: '1.0.0' }, latest: '1.2.0' },
  pdfcraft: { install: { kind: 'installed', version: '3.1.0' }, latest: '3.1.0' }
}

const FILES: Record<string, { name: string; modified: number }[]> = {
  filmcraft: [
    { name: 'Main cut.fcproj', modified: Date.now() - 12 * 60_000 },
    { name: 'Shorts version.fcproj', modified: Date.now() - 26 * 3600_000 }
  ],
  photocraft: [{ name: 'Thumbnail.pcproj', modified: Date.now() - 3 * 3600_000 }]
}

export function craftMock(): CraftApi {
  const apps = new Map<string, CraftAppStatus>()
  for (const [id, name] of Object.entries(CRAFT_NAMES)) {
    apps.set(id, {
      app: { id, name, blurb: BLURBS[id] ?? '', repo: `storytold/${id}`, agent: id !== 'cadcraft' },
      install: { kind: 'not-installed' },
      latest: '1.0.0',
      updateReady: null,
      running: false,
      brandId: null,
      projectId: null,
      file: null,
      agent: 'off',
      ...START[id]
    })
  }
  const subs = new Set<(s: CraftChanged) => void>()
  const set = (id: string, patch: Partial<CraftAppStatus>): CraftAppStatus => {
    const next = { ...apps.get(id)!, ...patch }
    apps.set(id, next)
    for (const fn of subs) fn(next)
    return next
  }
  const get = (id: string): CraftAppStatus => {
    const s = apps.get(id)
    if (!s) throw new Error(`no craft app called ${id}`)
    return s
  }
  const install = (id: string): Promise<CraftAppStatus> =>
    new Promise((resolve) => {
      const version = get(id).latest ?? '1.0.0'
      const total = 84_000_000
      let received = 0
      const tick = (): void => {
        received = Math.min(total, received + total / 10)
        if (received < total) {
          set(id, { install: { kind: 'installing', version, received, total } })
          setTimeout(tick, 200)
        } else resolve(set(id, { install: { kind: 'installed', version }, updateReady: null }))
      }
      tick()
    })
  let lastDock = ''
  return {
    list: async () => [...apps.values()],
    install,
    uninstall: async (id) => {
      set(id, { install: { kind: 'not-installed' }, running: false, file: null, agent: 'off', updateReady: null })
    },
    open: async (req) => {
      if (get(req.appId).install.kind !== 'installed') await install(req.appId)
      const ext = `${req.appId.charAt(0)}${req.appId.endsWith('craft') ? 'c' : ''}proj`
      const file = req.file ?? FILES[req.appId]?.[0]?.name ?? `Main.${ext}`
      set(req.appId, { running: true, brandId: req.brandId, projectId: req.projectId, file, agent: 'headless' })
      setTimeout(() => apps.get(req.appId)?.running && set(req.appId, { agent: 'bridge' }), 900)
      return get(req.appId)
    },
    close: async (id) => {
      set(id, { running: false, brandId: null, projectId: null, file: null, agent: 'off' })
    },
    dock: (d: CraftDock) => {
      const line = JSON.stringify(d)
      if (line !== lastDock) console.debug('craft mock dock', line)
      lastDock = line
    },
    files: async (_brandId, _projectId, appId) => FILES[appId] ?? [],
    checkUpdates: async () => [...apps.values()],
    onChanged: (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    }
  }
}
