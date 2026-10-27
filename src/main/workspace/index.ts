import { BrowserWindow, ipcMain } from 'electron'
import { ID_PATTERN, type AppData, type Brand } from '@shared/types'
import type { PipelineStage, Project } from '@shared/workspace'
import { getData, saveData } from '../store'
import { setStages } from '../pipeline/store'

// projects and the pipeline live on the brand in trenddeck.json. the renderer normally owns that
// file and saves it whole, so anything main changes here is sent back with data:changed and the
// renderer swaps its copy, otherwise its next save would put the old one back

function brandOf(brandId: unknown): Brand {
  const brand = typeof brandId === 'string' && ID_PATTERN.test(brandId) ? getData()?.brands.find((b) => b.id === brandId) : undefined
  if (!brand) throw new Error('No brand with that id')
  return brand
}

// saves the whole data from main and sends the saved copy to the renderer
export async function saveDataFromMain(next: AppData): Promise<AppData> {
  await saveData(next)
  const saved = getData() as AppData
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('data:changed', saved)
  return saved
}

async function editBrand(brandId: string, fn: (b: Brand) => Brand): Promise<Brand> {
  const data = getData()
  if (!data) throw new Error('Data not loaded yet')
  const next: AppData = { ...data, brands: data.brands.map((b) => (b.id === brandId ? fn(b) : b)) }
  // saveData cleans it, the cleaned copy is what's sent
  await saveDataFromMain(next)
  return brandOf(brandId)
}

export function readBrandPipeline(brandId: string): PipelineStage[] {
  return brandOf(brandId).pipeline
}

// the raw write, only main/pipeline/store calls it so runs get synced and pipeline:changed is sent.
// the stages are cleaned on save: bad ones dropped, an empty list goes back to the default.
// projects on a stage that's gone move to the first stage
export async function writeBrandPipeline(brandId: string, stages: PipelineStage[]): Promise<PipelineStage[]> {
  brandOf(brandId)
  return (await editBrand(brandId, (b) => ({ ...b, pipeline: stages }))).pipeline
}

export const getPipeline = readBrandPipeline

// everything else that changes the stages comes through here
export async function setPipeline(brandId: string, stages: PipelineStage[]): Promise<PipelineStage[]> {
  return (await setStages(brandId, stages)).stages
}

export function listProjects(brandId: string): Project[] {
  return brandOf(brandId).projects
}

export async function saveProject(brandId: string, project: Project): Promise<Project[]> {
  brandOf(brandId)
  const moving = Array.isArray(project.threadIds) ? project.threadIds : []
  const b = await editBrand(brandId, (b) => {
    const has = b.projects.some((p) => p.id === project.id)
    // a thread moving in here leaves the project it was in
    const others = b.projects.map((p) =>
      p.id === project.id ? p : { ...p, threadIds: p.threadIds.filter((t) => !moving.includes(t)) }
    )
    return { ...b, projects: has ? others.map((p) => (p.id === project.id ? project : p)) : [...others, project] }
  })
  return b.projects
}

export async function linkThread(brandId: string, projectId: string, threadId: string): Promise<void> {
  if (!ID_PATTERN.test(threadId)) throw new Error('Bad thread id')
  if (!brandOf(brandId).projects.some((p) => p.id === projectId)) throw new Error('No project with that id')
  await editBrand(brandId, (b) => ({
    ...b,
    projects: b.projects.map((p) => ({
      ...p,
      threadIds: p.id === projectId ? [...p.threadIds.filter((t) => t !== threadId), threadId] : p.threadIds.filter((t) => t !== threadId)
    }))
  }))
}

export function setupWorkspace(): void {
  ipcMain.handle('workspace:pipeline-get', (_e, brandId: unknown) => getPipeline(brandOf(brandId).id))
  ipcMain.handle('workspace:pipeline-set', (_e, brandId: unknown, stages: unknown) =>
    setPipeline(brandOf(brandId).id, Array.isArray(stages) ? (stages as PipelineStage[]) : [])
  )
  ipcMain.handle('workspace:projects', (_e, brandId: unknown) => listProjects(brandOf(brandId).id))
  ipcMain.handle('workspace:project-save', (_e, brandId: unknown, project: unknown) => {
    if (!project || typeof project !== 'object') throw new Error('Bad project')
    return saveProject(brandOf(brandId).id, project as Project)
  })
  ipcMain.handle('workspace:link-thread', (_e, brandId: unknown, projectId: unknown, threadId: unknown) => {
    if (typeof projectId !== 'string' || typeof threadId !== 'string') throw new Error('Bad ids')
    return linkThread(brandOf(brandId).id, projectId, threadId)
  })
}
