import { useEffect, useState, type ReactNode } from 'react'
import { craftBelongsTo } from '@shared/craft'
import { mediaUrl, type MediaInfo } from '@shared/media'
import type { Project } from '@shared/workspace'
import VideoReview from './VideoReview'
import { sendReview } from './cards/VideoCard'
import { cleanError } from './cards/useCards'
import './cards/cards.css'

// a file you dropped or attached: look at it, ask the agent about it, put it in the project,
// or have it placed in the FilmCraft edit. nothing goes into the edit without you clicking

type Place = 'insert' | 'replace'

export default function MediaReview({
  brandId,
  mediaId,
  revision,
  project,
  onSend
}: {
  brandId: string
  mediaId: string
  revision?: string
  project?: Project
  // null when there's no agent to send to
  onSend: ((text: string) => Promise<void>) | null
}): ReactNode {
  const [media, setMedia] = useState<MediaInfo | null>(null)
  const [status, setStatus] = useState('Loading')
  const [inProject, setInProject] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Place | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    let seq = 0
    setMedia(null)
    setStatus('Loading')
    const load = (): void => {
      const req = ++seq
      void window.trenddeck.media
        .list(brandId, {})
        .then((items) => {
          if (!active || req !== seq) return
          const item = items.find((m) => m.id === mediaId && m.brandId === brandId && !m.missing)
          setMedia(item ?? null)
          setStatus(item ? '' : 'This file is missing from Media.')
        })
        .catch(() => active && req === seq && setStatus("Couldn't load this file from Media."))
    }
    load()
    const off = window.trenddeck.media.onChange((b) => b === brandId && load())
    return () => {
      active = false
      off()
    }
  }, [brandId, mediaId])

  if (!media) return <p className="muted" role="status">{status}</p>
  const src = mediaUrl(brandId, mediaId)
  const full = `${media.name}${media.ext ? `.${media.ext}` : ''}`
  const general = !project

  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      await fn()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  const addToProject = async (): Promise<string> => {
    if (!project) throw new Error('Open a project first.')
    if (inProject) return inProject
    const rel = await window.trenddeckCards.addToProject(brandId, project.id, mediaId)
    setInProject(rel)
    return rel
  }

  const ask = (): Promise<void> =>
    run(async () => {
      await onSend?.(
        `Look at ${full} (media id ${mediaId}${revision ? `, revision ${revision}` : ''}) and tell me what you think. Don't add it to the project or the edit yet.`
      )
      setNote('Sent to your agent.')
    })

  const add = (): Promise<void> =>
    run(async () => {
      const rel = await addToProject()
      setNote(`In the project as ${rel}.`)
    })

  // placing it needs FilmCraft open on this project. when it isn't, ask before opening it
  const place = (how: Place, opened = false): Promise<void> =>
    run(async () => {
      if (!project || !onSend) return
      const apps = await window.trenddeckCraft.list()
      const film = apps.find((s) => s.app.id === 'filmcraft')
      const open = !!film && craftBelongsTo(film, brandId, project.id)
      if (!open && !opened) {
        setConfirm(how)
        return
      }
      setConfirm(null)
      const rel = await addToProject()
      if (!open) await window.trenddeckCraft.open({ appId: 'filmcraft', brandId, projectId: project.id, file: null })
      await onSend(
        how === 'insert'
          ? `Insert ${rel} (in the project folder) into the FilmCraft edit at the playhead, using the filmcraft tools. If the playhead or the track isn't clear, ask me first instead of guessing. Keep the original file as it is.`
          : `Replace the selected part of the FilmCraft timeline with ${rel} (in the project folder), using the filmcraft tools. If nothing is selected or the selection isn't clear, ask me to select it first. Keep the original file as it is.`
      )
      setNote(`Added ${rel} to the project and asked your agent to ${how === 'insert' ? 'insert it at the playhead' : 'replace the selection'}.`)
    })

  return (
    <section className="cx-card2 cx-media-review" aria-label={`Attached ${full}`}>
      <header className="cx-card2-head">
        <strong>{full}</strong>
        <span className="muted">Attached</span>
      </header>
      {media.kind === 'video' ? (
        <VideoReview
          src={src}
          name={full}
          onSend={async (drafts) => {
            if (!onSend) throw new Error('Set up an agent first.')
            await sendReview(brandId, mediaId, project?.id ?? '', full, project?.name ?? '', drafts, onSend)
          }}
        />
      ) : media.kind === 'audio' ? (
        <audio controls preload="metadata" src={src} aria-label={full} />
      ) : media.kind === 'image' ? (
        <img className="cx-card2-image" src={src} alt={full} />
      ) : null}
      <div className="cx-card2-actions">
        <button type="button" disabled={busy || !onSend} onClick={() => void ask()}>
          Ask about it
        </button>
        <button type="button" disabled={busy || general || !!inProject} onClick={() => void add()} title={general ? 'Open a project to add files to it' : undefined}>
          {inProject ? 'In the project' : 'Add to project media'}
        </button>
        {(media.kind === 'video' || media.kind === 'audio' || media.kind === 'image') && (
          <>
            <button type="button" disabled={busy || general || !onSend} onClick={() => void place('insert')}>
              Insert at playhead
            </button>
            <button type="button" disabled={busy || general || !onSend} onClick={() => void place('replace')}>
              Replace selection
            </button>
          </>
        )}
      </div>
      {confirm && (
        <div className="cx-card2-actions" role="alertdialog" aria-label="Open FilmCraft">
          <span>FilmCraft isn't open on {project?.name}. Open it and {confirm === 'insert' ? 'insert there' : 'replace the selection there'}?</span>
          <button type="button" className="primary" disabled={busy} onClick={() => void place(confirm, true)}>
            Open FilmCraft
          </button>
          <button type="button" onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      )}
      {general && <p className="cx-card2-note">Open a project to add this to its media or the edit.</p>}
      {note && <p className="cx-card2-note">{note}</p>}
      {error && (
        <p className="cx-card2-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
