import type { WebContents } from 'electron'

// thin dark scrollbars inside every site so they match the app instead of the default grey bars
const SCROLLBARS = `
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: #0E0E10; }
  ::-webkit-scrollbar-thumb { background: #2A2A33; border-radius: 99px; border: 2px solid #0E0E10; }
  ::-webkit-scrollbar-thumb:hover { background: #3B46A4; }
  ::-webkit-scrollbar-corner { background: #0E0E10; }
`

export function styleSite(contents: WebContents): void {
  const apply = (): void => {
    contents.insertCSS(SCROLLBARS, { cssOrigin: 'user' }).catch(() => {})
  }
  contents.on('dom-ready', apply)
}
