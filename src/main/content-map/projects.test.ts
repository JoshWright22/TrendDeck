import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { TakeCard } from '@shared/cards'
import { readLocal } from './projects'

const root = join(tmpdir(), `td-content-map-${process.pid}`)
afterAll(() => fs.rm(root, { recursive: true, force: true }))

describe('project folders', () => {
  it('reads the script, the newest captions, the export and thumbnail text', async () => {
    const dir = join(root, 'Budget PC')
    await fs.mkdir(join(dir, 'scripts'), { recursive: true })
    await fs.mkdir(join(dir, 'exports'), { recursive: true })
    await fs.writeFile(join(dir, 'scripts', 'script.md'), '# Budget PC\n\n## Hook\n\n- [you] So last week I tried something dumb. <!-- id:a1 -->\n- [suggestion] Here is what happened. <!-- id:a2 -->\n')
    await fs.writeFile(join(dir, 'exports', 'final.srt'), '1\n00:00:00,000 --> 00:00:03,000\nSo last week I tried something dumb.\n')
    await fs.writeFile(join(dir, 'exports', 'final.mp4'), '')
    await fs.writeFile(join(dir, 'thumbnail.txt'), '$300 PC?\n')
    const info = await readLocal({ id: 'p1', name: 'Budget PC', createdAt: 0 }, dir, [])
    expect(info.script).toEqual(['So last week I tried something dumb.', 'Here is what happened.'])
    expect(info.lines).toEqual([{ text: 'So last week I tried something dumb.', from: 0, to: 3, source: 'transcript' }])
    expect(info.exportAt).not.toBeNull()
    expect(info.thumbnailText).toBe('$300 PC?')
  })

  it('falls back to the newest take: its words, and its script lines with times', async () => {
    const take = {
      type: 'take',
      projectId: 'p2',
      state: 'ready',
      at: 5,
      transcript: { text: 'hi there', words: [{ text: 'hi', start: 0, end: 0.3 }], duration: 1, engine: 'local', model: 'x' },
      diff: { scriptFile: 'scripts/script.md', pickups: [], lines: [{ lineId: 'a', text: 'Hi there.', status: 'said', coverage: 1, from: 0, to: 1, said: 'hi there' }, { lineId: 'b', text: 'Missed.', status: 'missed', coverage: 0, from: null, to: null, said: '' }] }
    } as unknown as TakeCard
    const info = await readLocal({ id: 'p2', name: 'No folder', createdAt: 0 }, null, [take])
    expect(info.wordsSource).toBe('take')
    expect(info.lines).toEqual([{ text: 'Hi there.', from: 0, to: 1, source: 'script' }])
    expect((await readLocal({ id: 'p3', name: 'Other', createdAt: 0 }, null, [take])).words).toEqual([])
  })
})
