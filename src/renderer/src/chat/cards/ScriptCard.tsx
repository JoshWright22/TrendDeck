import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ScriptCard as Card } from '@shared/cards'
import type { DraftFlag } from '@shared/cadence'
import { allLines, type Claim, type LineChange, type ScriptLine, type ScriptView } from '@shared/script'
import { createSegmenter } from '@shared/vad'
import { openMic, type Mic } from '../../dictation/mic'
import { transcribePcm } from '../../dictation/engine'
import { cleanError, type CardActions } from './useCards'

// the talk-first script: each line with who it's from (you, the agent's suggestion, typed),
// cadence flags and claim checks, and per-line actions: say it again, edit, remove, ask the agent

const ORIGIN_LABEL: Record<ScriptLine['origin'], string> = { spoken: 'You', agent: 'Suggestion', typed: 'Typed' }
const CLAIM_LABEL: Record<Claim['status'], string> = {
  unchecked: 'Not checked',
  checking: 'Checking',
  sourced: 'Sourced',
  wrong: 'Wrong',
  unverifiable: "Couldn't verify"
}

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

// one line said again: records until a pause, transcribes, hands back the text
function useRespeak(): { line: string | null; start: (id: string, done: (text: string, dump: { text: string; words: { text: string; start: number; end: number }[]; duration: number }) => void) => void; stop: () => void; error: string } {
  const [line, setLine] = useState<string | null>(null)
  const [error, setError] = useState('')
  const mic = useRef<Mic | null>(null)
  const stop = (): void => {
    mic.current?.close()
    mic.current = null
  }
  useEffect(() => stop, [])
  const start: ReturnType<typeof useRespeak>['start'] = (id, done) => {
    if (line) return
    setError('')
    setLine(id)
    let finished = false
    const seg = createSegmenter(
      (u) => {
        if (finished) return
        finished = true
        stop()
        void transcribePcm(u.audio)
          .then((t) => {
            if (t.text.trim()) done(t.text.trim(), t)
            else setError("Didn't catch that. Try again.")
          })
          .catch((err) => setError(cleanError(err)))
          .finally(() => setLine(null))
      },
      { pause: 1.2 }
    )
    void openMic((f) => seg.push(f))
      .then((m) => {
        if (finished) m.close()
        else mic.current = m
      })
      .catch((err) => {
        setError(cleanError(err))
        setLine(null)
      })
  }
  return { line, start, stop, error }
}

function Line({
  l,
  flags,
  claims,
  busy,
  listening,
  onRespeak,
  onSave,
  onRemove,
  onAsk
}: {
  l: ScriptLine
  flags: DraftFlag[]
  claims: Claim[]
  busy: boolean
  listening: boolean
  onRespeak: () => void
  onSave: (text: string) => void
  onRemove: () => void
  onAsk: () => void
}): ReactNode {
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <li className={`cx-script-line ${l.origin}`}>
      <span className="cx-script-origin">{ORIGIN_LABEL[l.origin]}</span>
      <div className="cx-script-body">
        {editing !== null ? (
          <textarea
            value={editing}
            rows={2}
            autoFocus
            aria-label="Edit line"
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (editing.trim()) onSave(editing)
                setEditing(null)
              } else if (e.key === 'Escape') setEditing(null)
            }}
          />
        ) : (
          <p className="cx-script-text">{listening ? 'Listening. Say the line, then pause.' : l.text}</p>
        )}
        {flags.map((f, i) => (
          <p key={i} className="cx-script-flag">
            {f.text}
          </p>
        ))}
        {claims.map((c) => (
          <p key={c.id} className={`cx-script-claim ${c.status}`}>
            <strong>{CLAIM_LABEL[c.status]}</strong> {c.kind === 'stat' ? 'Number' : c.kind === 'quote' ? 'Quote' : 'Fact'}: {c.text}
            {c.sourceUrl && (
              <>
                {' '}
                <a href={c.sourceUrl} title={c.sourceUrl}>
                  source
                </a>
              </>
            )}
            {c.note && <span className="cx-script-claim-note"> {c.note}</span>}
          </p>
        ))}
        <div className="cx-script-actions">
          {editing !== null ? (
            <>
              <button type="button" disabled={busy || !editing.trim()} onClick={() => (onSave(editing), setEditing(null))}>
                Save
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={onRespeak} title="Say this line again in your own words, it replaces the text">
                {listening ? 'Listening' : 'Say it again'}
              </button>
              <button type="button" disabled={busy} onClick={() => setEditing(l.text)}>
                Edit
              </button>
              <button type="button" disabled={busy} onClick={onRemove}>
                Remove
              </button>
              <button type="button" disabled={busy} onClick={onAsk} title="Ask your agent to rework this line">
                Ask agent
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

export default function ScriptCard({ card, a }: { card: Card; a: CardActions }): ReactNode {
  const [view, setView] = useState<ScriptView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const respeak = useRespeak()
  const brandId = a.brand.id

  useEffect(() => {
    let alive = true
    const load = (): void =>
      void window.trenddeckScripts
        .get(brandId, card.projectId, card.file)
        .then((v) => {
          if (!alive) return
          setView(v)
          setLoaded(true)
        })
        .catch((err) => alive && (setError(cleanError(err)), setLoaded(true)))
    load()
    const off = window.trenddeckScripts.onChanged((c) => c.brandId === brandId && c.projectId === card.projectId && c.file === card.file && load())
    return () => {
      alive = false
      off()
    }
  }, [brandId, card.projectId, card.file, card.updatedAt])

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

  const change = (c: LineChange): Promise<void> =>
    run(async () => {
      const v = await window.trenddeckScripts.change(brandId, card.projectId, card.file, c)
      if (v) setView(v)
    })

  if (!loaded) return <p className="muted">Loading the script</p>
  if (!view) return <p className="cx-card2-note">The script file {card.file} isn't there anymore.</p>

  const lines = allLines(view.script)
  const spoken = lines.filter((l) => l.origin === 'spoken').length
  const blocking = view.ready.blocking.length

  return (
    <article className="cx-card2 cx-script" aria-label={`Script ${view.script.title}`}>
      <header className="cx-card2-head">
        <strong>{view.script.title}</strong>
        <span className="muted">
          {view.script.status === 'ready' ? 'Ready to record' : 'Draft'}, {spoken} of {lines.length} lines in your words, about {clock(view.check.seconds)} at {view.check.profiled ? 'your pace' : '150 words a minute'}
        </span>
      </header>
      {view.script.beats.map((b, bi) => (
        <section key={bi} className="cx-script-beat">
          <h4>{b.title}</h4>
          <ol>
            {b.lines.map((l) => (
              <Line
                key={l.id}
                l={l}
                flags={view.check.flags.filter((f) => f.lineId === l.id)}
                claims={view.claims.filter((c) => c.lineId === l.id)}
                busy={busy || (respeak.line !== null && respeak.line !== l.id)}
                listening={respeak.line === l.id}
                onRespeak={() =>
                  respeak.line === l.id
                    ? respeak.stop()
                    : respeak.start(l.id, (text, t) =>
                        void run(async () => {
                          const dump = await window.trenddeckScripts.saveDump(brandId, card.projectId, t)
                          const at = t.words[0]?.start ?? null
                          const v = await window.trenddeckScripts.change(brandId, card.projectId, card.file, { type: 'respeak', lineId: l.id, text, dump: dump.id, at })
                          if (v) setView(v)
                        })
                      )
                }
                onSave={(text) => void change({ type: 'type', lineId: l.id, text })}
                onRemove={() => void change({ type: 'remove', lineId: l.id })}
                onAsk={() =>
                  void run(async () => {
                    await a.sendToAgent(`Rework line ${l.id} of the script (${card.file}): "${l.text}". Keep my words where you can, mark anything new as your suggestion, and update it with script_write.`)
                    setNote('Asked your agent.')
                  })
                }
              />
            ))}
          </ol>
        </section>
      ))}
      {respeak.error && <p className="cx-card2-error">{respeak.error}</p>}
      <div className="cx-card2-actions">
        <button
          type="button"
          disabled={busy || !a.hasAgent}
          onClick={() =>
            void run(async () => {
              await a.sendToAgent(
                `Run the claim check on the script (${card.file}) before I record. Act as a separate fact checker: call script_get, list every factual claim (numbers, quotes, facts that could be wrong, mine included) with script_claims_set, verify each one with your web tools, and report each with script_claim_update. Only mark sourced when a page you read supports it.`
              )
              setNote('Asked your agent to check the claims.')
            })
          }
        >
          Check claims
        </button>
        {view.script.status === 'ready' ? (
          <button type="button" disabled={busy} onClick={() => void run(async () => setView(await window.trenddeckScripts.setStatus(brandId, card.projectId, card.file, 'draft')))}>
            Back to draft
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy || !view.ready.ready}
            title={blocking ? `${blocking} claim${blocking === 1 ? '' : 's'} need a source first` : undefined}
            onClick={() => void run(async () => setView(await window.trenddeckScripts.setStatus(brandId, card.projectId, card.file, 'ready')))}
          >
            Ready to record
          </button>
        )}
      </div>
      {blocking > 0 && (
        <p className="cx-card2-note">
          {blocking} number{blocking === 1 ? '' : 's'} or quote{blocking === 1 ? '' : 's'} need a source before you record.
        </p>
      )}
      {view.check.flags.length > 0 && (
        <p className="cx-card2-note">
          {view.check.flags.length} line{view.check.flags.length === 1 ? '' : 's'} may not sound like you out loud. These are notes, not a score.
        </p>
      )}
      {note && <p className="cx-card2-note">{note}</p>}
      {error && <p className="cx-card2-error">{error}</p>}
    </article>
  )
}
