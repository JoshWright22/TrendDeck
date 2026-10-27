import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import {
  MCP_PRESETS,
  MCP_SERVER_NAME,
  PROJECTS_FOLDER,
  type McpSaveResult,
  type McpServerPreset,
  type McpServerView
} from '@shared/mcp-servers'
import { ID_PATTERN } from '@shared/types'
import { projectsRoot } from '../craft/paths'
import { safeName } from '../craft/rules'
import { registerToolSource } from '../gateway/call'
import { registerSecretSource } from '../gateway/secrets'
import { getData } from '../store'
import { applyInput, ConfigError, toView, type StoredServer } from './config'
import { allSecrets, cachedTools, dropTools, loadServers, saveServers, seal, serverNow, serversNow } from './store'
import { changed, cleanError, closeAll, connect, disconnect, forgetLive, liveOf, mcpServerTools, setupTurnHook, testServer } from './tools'

// your own MCP servers, from Settings > MCP servers. their tools reach chat agents through the
// gateway as <server>_<tool>, only for brands you turned them on for

const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'
const isName = (v: unknown): v is string => typeof v === 'string' && MCP_SERVER_NAME.test(v)
const isBrand = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v)

function view(s: StoredServer, brandId: string): McpServerView {
  return toView(s, brandId, liveOf(s.id), cachedTools(s.id))
}

// starts it in the background so its tool list is fresh, a failure shows as its status
function warm(s: StoredServer): void {
  if (Object.keys(s.brands).length) void connect(s).catch(() => {})
}

async function update(id: string, fn: (s: StoredServer) => StoredServer): Promise<StoredServer | null> {
  const all = await loadServers()
  const cur = all.find((s) => s.id === id)
  if (!cur) return null
  const next = fn(cur)
  await saveServers(all.map((s) => (s.id === id ? next : s)))
  return next
}

// a preset's name, or name2, name3... when you have one called that already
function freeName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let i = 2; i < 100; i++) {
    const n = `${base.slice(0, 20 - String(i).length)}${i}`
    if (!taken.includes(n)) return n
  }
  return base
}

function presetsFor(brandId: unknown): McpServerPreset[] {
  const brand = isBrand(brandId) ? getData()?.brands.find((b) => b.id === brandId) : undefined
  // the same folder projectFolder puts the brand's projects in
  const folder = brand ? join(projectsRoot(), safeName(brand.name, 'Brand')) : projectsRoot()
  const put = (v: string): string => v.split(PROJECTS_FOLDER).join(folder)
  const taken = serversNow().map((s) => s.id)
  return MCP_PRESETS.map((p) => ({
    ...p,
    name: freeName(p.name, taken),
    args: p.args.map(put),
    env: p.env.map((v) => ({ ...v, value: put(v.value) })),
    headers: p.headers.map((h) => ({ ...h }))
  }))
}

export function setupMcpServers(): void {
  registerToolSource(mcpServerTools)
  registerSecretSource(allSecrets)
  setupTurnHook()
  void loadServers().catch((err) => console.error('mcp servers: could not load', err))
  app.on('will-quit', closeAll)

  ipcMain.handle('mcp-servers:list', async (e, brandId: unknown) => {
    if (!fromApp(e)) return []
    const all = await loadServers()
    const b = isBrand(brandId) ? brandId : ''
    return all.map((s) => view(s, b))
  })

  ipcMain.handle('mcp-servers:save', async (e, input: unknown): Promise<McpSaveResult> => {
    if (!fromApp(e)) return { ok: false, error: 'bad call' }
    const all = await loadServers()
    const id = input && typeof input === 'object' ? (input as { id?: unknown }).id : undefined
    const old = all.find((s) => s.id === id) ?? null
    let next: StoredServer
    try {
      next = applyInput(input, old, all.map((s) => s.id), seal)
    } catch (err) {
      return { ok: false, error: err instanceof ConfigError ? err.message : 'That server couldn\'t be saved.' }
    }
    try {
      await saveServers(old ? all.map((s) => (s.id === next.id ? next : s)) : [...all, next])
    } catch (err) {
      return { ok: false, error: `Couldn't save: ${cleanError(next.id, err)}` }
    }
    // what's running was started with the old settings
    disconnect(next.id)
    warm(next)
    changed()
    const from = (input as { brandId?: unknown }).brandId
    return { ok: true, server: view(next, isBrand(from) ? from : '') }
  })

  ipcMain.handle('mcp-servers:remove', async (e, id: unknown) => {
    if (!fromApp(e) || !isName(id)) throw new Error('bad mcp-servers call')
    const all = await loadServers()
    if (!all.some((s) => s.id === id)) return
    forgetLive(id)
    await saveServers(all.filter((s) => s.id !== id))
    await dropTools(id)
    changed()
  })

  ipcMain.handle('mcp-servers:set-enabled', async (e, id: unknown, brandId: unknown, on: unknown) => {
    if (!fromApp(e) || !isName(id) || !isBrand(brandId) || typeof on !== 'boolean') throw new Error('bad mcp-servers call')
    const next = await update(id, (s) => {
      const brands = { ...s.brands }
      if (on) brands[brandId] = true
      else delete brands[brandId]
      return { ...s, brands }
    })
    if (!next) return
    // off everywhere: nothing needs it running
    if (Object.keys(next.brands).length === 0) disconnect(id)
    else if (on) warm(next)
    changed()
  })

  ipcMain.handle('mcp-servers:set-trusted', async (e, id: unknown, on: unknown) => {
    if (!fromApp(e) || !isName(id) || typeof on !== 'boolean') throw new Error('bad mcp-servers call')
    await update(id, (s) => ({ ...s, trusted: on }))
    changed()
  })

  ipcMain.handle('mcp-servers:test', async (e, id: unknown) => {
    if (!fromApp(e) || !isName(id)) throw new Error('bad mcp-servers call')
    await loadServers()
    return testServer(id)
  })

  ipcMain.handle('mcp-servers:presets', async (e, brandId: unknown) => {
    if (!fromApp(e)) return []
    await loadServers()
    return presetsFor(brandId)
  })
}

// a deleted brand: every server is off for it
export async function dropMcpServersBrand(brandId: string): Promise<void> {
  const all = await loadServers()
  if (!all.some((s) => s.brands[brandId])) return
  const next = all.map((s) => {
    if (!s.brands[brandId]) return s
    const brands = { ...s.brands }
    delete brands[brandId]
    return { ...s, brands }
  })
  await saveServers(next)
  for (const s of next) if (Object.keys(s.brands).length === 0 && serverNow(s.id)) disconnect(s.id)
  changed()
}
