import { ipcRenderer, webUtils } from 'electron'

// the Craft editors in the chat (src/main/craft/web.ts). FilmCraft's web build keeps files dropped
// on it in the page only, so a drop goes through TrendDeck instead: it copies the files into the
// project folder and imports them from there, where the saved project can find them again
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
