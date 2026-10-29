import { describe, expect, it } from 'vitest'
import { defaultRoot, inOneDrive, swapRoot } from './root-paths'

const env = { OneDrive: 'C:\\Users\\awsom\\OneDrive' }

describe('project folder outside OneDrive', () => {
  it('knows a folder OneDrive syncs', () => {
    expect(inOneDrive('C:\\Users\\awsom\\OneDrive\\Documents', env)).toBe(true)
    expect(inOneDrive('C:\\Users\\a\\OneDrive - Contoso\\Documents', {})).toBe(true)
    expect(inOneDrive('C:\\Users\\awsom\\Videos', env)).toBe(false)
    expect(inOneDrive('C:\\Users\\awsom\\OneDriveStuff', {})).toBe(false)
  })

  it('takes Documents unless OneDrive has it, then Videos, then home', () => {
    const dirs = { documents: 'C:\\Users\\awsom\\OneDrive\\Documents', videos: 'C:\\Users\\awsom\\Videos', home: 'C:\\Users\\awsom' }
    expect(defaultRoot(dirs, env)).toMatch(/Videos[\\/]TrendDeck$/)
    expect(defaultRoot({ ...dirs, documents: 'D:\\Docs' }, env)).toMatch(/Docs[\\/]TrendDeck$/)
    expect(defaultRoot({ ...dirs, videos: 'C:\\Users\\awsom\\OneDrive\\Videos' }, env)).toMatch(/awsom[\\/]TrendDeck$/)
  })

  it('moves every spelling of the old folder in a saved file', () => {
    const from = 'C:\\Users\\awsom\\OneDrive\\Documents\\TrendDeck'
    const to = 'C:\\Users\\awsom\\Videos\\TrendDeck'
    const json = JSON.stringify({ path: `${from}\\My Brand\\a.mp4`, other: 'C:/Users/awsom/OneDrive/Documents/TrendDeck/x' })
    const out = JSON.parse(swapRoot(json, from, to)) as { path: string; other: string }
    expect(out.path).toBe(`${to}\\My Brand\\a.mp4`)
    expect(out.other).toBe('C:/Users/awsom/Videos/TrendDeck/x')
  })
})
