import { useState, type ReactNode } from 'react'
import type { ThreadMessage, WorkStep } from '@shared/chat'

// the thinking block and the work log that sit above an agent's answer

function Fold({
  title,
  live,
  children,
  className
}: {
  title: ReactNode
  // open by itself while it's the thing happening, the user's click wins after that
  live: boolean
  children: ReactNode
  className: string
}): ReactNode {
  const [picked, setPicked] = useState<boolean | null>(null)
  const open = picked ?? live
  return (
    <div className={`cx-fold ${className}${open ? ' open' : ''}${live ? ' live' : ''}`}>
      <button type="button" className="cx-fold-head" aria-expanded={open} onClick={() => setPicked(!open)}>
        <svg className="cx-fold-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        {title}
      </button>
      {open && <div className="cx-fold-body">{children}</div>}
    </div>
  )
}

function took(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}

function StepRow({ step }: { step: WorkStep }): ReactNode {
  return (
    <li className={`cx-step ${step.status}`}>
      <span className="cx-step-dot" aria-label={step.status} />
      <span className="cx-step-label">{step.label}</span>
      <span className="cx-step-detail" title={step.detail}>
        {step.detail}
      </span>
      <span className="cx-step-time">
        {step.status === 'running' ? 'running' : step.endedAt ? took(step.endedAt - step.startedAt) : ''}
      </span>
    </li>
  )
}

export default function WorkLog({ m }: { m: ThreadMessage }): ReactNode {
  const streaming = m.status === 'streaming'
  const steps = m.steps ?? []
  const hasThinking = !!m.thinking?.trim() || !!m.thinkingTokens
  const running = steps.some((s) => s.status === 'running')
  if (!hasThinking && steps.length === 0) return null
  const failed = steps.filter((s) => s.status === 'error').length
  return (
    <div className="cx-work">
      {hasThinking && (
        <Fold
          className="cx-think"
          live={streaming && !m.text && steps.length === 0}
          title={
            <>
              <span>{streaming && !m.text && steps.length === 0 ? 'Thinking' : 'Thought'}</span>
              {m.thinkingTokens ? <span className="muted">about {m.thinkingTokens} tokens</span> : null}
            </>
          }
        >
          {m.thinking?.trim() ? (
            <p className="cx-think-text">{m.thinking.trim()}</p>
          ) : (
            <p className="muted small">This agent doesn't show its thinking, only how long it was.</p>
          )}
        </Fold>
      )}
      {steps.length > 0 && (
        <Fold
          className="cx-log"
          live={streaming && !m.text}
          title={
            <>
              <span>{running || (streaming && !m.text) ? 'Working' : 'Worked'}</span>
              <span className="muted">
                · {steps.length} {steps.length === 1 ? 'step' : 'steps'}
                {failed ? `, ${failed} failed` : ''}
              </span>
            </>
          }
        >
          <ol className="cx-steps">
            {steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </ol>
        </Fold>
      )}
    </div>
  )
}
