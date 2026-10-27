import { ipcRenderer, webUtils } from 'electron'

// the Craft editors in the chat (src/main/craft/web.ts). FilmCraft's web build keeps files dropped
// on it in the page only, so a drop goes through TrendDeck instead: it copies the files into the
// project folder and imports them from there, where the saved project can find them again
// the editor is its own page, so a wheel over it never reaches the chat around it. a wheel the
// editor doesn't use (nothing under the pointer can scroll that way and the editor didn't take
// it for zoom or the timeline) goes to the chat, which scrolls by it
function scrollsWith(el: Element, dy: number): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) return false
  const oy = getComputedStyle(el).overflowY
  if (oy !== 'auto' && oy !== 'scroll' && el !== document.scrollingElement) return false
  return dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1
}

window.addEventListener(
  'wheel',
  (ev) => {
    if (ev.ctrlKey || !ev.deltaY || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return
    for (const t of ev.composedPath()) {
      if (t instanceof Element && scrollsWith(t, ev.deltaY)) return
    }
    // after the editor's own handlers had their turn
    setTimeout(() => {
      if (ev.defaultPrevented) return
      const px = ev.deltaMode === 1 ? ev.deltaY * 40 : ev.deltaMode === 2 ? ev.deltaY * innerHeight : ev.deltaY
      ipcRenderer.sendToHost('craft-web:wheel', px)
    }, 0)
  },
  { passive: true }
)

window.addEventListener(
  'drop',
  (ev) => {
    if (location.host !== 'filmcraft') return
    const files = [...(ev.dataTransfer?.files ?? [])]
    if (!files.length) return
    const paths = files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)
    if (!paths.length) return
    ev.preventDefault()
    ev.stopImmediatePropagation()
    ipcRenderer.send('craft-web:drop', paths)
  },
  true
)
