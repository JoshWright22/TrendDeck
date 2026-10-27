import { describe, expect, it, vi } from 'vitest'
import { draftKey, DraftStore } from './draft-store'

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const values = new Map<string, string>()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: (key) => { values.delete(key) } }
}

describe('saved chat drafts', () => {
  it('restores unsent typing after reopening the application', () => {
    const disk = storage()
    const first = new DraftStore(disk)
    first.set('chat', 'Please make the editor fill the chat')
    expect(new DraftStore(disk).get('chat')).toEqual({ text: 'Please make the editor fill the chat', saved: true })
  })
  it('keeps brands, chats and new-project drafts separate', () => {
    const keys = [draftKey('a', 'one', 'video'), draftKey('a', 'two', 'video'), draftKey('b', 'one', 'video'), draftKey('a', null, 'video'), draftKey('a', null, 'other')]
    expect(new Set(keys).size).toBe(keys.length)
    const store = new DraftStore(storage())
    keys.forEach((key, index) => store.set(key, String(index)))
    keys.forEach((key, index) => expect(store.get(key).text).toBe(String(index)))
  })
  it('clears a sent draft and supports appended dictation', () => {
    const disk = storage()
    const store = new DraftStore(disk)
    store.set('chat', 'First')
    store.set('chat', (text) => `${text} second`)
    expect(store.get('chat').text).toBe('First second')
    store.set('chat', '')
    expect(new DraftStore(disk).get('chat').text).toBe('')
  })
  it('retains text in memory and reports disk-write failures', () => {
    const disk = storage()
    disk.setItem = () => { throw new Error('disk unavailable') }
    const store = new DraftStore(disk)
    store.set('chat', 'Do not lose this')
    expect(store.get('chat')).toEqual({ text: 'Do not lose this', saved: false })
  })
  it('only notifies the changed chat and returns stable snapshots', () => {
    const store = new DraftStore(storage())
    const changed = vi.fn()
    const other = vi.fn()
    const off = store.subscribe('chat', changed)
    store.subscribe('other', other)
    expect(store.get('chat')).toBe(store.get('chat'))
    store.set('chat', 'saved')
    expect(changed).toHaveBeenCalledOnce()
    expect(other).not.toHaveBeenCalled()
    off()
    store.set('chat', 'again')
    expect(changed).toHaveBeenCalledOnce()
  })
})
