import type { ReactNode } from 'react'
import type { PipelineStage } from '@shared/workspace'

interface Props {
  stages: PipelineStage[]
  // where the project is
  currentId: string
  // what the pane shows, null when a tool or site is open
  openId: string | null
  onOpen: (stageId: string) => void
}

// ○Idea─●Script─●Edit─○Thumb. filled up to where the project is, the open one is underlined
export default function StageStrip({ stages, currentId, openId, onOpen }: Props): ReactNode {
  const at = Math.max(0, stages.findIndex((s) => s.id === currentId))
  return (
    <nav className="ws-strip" aria-label="Pipeline">
      {stages.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'current' : 'todo'
        return (
          <span key={s.id} className="ws-strip-item">
            {i > 0 && <span className={`ws-strip-line${i <= at ? ' done' : ''}`} aria-hidden="true" />}
            <button
              className={`ws-stage ${state}${s.id === openId ? ' open' : ''}`}
              aria-current={s.id === openId ? 'step' : undefined}
              title={state === 'current' ? `${s.label}, the project is here` : s.label}
              onClick={() => onOpen(s.id)}
            >
              <span className="ws-stage-dot" aria-hidden="true" />
              {s.label}
            </button>
          </span>
        )
      })}
    </nav>
  )
}
