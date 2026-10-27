import type { ReactNode } from 'react'
import QuestionDeck, { type Question } from './Questions'
import type { PendingItem } from './pending'

// a question an agent asked mid reply, from its own tool (provider user input) or the app's
// ask_user tool (pipeline). same card as the ```trenddeck question blocks, answered in place

type Asked = Extract<PendingItem, { kind: 'provider-input' | 'pipeline-question' }>

function questionsOf(item: Asked): Question[] {
  if (item.kind === 'provider-input') {
    return item.request.questions.map((q) => ({
      type: 'question',
      question: q.header && !q.question.startsWith(q.header) ? `${q.header}: ${q.question}` : q.question,
      options: q.options.map((o) => ({ label: o.label, description: o.description ?? '' })),
      multi: q.multi
    }))
  }
  return item.question.questions.map((q) => ({ type: 'question', question: q.question, options: q.options, multi: q.multi }))
}

interface Props {
  item: Asked
  onAnswer: (picks: string[][]) => void
  onDismiss?: () => void
}

export default function PendingQuestion({ item, onAnswer, onDismiss }: Props): ReactNode {
  const qs = questionsOf(item)
  if (!qs.length) return null
  return (
    <div className="cx-hand cx-q-hand cx-pending-q">
      <QuestionDeck
        key={item.id}
        kind={item.kind === 'pipeline-question' ? 'Pipeline question' : 'Question'}
        questions={qs}
        answered={null}
        onAnswer={() => {}}
        onPicks={onAnswer}
        onDismiss={onDismiss}
      />
    </div>
  )
}

// provider answers are keyed by question id, several picks joined with ", "
export function providerAnswers(item: Extract<PendingItem, { kind: 'provider-input' }>, picks: string[][]): Record<string, string> {
  const out: Record<string, string> = {}
  item.request.questions.forEach((q, i) => {
    out[q.id] = (picks[i] ?? []).join(', ')
  })
  return out
}
