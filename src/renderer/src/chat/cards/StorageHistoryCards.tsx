import { useState, type ReactNode } from 'react'
import type { HistoryCard as History, StorageCard as Storage } from '@shared/cards'
import { cleanError, type CardActions } from './useCards'

export function Spinner(): ReactNode {
  return <span className="cx-spin" aria-hidden="true" />
}

export function StorageCard({ card }: { card: Storage }): ReactNode {
  const pct = card.total ? Math.round((card.copied / card.total) * 100) : 0
  const what =
    card.status === 'running'
      ? `Copying ${card.copied} of ${card.total}`
      : card.status === 'done'
        ? `Copied ${card.copied} of ${card.total}`
        : `Stopped after ${card.copied} of ${card.total}`
  return (
    <article className="cx-card2" aria-label="Cloud copy">
      <header className="cx-card2-head">
        <strong>
          {card.status === 'running' && <Spinner />}
          {what}
        </strong>
        <span className="muted">{card.destination}</span>
      </header>
      <div className="cx-progress" role="progressbar" aria-valuemin={0} aria-valuemax={card.total} aria-valuenow={card.copied}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <p className="cx-card2-body muted">
        {card.verified} checked against the cloud
        {card.archived ? `, ${card.archived} original${card.archived === 1 ? '' : 's'} moved to the Recycle Bin` : ''}
      </p>
      {card.note && <p className={card.status === 'failed' ? 'cx-card2-error' : 'cx-card2-note'}>{card.note}</p>}
    </article>
  )
}

const day = (at: number): string =>
  new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

// a project's checkpoints: what changed, restore, save a new one. the agent's git_history makes
// one in the chat, the progress card opens one too
export function HistoryCard({ card: start, a }: { card: History; a: CardActions }): ReactNode {
  const [card, setCard] = useState(start)
  const [diff, setDiff] = useState<{ commit: string; text: string } | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const project = a.brand.projects.find((p) => p.id === card.projectId)
  const api = window.trenddeckCards

  const run = async (fn: () => Promise<void>): Promise<void> => {
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

  const save = (): Promise<void> =>
    run(async () => {
      const next = await api.saveCheckpoint(a.brand.id, card.projectId, message || 'Checkpoint')
      if (next) setCard({ ...next, id: card.id })
      setMessage('')
      setNote('Saved a checkpoint.')
    })

  return (
    <article className="cx-card2" aria-label="Project history">
      <header className="cx-card2-head">
        <strong>History{project ? ` of ${project.name}` : ''}</strong>
        <span className="muted">Scripts, captions and notes. Video files aren't kept here.</span>
      </header>
      {card.changed.length > 0 && (
        <p className="cx-card2-body">
          Changed since the last checkpoint: {card.changed.slice(0, 8).join(', ')}
          {card.changed.length > 8 ? ` and ${card.changed.length - 8} more` : ''}
        </p>
      )}
      <div className="cx-card2-reply">
        <input
          value={message}
          maxLength={200}
          placeholder="What changed, e.g. Tighter intro"
          aria-label="Checkpoint name"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') void save()
          }}
        />
        <button type="button" disabled={busy} onClick={() => void save()}>
          Save a checkpoint
        </button>
      </div>
      {card.entries.length === 0 ? (
        <p className="cx-card2-note">No checkpoints yet.</p>
      ) : (
        <ol className="cx-history">
          {card.entries.map((e) => (
            <li key={e.commit}>
              <div className="cx-history-line">
                <span className="cx-history-msg">{e.message}</span>
                <span className="muted">{day(e.at)}</span>
              </div>
              <div className="cx-history-files muted">{e.files.slice(0, 6).join(', ')}{e.files.length > 6 ? ` and ${e.files.length - 6} more` : ''}</div>
              <div className="cx-card2-actions">
                <button
                  type="button"
                  disabled={busy}
                  aria-expanded={diff?.commit === e.commit}
                  onClick={() =>
                    diff?.commit === e.commit
                      ? setDiff(null)
                      : void run(async () => setDiff({ commit: e.commit, text: await api.commitDiff(a.brand.id, card.projectId, e.commit) }))
                  }
                >
                  What changed
                </button>
                {confirm === e.commit ? (
                  <>
                    <span>Put these files back the way they were here? Files added since stay.</span>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const next = await api.restoreCommit(a.brand.id, card.projectId, e.commit)
                          if (next) setCard({ ...next, id: card.id })
                          setConfirm(null)
                          setNote('Restored. Save a checkpoint to keep it.')
                        })
                      }
                    >
                      Restore
                    </button>
                    <button type="button" onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={busy} onClick={() => setConfirm(e.commit)}>
                    Restore
                  </button>
                )}
              </div>
              {diff?.commit === e.commit && <pre className="cx-diff">{diff.text}</pre>}
            </li>
          ))}
        </ol>
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
