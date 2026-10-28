import { describe, expect, it } from 'vitest'
import { filmcraftWebStep, heavyCommand, mapProjectPaths, mimeOf, nativeExportParams, parseRange, PathTable, pickLive, projectPaths, proxyArgs, wantsProxy, webSpec, webTarget } from './craft-web'

describe('craft-web urls', () => {
  it('serves the app build and project files by token, nothing else', () => {
    expect(webTarget('craft-web://filmcraft/')).toEqual({ kind: 'app', appId: 'filmcraft', rel: 'index.html' })
    expect(webTarget('craft-web://filmcraft/filmcraft_web_bg.wasm?v=1')).toEqual({ kind: 'app', appId: 'filmcraft', rel: 'filmcraft_web_bg.wasm' })
    const token = 'a'.repeat(32)
    expect(webTarget(`craft-web://filmcraft/_project/${token}/media/My%20Clip.mp4`)).toEqual({ kind: 'project', appId: 'filmcraft', token, rel: 'media/My Clip.mp4' })
  })

  it('refuses paths that climb out, drive letters, backslashes and bad tokens', () => {
    // the url parser folds dot segments, so climbing ends at the root of what's served
    expect(webTarget('craft-web://filmcraft/%2e%2e/%2e%2e/secret.txt')).toEqual({ kind: 'app', appId: 'filmcraft', rel: 'secret.txt' })
    expect(webTarget(`craft-web://filmcraft/_project/${'a'.repeat(32)}/%2e%2e/%2e%2e/x.txt`)).toEqual({ kind: 'app', appId: 'filmcraft', rel: 'x.txt' })
    expect(webTarget('craft-web://filmcraft/C:/Windows/win.ini')).toBeNull()
    expect(webTarget('craft-web://filmcraft/a%5c..%5cb')).toBeNull()
    expect(webTarget('craft-web://filmcraft/a%00b')).toBeNull()
    expect(webTarget('craft-web://filmcraft/_project/short/x.mp4')).toBeNull()
    expect(webTarget(`craft-web://filmcraft/_project/${'a'.repeat(32)}`)).toBeNull()
    expect(webTarget('https://filmcraft/index.html')).toBeNull()
    expect(webTarget('craft-web://Bad_Host/index.html')).toBeNull()
  })

  it('has the wasm mime type streaming compilation needs', () => {
    expect(mimeOf('filmcraft_web_bg.wasm')).toBe('application/wasm')
    expect(mimeOf('filmcraft_web.js')).toMatch(/^text\/javascript/)
    expect(mimeOf('index.html')).toMatch(/^text\/html/)
    expect(mimeOf('clip.MP4')).toBe('video/mp4')
    expect(mimeOf('app/photocraft-web-ab.part-aa')).toBe('application/octet-stream')
  })
})

describe('byte ranges', () => {
  it('reads start-end, open ended and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 })
  })

  it('says unsatisfiable past the end, and ignores what it can not read', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=5-2', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-1', 0)).toBe('unsatisfiable')
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
  })
})

const DISK = 'C:\\Users\\me\\Documents\\TrendDeck\\Brand\\Ep 1\\media\\clip.mp4'
const project = {
  format: 'filmcraft.project',
  project: {
    items: {
      1: { name: 'clip.mp4', kind: { Media: { media: { File: { path: DISK } }, info: { name: 'clip.mp4' }, proxy_path: 'C:\\Users\\me\\Documents\\TrendDeck\\Brand\\Ep 1\\proxies\\clip_proxy.mp4' } } },
      8: { name: 'Main', kind: { Sequence: { video_tracks: [{ items: [{ name: 'clip.mp4' }] }] } } }
    }
  }
}

describe('project paths', () => {
  it('maps only path keys, never names that look the same', () => {
    const t = new PathTable()
    t.add(DISK.toUpperCase(), '/files/clip.mp4')
    const web = mapProjectPaths(project, (p) => t.web(p)) as typeof project
    expect(web.project.items[1].kind.Media.media.File.path).toBe('/files/clip.mp4')
    expect(web.project.items[1].name).toBe('clip.mp4')
    expect(web.project.items[1].kind.Media.info.name).toBe('clip.mp4')
    const back = mapProjectPaths(web, (p) => t.disk(p)) as typeof project
    expect(back.project.items[1].kind.Media.media.File.path).toBe(DISK.toUpperCase())
    expect(projectPaths(project)).toHaveLength(2)
  })

  it('lists the web paths it has no disk file for', () => {
    const t = new PathTable()
    t.add(DISK, '/files/clip.mp4')
    const doc = { a: { path: '/files/clip.mp4' }, b: { path: '/files/dropped.mov' }, c: { path: 'C:\\x.mov' } }
    expect(t.unknownIn(doc)).toEqual(['/files/dropped.mov'])
  })
})

describe('FilmCraft tools in the web build', () => {
  it('sends commands to execute, exports and proxies to the native engine', () => {
    expect(filmcraftWebStep('command_run', { id: 'timeline.razor', params: { time: 1 } })).toEqual({ kind: 'execute', command: 'timeline.razor', params: { time: 1 } })
    expect(filmcraftWebStep('command_run', { id: 'file.exportMedia', params: { path: 'C:\\p\\out.mp4' } })).toMatchObject({ kind: 'native', command: 'file.exportMedia' })
    expect(filmcraftWebStep('command_run', { id: 'export.queue.add', params: {} })).toMatchObject({ kind: 'native' })
    expect(filmcraftWebStep('command_run', { id: 'media.createProxies', params: {} })).toMatchObject({ kind: 'native' })
  })

  it('saves and reloads through TrendDeck', () => {
    expect(filmcraftWebStep('command_run', { id: 'file.save', params: {} })).toEqual({ kind: 'save', command: 'file.save', path: null })
    expect(filmcraftWebStep('command_run', { id: 'file.saveCopy', params: { path: 'C:\\p\\copy.fcproj' } })).toEqual({ kind: 'save', command: 'file.saveCopy', path: 'C:\\p\\copy.fcproj' })
    expect(filmcraftWebStep('command_run', { id: 'file.revert', params: {} })).toEqual({ kind: 'reload', path: null })
  })

  it('answers inspects and frames from the native engine, ui tools from the page', () => {
    expect(filmcraftWebStep('project_inspect', {})).toEqual({ kind: 'snapshot', tool: 'project_inspect', args: {} })
    expect(filmcraftWebStep('render_frame', { seconds: 2 })).toEqual({ kind: 'snapshot', tool: 'render_frame', args: { seconds: 2 } })
    expect(filmcraftWebStep('sequence_inspect', {})).toEqual({ kind: 'execute', command: 'sequence.inspect', params: {} })
    expect(filmcraftWebStep('ui_click', { id: 'tools.Razor' })).toEqual({ kind: 'request', method: 'ui.click', params: { id: 'tools.Razor' } })
    expect(filmcraftWebStep('ui_control', { method: 'ui.set', params: { tool: 'Razor' } })).toEqual({ kind: 'request', method: 'ui.set', params: { tool: 'Razor' } })
    expect(filmcraftWebStep('ui_screenshot', { panel: 'program' })).toEqual({ kind: 'screenshot', params: { panel: 'program' } })
    expect(filmcraftWebStep('media_import', { paths: ['C:\\p\\a.mp4'] })).toEqual({ kind: 'import', paths: ['C:\\p\\a.mp4'] })
    expect(filmcraftWebStep('command_batch', { steps: [{ id: 'a.b' }], stop_on_error: false })).toEqual({ kind: 'batch', steps: [{ id: 'a.b', params: {} }], stopOnError: false })
  })

  it('says what it can not do instead of guessing', () => {
    expect(filmcraftWebStep('something_new', {}).kind).toBe('unsupported')
    expect(filmcraftWebStep('command_run', {}).kind).toBe('unsupported')
    expect(filmcraftWebStep('media_import', { paths: [] }).kind).toBe('unsupported')
  })

  it('exports with hardware encoding unless asked otherwise, and waits', () => {
    expect(nativeExportParams({ path: 'x.mp4' })).toEqual({ path: 'x.mp4', settings: { hardwareEncoding: 'auto' }, wait: true })
    expect(nativeExportParams({ path: 'x.mp4', settings: { hardwareEncoding: 'off', crf: 18 } })).toEqual({ path: 'x.mp4', settings: { hardwareEncoding: 'off', crf: 18 }, wait: true })
  })
})

describe('which editors run', () => {
  const c = (id: string, key: string, rank: number, visible = true): { id: string; key: string; rank: number; visible: boolean } => ({ id, key, rank, visible })

  it('runs the two newest you can see, one per document', () => {
    const live = pickLive([c('a', 'film|p1', 1), c('b', 'film|p1', 2), c('c', 'photo|p1', 3), c('d', 'film|p2', 4, false)], new Set())
    expect([...live].sort()).toEqual(['b', 'c'])
  })

  it('keeps running ones running while visible, and the one asked for wins', () => {
    const now = new Set(['a', 'b'])
    expect([...pickLive([c('a', 'k1', 1), c('b', 'k2', 2), c('x', 'k3', 0)], now)].sort()).toEqual(['a', 'b'])
    // x asked for with Open here: it ranks newest, a still running one makes room
    expect([...pickLive([c('a', 'k1', 1), c('b', 'k2', 2), c('x', 'k3', 10)], now)].sort()).toEqual(['b', 'x'])
  })

  it('keeps one running after it scrolls away, until one you can see needs the room', () => {
    expect([...pickLive([c('a', 'k1', 1, false)], new Set(['a']))]).toEqual(['a'])
    // never starts one you can't see
    expect(pickLive([c('a', 'k1', 1, false)], new Set()).size).toBe(0)
    // two visible ones take both places from the one out of view
    expect([...pickLive([c('a', 'k1', 9, false), c('b', 'k2', 1), c('d', 'k3', 2)], new Set(['a']))].sort()).toEqual(['b', 'd'])
  })

  it('only FilmCraft and PhotoCraft run in the chat for now', () => {
    expect(webSpec('filmcraft')?.kind).toBe('api')
    expect(webSpec('photocraft')?.kind).toBe('files')
    expect(webSpec('soundcraft')).toBeNull()
  })
})

describe('proxies', () => {
  it('are made for footage over 1080p, heavy bit rates and heavy codecs', () => {
    expect(wantsProxy({ width: 3840, height: 2160, bitRate: 40e6, codec: 'h264' })).toBe(true)
    expect(wantsProxy({ width: 1920, height: 1080, bitRate: 70e6, codec: 'h264' })).toBe(true)
    expect(wantsProxy({ width: 1920, height: 1080, bitRate: 8e6, codec: 'prores' })).toBe(true)
    expect(wantsProxy({ width: 1920, height: 1080, bitRate: 8e6, codec: 'h264' })).toBe(false)
    expect(wantsProxy({ width: 0, height: 0, bitRate: 0, codec: '' })).toBe(false)
  })

  it('keep the frame rate and length, at quarter size with a short GOP', () => {
    const args = proxyArgs('in.mov', 'out.mp4')
    expect(args).not.toContain('-r')
    expect(args.slice(args.indexOf('-vf'), args.indexOf('-vf') + 2)).toEqual(['-vf', 'scale=-2:540'])
    expect(args).toContain('-threads')
    expect(args.at(-1)).toBe('out.mp4')
  })
})

describe('heavy filmcraft edits', () => {
  it('sends edits that read whole media files to the native engine, the rest to the page', () => {
    expect(filmcraftWebStep('command_run', { id: 'clip.extractAudio', params: { items: [7] } })).toMatchObject({ kind: 'nativeEdit', command: 'clip.extractAudio' })
    expect(filmcraftWebStep('command_run', { id: 'clip.audioGain', params: { mode: 'normalizeAll', db: -1 } })).toMatchObject({ kind: 'nativeEdit' })
    expect(filmcraftWebStep('command_run', { id: 'clip.audioGain', params: { mode: 'set', db: -3 } })).toMatchObject({ kind: 'execute' })
    expect(filmcraftWebStep('command_run', { id: 'clip.synchronize', params: { method: 'audio' } })).toMatchObject({ kind: 'nativeEdit' })
    expect(filmcraftWebStep('command_run', { id: 'clip.synchronize', params: { method: 'timecode' } })).toMatchObject({ kind: 'execute' })
    expect(heavyCommand('essentialSound.autoMatch', {})).toBe(true)
    expect(heavyCommand('timeline.place', {})).toBe(false)
  })
})
