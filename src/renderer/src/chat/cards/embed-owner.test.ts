import { afterEach, describe, expect, it, vi } from 'vitest'
import { embedFor, newestOnDoc, pinEmbed, registerEmbed, setEmbedVisible, setWritingReplies, waitsForReply } from './embed-owner'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const unregister of cleanup.splice(0)) unregister()
  vi.restoreAllMocks()
})

describe('Craft editor activation', () => {
  it('keeps a user activation requested before the card mounts', () => {
    vi.spyOn(Date, 'now').mockReturnValue(200)
    pinEmbed('requested-card')
    cleanup.push(registerEmbed('requested-card', 'photocraft', 'PhotoCraft', 'project', 100))
    expect(embedFor('project')?.pinned).toBe(200)
  })

  it('retains the registration and requested priority when scrolling offscreen', () => {
    cleanup.push(registerEmbed('existing-card', 'filmcraft', 'FilmCraft', 'video', 100))
    pinEmbed('existing-card')
    const pinned = embedFor('video')?.pinned
    setEmbedVisible('existing-card', true)
    setEmbedVisible('existing-card', false)
    expect(embedFor('video')?.pinned).toBe(pinned)
  })

  it('does not transfer a requested activation to another card or project', () => {
    pinEmbed('unmounted-card')
    cleanup.push(registerEmbed('other-card', 'filmcraft', 'FilmCraft', 'other-project', 10))
    expect(embedFor('other-project')?.pinned).toBe(0)
  })

  it('points older cards on the same file to the newest one', () => {
    cleanup.push(registerEmbed('old', 'filmcraft', 'FilmCraft', 'ep', 1))
    cleanup.push(registerEmbed('new', 'filmcraft', 'FilmCraft', 'ep', 2))
    cleanup.push(registerEmbed('photo', 'photocraft', 'PhotoCraft', 'ep', 3))
    expect(newestOnDoc('old')).toBe('new')
    expect(newestOnDoc('new')).toBe('new')
    expect(newestOnDoc('photo')).toBe('photo')
  })
})

describe('a reply\'s editor card', () => {
  it('waits while the reply is written, the one before keeps the editor, then it takes over', () => {
    const offA = registerEmbed('a', 'filmcraft', 'FilmCraft', 'p', 1, 'm1')
    setWritingReplies(new Set(['m2']))
    const offB = registerEmbed('b', 'filmcraft', 'FilmCraft', 'p', 2, 'm2')
    expect(waitsForReply('b')).toBe(true)
    expect(newestOnDoc('a')).toBe('a')
    expect(newestOnDoc('b')).toBe('a')
    setWritingReplies(new Set())
    expect(waitsForReply('b')).toBe(false)
    expect(newestOnDoc('a')).toBe('b')
    offA()
    offB()
  })

  it('a first card waits too, with nothing above it', () => {
    setWritingReplies(new Set(['m3']))
    const off = registerEmbed('c', 'filmcraft', 'FilmCraft', 'q', 3, 'm3')
    expect(waitsForReply('c')).toBe(true)
    expect(newestOnDoc('c')).toBe('c')
    off()
    setWritingReplies(new Set())
  })
})
