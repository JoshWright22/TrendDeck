import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { WebviewTag } from 'electron'
import type { CraftEmbedCard, ProjectFileRef } from '@shared/cards'
import { stageHeight, type EmbedSize } from '@shared/craft-embed'
import { webSpec, type WebEmbedState } from '@shared/craft-web'
import { craftApi, putCraft, useCraftApp } from '../../workspace/craft/store'
import VideoReview from '../VideoReview'
import CraftTimelineReview from './CraftTimelineReview'
import CraftVisualReview from './CraftVisualReview'
import { pinEmbed, registerEmbed, setEmbedVisible, useLiveEmbeds } from './embed-owner'
import { cleanError, type CardActions } from './useCards'
import { sendReview } from './VideoCard'
import './craft-embed.css'

// a Craft editor in the chat. FilmCraft and PhotoCraft run here as their web builds, a real part
// of the page: it scrolls with the chat, menus draw over it, and two can run at once. the others
// show a still and open in their own window. the agent's edits of the reply show as a count with
// Undo this turn and Keep, its versions of a cut as a switch, and FilmCraft gets timeline comments
// that become markers

// the last still of each embed, for when its editor isn't running here
const stills = new Map<string, string>()

const fileName = (p: string | null): string | null => (p ? (p.split(/[\\/]/).pop() ?? p) : null)

const SIZES: { id: EmbedSize; label: string }[] = [
  { id: 'inline', label: 'Inline' },
  { id: 'large', label: 'Large' },
  { id: 'fill', label: 'Whole chat' }
]

function scroller(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p
  }
  return null
}

const savedText = (s: WebEmbedState | null): string => {
  if (!s) return ''
  if (s.state === 'loading') return 'Opening the project...'
  if (s.state === 'failed') return s.note
  const at = s.savedAt ? `Saved to the project folder at ${new Date(s.savedAt).toLocaleTimeString()}. ` : ''
  return s.note || `${at}Changes save a few seconds after you make them, with recovery copies.`
}

export default function CraftEmbed({ card, a }: { card: CraftEmbedCard; a: CardActions }): ReactNode {
  const api = window.trenddeckEmbed
  const status = useCraftApp(card.appId)
  const liveSet = useLiveEmbeds()
  const rootRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<WebviewTag | null>(null)
  const [size, setSize] = useState<EmbedSize>('fill')
  const [height, setHeight] = useState(0)
  const [still, setStill] = useState<string | null>(stills.get(card.id) ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [commenting, setCommenting] = useState(false)
  const [reviewFrame, setReviewFrame] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [preview, setPreview] = useState<ProjectFileRef | null | undefined>(undefined)
  const [page, setPage] = useState<{ src: string; partition: string } | null>(null)
  const [web, setWeb] = useState<WebEmbedState | null>(null)
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
  const wanted = inChat && liveSet.has(card.id) && !fullHere && !cantRun && status !== undefined && reviewFrame === null
  const live = !!page && web?.state === 'ready'

  useEffect(() => registerEmbed(card.id, card.appId, card.appName, card.projectId, card.at), [card.id, card.appId, card.appName, card.projectId, card.at])

  // any of it in view counts as visible
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setEmbedVisible(card.id, entry.isIntersecting && entry.intersectionRect.height > 0), { threshold: [0, 0.01] })
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
  useEffect(() => {
    if (!api) return
    let alive = true
    if (wanted && !pageRef.current) {
      setError('')
      void api.webOpen(a.brand.id, card.id).then(
        (p) => alive && setPage(p),
        (err: unknown) => alive && setError(cleanError(err))
      )
    } else if (!wanted && pageRef.current) {
      void (async () => {
        const shot = await api.still(a.brand.id, card.id, null).catch(() => null)
        if (shot) {
          stills.set(card.id, shot)
          setStill(shot)
        }
        try {
          await api.webRelease(a.brand.id, card.id)
          if (alive) setPage(null)
        } catch (err) {
          // it couldn't save: it stays open here so nothing is lost
          if (alive) setError(cleanError(err))
        }
      })()
    }
    return () => {
      alive = false
    }
  }, [api, wanted, a.brand.id, card.id])

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
    attach()
    view.addEventListener('did-attach', attach)
    view.addEventListener('dom-ready', attach)
    return () => {
      view.removeEventListener('did-attach', attach)
      view.removeEventListener('dom-ready', attach)
    }
  }, [page, api, a.brand.id, card.id])

  // filling the chat, the plan bar above the messages folds away to give the editor the room
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
      const chrome = size === 'fill'
        ? Math.max(40, stage.getBoundingClientRect().top - root.getBoundingClientRect().top)
        : root.getBoundingClientRect().height - stage.getBoundingClientRect().height
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
      setReviewFrame(null)
      if (cantRun) putCraft(await craftApi()!.install(card.appId))
      if (inChat) {
        pinEmbed(card.id)
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

  const circle = (): Promise<void> => run(async () => {
    const frame = page ? await api!.still(a.brand.id, card.id, null) : still
    if (!frame) throw new Error('The editor did not provide a frame. Wait for it to finish opening, then try again.')
    stills.set(card.id, frame)
    setStill(frame)
    setReviewFrame(frame)
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

  const turn = card.turn
  const canComment = card.appId === 'filmcraft' && (live || fullHere)
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
          : still ? '' : `${card.appName} isn't running here. Two editors can run at once.`

  return (
    <article
      ref={rootRef}
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
        <div className="cx-embed-sizes" role="group" aria-label="Size">
          {SIZES.map((s) => (
            <button key={s.id} type="button" aria-pressed={size === s.id} onClick={() => setSize(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      </header>
      <div className="cx-embed-controls">
        <button type="button" onClick={() => void circle()} disabled={busy || (!live && !still)}>Circle and comment</button>
        {fullHere ? (
          <button type="button" onClick={() => void closeFull()} disabled={busy}>Close the full app</button>
        ) : (
          <button type="button" onClick={() => void openFull()} disabled={busy || cantRun || status === undefined}>Open in the full app</button>
        )}
        <span className="muted" role="status">{page ? savedText(web) : ''}</span>
      </div>
      {card.note && <p className="cx-card2-body">{card.note}</p>}

      {reviewFrame ? (
        <CraftVisualReview card={card} a={a} initialFrame={reviewFrame} onClose={() => setReviewFrame(null)} />
      ) : cantRun && card.appId === 'filmcraft' && preview ? (
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
          {cover && still && <img className="cx-embed-still" src={still} alt="" />}
          {cover && (
            <div className="cx-embed-cover">
              {coverText && <span>{coverText}</span>}
              {!page && !fullHere && (
                <button type="button" className="primary" disabled={busy || installKind === 'installing' || status === undefined} onClick={() => void openHere()}>
                  {status === undefined ? 'Loading editor status' : installKind === 'installing' ? 'Installing' : cantRun ? `Install ${card.appName}` : inChat ? 'Open here' : `Open ${card.appName}`}
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

      {(turn || canComment || dropping) && (
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
          {canComment && !dropping && (
            <button type="button" aria-expanded={commenting} onClick={() => setCommenting(!commenting)}>
              {commenting ? 'Close comments' : 'Comment on the timeline'}
            </button>
          )}
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
      {commenting && canComment && (
        <CraftTimelineReview brandId={a.brand.id} card={card} projectName={project?.name ?? ''} send={a.hasAgent ? a.sendToAgent : null} />
      )}
      {note && <p className="cx-card2-note">{note}</p>}
      {error && (
        <p className="cx-card2-error" role="alert">
          {error}
        </p>
      )}
    </article>
  )
}
