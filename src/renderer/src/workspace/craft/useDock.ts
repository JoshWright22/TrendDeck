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
  // the chat's jump to latest button and thread list float over the messages
  '.cx-jump',
  '.cx-threads-pop',
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
    if (!api || !active) return
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
      // what can be seen of the box: the window, then every scrolling or clipping parent. the app's
      // window keeps the box's full size and is cut to that, so it follows scrolling smoothly
      let seen = { left: Math.max(0, b.left), top: Math.max(0, b.top), right: Math.min(window.innerWidth, b.right), bottom: Math.min(window.innerHeight, b.bottom) }
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (!/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) continue
        const p = parent.getBoundingClientRect()
        seen = { left: Math.max(seen.left, p.left), top: Math.max(seen.top, p.top), right: Math.min(seen.right, p.right), bottom: Math.min(seen.bottom, p.bottom) }
      }
      const clip = { x: Math.round(seen.left), y: Math.round(seen.top), width: Math.round(seen.right - seen.left), height: Math.round(seen.bottom - seen.top) }
      // a sliver isn't worth showing, and an overlay over any of it hides the window
      const visible = bounds.width > 0 && bounds.height > 0 && clip.width >= 40 && clip.height >= 40 && !covered(clip)
      const whole = containedBy(b, seen)
      send({ appId, bounds, visible, clip: visible && !whole ? clip : null })
    }
    const soon = (): void => {
      if (!timer) timer = window.requestAnimationFrame(measure)
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
    document.addEventListener('animationend', soon, true)
    return () => {
      if (timer) window.cancelAnimationFrame(timer)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', soon)
      document.removeEventListener('scroll', soon, true)
      document.removeEventListener('transitionend', soon, true)
      document.removeEventListener('animationend', soon, true)
      targets.remove(target)
    }
  }, [appId, box, active, priority])
}
