import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAX_METADATA_BYTES, metadataFile, metadataPath, noSymlinks, remoteDestination, safeText } from './safety'

const folders: string[] = []
async function temporary(): Promise<string> {
  const folder = await fs.mkdtemp(join(tmpdir(), 'trenddeck-storage-safety-'))
  folders.push(folder)
  return folder
}
afterEach(async () => {
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true })
})

describe('metadata paths', () => {
  it.each(['notes/outline.md', 'project.json', '.gitignore', 'captions/en.srt'])('accepts %s', (name) => {
    expect(metadataPath(name)).toBe(name)
  })
  it.each(['../notes.md', '/notes.md', 'C:/notes.md', 'notes\\outline.md', 'notes//outline.md', '.git/config', '.env', 'notes.md:private', 'notes/../outside.md', 'notes./outline.md', 'NUL.txt', '-notes.md', 'video.mp4', 'recordings/notes.json', 'media/index.json', 'credentials.json', 'auth-token.txt', 'cookies.json', '.hidden/notes.md'])('rejects %s', (name) => {
    expect(() => metadataPath(name)).toThrow()
  })
})

describe('content guard', () => {
  it('accepts plain metadata', () => expect(safeText(Buffer.from('{"title":"Outline"}'))).toContain('Outline'))
  it.each(['password: ""', 'api_key: ""', 'authorization: ""', '-----BEGIN PRIVATE KEY-----'])('refuses credential fields or key headers without needing key literals', (text) => {
    expect(() => safeText(Buffer.from(text))).toThrow(/credentials/)
  })
  it('rejects binary, invalid UTF-8 and oversized content', () => {
    expect(() => safeText(Buffer.from([0]))).toThrow()
    expect(() => safeText(Buffer.from([255]))).toThrow()
    expect(() => safeText(Buffer.alloc(MAX_METADATA_BYTES + 1, 65))).toThrow()
  })
})

describe('filesystem containment', () => {
  it('reads ordinary metadata and refuses hard links', async () => {
    const root = await temporary()
    await fs.writeFile(join(root, 'notes.md'), 'Outline')
    expect((await metadataFile(root, 'notes.md')).toString()).toBe('Outline')
    await fs.link(join(root, 'notes.md'), join(root, 'linked.md'))
    await expect(metadataFile(root, 'linked.md')).rejects.toThrow(/hard links/)
  })
  it('rejects junction/symlink escapes', async () => {
    const root = await temporary()
    const outside = await temporary()
    await fs.writeFile(join(outside, 'notes.md'), 'Outside')
    await fs.symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(metadataFile(root, 'escape/notes.md')).rejects.toThrow(/links|junctions/)
    await expect(noSymlinks(join(root, 'escape'))).rejects.toThrow()
  })
})

describe('remote destinations', () => {
  it('accepts configured remote folder names', () => expect(remoteDestination('archive:Brand/Project')).toEqual({ remote: 'archive', destination: 'archive:Brand/Project' }))
  it.each([':s3:bucket', 'https://example.com', 'archive:', 'archive:/root', 'archive:../outside', 'archive:Brand/../outside', 'archive:Brand//Project', 'archive:Brand\\Project', 'archive:Brand?access_token=', 'archive:Brand\nProject', 'archive:./Project', 'archive:-flag', 'archive:Brand/Project.'])('rejects %s', (destination) => {
    expect(() => remoteDestination(destination)).toThrow()
  })
})
