import { app, clipboard, Menu, session as electronSession, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { CRAFT_WEB_PARTITION } from '@shared/craft-web'

// the right-click menu every page has in a browser: copy what you selected, cut and paste in a
// box, copy a link or a picture, fix a misspelled word. the Craft editors in the chat keep their
// own menus

export function menuItems(p: Electron.ContextMenuParams, wc: WebContents): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  const sep = (): void => {
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' })
  }
  if (p.isEditable && p.misspelledWord) {
    for (const word of p.dictionarySuggestions.slice(0, 4)) items.push({ label: word, click: () => wc.replaceMisspelling(word) })
    if (p.dictionarySuggestions.length) sep()
  }
  if (p.linkURL) {
    items.push({ label: 'Copy link', click: () => clipboard.writeText(p.linkURL) })
    sep()
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) })
    sep()
  }
  if (p.isEditable) {
    items.push(
      { label: 'Cut', role: 'cut', enabled: p.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Select all', role: 'selectAll' }
    )
  } else if (p.selectionText.trim()) {
    items.push({ label: 'Copy', role: 'copy' })
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop()
  return items
}

export function setupContextMenu(): void {
  app.on('web-contents-created', (_e, wc) => {
    wc.on('context-menu', (_ev, p) => {
      if (wc.session === electronSession.fromPartition(CRAFT_WEB_PARTITION)) return
      const items = menuItems(p, wc)
      if (items.length) Menu.buildFromTemplate(items).popup()
    })
  })
}
