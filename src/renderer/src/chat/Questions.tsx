import { useState, type ReactNode } from 'react'
import { EMBED_LANG } from '@shared/chat'
import { CardCorners } from './Marks'
import { parseEmbed, type Embed } from './Embeds'

// the agent asks, the user picks, the answer goes back as the next message.
// several question blocks in one reply turn into steps with dots

export type Question = Extract<Embed, { type: 'question' }>

const OTHER = 'Other'

const FENCE = new RegExp('```' + EMBED_LANG + '[^\\n]*\\n([\\s\\S]*?)\\n?```', 'g')

// closed question blocks in a reply, in order
export function questionsIn(text: string): Question[] {
  if (!text.includes('"question"')) return []
  const out: Question[] = []
  for (const m of text.matchAll(FENCE)) {
    const e = parseEmbed(m[1])
    if (e?.type === 'question') out.push(e)
  }
  return out
}

// the answer message is plain text so the agent can read it, and it gets read back here
// to show what was picked
export function answerText(qs: Question[], picks: string[][]): string {
  return qs.map((q, i) => `Q: ${q.question}\nA: ${picks[i].join(', ')}`).join('\n\n')
}

export function readAnswers(qs: Question[], text: string | undefined): string[] | null {
  if (!text?.startsWith('Q: ')) return null
  const found = new Map<string, string>()
  for (const part of text.split(/\n\n(?=Q: )/)) {
    const m = /^Q: ([\s\S]*?)\nA: ([\s\S]*)$/.exec(part)
    if (m) found.set(m[1].trim(), m[2].trim())
  }
  const out = qs.map((q) => found.get(q.question.trim()) ?? '')
  return out.some(Boolean) ? out : null
}

interface Props {
  questions: Question[]
  // what the user picked, read from the message after the reply
  answered: string[] | null
  // null when it can't be answered right now (still streaming, or a later message exists)
  onAnswer: ((text: string) => void) | null
}

export default function QuestionDeck({ questions, answered, onAnswer }: Props): ReactNode {
  const [step, setStep] = useState(0)
  const [picks, setPicks] = useState<string[][]>(() => questions.map(() => []))
  const [other, setOther] = useState<string[]>(() => questions.map(() => ''))
  const [otherOn, setOtherOn] = useState<boolean[]>(() => questions.map(() => false))

  if (answered) {
    return (
      <article className="cx-card cx-question answered">
        <CardCorners />
        <header>
          <span className="cx-kind">{questions.length > 1 ? 'Questions' : 'Question'}</span>
          <span className="cx-decided approved">Answered</span>
        </header>
        <dl className="cx-q-summary">
          {questions.map((q, i) => (
            <div key={i}>
              <dt>{q.question}</dt>
              <dd>{answered[i] || <span className="muted">No answer</span>}</dd>
            </div>
          ))}
        </dl>
      </article>
    )
  }

  const n = Math.min(step, questions.length - 1)
  const q = questions[n]
  const last = n === questions.length - 1
  const live = !!onAnswer

  // the picks for one step, with the free text swapped in for Other
  const final = (i: number, list = picks[i], on = otherOn[i]): string[] => [
    ...list,
    ...(on && other[i].trim() ? [other[i].trim()] : [])
  ]
  const ready = (i: number): boolean => final(i).length > 0

  const finish = (all: string[][]): void => {
    if (!onAnswer) return
    onAnswer(answerText(questions, all))
  }

  const next = (all = questions.map((_, i) => final(i))): void => {
    if (last) finish(all)
    else setStep(n + 1)
  }

  const choose = (label: string): void => {
    if (!live) return
    if (q.multi) {
      setPicks((p) => p.map((l, i) => (i === n ? (l.includes(label) ? l.filter((x) => x !== label) : [...l, label]) : l)))
      return
    }
    // single choice: a click is the answer
    const all = questions.map((_, i) => (i === n ? [label] : final(i)))
    setPicks(picks.map((l, i) => (i === n ? [label] : l)))
    setOtherOn((o) => o.map((v, i) => (i === n ? false : v)))
    next(all)
  }

  const toggleOther = (): void => {
    if (!live) return
    setOtherOn((o) => o.map((v, i) => (i === n ? (q.multi ? !v : true) : v)))
    if (!q.multi) setPicks((p) => p.map((l, i) => (i === n ? [] : l)))
  }

  return (
    <article className={`cx-card cx-question${live ? '' : ' waiting'}`} aria-label="Question from the agent">
      <CardCorners tone="hot" />
      <header>
        <span className="cx-kind">Question</span>
        {q.multi && <span className="muted">Pick any</span>}
        <span className="spacer" />
        {questions.length > 1 && (
          <span className="cx-q-dots" role="tablist" aria-label="Questions">
            {questions.map((_, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === n}
                aria-label={`Question ${i + 1} of ${questions.length}`}
                className={`cx-q-dot${i === n ? ' on' : ''}${ready(i) ? ' done' : ''}`}
                disabled={!live || (i > n && !ready(i - 1))}
                onClick={() => setStep(i)}
              />
            ))}
          </span>
        )}
      </header>
      <p className="cx-card-title">{q.question}</p>
      <div className="cx-q-options" role={q.multi ? 'group' : 'radiogroup'} aria-label={q.question}>
        {q.options.map((o) => {
          const on = picks[n].includes(o.label)
          return (
            <button
              key={o.label}
              type="button"
              role={q.multi ? 'checkbox' : 'radio'}
              aria-checked={on}
              className={`cx-q-option${on ? ' on' : ''}`}
              disabled={!live}
              onClick={() => choose(o.label)}
            >
              <span className={`cx-q-tick${q.multi ? ' box' : ''}`} aria-hidden="true" />
              <span className="cx-q-label">{o.label}</span>
              {o.description && <span className="cx-q-desc">{o.description}</span>}
            </button>
          )
        })}
        <button
          type="button"
          role={q.multi ? 'checkbox' : 'radio'}
          aria-checked={otherOn[n]}
          className={`cx-q-option${otherOn[n] ? ' on' : ''}`}
          disabled={!live}
          onClick={toggleOther}
        >
          <span className={`cx-q-tick${q.multi ? ' box' : ''}`} aria-hidden="true" />
          <span className="cx-q-label">{OTHER}</span>
          <span className="cx-q-desc">Write your own</span>
        </button>
        {otherOn[n] && (
          <input
            className="cx-q-other"
            autoFocus
            placeholder="Your answer"
            aria-label="Your answer"
            value={other[n]}
            onChange={(e) => {
              const v = e.target.value
              setOther((o) => o.map((x, i) => (i === n ? v : x)))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready(n)) {
                e.preventDefault()
                next()
              }
            }}
          />
        )}
      </div>
      <footer>
        {!live && <span className="muted">Answer when the reply is done</span>}
        <span className="spacer" />
        {n > 0 && (
          <button type="button" className="pill" disabled={!live} onClick={() => setStep(n - 1)}>
            Back
          </button>
        )}
        {(q.multi || otherOn[n]) && (
          <button type="button" className="pill teal" disabled={!live || !ready(n)} onClick={() => next()}>
            {last ? 'Send' : 'Next'}
          </button>
        )}
      </footer>
    </article>
  )
}
