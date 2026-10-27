import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findMedia, matchesQuery, mediaKind, queryWords, recordPathsFromIni, skipFolder } from './search'

// a made up folder tree in temp, nothing real is listed
let root = ''

function file(rel: string, ageMinutes: number): void {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, 'x')
  const t = new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - ageMinutes * 60_000)
  utimesSync(p, t, t)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'trenddeck-find-'))
  file('Recordings/2026-10-20 10-00-00.mkv', 120)
  file('Recordings/2026-10-20 11-00-00.mkv', 60)
  file('Recordings/notes.txt', 1)
  file('Recordings/Order of the Sinking Star/boss.mp4', 30)
  file('Recordings/SinkingStar clips/intro.webm', 10)
  file('Recordings/voice.WAV', 5)
  file('Recordings/AppData/hidden.mp4', 0)
  file('Recordings/node_modules/pkg/demo.mp4', 0)
  file('Recordings/.git/x.mp4', 0)
  file('Recordings/$Recycle.Bin/old.mp4', 0)
  file('Recordings/steamapps/common/game/intro.webm', 0)
  file('Recordings/a/b/c/d/e/f/g/too-deep.mp4', 0)
  file('Recordings/a/b/c/deep-enough.mp4', 200)
  file('Other/elsewhere.mov', 300)
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const names = (r: { matched: { path: string }[] }): string[] => r.matched.map((f) => f.path.slice(root.length + 1).replace(/\\/g, '/'))

describe('media rules', () => {
  it('knows media by extension only', () => {
    expect(mediaKind('a.MKV')).toBe('video')
    expect(mediaKind('a.opus')).toBe('audio')
    expect(mediaKind('a.txt')).toBeNull()
    expect(mediaKind('a.mp4.part')).toBeNull()
  })

  it('skips system, app, hidden and tool folders', () => {
    for (const n of ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'AppData', '$Recycle.Bin', 'node_modules', '.git', '.cache', 'steamapps']) expect(skipFolder(n)).toBe(true)
    for (const n of ['Recordings', 'Videos', 'OBS', 'Games']) expect(skipFolder(n)).toBe(false)
  })

  it('matches query words in names, ignoring case, spacing and small words', () => {
    const w = queryWords('Order of the Sinking Star')
    expect(w).toEqual(['order', 'sinking', 'star'])
    expect(matchesQuery('Recordings Order of the Sinking Star boss.mp4', w)).toBe(true)
    expect(matchesQuery('Recordings OrderOfTheSinkingStar.mkv', w)).toBe(true)
    expect(matchesQuery('Recordings SinkingStar clips intro.webm', w)).toBe(false)
    expect(queryWords('the')).toEqual(['the'])
  })

  it("reads OBS's record folders out of a profile file and nothing else", () => {
    const ini = '\uFEFF[General]\r\nName=AutoRec\r\n[SimpleOutput]\r\nFilePath=C:/Users/me/Videos/Recordings\r\nRecFormat2=mkv\r\n[AdvOut]\r\nRecFilePath=D:/Rec\r\nFFFilePath=\r\nKey=""\r\n'
    expect(recordPathsFromIni(ini).map((p) => p.replace(/\\/g, '/'))).toEqual(['C:/Users/me/Videos/Recordings', 'D:/Rec'])
  })
})

describe('findMedia', () => {
  it('lists media newest first and skips what it should', async () => {
    const r = await findMedia([{ dir: join(root, 'Recordings'), depth: 6 }])
    expect(names(r)).toEqual([
      'Recordings/voice.WAV',
      'Recordings/SinkingStar clips/intro.webm',
      'Recordings/Order of the Sinking Star/boss.mp4',
      'Recordings/2026-10-20 11-00-00.mkv',
      'Recordings/2026-10-20 10-00-00.mkv',
      'Recordings/a/b/c/deep-enough.mp4'
    ])
    expect(r.stopped).toBeNull()
  })

  it('filters by query, kind and dates', async () => {
    const places = [{ dir: join(root, 'Recordings'), depth: 6 }]
    expect(names(await findMedia(places, { query: 'sinking star' }))).toEqual(['Recordings/SinkingStar clips/intro.webm', 'Recordings/Order of the Sinking Star/boss.mp4'])
    expect(names(await findMedia(places, { kinds: ['audio'] }))).toEqual(['Recordings/voice.WAV'])
    const noon = Date.UTC(2026, 9, 20, 12, 0, 0)
    expect(names(await findMedia(places, { since: noon - 61 * 60_000, until: noon - 20 * 60_000 }))).toEqual([
      'Recordings/Order of the Sinking Star/boss.mp4',
      'Recordings/2026-10-20 11-00-00.mkv'
    ])
  })

  it('keeps everything it found when the query matches nothing', async () => {
    const r = await findMedia([{ dir: join(root, 'Recordings'), depth: 6 }], { query: 'minecraft' })
    expect(r.matched).toEqual([])
    expect(r.all.length).toBe(6)
  })

  it('walks places in order, once each, and respects their depth', async () => {
    const r = await findMedia([
      { dir: join(root, 'Recordings'), depth: 0 },
      { dir: root, depth: 6 },
      { dir: join(root, 'Recordings'), depth: 6 }
    ])
    // Recordings was read shallow first, the deeper root walk still goes into it
    expect(names(r)).toContain('Other/elsewhere.mov')
    expect(names(r)).toContain('Recordings/a/b/c/deep-enough.mp4')
    expect(new Set(names(r)).size).toBe(names(r).length)
  })

  it('stops after the file limit and says what it did not finish', async () => {
    const r = await findMedia([{ dir: join(root, 'Recordings'), depth: 6 }, { dir: join(root, 'Other'), depth: 6 }], { maxFiles: 3 })
    expect(r.stopped).toBe('files')
    expect(r.examined).toBeLessThanOrEqual(3)
    expect(r.unfinished.map((p) => p.slice(root.length + 1))).toEqual(['Recordings', 'Other'])
  })

  it('stops when the time is up', async () => {
    let t = 0
    const r = await findMedia([{ dir: join(root, 'Recordings'), depth: 6 }], { budgetMs: 2, now: () => (t += 1) })
    expect(r.stopped).toBe('time')
  })
})
