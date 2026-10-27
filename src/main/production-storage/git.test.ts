import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commitMetadata, initRepository, repositoryDiff, repositoryStatus } from './git'
import { executable, runProcess } from './process'
import { IGNORE_POLICY } from './safety'

const folders: string[] = []
async function temporary(): Promise<string> {
  const folder = await fs.mkdtemp(join(tmpdir(), 'trenddeck-storage-git-'))
  folders.push(folder)
  return folder
}
afterEach(async () => {
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true })
})

describe('real metadata Git operations', () => {
  it('initializes policy before staging, commits only selected metadata and reads diffs', async () => {
    const root = await temporary()
    await fs.writeFile(join(root, 'recording.mp4'), 'not media content')
    await fs.writeFile(join(root, 'notes.md'), 'First outline\n')
    await fs.writeFile(join(root, 'other.md'), 'Not selected\n')
    expect(await initRepository(root)).toEqual({ initialized: true })
    expect(await fs.readFile(join(root, '.gitignore'), 'utf8')).toBe(IGNORE_POLICY)
    expect(await initRepository(root)).toEqual({ initialized: false })
    const result = await commitMetadata(root, ['notes.md'], 'Save outline') as { commit: string }
    expect(result.commit).toMatch(/^[a-f0-9]{40,64}$/)
    expect(await repositoryStatus(root)).toMatchObject({ tracked: ['.gitignore', 'notes.md'], changes: [] })
    const git = await executable('git')
    expect(await runProcess(git, ['check-ignore', 'recording.mp4'], root)).toContain('recording.mp4')
    await fs.writeFile(join(root, 'notes.md'), 'Second outline\n')
    expect(await repositoryDiff(root, ['notes.md'])).toMatchObject({ staged: '', working: expect.stringContaining('+Second outline') })
    await commitMetadata(root, ['notes.md'], 'Revise outline')
    expect(await repositoryStatus(root)).toMatchObject({ changes: [] })
    await fs.writeFile(join(root, 'notes.md'), 'password: ""\n')
    await expect(repositoryDiff(root, ['notes.md'])).rejects.toThrow(/credentials/)
    await expect(commitMetadata(root, ['notes.md'], 'Unsafe outline')).rejects.toThrow(/credentials/)
  })
  it('refuses media paths, staged media and unsafe local configuration', async () => {
    const root = await temporary()
    await initRepository(root)
    await fs.writeFile(join(root, 'notes.md'), 'Outline\n')
    await fs.writeFile(join(root, 'recording.mp4'), 'Not real media\n')
    await expect(commitMetadata(root, ['recording.mp4'], 'Media')).rejects.toThrow(/metadata/)
    await runProcess(await executable('git'), ['add', '-f', '--', 'recording.mp4'], root)
    await expect(commitMetadata(root, ['notes.md'], 'Outline')).rejects.toThrow(/metadata/)
    await fs.appendFile(join(root, '.git', 'config'), '\n[include]\n\tpath = outside-config\n')
    await expect(repositoryStatus(root)).rejects.toThrow(/configuration/)
  })
  it('leaves preexisting repositories and custom ignore files untouched', async () => {
    const root = await temporary()
    await fs.writeFile(join(root, '.gitignore'), '*.tmp\n')
    await expect(initRepository(root)).rejects.toThrow(/custom/)
    expect(await fs.readFile(join(root, '.gitignore'), 'utf8')).toBe('*.tmp\n')
    const existing = await temporary()
    await runProcess(await executable('git'), ['init', '--template=', '.'], existing)
    await expect(initRepository(existing)).rejects.toThrow(/created by/)
  })
})
