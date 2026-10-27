import { lazy, type ComponentType, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import type { PipelineStage, Project } from '@shared/workspace'
import { craftAppOf, craftName, OWN_KEYS } from './craft/apps'

// what every stage workspace gets. a workspace is any component, the right pane mounts it
// under the stage strip and it fills the space with position: absolute; inset: 0 (.page does that)
export interface WorkspaceProps {
  brand: Brand
  project: Project
  // the stage it's open for, null when it's opened as a tool from the menu
  stage: PipelineStage | null
  editBrand: (fn: (b: Brand) => Brand) => void
  onEditBrand: () => void
  // open another workspace in the pane, e.g. a placeholder linking to Media
  onOpenWorkspace: (key: string) => void
  // links always open in a site tab, never the system browser
  onOpenUrl: (url: string) => void
  // the title bar search hands Trends its query
  trendQuery: string
  onTrendQuery: (q: string) => void
}

export interface WorkspaceDef {
  label: string
  component: ComponentType<WorkspaceProps>
  // listed in the pane's Tools menu, for things that aren't a pipeline step
  tool?: boolean
}

const registry = new Map<string, WorkspaceDef>()

// add or replace a workspace. a stage whose workspace key isn't registered shows a placeholder.
// keys are lowercase letters, digits and dashes, same as the store accepts
export function registerWorkspace(key: string, def: WorkspaceDef): void {
  registry.set(key, def)
}

export function workspaceFor(key: string): WorkspaceDef | undefined {
  // filmcraft, photocraft, soundcraft, effectcraft and craft:<any app id>
  return registry.get(key) ?? craftDef(key)
}

export function toolWorkspaces(): [string, WorkspaceDef][] {
  return [...registry].filter(([, d]) => d.tool)
}

const PhoneView = lazy(() => import('../emulator/PhoneView'))

function PhoneWorkspace({ brand }: WorkspaceProps): ReactNode {
  return <PhoneView key={brand.id} brand={brand} />
}

// the Craft apps. each key gets one component so switching stages between two keys of the same
// app doesn't remount it
const CraftWorkspace = lazy(() => import('./craft/CraftWorkspace').then((m) => ({ default: m.CraftWorkspace })))
const craftViews = new Map<string, ComponentType<WorkspaceProps>>()

function craftDef(key: string): WorkspaceDef | undefined {
  const appId = craftAppOf(key)
  if (!appId) return undefined
  let View = craftViews.get(appId)
  if (!View) {
    const Craft = (p: WorkspaceProps): ReactNode => <CraftWorkspace {...p} appId={appId} />
    View = Craft
    craftViews.set(appId, View)
  }
  return { label: craftName(appId), component: View }
}

registerWorkspace('phone', { label: 'Phone', component: PhoneWorkspace, tool: true })
// the pane docks the Craft apps and OBS (registered by the OBS pane as 'obs'). the old pages
// (ideas, writer, media, trends and the rest) are gone from it, the agent does that work in chat
for (const k of OWN_KEYS) registerWorkspace(k, craftDef(k)!)
