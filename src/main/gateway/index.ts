import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { PREVIEW_SPEED_TOOL } from '../preview-speed'
import { ID_PATTERN } from '@shared/types'
import { SITE_TOOLS } from '../mcp/tools'
import { onTurnClosed } from '../mcp/turns'
import { dropPipeline, dropTurnQuestions, PIPELINE_TOOLS, setupPipeline } from '../pipeline'
import { dropTurnApprovals, pendingApprovals, respondApproval } from './approvals'
import { dropAudit, listAudit } from './audit'
import { registerTools, toolInfo } from './call'
import { dropPolicy, getPolicy, setPolicy } from './policy'
import { dropReplies, listReplyDrafts, removeReplyDraft } from './replies'
import { forgetSecrets } from './secrets'
import { CONTENT_TOOLS } from './tools/content'
import { PUBLISH_TOOLS } from './tools/publish'
import { qcTools } from '../qc/tools'
import { STORAGE_TOOLS } from '../production-storage'
import { CONTEXT_TOOLS } from '../context'
import { OBS_TOOLS } from '../obs'
import { FOOTAGE_TOOLS } from '../footage/tools'
import { WORKSPACE_TOOLS } from '../workspace/tools'
import { APP_TOOLS } from './tools/app'
import { BRAND_TOOLS } from './tools/brand'

export { callGatewayTool, mcpToolList, toolInfo } from './call'

// every tool an agent can call, in the order tools/list shows them
registerTools([PREVIEW_SPEED_TOOL, ...SITE_TOOLS, ...CONTENT_TOOLS, ...PUBLISH_TOOLS, ...PIPELINE_TOOLS, ...WORKSPACE_TOOLS])
registerTools(qcTools())
// project history and cloud copies, then the brand's docs, past videos and style memory
registerTools(STORAGE_TOOLS)
registerTools(CONTEXT_TOOLS)
// OBS: status, scenes, pictures, recording and streaming with the user's approval
registerTools(OBS_TOOLS)
// recordings anywhere on the computer: find them, look inside, add parts to a project
registerTools(FOOTAGE_TOOLS)
// TrendDeck's own version and updates, and cards that send the user to Settings
registerTools(APP_TOOLS)
// the brand's name and niche keywords
registerTools(BRAND_TOOLS)

const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v)
// approvals and policy only from the app window, a site tab never gets to say yes
const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'

export function setupGateway(): void {
  setupPipeline()
  onTurnClosed((turn) => {
    dropTurnApprovals(turn.id)
    dropTurnQuestions(turn.id)
  })

  ipcMain.handle('gateway:tools', (e) => (fromApp(e) ? toolInfo() : []))
  ipcMain.handle('gateway:policy-get', (e, brandId: unknown) => {
    if (!fromApp(e) || !isId(brandId)) throw new Error('bad gateway call')
    return getPolicy(brandId)
  })
  ipcMain.handle('gateway:policy-set', (e, brandId: unknown, patch: unknown) => {
    if (!fromApp(e) || !isId(brandId)) throw new Error('bad gateway call')
    return setPolicy(brandId, patch)
  })
  ipcMain.handle('gateway:approvals', (e) => (fromApp(e) ? pendingApprovals() : []))
  ipcMain.handle('gateway:approval-respond', (e, res: unknown) => (fromApp(e) ? respondApproval(res) : false))
  ipcMain.handle('gateway:audit-list', (e, brandId: unknown, query: unknown) => {
    if (!fromApp(e) || !isId(brandId)) return []
    return listAudit(brandId, query)
  })
  ipcMain.handle('gateway:reply-drafts', (e, brandId: unknown) => (fromApp(e) && isId(brandId) ? listReplyDrafts(brandId) : []))
  ipcMain.handle('gateway:reply-draft-remove', (e, brandId: unknown, id: unknown) => {
    if (fromApp(e) && isId(brandId) && typeof id === 'string') return removeReplyDraft(brandId, id)
  })
}

// a deleted brand takes its policy, audit log, reply drafts and pipeline with it
export async function dropGatewayBrand(brandId: string): Promise<void> {
  forgetSecrets(brandId)
  await dropPolicy(brandId)
  await dropAudit(brandId)
  await dropReplies(brandId)
  await dropPipeline(brandId)
}
