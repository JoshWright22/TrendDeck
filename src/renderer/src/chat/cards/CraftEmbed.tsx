import { useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { WebviewTag } from 'electron'
import type { CraftEmbedCard, ProjectFileRef } from '@shared/cards'
import { stageHeight } from '@shared/craft-embed'
import { webSpec, type WebEmbedState } from '@shared/craft-web'
import { DEFAULT_ZOOM, ZOOMS } from '@shared/craft-web-view'
import { craftApi, putCraft, useCraftApp } from '../../workspace/craft/store'
import { markUserScroll } from '../scrollIntent'
import VideoReview from '../VideoReview'
import { liveMax, newestOnDoc, pinEmbed, registerEmbed, setEmbedVisible, takeHandover, takeReveal, useEmbeds, useLiveEmbeds, waitsForReply } from './embed-owner'
import { cleanError, type CardActions } from './useCards'
import { sendReview } from './VideoCard'
import './craft-embed.css'

// a Craft editor in the chat. FilmCraft and PhotoCraft run here as their web builds, a real part
// of the page: it scrolls with the chat and menus draw over it, as many at once as Settings, Craft
// apps says. the others show a still and open in their own window. the agent's edits of the reply
// show as a count with Undo this turn and Keep, its versions of a cut as a switch. what you change
// in it reaches the agent with your next message (main/cards/collab.ts), feedback is what you type
// or dictate

// the last still of each embed, for when its editor isn't running here
const stills = new Map<string, string>()

const fileName = (p: string | null): string | null => (p ? (p.split(/[\\/]/).pop() ?? p) : null)

function scroller(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p
  }
  return null
}

export default function CraftEmbed({ card, a }: { card: CraftEmbedCard; a: CardActions }): ReactNode {
  const api = window.trenddeckEmbed
  const status = useCraftApp(card.appId)
  const liveSet = useLiveEmbeds()
  // re-renders when cards come and go: an older card on the same file points to the newest one
  useEmbeds()
  const newest = newestOnDoc(card.id)
  const rootRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<WebviewTag | null>(null)
  // always the whole chat
  const size = 'fill'
  const [height, setHeight] = useState(0)
  const [still, setStill] = useState<string | null>(stills.get(card.id) ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [dropping, setDropping] = useState(false)
  const [preview, setPreview] = useState<ProjectFileRef | null | undefined>(undefined)
  const [page, setPage] = useState<{ src: string; partition: string } | null>(null)
  const [web, setWeb] = useState<WebEmbedState | null>(null)
  // the editor has the wheel. until you click into it, a wheel over it scrolls the chat: the
  // editors draw on one canvas that takes every wheel event, so none would ever reach the chat
  const [active, setActive] = useState(false)
  // starting the editor here, and a try again from Open here (one that failed or never came back)
  const [opening, setOpening] = useState(false)
  const [slow, setSlow] = useState(false)
  const [tries, setTries] = useState(0)
  // the app's size in the chat, the same for every embed of it
  const [zoom, setZoom] = useState<number | null>(null)
  const project = a.brand.projects.find((p) => p.id === card.projectId)

  const inChat = !!webSpec(card.appId)
  // the desktop app has this project open in its own window
  const fullHere =
    !!status?.running &&
    status.brandId === a.brand.id &&
    status.projectId === card.projectId &&
    (!card.file || !status.file || fileName(status.file)?.toLowerCase() === fileName(card.file)?.toLowerCase())
  const installKind = status?.install.kind
  const cantRun = installKind === 'not-installed' || installKind === 'failed'
  const wanted = inChat && liveSet.has(card.id) && !fullHere && !cantRun && status !== undefined
  const live = !!page && web?.state === 'ready'

  useEffect(() => registerEmbed(card.id, card.appId, card.appName, card.projectId, card.at, card.messageId ?? null), [card.id, card.appId, card.appName, card.projectId, card.at, card.messageId])

  // opened from the picker or Open here: the chat scrolls to it, it starts once it's in view. again
  // while it grows into its size and opens, so it ends up at the top of the chat
  const revealAt = useRef(0)
  useEffect(() => {
    if (takeReveal(card.id)) revealAt.current = Date.now()
    // its reply just finished: shown, unless you've scrolled up to read something else
    if (takeHandover(card.id)) {
      const sc = scroller(rootRef.current)
      if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < sc.clientHeight * 2) revealAt.current = Date.now()
    }
    if (Date.now() - revealAt.current < 4000) {
      markUserScroll(scroller(rootRef.current))
      rootRef.current?.scrollIntoView({ block: 'start' })
    }
  })

  // any of it in view, or within a screen of it, counts as visible
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    // a screen ahead: the editor starts before you scroll to it, so it's running when you get there
    const io = new IntersectionObserver(([entry]) => setEmbedVisible(card.id, entry.isIntersecting), {
      root: scroller(el),
      rootMargin: '100% 0px',
      threshold: 0
    })
    io.observe(el)
    return () => {
      io.disconnect()
      setEmbedVisible(card.id, false)
    }
  }, [card.id])

  // the editor's state from main: loading, ready, saved, failed
  useEffect(() => {
    if (!api) return
    const off = api.onWebState((s) => {
      if (s.cardId === card.id) setWeb(s)
    })
    void api.webState(card.id).then((s) => s && setWeb(s), () => {})
    return off
  }, [api, card.id])

  // the editor runs while this card is one of the live ones. letting go saves first, the webview
  // goes only after that (a still of it stays)
  const pageRef = useRef(page)
  pageRef.current = page
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted
  const openingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!api) return
    let alive = true
    if (wanted && !pageRef.current) {
      // one start at a time. it can wait a while: an edit your agent is making on this project
      // finishes first
      if (openingRef.current) return
      openingRef.current = true
      setOpening(true)
      setError('')
      void api
        .webOpen(a.brand.id, card.id)
        .then(
          (p) => {
            if (mounted.current && wantedRef.current) setPage(p)
            // not wanted here any more by the time it was ready
            else void api.webRelease(a.brand.id, card.id).catch(() => {})
          },
          (err: unknown) => mounted.current && setError(cleanError(err))
        )
        .finally(() => {
          openingRef.current = false
          if (mounted.current) setOpening(false)
        })
    } else if (!wanted && pageRef.current) {
      void (async () => {
        const shot = await api.still(a.brand.id, card.id, null).catch(() => null)
        if (shot) {
          stills.set(card.id, shot)
          setStill(shot)
        }
        try {
          const released = await api.webRelease(a.brand.id, card.id)
          if (alive && released !== false) setPage(null)
        } catch (err) {
          // it couldn't save: it stays open here so nothing is lost
          if (alive) setError(cleanError(err))
        }
      })()
    }
    return () => {
      alive = false
    }
  }, [api, wanted, a.brand.id, card.id, tries])

  useEffect(() => {
    setSlow(false)
    if (!opening) return
    const t = window.setTimeout(() => setSlow(true), 4000)
    return () => clearTimeout(t)
  }, [opening])

  useEffect(() => {
    if (!api || !inChat) return
    void api.webZoom(card.appId, 0).then(setZoom, () => {})
  }, [api, inChat, card.appId])

  const resize = (step: -1 | 1): void => {
    void api?.webZoom(card.appId, step).then(setZoom, (err: unknown) => setError(cleanError(err)))
  }

  // the card going away (another chat) lets go too. autosave has kept the project current
  useEffect(() => () => {
    if (pageRef.current) void api?.webRelease(a.brand.id, card.id).catch(() => {})
  }, [api, a.brand.id, card.id])

  // the webview on the page: main finds its guest and loads the project into it
  useEffect(() => {
    const view = viewRef.current
    if (!page || !view || !api) return
    // it may have attached before this ran: try now, and again on the events (main ignores repeats)
    const attach = (): void => {
      let id: number
      try {
        id = view.getWebContentsId()
      } catch {
        return
      }
      void api.webAttach(a.brand.id, card.id, id).then((s) => s && setWeb(s), (err: unknown) => setError(cleanError(err)))
    }
    // a wheel the editor didn't use scrolls the chat (see preload/craft-web.ts)
    const onMessage = (e: Electron.IpcMessageEvent): void => {
      const dy = Number(e.args[0])
      if (e.channel === 'craft-web:wheel' && Number.isFinite(dy)) {
        const sc = scroller(rootRef.current)
        markUserScroll(sc)
        sc?.scrollBy({ top: dy })
      }
    }
    attach()
    view.addEventListener('did-attach', attach)
    view.addEventListener('dom-ready', attach)
    view.addEventListener('ipc-message', onMessage)
    return () => {
      view.removeEventListener('did-attach', attach)
      view.removeEventListener('dom-ready', attach)
      view.removeEventListener('ipc-message', onMessage)
    }
  }, [page, api, a.brand.id, card.id])

  // a click anywhere else in TrendDeck gives the wheel back to the chat
  useEffect(() => {
    if (!active) return
    const away = (e: PointerEvent): void => {
      if (!stageRef.current?.contains(e.target as Node)) setActive(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [active])
  useEffect(() => {
    if (!page) setActive(false)
  }, [page])

  // the click that hands it the wheel goes through to the editor too
  const activate = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const view = viewRef.current
    const box = e.currentTarget.getBoundingClientRect()
    setActive(true)
    if (!view) return
    const at = { x: Math.round(e.clientX - box.left), y: Math.round(e.clientY - box.top), button: 'left' as const, clickCount: 1 }
    view.focus()
    view.sendInputEvent({ type: 'mouseDown', ...at })
    view.sendInputEvent({ type: 'mouseUp', ...at })
  }

  // filling the chat, the chat stops following new messages to the bottom
  useEffect(() => {
    if (size !== 'fill' || !page) return
    const root = document.documentElement
    root.dataset.embedFill = card.id
    return () => {
      if (root.dataset.embedFill === card.id) delete root.dataset.embedFill
    }
  }, [size, page, card.id])

  // a still for when the editor isn't running here
  const lastAsk = useRef(0)
  useEffect(() => {
    if (!api || cantRun || installKind === undefined || page) return
    if (stills.has(card.id) && !card.updatedAt) return
    const wait = Math.max(0, 2500 - (Date.now() - lastAsk.current))
    const t = window.setTimeout(() => {
      lastAsk.current = Date.now()
      void api
        .still(a.brand.id, card.id, null)
        .then((src) => {
          if (!src) return
          stills.set(card.id, src)
          setStill(src)
        })
        .catch(() => {})
    }, wait)
    return () => clearTimeout(t)
    // the card changes on every edit the agent makes
  }, [api, card.id, card.updatedAt, cantRun, installKind, a.brand.id, page])

  // FilmCraft that can't run: the newest render plays here instead, as a preview
  useEffect(() => {
    if (!api || !cantRun || card.appId !== 'filmcraft') return
    void api.latestRender(a.brand.id, card.id).then(setPreview, () => setPreview(null))
  }, [api, cantRun, card.appId, card.id, a.brand.id])

  // the stage fits the chat's visible height, the composer below it is never covered
  useEffect(() => {
    const root = rootRef.current
    const sc = scroller(root)
    if (!root) return
    const measure = (): void => {
      const stage = stageRef.current
      if (!stage) return
      // only what's above the stage, so the size stays put when the editor starts or stops and
      // the rows under it come and go
      const chrome = Math.max(40, stage.getBoundingClientRect().top - root.getBoundingClientRect().top)
      const room = Math.max(1, (sc?.clientHeight ?? window.innerHeight) - chrome - 24)
      setHeight(stageHeight(size, stage.getBoundingClientRect().width, room))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    if (sc) ro.observe(sc)
    return () => ro.disconnect()
  }, [size, page])

  const run = async (fn: () => Promise<{ ok: boolean; note: string } | void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      const out = await fn()
      if (out && !out.ok) setError(out.note)
      else if (out?.note) setNote(out.note)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  // Open here: this card's editor runs (the oldest live one lets go if two are running)
  const openHere = (): Promise<void> =>
    run(async () => {
      if (cantRun) putCraft(await craftApi()!.install(card.appId))
      if (inChat) {
        pinEmbed(card.id)
        // already wanted here but not running (it failed, or the page went away): start it again
        setTries((t) => t + 1)
        return
      }
      putCraft(await api!.open(a.brand.id, card.id))
    })

  const openFull = (): Promise<void> =>
    run(async () => {
      if (page) {
        const shot = await api!.still(a.brand.id, card.id, null).catch(() => null)
        if (shot) {
          stills.set(card.id, shot)
          setStill(shot)
        }
      }
      putCraft(await api!.openFull(a.brand.id, card.id))
      return { ok: true, note: `${card.appName} opened in its own window. Close it there to edit here again.` }
    })

  const closeFull = (): Promise<void> =>
    run(async () => {
      await craftApi()!.close(card.appId)
    })

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    if (!api) return
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
    if (!paths.length) return
    void run(async () => {
      const out = await api.importFiles(a.brand.id, card.id, paths)
      return { ok: true, note: out.imported.length ? `${out.note} ${out.imported.join(', ')}` : out.note }
    })
  }

  if (!api) {
    return (
      <article className="cx-card2" aria-label={`${card.appName} in the chat`}>
        <strong>{card.appName}</strong>
        <p className="cx-card2-note">This build can't show the Craft apps in the chat.</p>
      </article>
    )
  }

  // this reply's editor: it opens here once your agent is done, the one above shows the edits meanwhile
  if (waitsForReply(card.id)) {
    return (
      <article ref={rootRef} data-embed-id={card.id} className="cx-card2 cx-embed-older" aria-label={`${card.appName} in the chat`}>
        <strong>{card.appName}</strong>
        <span className="muted">{card.file ?? project?.name ?? ''}</span>
        <span className="cx-embed-older-text">
          {newest !== card.id ? 'Opens here when your agent is done. Its edits show in the editor above meanwhile.' : 'Opens here when your agent is done.'}
        </span>
      </article>
    )
  }

  if (newest !== card.id) {
    return (
      <article ref={rootRef} data-embed-id={card.id} className="cx-card2 cx-embed-older" aria-label={`${card.appName} in the chat`}>
        <strong>{card.appName}</strong>
        <span className="muted">{card.file ?? project?.name ?? ''}</span>
        <span className="cx-embed-older-text">Open further down in the chat.</span>
        <span className="spacer" />
        <button type="button" onClick={() => {
          const to = document.querySelector<HTMLElement>(`[data-embed-id="${newest}"]`)
          markUserScroll(scroller(to))
          to?.scrollIntoView({ block: 'start' })
        }}>
          Go to it
        </button>
      </article>
    )
  }

  const turn = card.turn
  const alts = card.alternatives
  const stageStyle = height ? { height } : undefined
  const cover = !live || !page
  const coverText = cantRun
    ? installKind === 'failed' ? `${card.appName} couldn't be installed.` : `${card.appName} isn't installed.`
    : fullHere
      ? `${card.appName} is open in its own window. Close it there to edit here.`
      : !inChat
        ? `${card.appName} opens in its own window.`
        : page
          ? web?.state === 'failed' ? web.note : 'Opening the project...'
          : opening
            ? slow ? `Waiting for your agent's ${card.appName} edit to finish, then it opens here.` : `Starting ${card.appName}...`
            : still ? '' : `${card.appName} isn't running. Up to ${liveMax()} editor${liveMax() === 1 ? '' : 's'} run at once, change it in Settings, Craft apps.`

  return (
    <article
      ref={rootRef}
      data-embed-id={card.id}
      className={`cx-card2 cx-embed size-${size}${dropping ? ' dropping' : ''}`}
      aria-label={`${card.appName} in the chat`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <header className="cx-card2-head cx-embed-head-row">
        <strong>{card.appName}</strong>
        <span className="muted">{card.file ?? project?.name ?? ''}</span>
        <span className="spacer" />
        {inChat && !cantRun && (
          <span className="cx-embed-zoom" role="group" aria-label={`Size of ${card.appName} in the chat`}>
            <button type="button" title="Smaller" aria-label="Smaller" disabled={zoom === null || zoom <= ZOOMS[0]} onClick={() => resize(-1)}>
              -
            </button>
            <span className="cx-embed-zoom-value" title={`Kept for every ${card.appName} in the chat`}>{Math.round((zoom ?? DEFAULT_ZOOM) * 100)}%</span>
            <button type="button" title="Bigger" aria-label="Bigger" disabled={zoom === null || zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => resize(1)}>
              +
            </button>
          </span>
        )}
        {fullHere ? (
          <button type="button" className="cx-embed-full" onClick={() => void closeFull()} disabled={busy}>
            Close the full app
          </button>
        ) : (
          <button type="button" className="cx-embed-full" onClick={() => void openFull()} disabled={busy || cantRun || status === undefined}>
            Open in the full app
          </button>
        )}
      </header>
      {web?.note && page && (
        <p className={web.state === 'failed' ? 'cx-card2-error' : 'cx-card2-note'} role="status">
          {web.note}
        </p>
      )}
      {card.note && <p className="cx-card2-body">{card.note}</p>}

      {cantRun && card.appId === 'filmcraft' && preview ? (
        <div className="cx-embed-fallback">
          <p className="cx-card2-note">
            Preview of the newest video in this project, {preview.file}. It isn't the editable project: FilmCraft {installKind === 'failed' ? "couldn't be installed" : "isn't installed"}, so comments here go to your agent without markers.
          </p>
          <VideoReview
            src={window.trenddeckCards.projectFileUrl(a.brand.id, preview)}
            name={preview.file}
            onSend={(drafts) => sendReview(a.brand.id, card.id, card.projectId, preview.file, project?.name ?? '', drafts, a.sendToAgent)}
          />
        </div>
      ) : (
        <div ref={stageRef} className={`cx-embed-stage${live ? ' is-live' : ''}`} style={stageStyle} aria-label={live ? `${card.appName}, live` : `${card.appName}, still`}>
          {page && (
            <webview
              ref={viewRef as never}
              className="cx-embed-web"
              src={page.src}
              partition={page.partition}
              webpreferences="backgroundThrottling=no"
              title={`${card.appName} editor`}
            />
          )}
          {live && !active && (
            <div className="cx-embed-shield" onClick={activate}>
              <span>Click to edit. The wheel scrolls the chat until you do.</span>
            </div>
          )}
          {cover && still && <img className="cx-embed-still" src={still} alt="" />}
          {cover && (
            <div className={`cx-embed-cover${still ? ' over-still' : ''}`}>
              {coverText && <span>{coverText}</span>}
              {!page && !fullHere && (
                <button type="button" className="primary" disabled={busy || opening || installKind === 'installing' || status === undefined} onClick={() => void openHere()}>
                  {status === undefined ? 'Loading editor status' : opening ? 'Starting' : installKind === 'installing' ? 'Installing' : cantRun ? `Install ${card.appName}` : inChat ? 'Open here' : `Open ${card.appName}`}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {alts && alts.items.length > 1 && (
        <div className="cx-embed-alts">
          <div className="cx-card2-actions" role="group" aria-label="Versions">
            {alts.items.map((v) => (
              <button
                key={v.sequence}
                type="button"
                aria-pressed={alts.showing === v.sequence}
                disabled={busy || (alts.kept !== null && alts.kept !== v.sequence)}
                onClick={() => void run(() => api.showAlternative(a.brand.id, card.id, v.sequence))}
              >
                {v.label}
              </button>
            ))}
            <span className="spacer" />
            {alts.kept === null ? (
              <button
                type="button"
                className="primary"
                disabled={busy || alts.showing === null}
                onClick={() => void run(() => api.keepAlternative(a.brand.id, card.id, alts.showing!))}
              >
                Keep this one
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => void run(() => api.undoAlternative(a.brand.id, card.id))}>
                Undo
              </button>
            )}
          </div>
          <p className="cx-card2-note">
            {alts.kept !== null
              ? `Kept ${alts.items.find((v) => v.sequence === alts.kept)?.label ?? 'this version'}, the others are gone from the project.`
              : 'Each version is its own sequence in the project. Keeping one removes the others.'}
          </p>
        </div>
      )}

      {(turn || dropping) && (
        <div className="cx-card2-actions cx-embed-foot" role="status">
          {dropping ? (
            <span>Drop to add the files to the {card.appName} project</span>
          ) : (
            turn && (
              <span>
                {turn.state === 'working' && `Your agent is editing. Edits this turn: ${turn.edits}`}
                {turn.state === 'review' && `Edits this turn: ${turn.edits}`}
                {turn.state === 'kept' && `Kept ${turn.edits} edit${turn.edits === 1 ? '' : 's'} from this reply`}
                {turn.state === 'undone' && `Undid ${turn.edits} edit${turn.edits === 1 ? '' : 's'} from this reply`}
                {turn.state === 'failed' && (turn.note || 'No edits went through')}
              </span>
            )
          )}
          <span className="spacer" />
          {turn?.state === 'review' && !dropping && (
            <>
              <button type="button" disabled={busy || !turn.checkpoint} title={turn.checkpoint ? 'Puts the project back the way it was before this reply' : turn.note} onClick={() => void run(() => api.undoTurn(a.brand.id, card.id))}>
                Undo this turn
              </button>
              <button type="button" className="primary" disabled={busy} onClick={() => void run(() => api.keepTurn(a.brand.id, card.id))}>
                Keep
              </button>
            </>
          )}
        </div>
      )}
      {turn?.note && turn.state !== 'failed' && <p className="cx-card2-note">{turn.note}</p>}
      {note && <p className="cx-card2-note">{note}</p>}
      {error && (
        <p className="cx-card2-error" role="alert">
          {error}
        </p>
      )}
    </article>
  )
}
