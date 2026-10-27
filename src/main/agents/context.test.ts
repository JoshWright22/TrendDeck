import { describe, expect, it, vi } from 'vitest'
import type { Brand } from '@shared/types'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('node:fs', () => ({ promises: { readFile: vi.fn(async () => { throw new Error('No cached trends') }) } }))
vi.mock('../context', () => ({ styleContext: async () => '' }))
vi.mock('../brand-memory', () => ({ brandMemoryContext: async () => '' }))

import { brandContext, PROMPT_MAX } from './context'

describe('recording workflow context', () => {
  it('distinguishes dictated instructions from footage and discovers OBS and takes safely', async () => {
    const brand = { id: 'brand-a', name: 'Brand', keywords: [], subreddits: [], sites: [], ideas: [], projects: [], pipeline: [] } as unknown as Brand
    const context = await brandContext(brand)
    for (const instruction of [
      'Ordinary dictation updates the draft', 'enabled hands-free mode sends it', 'Dictation does not create a take',
      'rather than assuming a dump exists', 'Settings, Dictation', 'obs_show', 'even before a take exists',
      'take_list', 'take_get', 'take_show creates a new take card for analysis, not a new recording',
      'never bypass it', 'Never start capture or send audio to a remote service without permission',
      'only use it when the creator permits sharing that view', 'never ask for OBS passwords or stream keys in chat',
      'Do not claim transcription, analysis, OBS connection or recording succeeded until the tools confirm it',
      'consult the content map first', 'Say which past videos you are building on', 'similar_videos', 'what_worked', 'retention_dips'
    ]) expect(context).toContain(instruction)
    expect(context.length).toBeLessThan(PROMPT_MAX)
  })
})
