import type { ReactNode } from 'react'
import type { Run, StageStatus } from '@shared/pipeline'
import type { PipelineStage } from '@shared/workspace'

interface Props {
  stages: PipelineStage[]
  // where the project is
  currentId: string
  // what the pane shows, null when a tool or site is open
  openId: string | null
  onOpen: (stageId: string) => void
  // the project's run, its per stage status drives the dots. null when it has none
  run: Run | null
  onEdit: () => void
  onStartRun: () => void
}

const STATUS_WORDS: Record<StageStatus, string> = {
  pending: 'not started',
  running: 'in progress',
  waiting_user: 'waiting for you',
  done: 'done',
  skipped: 'skipped'
}

// ○Idea─●Script─●Edit─○Thumb. with a run the dots show each stage's status, without one
// they fill up to where the project is. the open one is highlighted
export default function StageStrip({ stages, currentId, openId, onOpen, run, onEdit, onStartRun }: Props): ReactNode {
  const current = run ? (run.currentStageId ?? '') : currentId
  const at = stages.findIndex((s) => s.id === current)
  return (
    <nav className="ws-strip" aria-label="Pipeline">
      {stages.map((s, i) => {
        const status = run?.stageStates[s.id]?.status
        const state = run
          ? s.id === current
            ? 'current'
            : status === 'done' || status === 'skipped'
              ? 'done'
              : 'todo'
          : i < at
            ? 'done'
            : i === at
              ? 'current'
              : 'todo'
        const lineDone = run ? state !== 'todo' : i <= at
        const title = [s.label, status ? STATUS_WORDS[status] : state === 'current' ? 'the project is here' : '', s.auto ? 'auto' : '']
          .filter(Boolean)
          .join(', ')
        return (
          <span key={s.id} className="ws-strip-item">
            {i > 0 && <span className={`ws-strip-line${lineDone ? ' done' : ''}`} aria-hidden="true" />}
            <button
              className={`ws-stage ${state}${status ? ` run-${status}` : ''}${s.id === openId ? ' open' : ''}`}
              aria-current={s.id === openId ? 'step' : undefined}
              data-status={status}
              title={title}
              onClick={() => onOpen(s.id)}
            >
              <span className="ws-stage-dot" aria-hidden="true" />
              {s.label}
            </button>
          </span>
        )
      })}
      <span className="ws-strip-tail">
        {!run && (
          <button className="ws-strip-btn" title="Start a run through the pipeline for this project" onClick={onStartRun}>
            Start run
          </button>
        )}
        <button className="ws-strip-btn" title="Edit the pipeline" aria-label="Edit pipeline" onClick={onEdit}>
          Edit
        </button>
      </span>
    </nav>
  )
}
