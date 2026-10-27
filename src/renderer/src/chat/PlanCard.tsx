import type { ReactNode } from 'react'
import type { PlanStep } from '@shared/providers'

// the agent's plan or todo list, a compact checklist above its answer

const LABEL: Record<PlanStep['status'], string> = {
  pending: 'To do',
  'in-progress': 'Working on it',
  done: 'Done'
}

export default function PlanCard({ plan }: { plan: PlanStep[] }): ReactNode {
  if (!plan.length) return null
  const done = plan.filter((s) => s.status === 'done').length
  return (
    <div className="cx-plan" aria-label="Plan">
      <div className="cx-plan-head">
        <span>Plan</span>
        <span className="muted">
          {done} of {plan.length} done
        </span>
      </div>
      <ol className="cx-plan-steps">
        {plan.map((s, i) => (
          <li key={i} className={s.status}>
            <span className="cx-plan-tick" aria-label={LABEL[s.status]} />
            <span className="cx-plan-text">{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
