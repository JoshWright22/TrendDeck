import { describe, expect, it } from 'vitest'
import { cleanZoom, dockOpenClose, dockSizes, flatPrefs, panelsIn, prefsToRestore, stepZoom } from './craft-web-view'

const tabs = (panels: string[], active = 0) => ({ Tabs: { panels, active } })
const split = (axis: string, size: unknown, first: unknown, second: unknown) => ({ Split: { axis, size, first, second } })

// FilmCraft's default editing layout, roughly: sources and program on top, project and timeline below
const fresh = {
  root: split('Vertical', { Ratio: 0.5 }, split('Horizontal', { Ratio: 0.5 }, tabs(['Source', 'EffectControls']), tabs(['Program'])), split('Horizontal', { Ratio: 0.3 }, tabs(['Project', 'MediaBrowser']), tabs(['Timeline']))),
  floating: []
}

describe('craft-web view sizes', () => {
  it('snaps to the listed sizes and steps between them', () => {
    expect(cleanZoom(0.74)).toBe(0.75)
    expect(cleanZoom('x')).toBe(0.75)
    expect(cleanZoom(9)).toBe(1.25)
    expect(stepZoom(0.75, 1)).toBe(0.8)
    expect(stepZoom(0.75, -1)).toBe(0.67)
    expect(stepZoom(0.5, -1)).toBe(0.5)
    expect(stepZoom(1.25, 1)).toBe(1.25)
  })
})

describe('craft-web dock layout', () => {
  it('finds every panel, floating ones too', () => {
    expect(panelsIn({ ...fresh, floating: [{ id: 1, root: tabs(['Audio']), rect: [0, 0, 10, 10] }] })).toEqual(['Source', 'EffectControls', 'Program', 'Project', 'MediaBrowser', 'Timeline', 'Audio'])
  })

  it('closes the panels you closed and opens the ones you opened beside a panel they were with', () => {
    const saved = { root: split('Vertical', { Ratio: 0.6 }, tabs(['Program']), tabs(['Timeline', 'Captions'], 1)), floating: [] }
    const acts = dockOpenClose(fresh, saved)
    expect(acts).toContainEqual({ Open: { panel: 'Captions', anchor: 'Timeline' } })
    for (const p of ['Source', 'EffectControls', 'Project', 'MediaBrowser']) expect(acts).toContainEqual({ Close: { panel: p } })
    expect(acts.filter((a) => 'Close' in a)).toHaveLength(4)
  })

  it('never closes every panel and does nothing without a layout', () => {
    expect(dockOpenClose(fresh, { root: tabs(['Nothing']), floating: [] })).toEqual([])
    expect(dockOpenClose(null, fresh)).toEqual([])
    expect(dockOpenClose(fresh, null)).toEqual([])
  })

  it('puts the split sizes back where the panels match, and the tab each group showed', () => {
    const saved = {
      root: split('Vertical', { Ratio: 0.7 }, split('Horizontal', { FixedSecond: 900 }, tabs(['Source', 'EffectControls'], 1), tabs(['Program'])), split('Horizontal', { Ratio: 0.3 }, tabs(['Project', 'MediaBrowser']), tabs(['Timeline']))),
      floating: []
    }
    expect(dockSizes(fresh, saved)).toEqual([
      { ResizeSplit: { path: [], size: { Ratio: 0.7 } } },
      { ResizeSplit: { path: [false], size: { FixedSecond: 900 } } },
      { Activate: { panel: 'EffectControls' } }
    ])
  })

  it('reads the older bare tree FilmCraft 0.13 has', () => {
    const old = (size: unknown, active = 0) => ({ Split: { a: { Tabs: { active, panels: ['Source', 'Metadata'] } }, b: { Tabs: { active: 0, panels: ['Program'] } }, size, vertical: true } })
    expect(dockSizes(old({ Ratio: 0.5 }), old({ Ratio: 0.8 }, 1))).toEqual([{ ResizeSplit: { path: [], size: { Ratio: 0.8 } } }, { Activate: { panel: 'Metadata' } }])
    expect(dockOpenClose(old({ Ratio: 0.5 }), { Split: { a: { Tabs: { active: 0, panels: ['Source'] } }, b: { Tabs: { active: 0, panels: ['Program'] } }, size: { Ratio: 0.5 }, vertical: true } })).toEqual([{ Close: { panel: 'Metadata' } }])
  })

  it('leaves a split alone when its panels moved', () => {
    const saved = { root: split('Vertical', { Ratio: 0.7 }, tabs(['Program', 'Source']), tabs(['Timeline'])), floating: [] }
    expect(dockSizes(fresh, saved)).toEqual([])
  })
})

describe('craft-web prefs', () => {
  it('flattens to dotted keys and sets back only what differs and still exists', () => {
    expect(flatPrefs({ appearance: { uiScale: '75', animations: true } })).toEqual({ 'appearance.uiScale': '75', 'appearance.animations': true })
    const now = { appearance: { uiScale: 'auto', animations: true }, general: { lang: 'en' } }
    const saved = { appearance: { uiScale: '75', animations: true }, gone: { x: 1 } }
    expect(prefsToRestore(now, saved)).toEqual({ 'appearance.uiScale': '75' })
    expect(prefsToRestore(null, saved)).toEqual({})
  })
})
