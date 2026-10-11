import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { WebviewTag } from 'electron'
import type { Site } from '@shared/types'
import { BackIcon, CloseIcon, ForwardIcon, HomeIcon, ReloadIcon } from './Icons'

interface Props {
  site: Site
  partition: string
  // where to open, e.g. the page you were on last time
  startUrl: string
  onUrl: (url: string) => void
  // a link for this tab while it's already open
  navigate?: { url: string; n: number } | null
  right?: ReactNode
  // kept alive in the background, see useLiveTabs
  hidden?: boolean
}

// react drops unknown boolean attributes, so this one goes in as a string
const popups = { allowpopups: 'true' } as object

export default function SiteView(props: Props): ReactNode {
  const { site, partition, startUrl, onUrl, right, navigate, hidden = false } = props
  const ref = useRef<HTMLWebViewElement>(null)
  const ready = useRef(false)
  // only read once, changing src later would reload the page
  const [src] = useState(startUrl)
  const [url, setUrl] = useState(startUrl)
  const onUrlRef = useRef(onUrl)
  onUrlRef.current = onUrl
  const [loading, setLoading] = useState(true)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hiddenRef = useRef(hidden)
  hiddenRef.current = hidden
  // tells main so a hidden tab gets muted and its videos paused
  const report = (): void => {
    const view = ref.current as unknown as WebviewTag | null
    if (view && ready.current) window.trenddeck.setSiteHidden(view.getWebContentsId(), hiddenRef.current)
  }

  useEffect(() => {
    const view = ref.current as unknown as WebviewTag | null
    if (!view) return

    const sync = (): void => {
      if (!ready.current) return
      const now = view.getURL()
      setUrl(now)
      onUrlRef.current(now)
      setCanBack(view.canGoBack())
      setCanForward(view.canGoForward())
    }
    const onReady = (): void => {
      const first = !ready.current
      ready.current = true
      sync()
      if (first) report()
    }
    const onStart = (): void => {
      setLoading(true)
      setError(null)
    }
    const onStop = (): void => {
      setLoading(false)
      sync()
    }
    const onFail = (e: Electron.DidFailLoadEvent): void => {
      // -3 is just a cancelled load, e.g. a redirect
      if (!e.isMainFrame || e.errorCode === -3) return
      setError(e.errorDescription || 'load failed')
    }

    view.addEventListener('dom-ready', onReady)
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-navigate', sync)
    view.addEventListener('did-navigate-in-page', sync)
    view.addEventListener('did-fail-load', onFail)
    return () => {
      ready.current = false
      view.removeEventListener('dom-ready', onReady)
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-navigate', sync)
      view.removeEventListener('did-navigate-in-page', sync)
      view.removeEventListener('did-fail-load', onFail)
    }
    // keyed per brand and site in App, so one view never changes site
  }, [])

  const run = (fn: (view: WebviewTag) => void): void => {
    const view = ref.current as unknown as WebviewTag | null
    if (view && ready.current) fn(view)
  }

  useEffect(report, [hidden])

  const navN = navigate?.n
  useEffect(() => {
    if (navigate) run((v) => void v.loadURL(navigate.url).catch(() => {}))
    // only when a new link comes in
  }, [navN])

  return (
    <div className={`site-view${hidden ? ' hidden' : ''}`} aria-hidden={hidden || undefined}>
      <div className="toolbar page-head">
        <button
          className="icon-btn"
          title="Back"
          aria-label="Back"
          disabled={!canBack}
          onClick={() => run((v) => v.goBack())}
        >
          <BackIcon />
        </button>
        <button
          className="icon-btn"
          title="Forward"
          aria-label="Forward"
          disabled={!canForward}
          onClick={() => run((v) => v.goForward())}
        >
          <ForwardIcon />
        </button>
        {loading ? (
          <button
            className="icon-btn"
            title="Stop"
            aria-label="Stop"
            onClick={() => run((v) => v.stop())}
          >
            <CloseIcon />
          </button>
        ) : (
          <button
            className="icon-btn"
            title="Reload"
            aria-label="Reload"
            onClick={() => run((v) => v.reload())}
          >
            <ReloadIcon />
          </button>
        )}
        <button
          className="icon-btn"
          title={`Back to ${site.name}`}
          aria-label="Home"
          onClick={() => run((v) => void v.loadURL(site.url))}
        >
          <HomeIcon />
        </button>
        <div className={`url${error ? ' failed' : ''}`} title={url}>
          {error ? `Couldn't load this page (${error})` : url}
        </div>
        {right}
      </div>
      <webview ref={ref} className="webview" src={src} partition={partition} {...popups} />
    </div>
  )
}
