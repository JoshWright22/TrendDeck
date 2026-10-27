import { useState, type ReactNode } from 'react'
import { BRAND_FILE_TITLES } from '@shared/brand-memory'
import type { BrandFileCard as FileCard, RuleCard as Card } from '@shared/cards'
import Markdown from '../Markdown'
import { cleanError, type CardActions } from './useCards'

// cards that grow the brand memory: a rule from the session's changes (keep, edit, drop) and a
// brand file the agent drafted (keep, edit, drop). nothing is saved until you keep it

const KIND: Record<Card['rule']['kind'], string> = { voice: 'Voice rule', structure: 'Structure rule', packaging: 'Packaging rule', edit: 'Editing rule' }

function useRun(): { busy: boolean; error: string; run: (fn: () => Promise<void>) => Promise<void> } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

export function RuleCard({ card, a }: { card: Card; a: CardActions }): ReactNode {
  const [editing, setEditing] = useState<string | null>(null)
  const { busy, error, run } = useRun()
  const decided = card.state !== 'proposed'
  return (
    <article className="cx-card2 cx-rule" aria-label={`Proposed rule ${card.rule.text}`}>
      <header className="cx-card2-head">
        <strong>{decided && card.state === 'kept' ? card.kept : card.rule.text}</strong>
        <span className="muted">{KIND[card.rule.kind]}</span>
      </header>
      {card.rule.why && <p className="cx-card2-body">{card.rule.why}</p>}
      {card.rule.examples.length > 0 && (
        <ul className="cx-rule-examples">
          {card.rule.examples.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <p className="cx-card2-note">
        From {card.rule.evidence.length} change{card.rule.evidence.length === 1 ? '' : 's'} you made.
      </p>
      {editing !== null && (
        <textarea className="cx-card2-input" rows={2} value={editing} maxLength={280} aria-label="Edit the rule" onChange={(e) => setEditing(e.target.value)} />
      )}
      {decided ? (
        <p className="cx-card2-state">{card.state === 'kept' ? 'Kept. It is in your style rules and brand/rules.md.' : 'Dropped.'}</p>
      ) : (
        <div className="cx-card2-actions">
          <button
            type="button"
            className="primary"
            disabled={busy || (editing !== null && !editing.trim())}
            onClick={() => void run(async () => void (await window.trenddeckBrandMemory.keepRule(a.brand.id, card.id, editing ?? card.rule.text)))}
          >
            {editing !== null ? 'Keep edited rule' : 'Keep'}
          </button>
          {editing === null ? (
            <button type="button" disabled={busy} onClick={() => setEditing(card.rule.text)}>
              Edit
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => setEditing(null)}>
              Cancel edit
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void run(async () => void (await window.trenddeckBrandMemory.dropRule(a.brand.id, card.id)))}>
            Drop
          </button>
        </div>
      )}
      {error && <p className="cx-card2-error">{error}</p>}
    </article>
  )
}

export function BrandFileCard({ card, a }: { card: FileCard; a: CardActions }): ReactNode {
  const [editing, setEditing] = useState<string | null>(null)
  const { busy, error, run } = useRun()
  const decided = card.state !== 'proposed'
  return (
    <article className="cx-card2 cx-brand-file" aria-label={`Draft of ${card.file}`}>
      <header className="cx-card2-head">
        <strong>{BRAND_FILE_TITLES[card.file]}</strong>
        <span className="muted">brand/{card.file}</span>
      </header>
      {card.note && <p className="cx-card2-body">{card.note}</p>}
      {editing !== null ? (
        <textarea className="cx-card2-input cx-brand-file-edit" rows={14} value={editing} aria-label={`Edit ${card.file}`} onChange={(e) => setEditing(e.target.value)} />
      ) : (
        <div className="cx-brand-file-body">
          <Markdown text={card.content} />
        </div>
      )}
      {decided ? (
        <p className="cx-card2-state">{card.state === 'kept' ? `Saved to brand/${card.file} with its history.` : 'Dropped.'}</p>
      ) : (
        <div className="cx-card2-actions">
          <button
            type="button"
            className="primary"
            disabled={busy || (editing !== null && !editing.trim())}
            onClick={() => void run(async () => void (await window.trenddeckBrandMemory.keepFile(a.brand.id, card.id, editing ?? card.content)))}
          >
            {editing !== null ? 'Keep my version' : 'Keep'}
          </button>
          {editing === null ? (
            <button type="button" disabled={busy} onClick={() => setEditing(card.content)}>
              Edit
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => setEditing(null)}>
              Cancel edit
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void run(async () => void (await window.trenddeckBrandMemory.dropFile(a.brand.id, card.id)))}>
            Drop
          </button>
        </div>
      )}
      {error && <p className="cx-card2-error">{error}</p>}
    </article>
  )
}
