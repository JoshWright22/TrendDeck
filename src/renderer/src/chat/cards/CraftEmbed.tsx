import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { CraftEmbedCard, ProjectFileRef } from '@shared/cards'
import { stageHeight, type EmbedSize } from '@shared/craft-embed'
import { craftApi, putCraft, useCraftApp } from '../../workspace/craft/store'
import { useDock } from '../../workspace/craft/useDock'
import VideoReview from '../VideoReview'
import CraftTimelineReview from './CraftTimelineReview'
import { pinEmbed, registerEmbed, setEmbedVisible, useEmbedOwner } from './embed-owner'
import { cleanError, type CardActions } from './useCards'
import { sendReview } from './VideoCard'
import './craft-embed.css'

// a live Craft editor in the chat. the newest one you can see has the real app docked over its
// stage, the others show a still with Open here. the agent's edits of the reply show as a count
// with Undo this turn and Keep, its versions of a cut as a switch, and FilmCraft gets timeline
// comments that become markers

// the last still of each embed, kept while the window is open
const stills = new Map<string, string>()

const fileName = (p: string | null): string | null => (p ? (p.split(/[\\/]/).pop() ?? p) : null)

const SIZES: { id: EmbedSize; label: string }[] = [
  { id: 'inline', label: 'Inline' },
  { id: 'large', label: 'Large' },
  { id: 'fill', label: 'Fill' }
]

function scroller(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p
  }
  return null
}

export default function CraftEmbed({ card, a }: { card: CraftEmbedCard; a: CardActions }): ReactNode {
  const api = window.trenddeckEmbed
  const status = useCraftApp(card.appId)
  const owner = useEmbedOwner()
  const rootRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<EmbedSize>('inline')
  const [height, setHeight] = useState(0)
  const [still, setStill] = useState<string | null>(stills.get(card.id) ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [commenting, setCommenting] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [preview, setPreview] = useState<ProjectFileRef | null | undefined>(undefined)
  const project = a.brand.projects.find((p) => p.id === card.projectId)

  const runningHere =
    !!status?.running &&
    status.brandId === a.brand.id &&
    status.projectId === card.projectId &&
    (!card.file || !status.file || fileName(status.file)?.toLowerCase() === card.file.toLowerCase())
  const isOwner = owner === card.id
  const live = isOwner && runningHere
  const installKind = status?.install.kind
  const cantRun = installKind === 'not-installed' || installKind === 'failed'

  useEffect(() => registerEmbed(card.id, card.appId, card.appName, card.projectId, card.at), [card.id, card.appId, card.appName, card.projectId, card.at])

  // the newest embed you can see owns the app's window
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    // mostly in view, or a good piece of a tall one. a short chat (big display scaling, a small
    // window) counts most of what it shows as a good piece
    const sc = scroller(el)
    const io = new IntersectionObserver(
      ([entry]) => {
        const piece = Math.min(320, (sc?.clientHeight ?? window.innerHeight) * 0.6)
        setEmbedVisible(card.id, entry.isIntersecting && (entry.intersectionRatio >= 0.4 || entry.intersectionRect.height >= piece))
      },
      { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1] }
    )
    io.observe(el)
    return () => {
      io.disconnect()
      setEmbedVisible(card.id, false)
    }
  }, [card.id])

  useDock(card.appId, stageRef, live, 2)

  // filling the chat, the plan bar above the messages folds away to give the editor the room
  useEffect(() => {
    if (size !== 'fill' || !isOwner) return
    const root = document.documentElement
    root.dataset.embedFill = card.id
    return () => {
      if (root.dataset.embedFill === card.id) delete root.dataset.embedFill
    }
  }, [size, isOwner, card.id])

  // a still for when the window isn't here (and under it, for when it hides while scrolling)
  const lastAsk = useRef(0)
  useEffect(() => {
    if (!api || cantRun || installKind === undefined) return
    if (!runningHere && !isOwner && stills.has(card.id)) return
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
  }, [api, card.id, card.updatedAt, isOwner, runningHere, cantRun, installKind, a.brand.id])

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
      // the card's own rows above and below the stage, and a little air
      const chrome = root.getBoundingClientRect().height - stage.getBoundingClientRect().height
      const room = (sc?.clientHeight ?? window.innerHeight) - Math.min(chrome, 160) - 24
      setHeight(stageHeight(size, stage.getBoundingClientRect().width, room))
    }
    measure()
    if (size !== 'inline') root.scrollIntoView({ block: 'nearest' })
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    if (sc) ro.observe(sc)
    return () => ro.disconnect()
  }, [size])

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

  const openHere = (): Promise<void> =>
    run(async () => {
      pinEmbed(card.id)
      if (runningHere) return
      if (cantRun) putCraft(await craftApi()!.install(card.appId))
      putCraft(await api!.open(a.brand.id, card.id))
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
  const canComment = card.appId === 'filmcraft' && runningHere
  const alts = card.alternatives
  const stageStyle = height ? { height } : undefined

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
        <div
          ref={stageRef}
          className={`cx-embed-stage${live ? ' is-live' : ''}`}
          style={stageStyle}
          aria-label={live ? `${card.appName}, live` : `${card.appName}, still`}
        >
          {still && <img className="cx-embed-still" src={still} alt="" />}
          {!live && (
            <div className="cx-embed-cover">
              {cantRun ? (
                <span>{installKind === 'failed' ? `${card.appName} couldn't be installed.` : `${card.appName} isn't installed.`}</span>
              ) : !still ? (
                <span>{runningHere ? `${card.appName} is open in a newer spot in this chat.` : `${card.appName} isn't open here.`}</span>
              ) : null}
              <button type="button" className="primary" disabled={busy || installKind === 'installing'} onClick={() => void openHere()}>
                {installKind === 'installing' ? 'Installing' : cantRun ? `Install ${card.appName}` : 'Open here'}
              </button>
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
