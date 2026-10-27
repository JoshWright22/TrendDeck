import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { periodicSave, projectOperation, snapshotFile, SNAPSHOT_LIMIT } from '../recovery'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'craft-recovery-'))
})

afterEach(async () => {
  vi.useRealTimers()
  await fs.rm(root, { recursive: true, force: true })
})

describe('recoverable project snapshots', () => {
  it('keeps original files and existing checkpoints, pruning only owned copies within this project', async () => {
    const file = join(root, 'original.fcproj')
    const other = join(root, 'another-project')
    await fs.mkdir(other)
    await fs.writeFile(join(other, 'other.fcproj'), 'other')
    const otherSnapshot = await snapshotFile(other, join(other, 'other.fcproj'), 'filmcraft', 'before-open')
    const checkpoint = join(root, '.trenddeck', 'checkpoints', 'existing')
    await fs.mkdir(checkpoint, { recursive: true })
    await fs.writeFile(join(checkpoint, 'original.fcproj'), 'checkpoint')
    for (let index = 0; index < SNAPSHOT_LIMIT + 4; index++) {
      await fs.writeFile(file, `version ${index}`)
      await projectOperation(root, () => snapshotFile(root, file, index % 2 ? 'filmcraft' : 'photocraft', 'autosave'))
    }
    const directory = join(root, '.trenddeck', 'autosaves')
    expect(await fs.readdir(directory)).toHaveLength(SNAPSHOT_LIMIT)
    expect(await fs.readFile(file, 'utf8')).toBe(`version ${SNAPSHOT_LIMIT + 3}`)
    expect(await fs.readFile(join(checkpoint, 'original.fcproj'), 'utf8')).toBe('checkpoint')
    expect(await fs.readFile(otherSnapshot, 'utf8')).toBe('other')
    for (const entry of await fs.readdir(directory)) {
      expect(await fs.readFile(join(directory, entry, 'original.fcproj'), 'utf8')).toMatch(/^version /)
      expect(JSON.parse(await fs.readFile(join(directory, entry, 'snapshot.json'), 'utf8')).file).toBe('original.fcproj')
    }
  })

  it('refuses outside files and linked recovery directories', async () => {
    const project = join(root, 'project')
    const outside = join(root, 'outside.fcproj')
    await fs.mkdir(project)
    await fs.writeFile(outside, 'outside')
    await expect(snapshotFile(project, outside, 'filmcraft', 'autosave')).rejects.toThrow('inside its project')
    const file = join(project, 'main.fcproj')
    await fs.writeFile(file, 'original')
    await fs.symlink(root, join(project, '.trenddeck'), 'junction')
    await expect(snapshotFile(project, file, 'filmcraft', 'autosave')).rejects.toThrow('Unsafe')
    expect(await fs.readFile(file, 'utf8')).toBe('original')
  })

  it('does not prune unowned or incomplete entries', async () => {
    const file = join(root, 'main.fcproj')
    await fs.writeFile(file, 'original')
    await snapshotFile(root, file, 'filmcraft', 'before-open')
    const foreign = join(root, '.trenddeck', 'autosaves', '0000000000000-00000000-0000-0000-0000-000000000000')
    await fs.mkdir(foreign)
    await fs.writeFile(join(foreign, 'keep.fcproj'), 'keep')
    for (let index = 0; index <= SNAPSHOT_LIMIT; index++) {
      await fs.writeFile(file, `version ${index}`)
      await snapshotFile(root, file, 'filmcraft', 'autosave')
    }
    expect(await fs.readFile(join(foreign, 'keep.fcproj'), 'utf8')).toBe('keep')
  })

  it('does not evict meaningful history when the editor keeps saving unchanged content', async () => {
    const file = join(root, 'main.fcproj')
    await fs.writeFile(file, 'original')
    const original = await snapshotFile(root, file, 'filmcraft', 'before-open')
    await fs.writeFile(file, 'edited')
    const edited = await snapshotFile(root, file, 'filmcraft', 'autosave')
    for (let index = 0; index <= SNAPSHOT_LIMIT; index++) expect(await snapshotFile(root, file, 'filmcraft', 'autosave')).toBe(edited)
    expect(await fs.readFile(original, 'utf8')).toBe('original')
    expect(await fs.readdir(join(root, '.trenddeck', 'autosaves'))).toHaveLength(2)
  })

  it('serializes operations per project, recovers after rejection, and lets other projects proceed', async () => {
    let release!: () => void
    const gate = new Promise<void>((done) => { release = done })
    const order: string[] = []
    const first = projectOperation(root, async () => { order.push('first'); await gate; throw new Error('save failed') })
    const failed = expect(first).rejects.toThrow('save failed')
    const second = projectOperation(root, async () => { order.push('second') })
    await projectOperation(join(root, 'other'), async () => { order.push('other') })
    expect(order).toEqual(['first', 'other'])
    release()
    await failed
    await second
    expect(order).toEqual(['first', 'other', 'second'])
  })
})

describe('periodic autosave', () => {
  it('never overlaps, retries failures, and stops without scheduling another save', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const gate = new Promise<void>((done) => { release = done })
    const save = vi.fn().mockReturnValueOnce(gate).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const failed = vi.fn()
    const stop = periodicSave(save, failed, 100)
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(100)
    expect(failed).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(100)
    expect(save).toHaveBeenCalledTimes(3)
    stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(3)
  })
})
