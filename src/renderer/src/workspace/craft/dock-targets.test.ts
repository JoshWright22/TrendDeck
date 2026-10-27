import { describe, expect, it } from 'vitest'
import type { CraftDock } from '@shared/craft'
import { containedBy, DockTargets } from './dock-targets'

const dock = (appId = 'filmcraft', visible = true): CraftDock => ({
  appId,
  bounds: { x: 20, y: 40, width: 600, height: 300 },
  visible
})

describe('Craft dock ownership', () => {
  it('gives the chat priority over a legacy workspace', () => {
    const sent: CraftDock[] = []
    const targets = new DockTargets((value) => sent.push(value))
    targets.set(Symbol('workspace'), dock(), 0)
    targets.set(Symbol('chat'), { ...dock(), bounds: { x: 40, y: 80, width: 700, height: 400 } }, 1)
    targets.set(Symbol('workspace update'), dock(), 0)
    expect(sent).toHaveLength(2)
    expect(sent.at(-1)?.bounds?.width).toBe(700)
  })

  it('does not let a hidden workspace hide the chat', () => {
    const sent: CraftDock[] = []
    const targets = new DockTargets((value) => sent.push(value))
    const workspace = Symbol('workspace')
    targets.set(workspace, dock(), 0)
    targets.set(Symbol('chat'), dock(), 1)
    targets.remove(workspace)
    expect(sent.at(-1)?.visible).toBe(true)
  })

  it('hides an app when its last surface is removed', () => {
    const sent: CraftDock[] = []
    const targets = new DockTargets((value) => sent.push(value))
    const chat = Symbol('chat')
    targets.set(chat, dock(), 1)
    targets.remove(chat)
    expect(sent.at(-1)).toEqual({ appId: 'filmcraft', bounds: null, visible: false })
  })

  it('keeps different apps independent', () => {
    const sent: CraftDock[] = []
    const targets = new DockTargets((value) => sent.push(value))
    const photo = Symbol('photo')
    targets.set(Symbol('video'), dock(), 1)
    targets.set(photo, dock('photocraft'), 1)
    targets.remove(photo)
    expect(sent.filter((value) => value.appId === 'filmcraft')).toEqual([dock()])
  })

  it('does not reveal a lower-priority app surface behind a modal', () => {
    const sent: CraftDock[] = []
    const targets = new DockTargets((value) => sent.push(value))
    targets.set(Symbol('workspace'), dock(), 0)
    targets.set(Symbol('chat'), dock('filmcraft', false), 1)
    expect(sent.at(-1)?.visible).toBe(false)
  })
})

describe('Craft viewport clipping', () => {
  const viewport = { left: 0, top: 0, right: 800, bottom: 600 }

  it('allows fully visible and edge-aligned editor surfaces', () => {
    expect(containedBy(viewport, viewport)).toBe(true)
    expect(containedBy({ left: 20, top: 40, right: 700, bottom: 500 }, viewport)).toBe(true)
  })

  it('rejects surfaces clipped on any side', () => {
    expect(containedBy({ ...viewport, left: -1 }, viewport)).toBe(false)
    expect(containedBy({ ...viewport, top: -1 }, viewport)).toBe(false)
    expect(containedBy({ ...viewport, right: 801 }, viewport)).toBe(false)
    expect(containedBy({ ...viewport, bottom: 601 }, viewport)).toBe(false)
  })
})
