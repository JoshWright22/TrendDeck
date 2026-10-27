import { useEffect, useState, type ReactNode } from 'react'
import { clock, ratioText, SNAPSHOT_NAMES, type VideoDetail } from '@shared/content-map'
import type { ContentMapCard as MapCard, PostMortemCard as PmCard } from '@shared/cards'
import ContentMap from '../../components/content-map/ContentMap'
import RetentionChart from '../../components/content-map/RetentionChart'
import { cleanError, type CardActions } from './useCards'

// the content map in the chat, and the post-mortem a new video gets after 2 and 7 days. kept
// learnings go into brand/learnings.md, nothing is written until you keep one

export function ContentMapCard({ card, a }: { card: MapCard; a: CardActions }): ReactNode {
  return (
    <article className="cx-card2" aria-label="Content map">
      <header className="cx-card2-head">
        <strong>Content map</strong>
        <span className="muted">{a.brand.name}</span>
      </header>
      {card.note && <p className="cx-card2-body">{card.note}</p>}
      <ContentMap brandId={a.brand.id} projects={a.brand.projects} focus={card.focus} />
    </article>
  )
}

const STATE: Record<'kept' | 'dropped', string> = { kept: 'Kept in brand/learnings.md.', dropped: 'Dropped.' }

export function PostMortemCard({ card, a }: { card: PmCard; a: CardActions }): ReactNode {
  const [detail, setDetail] = useState<VideoDetail | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [own, setOwn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const api = window.trenddeckContentMap

  useEffect(() => {
    let alive = true
    void api.detail(a.brand.id, card.videoId).then((d) => alive && setDetail(d)).catch(() => {})
    return () => {
      alive = false
    }
  }, [api, a.brand.id, card.videoId])

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
      setEditing(null)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  const v = detail?.video
  return (
    <article className="cx-card2" aria-label={`Post-mortem of ${card.title}`}>
      <header className="cx-card2-head">
        <strong>{card.title}</strong>
        <span className="muted">
          After {SNAPSHOT_NAMES[card.stage]}
          {card.ratio !== null ? `, ${ratioText(card.ratio)} your usual at this age` : ''}
        </span>
      </header>
      {card.summary && <p className="cx-card2-body">{card.summary}</p>}
      {v && v.retention.length > 1 && v.duration ? <RetentionChart points={v.retention} duration={v.duration} dips={card.dips} /> : null}
      {card.learnings.length > 0 && (
        <>
          <p className="cx-card2-note">Keep what you agree with, it goes into your learnings for the next video.</p>
          <ul className="cm-learnings">
            {card.learnings.map((l) => (
              <li key={l.id}>
                {editing?.id === l.id ? (
                  <textarea className="cx-card2-input" rows={2} value={editing.text} aria-label="Edit the learning" onChange={(e) => setEditing({ id: l.id, text: e.target.value })} />
                ) : (
                  <p>{l.text}</p>
                )}
                {l.state === 'proposed' ? (
                  <div className="cx-card2-actions">
                    <button type="button" disabled={busy} onClick={() => void run(() => api.keepLearning(a.brand.id, card.id, l.id, editing?.id === l.id ? editing.text : l.text))}>
                      {editing?.id === l.id ? 'Keep my version' : 'Keep'}
                    </button>
                    {editing?.id === l.id ? (
                      <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                        Cancel edit
                      </button>
                    ) : (
                      <button type="button" disabled={busy} onClick={() => setEditing({ id: l.id, text: l.text })}>
                        Edit
                      </button>
                    )}
                    <button type="button" disabled={busy} onClick={() => void run(() => api.dropLearning(a.brand.id, card.id, l.id))}>
                      Drop
                    </button>
                  </div>
                ) : (
                  <p className="cx-card2-state">{STATE[l.state]}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="cx-card2-reply">
        <input
          className="cx-card2-input"
          value={own}
          maxLength={500}
          placeholder="What you learned from this one"
          aria-label="Add your own learning"
          onChange={(e) => setOwn(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && own.trim()) void run(async () => (await api.addLearning(a.brand.id, card.id, own), setOwn('')))
          }}
        />
        <button type="button" disabled={busy || !own.trim()} onClick={() => void run(async () => (await api.addLearning(a.brand.id, card.id, own), setOwn('')))}>
          Keep
        </button>
        {a.hasAgent && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void a.sendToAgent(
                `Let's go through how "${card.title}" did after ${SNAPSHOT_NAMES[card.stage]}. Use retention_dips and video_stats for ${card.videoId}${card.dips.length ? `, the drops were at ${card.dips.map((d) => clock(d.from)).join(', ')}` : ''}, compare it with similar_videos, and tell me what to change for the next one.`
              )
            }
          >
            Talk it through
          </button>
        )}
      </div>
      {error && <p className="cx-card2-error">{error}</p>}
    </article>
  )
}
