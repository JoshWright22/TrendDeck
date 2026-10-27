import type { ReactNode } from 'react'
import type { Brand } from '@shared/types'
import type { Project } from '@shared/workspace'
import { useRun } from '../workspace/WorkspacePane'
import { draftChat } from '../pages/voice/chatDraft'

export default function ProjectProgress({ brand, project }: { brand: Brand; project: Project }): ReactNode {
  const run = useRun(brand.id, project.id)
  const stage = brand.pipeline.find((entry) => entry.id === run?.currentStageId)
  const state = stage && run ? run.stageStates[stage.id] : null
  const completed = brand.pipeline.filter((entry) => ['done', 'skipped'].includes(run?.stageStates[entry.id]?.status ?? '')).length
  const next = stage ? brand.pipeline[brand.pipeline.findIndex((entry) => entry.id === stage.id) + 1] : null
  const status = !run ? 'Ready to plan' : !run.currentStageId ? 'Workflow complete' : state?.status === 'waiting_user' ? 'Needs your input' : state?.status === 'running' ? 'In progress' : 'Ready for the next step'
  return (
    <section className="cx-project-progress" aria-label="Project progress">
      <div><strong>{status}</strong><span>{run ? `${completed} of ${brand.pipeline.length} steps complete` : 'Your agent sets up and manages the workflow.'}</span></div>
      {stage && <p><b>Now:</b> {stage.label}{next ? ` / Next: ${next.label}` : ''}</p>}
      {state?.notes && <p>{state.notes.slice(0, 240)}</p>}
      <button className="ws-head-btn" onClick={() => draftChat(run
        ? `Explain where ${project.name} stands, what you are doing now, and what you need from me. Update the workflow using your tools if anything has changed.`
        : `Set up and manage the workflow for ${project.name}. Inspect the existing pipeline using your tools, adapt it to this video, and create its run. Ask only for missing creative decisions and explain the next step.`)}>{run ? 'Ask for an update' : 'Ask agent to set up'}</button>
    </section>
  )
}
