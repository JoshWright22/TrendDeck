import { app, ipcMain } from 'electron'
import { ID_PATTERN } from '@shared/types'
import type { PostRequest } from '@shared/mcp'
import { getData } from '../store'
import { attachFor, sweepConfigs, type AgentKind, type Attachment } from './attach'
import { ensureServer } from './server'
import { changeState, loadState, notify, setGrant } from './state'
import { armedShare, armShare, closeTurn, disarmShare, openTurn, type Turn } from './turns'

export type { AgentKind, Attachment } from './attach'

export interface AgentSession {
  turn: Turn
  url: string
  attach: Attachment
  // call when the agent process exits, the token stops working right away
  end: () => Promise<void>
}

// the chat runs this when the user sends a message, right before it starts the agent.
// nothing else opens a turn, so agents can only reach the app while answering the user
export async function beginAgentTurn(
  brandId: string,
  agent: AgentKind,
  opts: { shareSiteId?: string | null } = {}
): Promise<AgentSession> {
  const url = await ensureServer()
  const turn = openTurn(brandId, opts)
  const attach = await attachFor(agent, turn, url)
  let ended = false
  return {
    turn,
    url,
    attach,
    end: async () => {
      if (ended) return
      ended = true
      closeTurn(turn.id)
      await attach.cleanup()
    }
  }
}

const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v)

export function setupMcp(): void {
  void app.whenReady().then(() => sweepConfigs())

  ipcMain.handle('mcp:state', async () => {
    const s = await loadState()
    // brands and sites that are gone don't count anymore
    const brands = getData()?.brands ?? []
    const grants: Record<string, string[]> = {}
    for (const b of brands) {
      const ids = new Set(b.sites.map((x) => x.id))
      grants[b.id] = (s.grants[b.id] ?? []).filter((id) => ids.has(id))
    }
    const list = brands.map((b) => ({
      id: b.id,
      name: b.name,
      sites: b.sites.map(({ id, name, url }) => ({ id, name, url }))
    }))
    return { ...s, grants, brands: list }
  })
  ipcMain.handle('mcp:grant', (_e, brandId: unknown, siteId: unknown, on: unknown) => {
    if (isId(brandId) && isId(siteId)) return setGrant(brandId, siteId, on === true)
  })
  ipcMain.handle('mcp:clear-log', async (_e, brandId: unknown) => {
    if (!isId(brandId)) return
    await changeState((s) => {
      s.log = s.log.filter((l) => l.brandId !== brandId)
    })
  })
  ipcMain.handle('mcp:post-status', async (_e, id: unknown, status: unknown) => {
    const ok: PostRequest['status'][] = ['waiting', 'done', 'dismissed']
    if (typeof id !== 'string' || !ok.includes(status as PostRequest['status'])) return
    await changeState((s) => {
      const p = s.posts.find((x) => x.id === id)
      if (p) p.status = status as PostRequest['status']
    })
  })
  ipcMain.handle('mcp:share-once', (_e, brandId: unknown, siteId: unknown) => {
    if (isId(brandId) && isId(siteId)) armShare(brandId, siteId)
    else disarmShare()
    notify()
  })
  ipcMain.handle('mcp:shared', () => armedShare())

  // dev only: opens one turn for the open brand and prints how to attach, so the
  // tools can be tried by hand without the chat. never in a packaged build
  if (!app.isPackaged && process.argv.includes('--mcp-dev')) {
    void app.whenReady().then(async () => {
      for (let i = 0; i < 50 && !getData(); i++) await new Promise((r) => setTimeout(r, 200))
      const brandId = getData()?.activeBrandId
      if (!brandId) return
      const s = await beginAgentTurn(brandId, 'generic')
      console.log(`[mcp-dev] ${JSON.stringify({ url: s.url, token: s.turn.token, config: s.attach.env.TRENDDECK_MCP_CONFIG })}`)
    })
  }
}
