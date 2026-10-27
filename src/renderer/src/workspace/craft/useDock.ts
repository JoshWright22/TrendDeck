import { useEffect, type RefObject } from 'react'
import type { CraftDock } from '@shared/craft'
import { craftApi } from './store'
import { containedBy, DockTargets } from './dock-targets'

const targets = new DockTargets((dock) => craftApi()?.dock(dock))

// anything of TrendDeck's own that can sit over the pane. the app's window is native and always
// on top of the page, so while one of these overlaps it the window is hidden instead
const OVERLAYS = [
  '.modal-backdrop',
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '.ui-pop',
  '.search-results',
  '[data-over-craft]'
].join(', ')

type Rect = { x: number; y: number; width: number; height: number }

const overlaps = (a: Rect, b: DOMRect): boolean =>
  b.width > 0 && b.height > 0 && a.x < b.right && b.left < a.x + a.width && a.y < b.bottom && b.top < a.y + a.height

function covered(r: Rect): boolean {
  for (const el of document.querySelectorAll(OVERLAYS)) {
    if (overlaps(r, el.getBoundingClientRect())) return true
  }
  return false
}

// keeps main told where the app's window goes: the box's place in css pixels of the window's
// content area, and whether it should show. active is false when it isn't open in this pane
// or the pane is hidden; going away (another stage, another project) hides it too. minimizing
// isn't sent, document.hidden is also true when other windows merely cover TrendDeck, and the
// app's window is owned by TrendDeck's so it minimizes along with it
export function useDock(appId: string, box: RefObject<HTMLElement | null>, active: boolean, priority = 0): void {
  useEffect(() => {
    const api = craftApi()
    if (!api) return
    const target = Symbol(appId)
    let timer = 0
    const send = (d: CraftDock): void => {
      targets.set(target, d, priority)
    }
    const measure = (): void => {
      timer = 0
      const el = box.current
      if (!active || !el) return targets.remove(target)
      const b = el.getBoundingClientRect()
      const bounds = { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }
      let visible = bounds.width > 0 && bounds.height > 0 && containedBy(b, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }) && !covered(bounds)
      for (let parent = el.parentElement; parent && visible; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
          visible = containedBy(b, parent.getBoundingClientRect())
        }
      }
      send({ appId, bounds, visible })
    }
    // many changes come in a burst, measure once a frame. a timer, not requestAnimationFrame,
    // which stops while other windows cover TrendDeck
    const soon = (): void => {
      if (!timer) timer = window.setTimeout(measure, 16)
    }
    measure()
    const ro = new ResizeObserver(soon)
    if (box.current) ro.observe(box.current)
    ro.observe(document.body)
    // menus, modals and the palette come and go as dom changes, and the pane moves on class
    // and style changes (collapsing slides it off screen without resizing it)
    const mo = new MutationObserver(soon)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'aria-hidden', 'open'] })
    window.addEventListener('resize', soon)
    document.addEventListener('scroll', soon, true)
    // a sliding pane moves without a resize or a mutation on every frame
    document.addEventListener('transitionend', soon, true)
    return () => {
      if (timer) clearTimeout(timer)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', soon)
      document.removeEventListener('scroll', soon, true)
      document.removeEventListener('transitionend', soon, true)
      targets.remove(target)
    }
  }, [appId, box, active, priority])
}
