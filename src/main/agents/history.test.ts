import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from '@shared/chat'

const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }))
vi.mock('../store', () => ({ getData: () => ({ brands: [] }) }))

const brandId = '00000000-0000-4000-8000-000000000001'
const threadId = '00000000-0000-4000-8000-000000000002'
const thread: Thread = { id: threadId, title: 'Feedback', updatedAt: 1, agentId: null, messages: [{ id: '00000000-0000-4000-8000-000000000003', role: 'user', text: 'Make the editor fill the chat', at: 1 }] }

beforeEach(async () => {
  vi.resetModules()
  state.directory = await fs.mkdtemp(join(tmpdir(), 'trenddeck-chat-history-test-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(state.directory, { recursive: true, force: true })
})

describe('retained chat history', () => {
  it('archives the complete thread before removing it', async () => {
    const history = await import('./history')
    await history.addThread(brandId, structuredClone(thread))
    await history.persist(brandId)
    await history.removeThread(brandId, threadId)
    expect(await history.findThread(brandId, threadId)).toBeNull()
    const saved = JSON.parse(await fs.readFile(join(state.directory, 'chats', 'removed', `${brandId}.jsonl`), 'utf8'))
    expect(saved.thread).toEqual(thread)
  })
  it('keeps the live and on-disk chat if archival fails', async () => {
    const history = await import('./history')
    await history.addThread(brandId, structuredClone(thread))
    await history.persist(brandId)
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'))
    await expect(history.removeThread(brandId, threadId)).rejects.toThrow('disk full')
    expect(await history.findThread(brandId, threadId)).toEqual(thread)
    expect(JSON.parse(await fs.readFile(join(state.directory, 'chats', `${brandId}.json`), 'utf8')).threads).toEqual([thread])
  })
  it('does not delete a brand history when its safety copy cannot be saved', async () => {
    const history = await import('./history')
    await history.addThread(brandId, structuredClone(thread))
    await history.persist(brandId)
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'))
    await expect(history.dropChats(brandId)).rejects.toThrow('disk full')
    expect(await history.findThread(brandId, threadId)).toEqual(thread)
    await expect(fs.access(join(state.directory, 'chats', `${brandId}.json`))).resolves.toBeUndefined()
  })
})
