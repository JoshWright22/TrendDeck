import {
  STAGE_KINDS,
  STAGE_STATUSES,
  WORKSPACES,
  type PipelineChange,
  type PipelineStage,
  type Run,
  type StageStatus
} from '@shared/pipeline'
import { ToolError, type GatewayTool, type Turn } from '../gateway/types'
import { bool, int, list, obj, oneOf, str, type JsonSchema } from '../gateway/validate'
import { brandOf } from '../gateway/tools/common'
import { advanceRun, applyChanges, diffStages, PipelineError, setStage } from './model'
import { createRun, getPipeline, getRun, listRuns, setStages, updateRun } from './store'
import { answerText, askUser } from './questions'

// a question waits this long for the user before the agent hears there was no answer
const QUESTION_MS = 15 * 60_000

function stageOut(s: PipelineStage, i: number): Record<string, unknown> {
  return { step: i + 1, id: s.id, label: s.label, kind: s.kind, workspace: s.workspace, auto: s.auto, config: s.config }
}

function runOut(r: Run, stages: PipelineStage[]): Record<string, unknown> {
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    currentStageId: r.currentStageId,
    archived: r.archived,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    stages: stages.map((s) => ({ id: s.id, label: s.label, auto: s.auto, ...r.stageStates[s.id] })).map(({ updatedAt, ...rest }) => ({
      ...rest,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null
    }))
  }
}

async function runFor(turn: Turn, runId: unknown): Promise<Run> {
  if (typeof runId === 'string' && runId) {
    const r = await getRun(turn.brandId, runId)
    if (!r) throw new ToolError(`no run with id ${runId}, see run_list`)
    return r
  }
  const latest = (await listRuns(turn.brandId, { archived: false }))[0]
  if (!latest) throw new ToolError('this brand has no runs yet, start one with run_start')
  return latest
}

// config values can be strings, numbers or true/false
const configAny: JsonSchema = { type: 'object', description: 'stage settings, string, number or true/false values', additionalProperties: true }

const stageInput: JsonSchema = obj(
  {
    id: str('lowercase id, made from the label when left out', 40),
    label: str('what the user sees', 60, 1),
    kind: oneOf('what happens in it', STAGE_KINDS),
    workspace: oneOf('which workspace the app shows for it', WORKSPACES),
    config: configAny,
    auto: bool('you may finish this stage without asking the user')
  },
  ['label', 'kind', 'workspace']
)

const changeInput: JsonSchema = obj(
  {
    op: oneOf('add, remove, move or configure', ['add', 'remove', 'move', 'configure']),
    stage: stageInput,
    stage_id: str('the stage to remove, move or configure', 40),
    index: int('0 based position for add and move, default the end', 0, 50),
    patch: obj({
      label: str('new label', 60, 1),
      kind: oneOf('new kind', STAGE_KINDS),
      workspace: oneOf('new workspace', WORKSPACES),
      config: configAny,
      auto: bool('new auto setting')
    })
  },
  ['op']
)

function toChanges(raw: unknown): PipelineChange[] {
  const out: PipelineChange[] = []
  for (const [i, c] of (raw as Record<string, unknown>[]).entries()) {
    const need = (k: string): never => {
      throw new ToolError(`changes[${i}] with op ${c.op} needs ${k}`)
    }
    if (c.op === 'add') {
      const stage = (c.stage ?? need('stage')) as Extract<PipelineChange, { op: 'add' }>['stage']
      out.push({ op: 'add', stage, index: c.index as number | undefined })
    }
    else if (c.op === 'remove') out.push({ op: 'remove', stageId: (c.stage_id as string) ?? need('stage_id') })
    else if (c.op === 'move') {
      if (c.index === undefined) need('index')
      out.push({ op: 'move', stageId: (c.stage_id as string) ?? need('stage_id'), index: c.index as number })
    } else if (c.op === 'configure') {
      const patch = (c.patch ?? need('patch')) as Extract<PipelineChange, { op: 'configure' }>['patch']
      out.push({ op: 'configure', stageId: (c.stage_id as string) ?? need('stage_id'), patch })
    }
  }
  return out
}

async function proposed(turn: Turn, args: Record<string, unknown>): Promise<{ before: PipelineStage[]; after: PipelineStage[] }> {
  const before = (await getPipeline(turn.brandId)).stages
  try {
    return { before, after: applyChanges(before, toChanges(args.changes)) }
  } catch (err) {
    if (err instanceof PipelineError) throw new ToolError(err.message)
    throw err
  }
}

function wrap<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof PipelineError) throw new ToolError(err.message)
    throw err
  }
}

// a stage that isn't auto needs the user to finish it
async function stageNeedsUser(turn: Turn, stageId: string | null): Promise<string | null> {
  if (!stageId) return null
  const stages = (await getPipeline(turn.brandId)).stages
  const s = stages.find((x) => x.id === stageId)
  if (!s || s.auto) return null
  return `"${s.label}" isn't an auto stage, so the user signs it off`
}

export const PIPELINE_TOOLS: GatewayTool[] = [
  {
    name: 'pipeline_get',
    title: 'See the pipeline',
    description:
      "The brand's content pipeline: its stages in order, what each is for, which workspace it uses and whether you may finish it on your own (auto).",
    inputSchema: obj(),
    risk: 'read',
    run: async (turn) => {
      const p = await getPipeline(turn.brandId)
      return { stages: p.stages.map(stageOut), updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : null }
    }
  },
  {
    name: 'pipeline_propose_change',
    title: 'Change the pipeline',
    description:
      'Propose changes to the pipeline: add, remove, move or configure stages. The user always sees it as a diff and approves or says no, nothing changes until they do. Changes apply in order.',
    inputSchema: obj(
      { changes: list('the changes, applied in order', changeInput, 20, 1), reason: str('why, shown to the user', 500, 1) },
      ['changes', 'reason']
    ),
    risk: 'edit',
    alwaysAsk: true,
    summarize: (_t, args) => `Change the pipeline: ${String(args.reason)}`,
    diff: async (turn, args) => {
      const { before, after } = await proposed(turn, args)
      return diffStages(before, after)
    },
    run: async (turn, args) => {
      brandOf(turn)
      const { before, after } = await proposed(turn, args)
      const p = await setStages(turn.brandId, after)
      return { changed: true, diff: diffStages(before, after).filter((l) => l.kind !== 'same'), stages: p.stages.map(stageOut) }
    }
  },
  {
    name: 'run_list',
    title: 'List runs',
    description: 'Pieces of content going through the pipeline, newest first, with the stage each is on.',
    inputSchema: obj({ project_id: str('only runs for this project', 64), include_archived: bool('also show archived runs') }),
    risk: 'read',
    run: async (turn, args) => {
      const stages = (await getPipeline(turn.brandId)).stages
      const runs = await listRuns(turn.brandId, {
        ...(typeof args.project_id === 'string' ? { projectId: args.project_id } : {}),
        ...(args.include_archived === true ? {} : { archived: false })
      })
      return runs.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        title: r.title,
        currentStageId: r.currentStageId,
        currentStage: stages.find((s) => s.id === r.currentStageId)?.label ?? null,
        status: r.currentStageId ? r.stageStates[r.currentStageId]?.status : 'finished',
        updatedAt: new Date(r.updatedAt).toISOString()
      }))
    }
  },
  {
    name: 'run_get',
    title: 'See a run',
    description: 'One run with every stage: status (pending, running, waiting_user, done, skipped), notes and artifact ids. Leave run_id out for the latest run.',
    inputSchema: obj({ run_id: str('id from run_list', 64) }),
    risk: 'read',
    run: async (turn, args) => {
      const stages = (await getPipeline(turn.brandId)).stages
      return runOut(await runFor(turn, args.run_id), stages)
    }
  },
  {
    name: 'run_start',
    title: 'Start a run',
    description: 'Start a new piece of content at the first stage of the pipeline. project_id ties it to a project.',
    inputSchema: obj({ title: str('what this run makes', 200, 1), project_id: str('optional project id', 64) }, ['title']),
    risk: 'edit',
    summarize: (_t, args) => `Start a run: ${args.title}`,
    run: async (turn, args) => {
      brandOf(turn)
      const run = await createRun(turn.brandId, { title: String(args.title), projectId: typeof args.project_id === 'string' ? args.project_id : '' })
      return runOut(run, (await getPipeline(turn.brandId)).stages)
    }
  },
  {
    name: 'run_advance_stage',
    title: 'Finish a stage',
    description:
      "Mark the run's current stage done (or skipped) and start the next one, or a stage you name. Stages that aren't auto ask the user first. Add notes and artifact ids (idea, draft, media, post or slot ids) made in the stage.",
    inputSchema: obj({
      run_id: str('id from run_list, the latest run when left out', 64),
      notes: str('what was done, replaces the stage notes', 4000),
      artifacts: list('ids made in this stage, added to the stage', str('id', 64), 50),
      skip: bool('mark it skipped instead of done'),
      to_stage_id: str('go to this stage instead of the next one, e.g. back to fix something', 40)
    }),
    risk: 'edit',
    mustAsk: async (turn, args) => {
      const r = await runFor(turn, args.run_id)
      return stageNeedsUser(turn, r.currentStageId)
    },
    summarize: async (turn, args) => {
      const r = await runFor(turn, args.run_id)
      const stages = (await getPipeline(turn.brandId)).stages
      const cur = stages.find((s) => s.id === r.currentStageId)?.label ?? 'the stage'
      return `${args.skip ? 'Skip' : 'Finish'} "${cur}" on ${r.title || 'the run'}${args.to_stage_id ? ` and go to ${args.to_stage_id}` : ''}`
    },
    run: async (turn, args) => {
      const r = await runFor(turn, args.run_id)
      const next = await updateRun(turn.brandId, r.id, (run, stages) =>
        wrap(() =>
          advanceRun(run, stages, {
            notes: args.notes as string | undefined,
            artifacts: args.artifacts as string[] | undefined,
            skip: args.skip === true,
            toStageId: args.to_stage_id as string | undefined
          })
        )
      )
      if (!next) throw new ToolError('the run is gone')
      return runOut(next, (await getPipeline(turn.brandId)).stages)
    }
  },
  {
    name: 'run_set_stage_status',
    title: 'Set a stage status',
    description:
      'Set one stage of a run to pending, running, waiting_user, done or skipped, with notes and artifact ids. Use waiting_user while you wait on the user. Done or skipped on a stage that isn\'t auto asks the user first.',
    inputSchema: obj(
      {
        run_id: str('id from run_list, the latest run when left out', 64),
        stage_id: str('stage id from pipeline_get', 40, 1),
        status: oneOf('the new status', STAGE_STATUSES),
        notes: str('replaces the stage notes', 4000),
        artifacts: list('ids made in this stage, added to the stage', str('id', 64), 50)
      },
      ['stage_id', 'status']
    ),
    risk: 'edit',
    mustAsk: async (turn, args) =>
      args.status === 'done' || args.status === 'skipped' ? stageNeedsUser(turn, String(args.stage_id)) : null,
    summarize: (_t, args) => `Set stage ${args.stage_id} to ${args.status}`,
    run: async (turn, args) => {
      const r = await runFor(turn, args.run_id)
      const next = await updateRun(turn.brandId, r.id, (run, stages) =>
        wrap(() =>
          setStage(run, stages, String(args.stage_id), {
            status: args.status as StageStatus,
            notes: args.notes as string | undefined,
            artifacts: args.artifacts as string[] | undefined
          })
        )
      )
      if (!next) throw new ToolError('the run is gone')
      return runOut(next, (await getPipeline(turn.brandId)).stages)
    }
  },
  {
    name: 'ask_user',
    title: 'Ask the user',
    description:
      'Ask the user one to four multiple choice questions and wait for the answer. Each question gets 2 to 6 options and an Other box for their own words. Use it for real choices, not to confirm every step. Returns their picks.',
    inputSchema: obj(
      {
        questions: list(
          'the questions, shown one after another',
          obj(
            {
              question: str('the question', 300, 1),
              options: list(
                'the choices',
                obj({ label: str('short choice', 80, 1), description: str('one line on what it means', 200) }, ['label']),
                6,
                2
              ),
              multi: bool('more than one can be picked')
            },
            ['question', 'options']
          ),
          4,
          1
        ),
        run_id: str('the run this is about', 64),
        stage_id: str('the stage this is about', 40)
      },
      ['questions']
    ),
    risk: 'read',
    annotations: { readOnlyHint: true, idempotentHint: false },
    run: async (turn, args) => {
      const questions = (args.questions as { question: string; options: { label: string; description?: string }[]; multi?: boolean }[]).map((q) => ({
        question: q.question,
        options: q.options.map((o) => ({ label: o.label, description: o.description ?? '' })),
        multi: q.multi === true
      }))
      const out = await askUser(
        {
          brandId: turn.brandId,
          threadId: turn.threadId,
          turnId: turn.id,
          runId: typeof args.run_id === 'string' ? args.run_id : null,
          stageId: typeof args.stage_id === 'string' ? args.stage_id : null,
          questions
        },
        QUESTION_MS
      )
      if (out.kind === 'answered') return { answered: true, picks: out.picks, text: answerText(questions, out.picks) }
      if (out.kind === 'dismissed') return { answered: false, note: 'the user closed the question without answering' }
      if (out.kind === 'timeout') return { answered: false, note: "the user didn't answer in time, ask in your reply instead" }
      return { answered: false, note: 'the question was cancelled' }
    }
  }
]
