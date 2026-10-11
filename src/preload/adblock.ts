import { ipcRenderer, webFrame } from 'electron'
// the library's own preload watches the dom and asks main for element hiding css
import '@ghostery/adblocker-electron-preload'

// sites ask for a passkey on their own while they load, even in tabs you can't see, and
// windows answers with its security key prompt. only let a click on the page ask for one
if (/^https?:/.test(location.protocol)) {
  void webFrame
    .executeJavaScript(
      `(() => {
        const c = navigator.credentials
        if (!c) return
        const guard = (fn) => function (opts) {
          if (opts && opts.publicKey && !(navigator.userActivation && navigator.userActivation.isActive)) {
            return Promise.reject(new DOMException('A passkey needs a click on the page', 'NotAllowedError'))
          }
          return fn.call(c, opts)
        }
        c.get = guard(c.get)
        c.create = guard(c.create)
      })()`
    )
    .catch(() => {})
}

// scriptlets have to run before the page's own scripts or youtube's player response
// already has its ads in it, so ask main synchronously and run them right now
if (window === window.top && /^https?:/.test(location.protocol)) {
  try {
    const scripts = ipcRenderer.sendSync('adblock:scripts', location.href) as unknown
    if (Array.isArray(scripts) && scripts.length > 0) {
      // each scriptlet brings the same helpers (JSONPath and so on), so each gets its own
      // scope, and one that throws can't stop the rest
      const code = scripts
        .filter((s): s is string => typeof s === 'string')
        .map((s) => `try{(function(){\n${s}\n})()}catch(e){}`)
        .join('\n')
      void webFrame.executeJavaScript(code).catch(() => {})
    }
  } catch {
    // no blocker yet, the page just loads normally
  }
}
