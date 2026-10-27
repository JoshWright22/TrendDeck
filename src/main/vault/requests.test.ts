import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Turn } from '../mcp/turns'

const mocks = vi.hoisted(() => ({
  save: vi.fn(async () => ''),
  close: null as ((turn: { id: string }) => void) | null,
  siteUrl: 'https://example.com',
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(name, handler) }
}))
vi.mock('../mcp/turns', () => ({ onTurnClosed: (callback: (turn: { id: string }) => void) => { mocks.close = callback } }))
vi.mock('../store', () => ({ getData: () => ({ brands: [{ id: 'brand-a', sites: [{ id: 'site-a', url: mocks.siteUrl }] }] }) }))
vi.mock('./store', () => ({ saveLogin: mocks.save }))

import { answerLogin, loginRequests, requestLogin, setupLoginRequests } from './requests'

const turn: Turn = { id: 'turn-a', token: 'private-turn-token', brandId: 'brand-a', threadId: 'thread-a', sharedSiteId: null, startedAt: 0 }
const site = { id: 'site-a', name: 'Example', url: 'https://example.com' }
const input = { username: 'private-user', password: 'private-password', notes: '', loginUrl: '' }

beforeEach(() => {
  vi.useFakeTimers()
  mocks.siteUrl = site.url
  mocks.save.mockReset().mockResolvedValue('')
  setupLoginRequests()
})

afterEach(async () => {
  for (const request of loginRequests()) await answerLogin(request.id, null)
  vi.useRealTimers()
})

describe('secure sign-in requests', () => {
  it('only exposes site and routing metadata, never credentials or turn tokens', async () => {
    const result = requestLogin(turn, site)
    const request = loginRequests()[0]
    expect(request).toMatchObject({ brandId: 'brand-a', threadId: 'thread-a', siteId: 'site-a' })
    expect(JSON.stringify(request)).not.toContain('private')
    expect(await answerLogin(request.id, input)).toBe('')
    expect(mocks.save).toHaveBeenCalledWith('brand-a', 'site-a', input)
    expect(await result).toBe(true)
    expect(loginRequests()).toEqual([])
  })

  it('lets the user cancel without saving a login', async () => {
    const result = requestLogin(turn, site)
    await answerLogin(loginRequests()[0].id, null)
    expect(await result).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('expires unanswered requests', async () => {
    const result = requestLogin(turn, site)
    const id = loginRequests()[0].id
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(await result).toBe(false)
    expect(await answerLogin(id, input)).toContain('expired')
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('cancels requests when their owning agent turn ends', async () => {
    const result = requestLogin(turn, site)
    mocks.close?.({ id: turn.id })
    expect(await result).toBe(false)
    expect(loginRequests()).toEqual([])
  })

  it('refuses credentials if the website changed after the request', async () => {
    const result = requestLogin(turn, site)
    mocks.siteUrl = 'https://different.example'
    expect(await answerLogin(loginRequests()[0].id, input)).toContain('website changed')
    expect(await result).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('blocks website webviews from submitting credentials', async () => {
    const result = requestLogin(turn, site)
    const response = await mocks.handlers.get('vault:answer-login')?.({ sender: { getType: () => 'webview' } }, loginRequests()[0].id, input)
    expect(response).toContain('Invalid')
    expect(mocks.save).not.toHaveBeenCalled()
    await answerLogin(loginRequests()[0].id, null)
    expect(await result).toBe(false)
  })

  it('keeps a failed secure save retryable without leaking exception content', async () => {
    const result = requestLogin(turn, site)
    mocks.save.mockRejectedValueOnce(new Error('private-password'))
    const response = await answerLogin(loginRequests()[0].id, input)
    expect(response).not.toContain('private-password')
    expect(loginRequests()).toHaveLength(1)
    await answerLogin(loginRequests()[0].id, null)
    expect(await result).toBe(false)
  })
})
