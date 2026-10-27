import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APPS, fill, spec } from '../catalog'
import {
  commandIds,
  deletesFiles,
  gatewayName,
  gatewaySchema,
  hideRoot,
  isInside,
  newer,
  parseSums,
  pickAsset,
  resolveInProject,
  rewritePaths,
  riskFor,
  safeName,
  uniqueName,
  versionFromTag,
  zipTarget
} from '../rules'

const SUMS = `78638041dd32f85c143f0753e5830cdb7159d8117365461d70ad903346dc4291  filmcraft-0.13.0-freebsd-x86_64.tar.gz
43EF574058ACEB5AB060521E12722EE8B5F021C2E66702C4495463D384E87930 *filmcraft-0.13.0-windows-x64-portable.zip
# a comment
not a line
abc  too-short.zip
`

describe('SHA256SUMS.txt', () => {
  it('reads text and binary mode lines, lower cases the hash, skips the rest', () => {
    const m = parseSums(SUMS)
    expect(m.size).toBe(2)
    expect(m.get('filmcraft-0.13.0-windows-x64-portable.zip')).toBe('43ef574058aceb5ab060521e12722ee8b5f021c2e66702c4495463d384e87930')
    expect(m.get('filmcraft-0.13.0-freebsd-x86_64.tar.gz')).toMatch(/^7863/)
    expect(m.has('too-short.zip')).toBe(false)
  })
  it('handles windows line ends and ./ prefixes', () => {
    const m = parseSums(`${'a'.repeat(64)}  ./x.zip\r\n`)
    expect(m.get('x.zip')).toBe('a'.repeat(64))
  })
})

describe('release assets', () => {
  const names = ['filmcraft-0.13.0-windows-x64-portable.zip', 'filmcraft-0.13.0-windows-x86-portable.zip', 'filmcraft-0.13.0-windows-x64.msi', 'SHA256SUMS.txt']
  it('picks the portable zip for the arch', () => {
    expect(pickAsset(names, 'filmcraft', '0.13.0', 'x64')).toBe('filmcraft-0.13.0-windows-x64-portable.zip')
    expect(pickAsset(names, 'filmcraft', '0.13.0', 'ia32')).toBe('filmcraft-0.13.0-windows-x86-portable.zip')
  })
  it('arm64 takes its own build, else x64', () => {
    expect(pickAsset(names, 'filmcraft', '0.13.0', 'arm64')).toBe('filmcraft-0.13.0-windows-x64-portable.zip')
    expect(pickAsset([...names, 'filmcraft-0.13.0-windows-arm64-portable.zip'], 'filmcraft', '0.13.0', 'arm64')).toBe(
      'filmcraft-0.13.0-windows-arm64-portable.zip'
    )
  })
  it('null when there is no windows zip, never an msi', () => {
    expect(pickAsset(['filmcraft-0.13.0-windows-x64.msi'], 'filmcraft', '0.13.0', 'x64')).toBeNull()
    expect(pickAsset(names, 'photocraft', '0.13.0', 'x64')).toBeNull()
  })
  it('versions from tags and their order', () => {
    expect(versionFromTag('v0.13.0')).toBe('0.13.0')
    expect(versionFromTag('0.11.2')).toBe('0.11.2')
    expect(versionFromTag('v1.0.0-beta.1')).toBe('1.0.0-beta.1')
    expect(versionFromTag('nightly')).toBeNull()
    expect(versionFromTag('v1.0.0/../x')).toBeNull()
    expect(newer('0.13.1', '0.13.0')).toBe(true)
    expect(newer('0.10.0', '0.9.9')).toBe(true)
    expect(newer('0.13.0', '0.13.0')).toBe(false)
    expect(newer('1.0.0', '1.0.0-beta.2')).toBe(true)
    expect(newer('1.0.0-beta.2', '1.0.0')).toBe(false)
  })
})

describe('zip entries', () => {
  const root = resolve('C:/craft/filmcraft/0.13.0')
  const top = 'filmcraft-0.13.0-windows-x64-portable'
  it('drops the top folder', () => {
    expect(zipTarget(root, `${top}/filmcraft.exe`, top)).toBe(join(root, 'filmcraft.exe'))
    expect(zipTarget(root, `${top}/models/a.bin`, top)).toBe(join(root, 'models', 'a.bin'))
    expect(zipTarget(root, `${top}/`, top)).toBeNull()
  })
  it('refuses paths that climb out or are absolute', () => {
    expect(() => zipTarget(root, `${top}/../../evil.exe`, top)).toThrow(/unsafe/)
    expect(() => zipTarget(root, '../evil.exe', top)).toThrow(/unsafe/)
    expect(() => zipTarget(root, 'C:/Windows/evil.exe', top)).toThrow(/unsafe/)
    expect(() => zipTarget(root, '/etc/passwd', top)).toThrow(/unsafe/)
    expect(() => zipTarget(root, `${top}\\..\\evil.exe`, top)).toThrow(/unsafe/)
    expect(() => zipTarget(root, `${top}/a:b`, top)).toThrow(/unsafe/)
    expect(() => zipTarget(root, `${top}/CON`, top)).toThrow(/unsafe/)
  })
})

describe('folder names', () => {
  it('makes a windows safe name', () => {
    expect(safeName('My Brand')).toBe('My Brand')
    expect(safeName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j')
    expect(safeName('trailing dots...  ')).toBe('trailing dots')
    expect(safeName('   ')).toBe('Untitled')
    expect(safeName('..')).toBe('Untitled')
    expect(safeName('CON')).toBe('CON_')
    expect(safeName('lpt1.txt')).toBe('lpt1.txt_')
    expect(safeName('x'.repeat(200)).length).toBe(80)
    expect(safeName('tab\there\nnewline')).toBe('tab here newline')
  })
  it('finds the first free name, ignoring case', () => {
    expect(uniqueName('Video', [])).toBe('Video')
    expect(uniqueName('Video', ['video'])).toBe('Video (2)')
    expect(uniqueName('Video', ['Video', 'Video (2)'])).toBe('Video (3)')
  })
})

describe('project folder containment', () => {
  const root = resolve('C:/Users/me/Documents/TrendDeck/Brand/Clip')
  it('knows inside from outside', () => {
    expect(isInside(root, root)).toBe(true)
    expect(isInside(root, join(root, 'a', 'b.fcproj'))).toBe(true)
    expect(isInside(root, join(root, '..', 'Other', 'x'))).toBe(false)
    expect(isInside(root, `${root} 2\\x`)).toBe(false)
    expect(isInside(root, 'D:\\x')).toBe(false)
  })
  it('resolves relative paths into the folder and refuses the rest', () => {
    expect(resolveInProject(root, 'cut.fcproj')).toBe(join(root, 'cut.fcproj'))
    expect(resolveInProject(root, './exports/a.mp4')).toBe(join(root, 'exports', 'a.mp4'))
    expect(resolveInProject(root, join(root, 'x.png'))).toBe(join(root, 'x.png'))
    expect(() => resolveInProject(root, '../secret.txt')).toThrow(/outside/)
    expect(() => resolveInProject(root, 'C:\\Windows\\system32\\x')).toThrow(/outside/)
    expect(() => resolveInProject(root, '\\\\server\\share\\x')).toThrow(/network/)
    expect(() => resolveInProject(root, '~/x')).toThrow(/outside/)
    expect(() => resolveInProject(root, '  ')).toThrow()
  })
  it('rewrites path arguments at any depth and leaves other strings', () => {
    const out = rewritePaths(
      {
        id: 'file.exportMedia',
        params: { path: 'out/final.mp4', name: 'final', settings: { outputPath: 'b.mov', title: 'C: is a drive' } },
        paths: ['a.mov', 'b.mov'],
        seconds: 3
      },
      root
    )
    expect(out).toEqual({
      id: 'file.exportMedia',
      params: { path: join(root, 'out', 'final.mp4'), name: 'final', settings: { outputPath: join(root, 'b.mov'), title: 'C: is a drive' } },
      paths: [join(root, 'a.mov'), join(root, 'b.mov')],
      seconds: 3
    })
  })
  it('collects the paths it rewrote', () => {
    const found: string[] = []
    rewritePaths({ path: 'exports/a.png', note: 'hello', paths: ['b.mov'] }, root, '', found)
    expect(found).toEqual([join(root, 'exports', 'a.png'), join(root, 'b.mov')])
  })
  it('leaves plain words under keys that are only sometimes paths', () => {
    expect(rewritePaths({ id: 'markers.add', params: { target: 'program', time: 1 } }, root)).toEqual({ id: 'markers.add', params: { target: 'program', time: 1 } })
    expect(rewritePaths({ params: { target: 'renders/cut.mp4', output: 'out.mov' } }, root)).toEqual({ params: { target: join(root, 'renders', 'cut.mp4'), output: join(root, 'out.mov') } })
    expect(() => rewritePaths({ params: { target: '..' } }, root)).toThrow(/outside/)
    expect(() => rewritePaths({ params: { output: 'D:\\x' } }, root)).toThrow(/outside/)
  })
  it('refuses absolute paths outside the folder whatever the key', () => {
    expect(() => rewritePaths({ params: { lut: 'C:\\Users\\me\\.ssh\\id_rsa' } }, root)).toThrow(/outside/)
    expect(() => rewritePaths({ steps: [{ id: 'x', params: { file: '..\\..\\x' } }] }, root)).toThrow(/outside/)
    expect(() => rewritePaths({ text: '/etc/passwd' }, root)).toThrow(/outside/)
  })
  it('shows the folder as . in what goes back to the agent', () => {
    expect(hideRoot(`saved ${join(root, 'cut.fcproj')}`, root)).toBe('saved cut.fcproj')
    expect(hideRoot(JSON.stringify({ path: root }), root)).toBe('{"path":"."}')
    expect(hideRoot(JSON.stringify({ path: join(root, 'a.png') }), root)).toBe('{"path":"a.png"}')
  })
})

describe('risk of an app tool', () => {
  it('read only tools read, the rest edit', () => {
    expect(riskFor({ name: 'project_inspect', annotations: { readOnlyHint: true } })).toEqual({ risk: 'read', alwaysAsk: false })
    expect(riskFor({ name: 'render_frame', annotations: { readOnlyHint: true } }).risk).toBe('read')
    expect(riskFor({ name: 'command_run', annotations: { readOnlyHint: false, destructiveHint: true } })).toEqual({ risk: 'edit', alwaysAsk: false })
    expect(riskFor({ name: 'media_import' }).risk).toBe('edit')
  })
  it('ui tools edit even when they say read only', () => {
    expect(riskFor({ name: 'ui_click' }).risk).toBe('edit')
    expect(riskFor({ name: 'ui_screenshot', annotations: { readOnlyHint: true } }).risk).toBe('edit')
  })
  it('tools that delete always ask', () => {
    expect(riskFor({ name: 'doc_delete', annotations: { readOnlyHint: true } })).toEqual({ risk: 'edit', alwaysAsk: true })
    expect(riskFor({ name: 'remove_file' }).alwaysAsk).toBe(true)
    expect(riskFor({ name: 'removed_items_list', annotations: { readOnlyHint: true } }).alwaysAsk).toBe(false)
  })
  it('commands that remove files from disk are spotted', () => {
    expect(commandIds({ id: 'file.saveAs' })).toEqual(['file.saveAs'])
    expect(commandIds({ steps: [{ id: 'a' }, { id: 'b' }, 'x'] })).toEqual(['a', 'b'])
    expect(deletesFiles('media.deleteFromDisk')).toBe(true)
    expect(deletesFiles('file.delete')).toBe(true)
    expect(deletesFiles('proxies.delete')).toBe(true)
    expect(deletesFiles('file.projectManager')).toBe(true)
    expect(deletesFiles('timeline.delete')).toBe(false)
    expect(deletesFiles('edit.clear')).toBe(false)
  })
  it('names fit the gateway policy', () => {
    expect(gatewayName('filmcraft', 'render_frame')).toBe('filmcraft_render_frame')
    expect(gatewayName('filmcraft', 'Weird-Name.x')).toBe('filmcraft_weird_name_x')
    expect(gatewayName('photocraft', 'x'.repeat(100))).toHaveLength(64)
  })
})

describe('app tool schemas for the gateway checker', () => {
  it('spells out that nested objects take any keys, the top stays strict', () => {
    const s = gatewaySchema({
      type: 'object',
      properties: { id: { type: 'string' }, params: { type: 'object' }, n: { type: ['integer', 'null'] }, v: { type: ['string', 'number'] } },
      required: ['id']
    })
    expect(s.additionalProperties).toBe(false)
    const p = s.properties as Record<string, Record<string, unknown>>
    expect(p.params.additionalProperties).toBe(true)
    expect(p.n.type).toBe('integer')
    expect(p.v.type).toBeUndefined()
    expect(s.required).toEqual(['id'])
  })
  it('a missing schema is an empty object', () => {
    expect(gatewaySchema(undefined)).toEqual({ type: 'object', properties: {} })
  })
})

describe('catalog', () => {
  it('has the whole suite with unique ids that make good tool prefixes', () => {
    expect(APPS.length).toBe(13)
    expect(new Set(APPS.map((a) => a.id)).size).toBe(13)
    for (const a of APPS) {
      expect(a.id).toMatch(/^[a-z]+$/)
      expect(a.repo).toBe(`storytold/${a.id}`)
      expect(a.exts.length).toBeGreaterThan(0)
      for (const e of a.exts) expect(e).toMatch(/^\.[a-z0-9]+$/)
    }
  })
  it('fills the file path into tool steps', () => {
    const s = spec('filmcraft').newFile![0]
    expect(fill(s, 'C:\\p\\a.fcproj')).toEqual({ name: 'command_run', args: { id: 'file.saveAs', params: { path: 'C:\\p\\a.fcproj' } } })
    expect(spec('filmcraft').bridgeArgs!(9876)).toEqual(['--bridge', '127.0.0.1:9876'])
    expect(spec('figcraft').bridgeArgs!(1)).toEqual(['--attach', '127.0.0.1:1'])
    expect(spec('pdfcraft').bridgeArgs).toBeNull()
  })
})
