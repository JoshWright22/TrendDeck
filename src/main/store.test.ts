import { describe, expect, it, vi } from 'vitest'
import type { AppData, Brand } from '@shared/types'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const { keepBrandFolders, sanitize } = await import('./store')
const { brandFolderName } = await import('./craft/root')

const ID = '00000000-0000-4000-8000-000000000001'
const brand = (p: Partial<Brand> = {}): Brand => ({ id: ID, name: 'My Brand', keywords: [], subreddits: [], adblock: true, adblockAllow: [], sites: [], threads: [], ideas: [], projects: [], pipeline: [], ...p })
const data = (b: Brand): AppData => ({ version: 1, activeBrandId: ID, chatOpen: false, onboarded: true, settings: { youtubeApiKey: '', tabCap: 4, autoUpdate: true }, brands: [b] })

describe('brand folders through a rename', () => {
  it('keeps the old folder when it is already on disk', () => {
    const out = keepBrandFolders(data(brand({ name: 'Josh Wright' })), data(brand()), (n) => n === 'My Brand')
    expect(out.brands[0].folderName).toBe('My Brand')
    expect(brandFolderName(out.brands[0])).toBe('My Brand')
  })

  it('uses the new name when nothing was made on disk yet', () => {
    const out = keepBrandFolders(data(brand({ name: 'Josh Wright' })), data(brand()), () => false)
    expect(out.brands[0].folderName).toBeUndefined()
    expect(brandFolderName(out.brands[0])).toBe('Josh Wright')
  })

  it('a kept folder stays through later saves and renames, whatever the renderer sends', () => {
    const prev = data(brand({ name: 'Josh Wright', folderName: 'My Brand' }))
    expect(keepBrandFolders(data(brand({ name: 'Josh Wright' })), prev, () => true).brands[0].folderName).toBe('My Brand')
    expect(keepBrandFolders(data(brand({ name: 'JW', folderName: 'Elsewhere' })), prev, () => true).brands[0].folderName).toBe('My Brand')
  })

  it('a new brand or an unchanged name gets no folderName, even if one is sent', () => {
    expect(keepBrandFolders(data(brand({ folderName: 'Sneaky' })), null, () => true).brands[0].folderName).toBeUndefined()
    expect(keepBrandFolders(data(brand()), data(brand()), () => true).brands[0].folderName).toBeUndefined()
  })

  it('the file keeps a safe folderName and drops a path', () => {
    expect(sanitize(data(brand({ folderName: 'My Brand' }))).brands[0].folderName).toBe('My Brand')
    expect(sanitize(data(brand({ folderName: '..\\..\\Windows' }))).brands[0].folderName).toBeUndefined()
    expect(sanitize(data(brand({ folderName: 'C:\\x' }))).brands[0].folderName).toBeUndefined()
  })
})
