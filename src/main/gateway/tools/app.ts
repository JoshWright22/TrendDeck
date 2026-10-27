import { app } from 'electron'
import type { SettingsCard } from '@shared/cards'
import type { CraftAppStatus } from '@shared/craft'
import { SETTINGS_SECTIONS, isSettingsSection } from '@shared/settings'
import { addCard, newCardId } from '../../cards/store'
import { allStatus } from '../../craft/state'
import { newer } from '../../craft/rules'
import { getData } from '../../store'
import { updateStatus } from '../../updater'
import { ToolError, type GatewayTool } from '../types'
import { obj, oneOf, str } from '../validate'

// TrendDeck itself for the agent: its version and updates, the Craft apps' versions, and a way to
// send the user to Settings for what only they can do there (a password import, an API key)

interface AppReport {
  version: string
  packaged: boolean
  autoUpdate: boolean
  update: ReturnType<typeof updateStatus>
  craft: Pick<CraftAppStatus, 'app' | 'install' | 'latest' | 'updateReady' | 'running'>[]
}

const when = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ')

// what app_status says, from what main knows. pure, unit tested
export function appStatusReport(r: AppReport): Record<string, unknown> {
  let update: string
  if (!r.packaged) update = 'this is a development build, it does not update itself'
  else if (r.update.ready) update = `version ${r.update.ready} is downloaded and waiting. the user clicks Update in the title bar to restart into it`
  else if (!r.autoUpdate) update = 'automatic updates are off in Settings, About'
  else if (!r.update.lastCheck) update = 'not checked yet this session, it checks a few seconds after start and every 6 hours'
  else if (r.update.lastCheck.result === 'latest') update = `up to date, checked ${when(r.update.lastCheck.at)} UTC`
  else if (r.update.lastCheck.result === 'downloading') update = 'a new version is downloading'
  else update = `the last check failed (${when(r.update.lastCheck.at)} UTC), it tries again later`
  const craftApps = r.craft.map((s) => {
    const installed = s.install.kind === 'installed' ? s.install.version : null
    let state: string
    if (s.install.kind === 'installing') state = 'installing'
    else if (s.install.kind === 'failed') state = `the last install failed: ${s.install.error}`
    else if (!installed) state = 'not installed, craft_install or craft_open installs it'
    else if (s.updateReady) state = `update ${s.updateReady} downloaded, it goes in when the app closes`
    else if (s.latest && newer(s.latest, installed)) state = `update ${s.latest} available, craft_install gets it`
    else state = s.latest ? 'up to date' : 'installed, latest version not known yet'
    return { app: s.app.id, name: s.app.name, installed: installed ?? false, latest: s.latest, state, open: s.running }
  })
  return { trenddeck: { version: r.version, update }, craftApps }
}

export const APP_TOOLS: GatewayTool[] = [
  {
    name: 'app_status',
    title: 'Check TrendDeck and its apps',
    description:
      "TrendDeck's own version and whether an update is downloaded and waiting, plus every Craft app with its installed and latest version. Use it when the user asks whether they're on the latest version.",
    inputSchema: obj(),
    risk: 'read',
    run: async () =>
      appStatusReport({
        version: app.getVersion(),
        packaged: app.isPackaged,
        autoUpdate: (getData()?.settings as { autoUpdate?: boolean } | undefined)?.autoUpdate !== false,
        update: updateStatus(),
        craft: allStatus()
      })
  },
  {
    name: 'open_settings',
    title: 'Ask the user to open Settings',
    description:
      "Posts a card in the chat with a button that opens TrendDeck's Settings at a section, with why in one or two plain sentences. For what only the user can do there: sign-ins, API keys, choosing a folder. Never ask for a password, key or code in the chat instead. OBS's password has its own tool, obs_import_password.",
    inputSchema: obj({ section: oneOf('the Settings section', [...SETTINGS_SECTIONS]), why: str('what to do there and why, plain and short', 300, 1) }, ['section', 'why']),
    risk: 'read',
    run: async (turn, args) => {
      if (!isSettingsSection(args.section)) throw new ToolError(`no Settings section ${String(args.section)}. sections: ${SETTINGS_SECTIONS.join(', ')}`)
      const now = Date.now()
      const card: SettingsCard = {
        id: newCardId(), brandId: turn.brandId, threadId: turn.threadId, messageId: turn.messageId ?? null, at: now, updatedAt: now,
        type: 'settings', section: args.section, why: String(args.why).trim()
      }
      await addCard(card)
      return `a card with a button to Settings, ${args.section} is in the chat. the user opens it from there`
    }
  }
]
