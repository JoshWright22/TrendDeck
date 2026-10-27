import { useState, type ReactNode } from 'react'
import type { HistoryCard as History } from '@shared/cards'
import type { StageStatus } from '@shared/pipeline'
import type { Brand } from '@shared/types'
import type { Project } from '@shared/workspace'
import { useRun } from '../workspace/WorkspacePane'
import { draftChat } from '../pages/voice/chatDraft'
import { Menu } from './ui'
import { HistoryCard } from './cards/StorageHistoryCards'
import { cleanError, type CardActions } from './cards/useCards'
import './cards/cards.css'

// pinned at the top of a project's chat: where the video is, what's happening now and what's
// next. the agent sets up and moves the run with its pipeline tools, this only shows it

const WORDS: Record<StageStatus, string> = {
  pending: 'To do',
  running: 'Now',
  waiting_user: 'Needs you',
  done: 'Done',
  skipped: 'Skipped'
}

function Check(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 5.2l2 2 4-4.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function ProjectProgress({ brand, project, actions }: { brand: Brand; project: Project; actions?: CardActions }): ReactNode {
  const run = useRun(brand.id, project.id)
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState<History | null | 'none'>(null)
  const [error, setError] = useState('')
  const stages = brand.pipeline
  const stage = stages.find((s) => s.id === run?.currentStageId)
  const state = stage && run ? run.stageStates[stage.id] : null
  const statusOf = (id: string): StageStatus => run?.stageStates[id]?.status ?? 'pending'
  const done = stages.filter((s) => ['done', 'skipped'].includes(statusOf(s.id))).length
  const at = stage ? stages.findIndex((s) => s.id === stage.id) : -1
  const next = at >= 0 ? stages.slice(at + 1).find((s) => !['done', 'skipped'].includes(statusOf(s.id))) : null
  const made = run ? Object.values(run.stageStates).reduce((n, s) => n + s.artifacts.length, 0) : 0
  const headline = !run
    ? 'No plan yet'
    : !run.currentStageId
      ? 'Everything is done'
      : state?.status === 'waiting_user'
        ? `${stage?.label}: needs you`
        : `${stage?.label ?? 'Working'}`

  const showHistory = async (): Promise<void> => {
    if (history) return setHistory(null)
    setError('')
    try {
      setHistory((await window.trenddeckCards.history(brand.id, project.id)) ?? 'none')
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const ask = (): void =>
    draftChat(
      run
        ? `Tell me where ${project.name} stands, what you're doing now and what you need from me. Update the steps with your pipeline tools if anything changed.`
        : `Set up the steps for ${project.name}. Look at the pipeline with your tools, fit it to this video and start its run. Ask me only for creative decisions, then tell me the first step.`
    )

  // one quiet row: the video, where it is, what's next. clicking it shows the steps, the rest is in the menu
  return (
    <section className="cx-project-progress" aria-label={`${project.name} progress`}>
      <div className="cx-progress-top">
        <button type="button" className="cx-progress-row" aria-expanded={open} disabled={!run} onClick={() => setOpen(!open)}>
          <span className="cx-progress-name">{project.name}</span>
          <span className="cx-progress-headline">{headline}</span>
          <span className="cx-progress-detail">
            {run
              ? `${done} of ${stages.length} steps done${made ? `, ${made} thing${made === 1 ? '' : 's'} made` : ''}${next ? `. Next: ${next.label}` : ''}`
              : 'Your agent sets up the steps for this video'}
          </span>
        </button>
        <Menu
          label={`${project.name} options`}
          className="cx-progress-menu"
          items={[
            ...(run ? [{ label: open ? 'Hide steps' : 'Show steps', onSelect: () => setOpen(!open) }] : []),
            { label: run ? 'Ask for an update' : 'Ask your agent to set it up', onSelect: ask },
            ...(actions ? [{ label: history ? 'Hide history' : 'History', onSelect: () => void showHistory() }] : [])
          ]}
        />
      </div>
      {state?.notes && <p className="cx-progress-notes">{state.notes.slice(0, 280)}</p>}
      {open && run && (
        <ol className="cx-progress-steps">
          {stages.map((s) => {
            const st = statusOf(s.id)
            return (
              <li key={s.id} className={`is-${st}`}>
                <span className="cx-progress-step-name">
                  {st === 'done' && <Check />}
                  {s.label}
                </span>
                <span className="muted">{WORDS[st]}</span>
              </li>
            )
          })}
        </ol>
      )}
      {error && <p className="cx-card2-error">{error}</p>}
      {history === 'none' && actions && (
        <p className="cx-progress-notes">
          No history yet. Save a checkpoint of this project's scripts, captions and notes to start one.{' '}
          <button
            type="button"
            className="ws-head-btn"
            onClick={() =>
              void window.trenddeckCards
                .saveCheckpoint(brand.id, project.id, 'First checkpoint')
                .then((h) => setHistory(h ?? 'none'))
                .catch((err) => setError(cleanError(err)))
            }
          >
            Save a checkpoint
          </button>
        </p>
      )}
      {history && history !== 'none' && actions && <HistoryCard key={history.updatedAt} card={history} a={actions} />}
    </section>
  )
}
