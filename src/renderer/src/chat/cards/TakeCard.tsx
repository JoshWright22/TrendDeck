import { useRef, useState, type ReactNode } from 'react'
import { craftBelongsTo } from '@shared/craft'
import type { TakeCard as Card } from '@shared/cards'
import { reviewTime } from '@shared/cards'
import type { LineStatus } from '@shared/take'
import { cleanError, type CardActions } from './useCards'

// a take: playback, the transcript with clickable times, cadence notes, the script diff and the
// pickup list of lines to record again. actions send it on, put it in the project or the edit

const STATUS: Record<LineStatus, string> = { said: 'Said', paraphrased: 'Said differently', flubbed: 'Flubbed', missed: 'Missed' }
const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

type Place = 'insert' | 'replace'

export default function TakeCard({ card, a }: { card: Card; a: CardActions }): ReactNode {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<Place | null>(null)
  const [showWords, setShowWords] = useState(false)
  const src = window.trenddeckCards.projectFileUrl(a.brand.id, card.media)
  const project = a.brand.projects.find((p) => p.id === card.projectId)

  const seek = (t: number): void => {
    const el = media.current
    if (!el) return
    el.currentTime = Math.max(0, t - 0.3)
    void el.play().catch(() => {})
  }
  const At = ({ t }: { t: number }): ReactNode => (
    <button type="button" className="cx-take-at" onClick={() => seek(t)} title={`Play from ${clock(t)}`}>
      {clock(t)}
    </button>
  )

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

  const summary = (): string => {
    const lines = [`Here's my take ${card.media.file} (take card ${card.id}).`]
    if (card.feedback) lines.push(`${Math.round(card.feedback.wpm)} words a minute${card.feedback.usualWpm ? `, I usually talk at ${Math.round(card.feedback.usualWpm)}` : ''}.`)
    if (card.diff) lines.push(card.diff.pickups.length ? `Pickups: ${card.diff.pickups.map((p) => `"${p.text}" (${p.reason})`).join('; ')}.` : 'It covers the whole script.')
    lines.push('Read it with take_get and tell me what to keep and what to record again.')
    return lines.join(' ')
  }

  const place = (how: Place, opened = false): Promise<void> =>
    run(async () => {
      if (!project) return
      const apps = await window.trenddeckCraft.list()
      const film = apps.find((s) => s.app.id === 'filmcraft')
      const open = !!film && craftBelongsTo(film, a.brand.id, project.id)
      if (!open && !opened) {
        setConfirm(how)
        return
      }
      setConfirm(null)
      if (!open) await window.trenddeckCraft.open({ appId: 'filmcraft', brandId: a.brand.id, projectId: project.id, file: null })
      await a.sendToAgent(
        how === 'insert'
          ? `Insert the take ${card.media.file} (in the project folder) into the FilmCraft edit at the playhead, using the filmcraft tools. If the playhead or the track isn't clear, ask me first instead of guessing.`
          : `Replace the selected part of the FilmCraft timeline with the take ${card.media.file} (in the project folder), using the filmcraft tools. If nothing is selected or it isn't clear, ask me to select it first.`
      )
      setNote(`Asked your agent to ${how === 'insert' ? 'insert it at the playhead' : 'replace the selection'}.`)
    })

  const f = card.feedback
  const d = card.diff
  return (
    <article className="cx-card2 cx-take" aria-label={`Take ${card.title}`}>
      <header className="cx-card2-head">
        <strong>{card.title}</strong>
        <span className="muted">
          {card.source === 'obs' ? 'Recorded in OBS' : 'Recorded here'}
          {f ? `, ${clock(f.duration)}` : ''}
        </span>
      </header>
      {card.media.kind === 'video' ? (
        <video ref={media} className="cx-card2-video" src={src} controls preload="metadata" />
      ) : (
        <audio ref={media} src={src} controls preload="metadata" aria-label={card.title} />
      )}
      {card.state === 'transcribing' && <p className="cx-card2-state">Transcribing on this computer</p>}
      {card.state === 'failed' && <p className="cx-card2-error">{card.error}</p>}
      {f && (
        <section className="cx-take-section" aria-label="Delivery">
          <h4>Delivery</h4>
          <p>
            {Math.round(f.wpm)} words a minute{f.usualWpm ? `, you usually talk at ${Math.round(f.usualWpm)}` : ''}. {f.fillers.length} filler word{f.fillers.length === 1 ? '' : 's'}, {f.longPauses.length} long pause{f.longPauses.length === 1 ? '' : 's'}.
            {card.transcript?.wordTimesApproximate ? ' Times are approximate for this transcription.' : ''}
          </p>
          {f.notes.length > 0 && (
            <ul className="cx-take-notes">
              {f.notes.map((n, i) => (
                <li key={i}>
                  <At t={n.at} /> {n.text}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {d && (
        <section className="cx-take-section" aria-label="Against the script">
          <h4>Against the script</h4>
          {d.pickups.length ? (
            <>
              <p>
                {d.pickups.length} line{d.pickups.length === 1 ? '' : 's'} to record again:
              </p>
              <ol className="cx-take-pickups">
                {d.pickups.map((p) => (
                  <li key={p.lineId}>
                    <span className="cx-take-line">{p.text}</span> <span className="muted">{p.reason}</span> {p.at !== null && <At t={p.at} />}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p>Every line of the script is in this take.</p>
          )}
          <details>
            <summary>All lines</summary>
            <ul className="cx-take-lines">
              {d.lines.map((l) => (
                <li key={l.lineId} className={l.status}>
                  <strong>{STATUS[l.status]}</strong> {l.text} {l.from !== null && <At t={l.from} />}
                  {l.status === 'paraphrased' && l.said && <span className="cx-take-said">You said: {l.said}</span>}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
      {card.transcript && card.transcript.words.length > 0 && (
        <section className="cx-take-section" aria-label="Transcript">
          <button type="button" className="cx-take-toggle" aria-expanded={showWords} onClick={() => setShowWords(!showWords)}>
            {showWords ? 'Hide transcript' : 'Show transcript'}
          </button>
          {showWords && (
            <p className="cx-take-transcript">
              {card.transcript.words.map((w, i) => (
                <button key={i} type="button" className="cx-take-word" title={reviewTime(w.start)} onClick={() => seek(w.start)}>
                  {w.text.trim()}
                </button>
              ))}
            </p>
          )}
        </section>
      )}
      <div className="cx-card2-actions">
        <button type="button" className="primary" disabled={busy || !a.hasAgent || card.state === 'transcribing'} onClick={() => void run(async () => (await a.sendToAgent(summary()), setNote('Sent to your agent.')))}>
          Send to agent
        </button>
        <button type="button" disabled title={`Saved in the project folder as ${card.media.file}`}>
          In project media
        </button>
        <button type="button" disabled={busy || !a.hasAgent || !project} onClick={() => void place('insert')}>
          Insert at playhead
        </button>
        <button type="button" disabled={busy || !a.hasAgent || !project} onClick={() => void place('replace')}>
          Replace selection
        </button>
        {card.state === 'ready' && (
          <button type="button" disabled={busy} title="Compare with the script again" onClick={() => void run(async () => (await window.trenddeckTakes.rediff(a.brand.id, card.id), setNote('Compared again.')))}>
            Compare again
          </button>
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
      {note && <p className="cx-card2-note">{note}</p>}
      {error && <p className="cx-card2-error">{error}</p>}
    </article>
  )
}
