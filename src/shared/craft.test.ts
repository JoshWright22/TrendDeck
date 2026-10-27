import { describe, expect, it } from 'vitest'
import { craftBelongsTo } from './craft'

describe('Craft project isolation', () => {
  const status = { running: true, brandId: 'brand-a', projectId: 'project-a' }

  it('only docks the running editor for its owning brand and project', () => {
    expect(craftBelongsTo(status, 'brand-a', 'project-a')).toBe(true)
    expect(craftBelongsTo(status, 'brand-b', 'project-a')).toBe(false)
    expect(craftBelongsTo(status, 'brand-a', 'project-b')).toBe(false)
  })

  it('does not dock stopped or unassigned editors', () => {
    expect(craftBelongsTo({ ...status, running: false }, 'brand-a', 'project-a')).toBe(false)
    expect(craftBelongsTo({ ...status, brandId: null, projectId: null }, 'brand-a', 'project-a')).toBe(false)
  })
})
