import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ID_PATTERN } from '@shared/types'
import type { LoginInput, VaultState } from '@shared/vault'
import { getData } from '../store'
import { setupCodePrompt } from './login'
import { setupLoginRequests } from './requests'
import { listAttempts, listLogins, removeLogin, saveLogin, unavailableReason } from './store'

export { authGuard } from './guard'
export { loginTool } from './tool'
export { forgetBrandLogins } from './store'

const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v)

// only the app window may touch the vault, never a site tab
const fromApp = (e: IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'

function siteExists(brandId: string, siteId: string): boolean {
  return !!getData()?.brands.find((b) => b.id === brandId)?.sites.some((s) => s.id === siteId)
}

export function setupVault(): void {
  setupCodePrompt()
  setupLoginRequests()

  ipcMain.handle('vault:state', async (e): Promise<VaultState | null> => {
    if (!fromApp(e)) return null
    const logins = await listLogins()
    const reason = unavailableReason()
    const brands = (getData()?.brands ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      sites: b.sites.map((s) => {
        const l = logins.find((x) => x.brandId === b.id && x.siteId === s.id)
        return {
          id: s.id,
          name: s.name,
          url: s.url,
          login: l ? { siteId: s.id, username: l.username, hasNotes: l.hasNotes, loginUrl: l.loginUrl, savedAt: l.savedAt } : null
        }
      })
    }))
    return { available: reason === '', reason, brands, attempts: (await listAttempts()).slice(-100) }
  })

  ipcMain.handle('vault:save', async (e, brandId: unknown, siteId: unknown, raw: unknown) => {
    if (!fromApp(e) || !isId(brandId) || !isId(siteId)) return 'bad request'
    if (!siteExists(brandId, siteId)) return 'that site is gone'
    const r = (raw ?? {}) as Partial<LoginInput>
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    return saveLogin(brandId, siteId, {
      username: str(r.username),
      password: str(r.password),
      notes: str(r.notes),
      loginUrl: str(r.loginUrl)
    })
  })

  ipcMain.handle('vault:remove', async (e, brandId: unknown, siteId: unknown) => {
    if (fromApp(e) && isId(brandId) && isId(siteId)) await removeLogin(brandId, siteId)
  })
}
