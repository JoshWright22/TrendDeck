import { afterEach, describe, expect, it, vi } from 'vitest'
import { embedFor, pinEmbed, registerEmbed, setEmbedVisible } from './embed-owner'

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
})
