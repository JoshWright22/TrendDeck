import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ID_PATTERN } from '@shared/types'
import { STAGE_STATUSES, type StageStatus } from '@shared/pipeline'
import { advanceRun, PipelineError, setStage } from './model'
import { answerQuestion, pendingQuestions } from './questions'
import { createRun, dropPipeline, getPipeline, getRun, listRuns, removeRun, setStages, updateRun } from './store'

export { PIPELINE_TOOLS } from './tools'
export { dropTurnQuestions } from './questions'
export { dropPipeline }

const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v)
// only the app window, never a site tab
const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'

function guard<A extends unknown[], R>(fn: (brandId: string, ...a: A) => R) {
  return (e: IpcMainInvokeEvent, brandId: unknown, ...a: A): R => {
    if (!fromApp(e) || !isId(brandId)) throw new Error('bad pipeline call')
    return fn(brandId, ...a)
  }
}

export function setupPipeline(): void {
  ipcMain.handle('pipeline:get', guard((brandId) => getPipeline(brandId)))
  // the user editing their own pipeline goes straight in
  ipcMain.handle('pipeline:set', guard((brandId, stages: unknown) => setStages(brandId, stages)))

  ipcMain.handle(
    'run:list',
    guard((brandId, opts: unknown) => {
      const o = (opts ?? {}) as { projectId?: unknown; archived?: unknown }
      return listRuns(brandId, {
        ...(typeof o.projectId === 'string' ? { projectId: o.projectId } : {}),
        ...(typeof o.archived === 'boolean' ? { archived: o.archived } : {})
      })
    })
  )
  ipcMain.handle('run:get', guard((brandId, runId: unknown) => (typeof runId === 'string' ? getRun(brandId, runId) : null)))
  ipcMain.handle(
    'run:create',
    guard((brandId, input: unknown) => {
      const i = (input ?? {}) as { projectId?: unknown; title?: unknown }
      return createRun(brandId, {
        projectId: typeof i.projectId === 'string' ? i.projectId : '',
        title: typeof i.title === 'string' ? i.title : ''
      })
    })
  )
  ipcMain.handle(
    'run:update',
    guard((brandId, runId: unknown, raw: unknown) => {
      if (typeof runId !== 'string') return null
      const p = (raw ?? {}) as {
        title?: unknown
        archived?: unknown
        currentStageId?: unknown
        stage?: { id?: unknown; status?: unknown; notes?: unknown }
      }
      return updateRun(brandId, runId, (run, stages) => {
        let r = { ...run }
        if (typeof p.title === 'string') r.title = p.title.slice(0, 200)
        if (typeof p.archived === 'boolean') r.archived = p.archived
        try {
          if (typeof p.currentStageId === 'string' && p.currentStageId !== r.currentStageId) {
            // the user jumping to a stage: the one they leave keeps its status
            r = setStage(r, stages, p.currentStageId, { status: 'running' })
          }
          if (p.stage && typeof p.stage.id === 'string') {
            const status = (STAGE_STATUSES as readonly string[]).includes(p.stage.status as string) ? (p.stage.status as StageStatus) : undefined
            r = setStage(r, stages, p.stage.id, { status, notes: typeof p.stage.notes === 'string' ? p.stage.notes : undefined })
          }
        } catch (err) {
          if (err instanceof PipelineError) throw new Error(err.message)
          throw err
        }
        return r
      })
    })
  )
  ipcMain.handle(
    'run:advance',
    guard((brandId, runId: unknown) =>
      typeof runId === 'string' ? updateRun(brandId, runId, (run, stages) => advanceRun(run, stages)) : null
    )
  )
  ipcMain.handle('run:remove', guard((brandId, runId: unknown) => (typeof runId === 'string' ? removeRun(brandId, runId) : undefined)))

  ipcMain.handle('pipeline:questions', (e) => (fromApp(e) ? pendingQuestions() : []))
  ipcMain.handle('pipeline:answer', (e, answer: unknown) => (fromApp(e) ? answerQuestion(answer) : false))
}
