import { useState, type ReactNode } from 'react'
import { formatAnswer, SUGGESTION_NAMES, type EditState, type SuggestionCard as Card } from '@shared/cards'
import { cleanError, type CardActions } from './useCards'

const EDIT_WORDS: Record<EditState, string> = {
  proposed: 'Not applied yet',
  previewing: 'Preview ready, not applied yet',
  applied: 'Applied',
  failed: "Didn't apply",
  undone: 'Undone'
}

function answerWords(choice: string): string {
  if (choice === 'accept') return 'You said yes'
  if (choice === 'later') return 'You said not now'
  if (choice === 'reply') return 'You replied'
  return `You picked ${choice}`
}

export default function SuggestionCard({ card, a }: { card: Card; a: CardActions }): ReactNode {
  const [replying, setReplying] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const edit = card.edit
  const answered = card.answer && card.answer.choice !== 'accept' ? card.answer : null
  // an accepted edit stays live for preview, apply and undo
  const closed = !!card.answer && !edit

  const pick = async (choice: string, body = ''): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      if (choice === 'apply') {
        const id = await window.trenddeckCards.checkpoint(a.brand.id, card.id)
        if (!id) setNote('No editor files in this project yet, so there is no checkpoint to go back to.')
      }
      await window.trenddeckCards.answer(a.brand.id, card.id, { choice, text: body })
      await a.sendToAgent(formatAnswer(card, { choice, text: body }))
      setReplying(false)
      setText('')
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  const restore = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      // a restore that worked shows on the card itself
      const out = await window.trenddeckCards.restoreCheckpoint(a.brand.id, card.id)
      if (!out.ok) setError(out.note)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  const src = card.preview ? window.trenddeckCards.projectFileUrl(a.brand.id, card.preview) : ''
  const off = busy || !a.hasAgent

  return (
    <article className="cx-card2 cx-suggestion" aria-label={`${SUGGESTION_NAMES[card.kind]} suggestion`}>
      <header className="cx-card2-head">
        <strong>{card.title}</strong>
        <span className="muted">{SUGGESTION_NAMES[card.kind]} suggestion</span>
      </header>
      <p className="cx-card2-body">{card.body}</p>
      {card.preview?.kind === 'video' && (
        <video
          className="cx-card2-video"
          src={card.preview.from !== null ? `${src}#t=${card.preview.from}${card.preview.to !== null ? `,${card.preview.to}` : ''}` : src}
          controls
          preload="metadata"
          aria-label={`Preview ${card.preview.file}`}
        />
      )}
      {card.preview?.kind === 'image' && <img className="cx-card2-image" src={src} alt={`Preview ${card.preview.file}`} />}
      {edit && (
        <p className="cx-card2-state" role="status">
          {EDIT_WORDS[edit.state]}
          {edit.note ? `. ${edit.note}` : ''}
        </p>
      )}
      {answered && <p className="cx-card2-state">{answerWords(answered.choice)}{answered.text ? `: ${answered.text}` : ''}</p>}
      {card.answer?.choice === 'accept' && !edit && <p className="cx-card2-state">You said yes</p>}
      {!closed && !answered && (
        <div className="cx-card2-actions">
          {edit ? (
            <>
              {edit.state !== 'applied' && (
                <>
                  <button type="button" disabled={off} onClick={() => void pick('preview')}>
                    Preview
                  </button>
                  <button type="button" className="primary" disabled={off} onClick={() => void pick('apply')}>
                    Apply
                  </button>
                </>
              )}
              {(edit.state === 'applied' || edit.checkpoint) && edit.state !== 'undone' && (
                <button type="button" disabled={off} onClick={() => void pick('undo')}>
                  Undo
                </button>
              )}
              {edit.checkpoint && edit.state !== 'undone' && (
                <button type="button" disabled={busy} onClick={() => void restore()} title="Puts the editor files back the way they were before Apply">
                  Restore checkpoint
                </button>
              )}
            </>
          ) : (
            <button type="button" className="primary" disabled={off} onClick={() => void pick('accept')}>
              Accept
            </button>
          )}
          {card.actions.map((label) => (
            <button key={label} type="button" disabled={off} onClick={() => void pick(label)}>
              {label}
            </button>
          ))}
          {edit?.state !== 'applied' && (
            <button type="button" disabled={off} onClick={() => void pick('later')}>
              Not now
            </button>
          )}
          <button type="button" disabled={off} aria-expanded={replying} onClick={() => setReplying(!replying)}>
            Reply
          </button>
        </div>
      )}
      {replying && (
        <div className="cx-card2-reply">
          <textarea
            rows={2}
            value={text}
            autoFocus
            placeholder="Tell your agent what to change"
            aria-label="Reply to this suggestion"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                e.preventDefault()
                void pick('reply', text)
              }
            }}
          />
          <button type="button" disabled={off || !text.trim()} onClick={() => void pick('reply', text)}>
            Send
          </button>
        </div>
      )}
      {!a.hasAgent && !closed && <p className="cx-card2-note">Set up an agent to answer this.</p>}
      {note && <p className="cx-card2-note">{note}</p>}
      {error && (
        <p className="cx-card2-error" role="alert">
          {error}
        </p>
      )}
    </article>
  )
}
